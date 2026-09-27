"""
Turn the assessment-overview text into figures.

Why this is deterministic and not a model call
----------------------------------------------
The plan for this step assumed a model, because the overview is a table that
PyMuPDF flattens into a column of lines and the column count differs between
syllabuses. That turned out to be the wrong read of the problem. There is one
invariant that holds across every layout Cambridge uses: **each paper states
exactly one mark total.** Anchoring on those, and taking the duration from
before each anchor and the weighting from around it, parses 22 of 23
syllabuses with no model, no cost and no chance of an invented figure.

The layouts it has to survive, each found by running it rather than predicted:

  1. `Paper 1: Multiple Choice (Core)` -- name in the heading, then blocks of
     duration / marks / weighting.        (IGCSE sciences)
  2. Bare `Paper 1`, `Paper 2` headings in a run, then one block per paper with
     the name as the block's first line.  (A Level Mathematics)
  3. `Paper 1 Theory Fundamentals` -- name after the number with no colon. This
     one is why headings must be told apart from prose: 9618's own overview
     contains the line "Paper 1 will assess sections 1 to 8 of the".
  4. Weighting *before* the mark total rather than after. (0450, 0411)
  5. Components with no duration at all -- coursework is not timed, so a null
     here is the truth and not a parse failure.

A figure this cannot find is left null. Nothing is guessed: `lib/paper-
templates.ts` measures the corpus and is the fallback for every field, so a
null costs a correction and not a paper.

Usage:
    python3 scripts/parse_syllabus_formats.py          # all, writes formats.json
    python3 scripts/parse_syllabus_formats.py 0625     # one, prints it
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ops" / "syllabus"
TEXT = OUT / "text"
MANIFEST = OUT / "sources.json"
FORMATS = OUT / "formats.json"

HEAD = re.compile(
    r'^(?:Paper|Component)s?\s+([0-9]+[A-Za-z]?)'
    r'(?:\s*[:–-]\s*(.+?)|\s+([A-Z][^.]{0,60}?))?\s*$'
)
MARKS = re.compile(r'^(\d+)\s*marks\b', re.I)
# The decimal is not optional to match: 9702 states "38.5% of the A Level",
# and a bare \d+ regex reads that as 5%.
PCT = re.compile(r'(\d+(?:\.\d+)?)\s*%')
# "1 hour 15 minutes", "c.1 hour 15 minutes", "Approx. 10-12 minutes".
DUR = re.compile(
    r'^(?:c\.?|approx\.?|about|approximately)?\s*'
    r'(?:(\d+)(?:\s*[–-]\s*\d+)?\s*hours?)?\s*(?:and\s*)?'
    r'(?:(\d+)(?:\s*[–-]\s*(\d+))?\s*minutes?)?\s*$',
    re.I,
)
# Never a paper name. Kept narrow on purpose: an earlier version skipped
# anything starting "Externally", which threw away Art & Design's real
# component name, "Externally Set Assignment".
HARD_SKIP = re.compile(
    r'^(?:(?:Externally|Internally)\s+(?:assessed|moderated)|Candidates\b|OR|and:?|'
    r'All candidates\b|[•–—*\-]\s*)', re.I,
)
# A name only if nothing better is in the block -- 0411's Component 1 really is
# called "Written examination".
SOFT_SKIP = re.compile(r'^Written\s+(?:examination|paper)\b', re.I)
# Syllabuses retired before ~2022 tabulate the weighting under a "Weighting
# (%)" column head and leave the sign off the cells, so the figure arrives as a
# bare "50". Only trusted when that column head is present -- a loose integer
# match would read a mark total or a section number as a weighting.
BARE_PCT = re.compile(r'^(\d{1,3})$')
# A heading too long for the column wraps onto the next line: 9618's "Paper 2
# Fundamental Problem-solving and / Programming Skills" and 9231's "Paper 4
# Further Probability & / Statistics". Recognised by the name ending on a word
# that cannot end a title, which keeps it from swallowing the block name in the
# layout where the headings are bare and the names follow them.
CONTINUES = re.compile(r'(?:\b(?:and|or|of|the|in|to|for|with|a|an)|&|,)$', re.I)
PCT_COLUMN = re.compile(r'Weighting\s*\(%\)', re.I)


def minutes(line: str) -> int | None:
    m = DUR.match(line.strip())
    if not m or not (m.group(1) or m.group(2)):
        return None
    # A range ("Approx. 10-12 minutes") is reported at its upper bound: that is
    # the time a student has to plan for.
    mins = int(m.group(3) or m.group(2) or 0)
    return int(m.group(1) or 0) * 60 + mins


def groups_of(lines: list[str]) -> list[tuple[list[tuple[str, str | None]], list[str]]]:
    """
    Split into (headings, body) groups.

    Headings run consecutively and their blocks follow in the same order, so a
    heading appearing *after* a body has started closes the group. That single
    rule covers both the column-major layout (all headings, then all blocks)
    and the row-major one (heading, block, heading, block).
    """
    out: list[tuple[list[tuple[str, str | None]], list[str]]] = []
    heads: list[tuple[str, str | None]] = []
    body: list[str] = []
    for line in lines:
        h = HEAD.match(line)
        if h:
            if body:
                out.append((heads, body))
                heads, body = [], []
            heads.append((h.group(1), h.group(2) or h.group(3)))
        elif heads and not body and heads[-1][1] and CONTINUES.search(heads[-1][1]):
            heads[-1] = (heads[-1][0], f"{heads[-1][1]} {line}".strip())
        elif heads:
            body.append(line)
    if heads:
        out.append((heads, body))
    return out


def plausible(line: str) -> bool:
    return bool(line) and minutes(line) is None and not PCT.search(line) \
        and not MARKS.match(line) and not HARD_SKIP.match(line)


def name_near(body: list[str], dur: int | None, lo: int, hi: int) -> str | None:
    """
    The paper's name, which sits against its duration line.

    Both layouts put it adjacent to the duration, on opposite sides: the A
    Level overviews read "A Level Structured Questions / 2 hours / 100 marks",
    while 0450 and 0411 read "1 hour 30 minutes / Short Answer and Data
    Response / 50% / 80 marks". So look immediately before, then immediately
    after. Anchoring on the duration rather than on the mark total is what
    keeps a paper from being named after the *previous* paper's description --
    the mark anchors sit mid-block, so a window between them straddles two
    papers.
    """
    if dur is not None:
        # Step over empty cells: the flattened table leaves a tab-only line
        # between 9702 Paper 5's name and its duration.
        def toward(step: int) -> tuple[int, str] | None:
            i = dur + step
            while lo <= i < hi and not body[i]:
                i += step
            return (i, body[i].strip()) if lo <= i < hi and plausible(body[i]) else None

        before, after = toward(-1), toward(1)
        if before:
            # 9231 wraps the name *around* its duration: "Further Probability &
            # / 1 hour 30 minutes / Statistics".
            if CONTINUES.search(before[1]) and after:
                return f"{before[1]} {after[1]}".strip()
            return before[1]
        if after:
            return after[1]
    # Untimed components (coursework) have no duration to anchor to.
    soft = None
    for line in body[lo:hi]:
        if not plausible(line):
            continue
        if SOFT_SKIP.match(line):
            soft = soft or line.strip()
            continue
        return line.strip()
    return soft


def parse(code: str) -> list[dict]:
    lines = [l.strip() for l in (TEXT / f"{code}.txt").read_text().split("\n")]
    papers: list[dict] = []
    seen: set[tuple[str, int]] = set()
    tabulated = any(PCT_COLUMN.search(l) for l in lines)
    for heads, body in groups_of(lines):
        # Every paper states exactly one mark total, so the anchors count the
        # papers; the durations then say where each block actually begins.
        anchors = [i for i, l in enumerate(body) if MARKS.match(l)]
        durs = []
        for i, at in enumerate(anchors):
            lo = anchors[i - 1] + 1 if i else 0
            hi = anchors[i + 1] if i + 1 < len(anchors) else len(body)
            found = next((j for j in range(at - 1, lo - 1, -1)
                          if minutes(body[j]) is not None), None)
            if found is None:
                # The older layout states the duration *after* the mark total
                # ("75 marks / Externally assessed / 1 hour 30 minutes"), so
                # look forward when nothing precedes. Second choice only: where
                # a duration comes first, it is the block's own.
                found = next((j for j in range(at + 1, hi)
                              if minutes(body[j]) is not None), None)
            durs.append(found)

        for i, (number, name) in enumerate(heads):
            if i >= len(anchors):
                continue  # an option branch with no figures of its own
            at, dur = anchors[i], durs[i]
            lo = anchors[i - 1] + 1 if i else 0
            hi = anchors[i + 1] if i + 1 < len(anchors) else len(body)
            marks = int(MARKS.match(body[at]).group(1))
            if (number, marks) in seen:
                continue  # "either Paper 3 + 4 or Paper 3 + 5" repeats Paper 3
            seen.add((number, marks))

            # The weighting belongs to whichever block the duration opens, so
            # the search runs to the *next* paper's duration rather than to the
            # next mark total. 9702 states its weighting three lines after the
            # mark total, well past where a marks-delimited window would stop.
            nxt = next((d for d in durs[i + 1:] if d is not None), None)
            w_lo = dur if dur is not None else lo
            w_hi = nxt if nxt is not None else hi
            window = body[min(w_lo, at):max(w_hi, at + 1)]
            weighting = next(
                (round(float(p.group(1))) for l in window
                 if not MARKS.match(l) and (p := PCT.search(l))), None
            )
            if weighting is None and tabulated:
                weighting = next(
                    (int(p.group(1)) for l in window if (p := BARE_PCT.match(l))), None
                )
            papers.append({
                "paperNumber": number,
                "name": name or name_near(body, dur, lo, hi),
                "minutes": minutes(body[dur]) if dur is not None else None,
                "marks": marks,
                "weightingPercent": weighting,
            })
    return papers


def main() -> int:
    manifest = json.loads(MANIFEST.read_text())
    wanted = sys.argv[1:] or sorted(p.stem for p in TEXT.glob("*.txt"))
    formats, incomplete = {}, []

    for code in wanted:
        papers = parse(code)
        if not papers:
            print(f"  {code}: no papers parsed")
            incomplete.append(code)
            continue
        src = manifest.get(code, {})
        formats[code] = {
            "years": src.get("years"),
            "url": src.get("url"),
            "corpusOverlapYears": src.get("overlap"),
            "papers": papers,
        }
        gaps = [f"P{p['paperNumber']}" for p in papers
                if not p["name"] or p["minutes"] is None or p["weightingPercent"] is None]
        if gaps:
            incomplete.append(code)
        print(f"  {code}: {len(papers)} papers" + (f"  partial: {' '.join(gaps)}" if gaps else ""))
        for p in papers:
            print(f"      P{p['paperNumber']:<3} {str(p['minutes'] or '-'):>4}min "
                  f"{p['marks']:>3}mk {str(p['weightingPercent'] or '-'):>3}%  {p['name']}")

    if len(sys.argv) == 1:
        FORMATS.write_text(json.dumps(formats, indent=2, sort_keys=True) + "\n")
        print(f"\nwrote {FORMATS.relative_to(ROOT)}: {len(formats)} syllabuses")
    if incomplete:
        print(f"partial or empty: {' '.join(incomplete)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
