"""Turn the IB's coordinator grade-boundary PDFs into the admin upload CSV.

    python3 scripts/parse_ib_grade_boundaries.py --dir "<folder of PDFs>"
    python3 scripts/parse_ib_grade_boundaries.py --dir ... --out ib-boundaries.csv

The IB does not publish thresholds the way CAIE does; a school receives the
"Grade boundaries for Diploma programme coordinators" document each session.
These PDFs are the only real source for an IB predicted grade -- without them
`gradeFromBoundaries` has nothing to match and falls back to a labelled
estimate. Uploaded rows therefore carry source `school`, not `published`.

Each subject block looks like this once the text layer is read:

    Subject: BIOLOGY / Level: HL / Subject option: BIOLOGY / Timezone: 3
    PAPER ONE      Grade From To  1 0 4 ... 7 26 40
    ...
    FINAL          Grade From To  1 0 12 ... 7 75 100

Only FINAL is taken. Component boundaries are per paper and per timezone, and a
generated mock is not any real paper; the overall subject boundary out of 100 is
what a mock percentage can honestly be matched against. `gradeFromBoundaries`
compares proportionally (marks/totalMarks against minMark/totalMarks), so
`totalMarks = 100` makes the FINAL row drop straight in.

Two places where the source data is richer than the schema, both resolved by
choosing rather than averaging -- averaging two real boundaries produces a
number the IB never issued:

* **Timezone.** Preferred order is 0 (subjects with no timezone variant), then
  `--timezone` (default 3, Asia-Pacific, where the school sits), then lowest.
* **Subject option.** History HL is examined by region and each region gets its
  own boundary. The option matching the plain subject name wins, else the first
  alphabetically; disagreements between options are reported, not hidden.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

import fitz

#: Where a subject is examined by region and the plain name never appears, the
#: region the school actually sits. History HL publishes four -- Africa and the
#: Middle East, the Americas, Asia and Oceania, Europe -- and they differ by a
#: mark or two, so alphabetical order is a coin toss rather than an answer.
#: YK Pao sits Asia and Oceania.
PREFERRED_OPTIONS = {
    ("ib-history", "HL"): "HISTORY ASIA AND OCEANIA",
}

#: The names the IB prints, mapped to the `ib-` slugs in COURSE_CATALOG
#: (lib/course-catalog-data.ts). The PDFs abbreviate heavily and inconsistently
#: across years, so this is an explicit table rather than a slugify() -- a
#: near-miss here silently drops a whole subject.
SUBJECTS = {
    "BIOLOGY": "biology",
    "CHEMISTRY": "chemistry",
    "PHYSICS": "physics",
    "SPORTS EX SCI": "sports-exercise-and-health-science",
    "ENV. AND SOC.": "environmental-systems-and-societies",
    "ENVIRONMENTAL SYSTEMS AND SOCIETIES": "environmental-systems-and-societies",
    "MATH ANALYSIS": "mathematics-analysis-and-approaches",
    "MATH APPS": "mathematics-applications-and-interpretation",
    "COMPUTER SC.": "computer-science",
    "COMPUTER SCIENCE": "computer-science",
    "ECONOMICS": "economics",
    "BUS MAN": "business-management",
    "BUSINESS MAN.": "business-management",
    "BUSINESS MANAGEMENT": "business-management",
    "BUS. MANAGEMENT": "business-management",
    "GEOGRAPHY": "geography",
    "HISTORY": "history",
    "PSYCHOLOGY": "psychology",
    "PHILOSOPHY": "philosophy",
    "ENGLISH A LIT": "english-a-literature",
    "ENGLISH A LAL": "english-a-language-and-literature",
    "CHINESE A LAL": "chinese-a-language-and-literature",
    "MUSIC": "music",
}

HEADER = re.compile(
    r"Subject:\s*(?P<subject>.+?)\s*\n"
    r"\s*Level:\s*(?P<level>HL|SL)\s*\n"
    r"(?:\s*Subject option:\s*(?P<option>.+?)\s*\n)?"
    r"\s*Timezone:\s*(?P<tz>\d+)",
    re.I,
)

#: FINAL, then the column headers, then seven `grade from to` triples one per
#: line. The word also appears in prose, so the header rows are part of the match.
FINAL = re.compile(
    r"\bFINAL\b\s*\n\s*Grade\s*\n\s*From\s*\n\s*To\s*\n((?:\s*\d+\s*\n){20}\s*\d+)",
    re.I,
)

SESSION = re.compile(r"\b(May|November)\b\s*(\d{4})", re.I)


def session_of(path: Path) -> tuple[str, int] | None:
    found = SESSION.search(path.stem)
    return (found.group(1).capitalize(), int(found.group(2))) if found else None


def read_text(path: Path) -> str:
    document = fitz.open(path)
    try:
        return "\n".join(document[i].get_text() for i in range(document.page_count))
    finally:
        document.close()


def parse_pdf(path: Path) -> tuple[list[dict], int]:
    """Every FINAL boundary in one session's document, plus blocks skipped."""
    meta = session_of(path)
    if meta is None:
        return [], 0
    return parse_text(read_text(path), *meta)


def parse_text(text: str, session: str, year: int) -> tuple[list[dict], int]:
    """The parsing proper, over already-extracted text. Tested directly."""
    # The headers are typed with non-breaking spaces; normalising here lets every
    # pattern below be written with ordinary whitespace.
    text = text.replace("\xa0", " ")
    headers = list(HEADER.finditer(text))
    rows: list[dict] = []
    untaught = 0

    for index, head in enumerate(headers):
        # A block ends where the next one starts, so FINAL can never be taken
        # from a neighbouring subject.
        end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
        # 2018-2020 documents render each digit as its own glyph run, so a
        # boundary of 15 arrives as "1 5". Numbers sit one per line in these
        # tables, so closing gaps between digits inside the block is safe.
        block = re.sub(r"(?<=\d) (?=\d)", "", text[head.start():end])

        name = head.group("subject").strip().upper()
        code = SUBJECTS.get(name)
        if code is None:
            untaught += 1
            continue

        final = FINAL.search(block)
        if final is None:
            continue
        numbers = [int(n) for n in re.findall(r"\d+", final.group(1))]
        if len(numbers) != 21:
            continue

        option = (head.group("option") or name).strip().upper()
        for i in range(0, 21, 3):
            grade, low, high = numbers[i], numbers[i + 1], numbers[i + 2]
            if grade != i // 3 + 1:
                rows = rows[: len(rows) - i // 3]  # malformed block, drop it whole
                break
            rows.append({
                "board": "IB",
                "subjectCode": f"ib-{code}",
                "level": head.group("level").upper(),
                "year": year,
                "session": session,
                "grade": str(grade),
                "minMark": low,
                "totalMarks": 100,
                "_tz": int(head.group("tz")),
                "_option": option,
                "_name": name,
                "_top": high,
            })
    return rows, untaught


def pick_timezone(rows: list[dict], preferred: int) -> list[dict]:
    """One timezone per subject-level-session. 0, else preferred, else lowest."""
    available: dict[tuple, set[int]] = defaultdict(set)
    for row in rows:
        available[(row["subjectCode"], row["level"], row["year"], row["session"])].add(row["_tz"])

    chosen = {}
    for key, zones in available.items():
        if 0 in zones:
            chosen[key] = 0
        elif preferred in zones:
            chosen[key] = preferred
        else:
            chosen[key] = min(zones)
    return [r for r in rows
            if chosen[(r["subjectCode"], r["level"], r["year"], r["session"])] == r["_tz"]]


def pick_option(rows: list[dict]) -> tuple[list[dict], list[str]]:
    """One subject option per subject-level-session, with disagreements reported."""
    grouped: dict[tuple, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        key = (row["subjectCode"], row["level"], row["year"], row["session"])
        grouped[key][row["_option"]].append(row)

    kept: list[dict] = []
    notes: list[str] = []
    for key, options in grouped.items():
        if len(options) > 1:
            spread = {opt: [r["minMark"] for r in sorted(rs, key=lambda r: r["grade"])]
                      for opt, rs in options.items()}
            if len({tuple(v) for v in spread.values()}) > 1:
                sevens = {opt: marks[-1] for opt, marks in spread.items()}
                notes.append(
                    f"{key[0]} {key[1]} {key[3]} {key[2]}: options differ, "
                    f"grade 7 from " + ", ".join(f"{o} at {m}" for o, m in sorted(sevens.items()))
                )
        # A region the school actually sits wins outright. Otherwise the option
        # printed under the subject's own name (History SL, plain Economics) is
        # the ungrouped one; regional and pilot variants are not.
        preferred = PREFERRED_OPTIONS.get((key[0], key[1]))
        choice = (
            preferred if preferred in options
            else next((o for o in options if o in SUBJECTS), None) or sorted(options)[0]
        )
        kept.extend(options[choice])
    return kept, notes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", required=True)
    parser.add_argument("--out")
    parser.add_argument("--since", type=int, default=0, help="ignore sessions before this year")
    parser.add_argument("--timezone", type=int, default=3,
                        help="timezone to prefer when a subject has variants (default 3, Asia-Pacific)")
    args = parser.parse_args()

    folder = Path(args.dir).expanduser()
    pdfs = sorted(folder.glob("*.pdf"))
    if not pdfs:
        print(f"no PDFs in {folder}")
        return 1

    everything: list[dict] = []
    for pdf in pdfs:
        found, untaught = parse_pdf(pdf)
        meta = session_of(pdf)
        label = f"{meta[0]} {meta[1]}" if meta else pdf.stem
        subjects = len({(r["subjectCode"], r["level"]) for r in found})
        print(f"  {label:<16} {subjects:>3} subject-levels, {len(found):>4} rows"
              f"   ({untaught} blocks for subjects the school does not teach)")
        everything.extend(found)

    if args.since:
        everything = [r for r in everything if r["year"] >= args.since]

    kept = pick_timezone(everything, args.timezone)
    kept, notes = pick_option(kept)

    seen: set[tuple] = set()
    final_rows = []
    for row in kept:
        key = (row["subjectCode"], row["level"], row["year"], row["session"], row["grade"])
        if key in seen:
            continue
        seen.add(key)
        final_rows.append({k: v for k, v in row.items() if not k.startswith("_")})

    by_subject: dict[str, set] = defaultdict(set)
    for row in final_rows:
        by_subject[row["subjectCode"]].add((row["year"], row["session"], row["level"]))

    print(f"\n{len(final_rows):,} rows across {len(by_subject)} subjects")
    for code in sorted(by_subject):
        sessions = by_subject[code]
        years = sorted({y for y, _, _ in sessions})
        print(f"  {code:<48} {len(sessions):>3} session-levels  {years[0]}-{years[-1]}")

    missing = sorted(set(SUBJECTS.values()) - {c.removeprefix("ib-") for c in by_subject})
    if missing:
        print(f"\nno boundaries found for {len(missing)}: {', '.join(missing)}")
    if notes:
        print(f"\n{len(notes)} subject-options disagree; the plain option was taken:")
        for note in notes[:10]:
            print(f"  {note}")

    if args.out:
        columns = ["board", "subjectCode", "level", "year", "session", "grade", "minMark", "totalMarks"]
        with open(args.out, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            writer.writerows(sorted(final_rows, key=lambda r: (
                r["subjectCode"], r["level"], r["year"], r["session"], int(r["grade"]))))
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
