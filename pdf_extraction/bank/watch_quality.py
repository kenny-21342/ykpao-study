#!/usr/bin/env python3
"""Watch a transcription run for the model going quietly bad.

`run_transcription.sh` already catches the loud failures: a chunk that dies, a
run that stalls, a provider returning something that will not parse as JSON. It
cannot catch the quiet one, which is what a degrading model actually does --
answer with well-formed JSON whose content is a refusal, a placeholder, or the
same text over and over. Those are written to the store as `ok` and become
corpus.

    pdf_extraction/bank/watch_quality.py                  # watch forever
    pdf_extraction/bank/watch_quality.py --once           # one pass, then exit
    MODEL=gpt-5.6-sol pdf_extraction/bank/watch_quality.py

Prints a line only when something trips, at most once per 30 minutes per issue,
so it is quiet by design: silence means the run is healthy.

Every detector below started out wrong in a way that took a real investigation
to find, and each comment records what it was, because the failure mode of a
monitor is a false alarm that trains you to ignore it.
"""
import argparse
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

DB = Path(__file__).resolve().parent / "extract.db"
WINDOW_MIN = 20
MIN_SAMPLE = 20
FAIL_PCT = 25          # below the supervisor's 40, so this speaks first
LEN_FLOOR = 150        # against a ~500-character corpus average
QUIET_SECONDS = 1800

# Anchored to the start. "unable to" and "cannot" are ordinary exam prose --
# 9608 q845 reads "the programmer is unable to ..." -- and an unanchored
# pattern flags it as a refusal. A real refusal *is* the whole response.
REFUSAL = re.compile(
    r"^\W{0,4}(i'?m sorry|i am sorry|sorry[,.]|i cannot|i can'?t|i'?m unable|"
    r"i am unable|as an ai|i don'?t have|unfortunately[,]? i)", re.I)

# Three Latin letters or two CJK characters. Mirrors `hasGradableText` in
# lib/grading-router.ts: asks whether a question is there at all, rather than
# whether it is long. A crop failure leaves `![](asset:fig1)` and no words; a
# 0509 Chinese essay title is two characters and is a complete question.
WORD_LIKE = re.compile(r"[A-Za-z]{3,}|[㐀-䶿一-鿿぀-ヿ가-힯]{2,}")


def prose(text: str) -> str:
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text or "")
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


class Reporter:
    """At most one line per issue per QUIET_SECONDS."""

    def __init__(self) -> None:
        self._last: dict[str, float] = {}

    def say(self, key: str, message: str) -> None:
        now = time.time()
        if now - self._last.get(key, 0.0) < QUIET_SECONDS:
            return
        self._last[key] = now
        print(message, flush=True)

    def clear(self, key: str) -> None:
        self._last.pop(key, None)


def check(conn: sqlite3.Connection, model: str, out: Reporter) -> None:
    failed, total = conn.execute(
        f"""select sum(status='failed'), count(*) from bank_run_ledger
             where completed_at >= datetime('now', '-{WINDOW_MIN} minutes')"""
    ).fetchone()
    failed, total = failed or 0, total or 0
    if total >= MIN_SAMPLE:
        pct = round(100.0 * failed / total)
        if pct >= FAIL_PCT:
            out.say("fail", f"FAILURE RATE {pct}% ({failed}/{total}) in the last {WINDOW_MIN}m")
        else:
            out.clear("fail")

    rows = conn.execute(
        """select id, body_md, paper_id from bank_questions
            where model = ? and coalesce(body_md,'') <> ''
            order by id desc limit 400""",
        (model,),
    ).fetchall()

    if len(rows) >= MIN_SAMPLE:
        texts = [r[1] for r in rows]
        avg = sum(len(t) for t in texts) / len(texts)
        if avg < LEN_FLOOR:
            out.say("short", f"TRANSCRIPTS COLLAPSING: avg {avg:.0f} chars over {len(texts)}")

        refusals = [(r[0], r[1]) for r in rows if REFUSAL.match(r[1].strip())]
        if len(refusals) >= 2:
            out.say("refuse", f"REFUSAL TEXT STORED AS OK: {len(refusals)} of {len(texts)} — "
                              f"q{refusals[0][0]}: {refusals[0][1][:90]!r}")

        wordless = [r for r in rows if not WORD_LIKE.search(prose(r[1]))]
        pct = round(100.0 * len(wordless) / len(rows))
        if pct >= 10:
            out.say("crop", f"CROP FAILURES RISING: {pct}% of the last {len(rows)} "
                            f"transcripts contain no words at all")

        # Repetition counts only *within one paper*. Cambridge reuses a
        # multiple-choice question across the variants of a session and across
        # sessions -- 0455 w19 qp_11/12/13 and w22 qp_11/12/13 all carry the
        # same musician question. The corpus audit found 1,498 of 1,499
        # duplicate texts were cross-paper and legitimate; only 5 were inside a
        # paper. A looping model repeats inside one paper.
        seen: dict[tuple, int] = {}
        for _, body, paper_id in rows:
            if not WORD_LIKE.search(prose(body)):
                continue
            key = (paper_id, body.strip()[:200])
            seen[key] = seen.get(key, 0) + 1
        worst = max(seen.values(), default=0)
        if worst >= 3:
            paper_id, text = next(k for k, v in seen.items() if v == worst)
            out.say("dup", f"MODEL REPEATING ITSELF: same text {worst}x inside paper "
                           f"{paper_id} — {text[:80]!r}")

    alive = subprocess.run(["pgrep", "-f", "corpus_run"], capture_output=True).returncode == 0
    if alive:
        out.clear("dead")
    else:
        out.say("dead", "BATCH NOT RUNNING: no corpus_run process")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="one pass, then exit")
    parser.add_argument("--model", default="gpt-5.6-sol", help="which model's output to judge")
    parser.add_argument("--interval", type=int, default=180)
    args = parser.parse_args()

    out = Reporter()
    while True:
        try:
            conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
            conn.execute("PRAGMA busy_timeout = 30000")
            try:
                check(conn, args.model, out)
            finally:
                conn.close()
        except Exception as error:  # a watcher that dies on a blip is no watcher
            out.say("err", f"watcher error: {error}")
        if args.once:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
