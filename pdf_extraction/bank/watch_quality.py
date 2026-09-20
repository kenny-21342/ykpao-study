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
#: How far below its own peer group a batch of transcripts has to fall before
#: it counts as collapsing. Half is deliberately generous: real degradation
#: takes the average to a fraction of normal, while legitimate variation
#: between papers of the same kind is nowhere near 2x.
COLLAPSE_RATIO = 0.5
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
        print(f"[{stamp()}] {message}", flush=True)

    def clear(self, key: str) -> None:
        self._last.pop(key, None)


def collapsing_groups(conn: sqlite3.Connection, model: str, recent_ids: list[int]) -> list[dict]:
    """Recent transcripts that are short *for the kind of paper they are on*.

    The first version of this compared a flat average of the last 400
    transcripts against a fixed 150-character floor, and it cried wolf four
    times in one day. Nothing was wrong with the model: the run had simply
    reached the multiple-choice papers. A paper 1 question is "How many
    protons are in one nucleus?" and runs about 130 characters; a paper 5
    practical question runs 1,600. Whenever a chunk happened to be
    MCQ-heavy the flat average fell through the floor, and an alert that
    fires on healthy data is worse than no alert -- by the fourth one it is
    being skimmed past, which is precisely when the real one arrives.

    So each group is judged against its own peers: the same subject and the
    same paper number, from transcripts already in the store. Paper 1 of 0625
    is compared with the thousands of other 0625 paper 1 questions, not with
    a practical paper. A group with no peers yet falls back to the absolute
    floor, which is the old behaviour and the right default for a subject
    being transcribed for the first time.
    """
    if not recent_ids:
        return []

    placeholders = ",".join("?" * len(recent_ids))
    rows = conn.execute(
        f"""select s.code, p.paper_number, q.id, length(q.body_md)
              from bank_questions q
              join bank_papers p on p.id = q.paper_id
              join bank_subjects s on s.id = p.subject_id
             where q.id in ({placeholders})""",
        recent_ids,
    ).fetchall()

    groups: dict[tuple, list[int]] = {}
    for code, paper_number, _id, length in rows:
        groups.setdefault((code, paper_number), []).append(length)

    out = []
    for (code, paper_number), lengths in groups.items():
        if len(lengths) < MIN_SAMPLE:
            continue
        recent = sum(lengths) / len(lengths)

        # The peer baseline deliberately excludes the rows being judged --
        # otherwise a large enough collapse drags its own baseline down with
        # it and the ratio never trips.
        baseline = conn.execute(
            f"""select avg(length(q.body_md))
                  from bank_questions q
                  join bank_papers p on p.id = q.paper_id
                  join bank_subjects s on s.id = p.subject_id
                 where s.code = ? and p.paper_number = ? and q.model = ?
                   and coalesce(q.body_md,'') <> ''
                   and q.id not in ({placeholders})""",
            (code, paper_number, model, *recent_ids),
        ).fetchone()[0]

        label = f"{code} paper {paper_number}"
        if baseline is None:
            if recent < LEN_FLOOR:
                out.append({"label": f"{label} (no peers yet)", "recent": recent,
                            "baseline": LEN_FLOOR, "n": len(lengths)})
        elif recent < baseline * COLLAPSE_RATIO:
            out.append({"label": label, "recent": recent,
                        "baseline": baseline, "n": len(lengths)})

    out.sort(key=lambda g: g["recent"] / max(g["baseline"], 1))
    return out


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

        collapse = collapsing_groups(conn, model, [r[0] for r in rows])
        if collapse:
            worst = collapse[0]
            out.say("short", f"TRANSCRIPTS COLLAPSING: {worst['label']} averaging "
                             f"{worst['recent']:.0f} chars against {worst['baseline']:.0f} "
                             f"for the same papers ({worst['n']} transcripts)")
        else:
            out.clear("short")

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


def stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


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
