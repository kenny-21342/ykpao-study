"""
Read the official mark total and duration off every IB paper we hold.

Why this and not a syllabus
---------------------------
`scripts/fetch_syllabus_formats.py` gets Cambridge's figures from the
syllabus, because Cambridge publishes one per subject and it covers a stated
range of years. The IB does not work that way. Its assessment outline lives in
the subject guide, which is behind MyIB and not public; the public subject
briefs describe only the *current* structure, and our corpus is 2016-2025 --
so a brief fetched today would describe the 2025 Biology redesign, whose paper
structure none of the papers we hold were ever sat under. That is the same
trap the Cambridge fetcher had to solve by picking a syllabus that overlaps the
corpus, and for the IB there is no archived brief to pick.

The papers themselves are a better source than either. Every IB cover page
states both figures outright:

    The maximum mark for this examination paper is [40 marks].
    1 hour

So this reads them. The result is not an approximation of the official figure,
it *is* the official figure, taken per paper and per year, which means it
cannot drift out of step with the corpus -- the corpus is where it comes from.

Aggregated as a median per (subject, level, paper number), with the spread
reported: a subject whose covers disagree is telling us the structure changed
mid-corpus, and that is worth knowing rather than averaging away.

Usage:
    python3 scripts/read_ib_paper_covers.py           # all, writes ib-formats.json
    python3 scripts/read_ib_paper_covers.py physics   # one subject, prints it
"""
from __future__ import annotations

import json
import re
import sqlite3
import statistics
import sys
from collections import defaultdict
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover
    sys.exit("PyMuPDF is required: pip install pymupdf")

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "pdf_extraction" / "bank" / "extract.db"
OUT = ROOT / "ops" / "syllabus" / "ib-formats.json"

# "is [40 marks]" on most, "is 40 marks" on a few, and the older covers put the
# total in the instructions rather than in a box.
MAX_MARK = re.compile(r'maximum mark for this (?:examination )?paper is\s*\[?\s*(\d{1,3})\s*marks?\s*\]?', re.I)
# "1 hour", "45 minutes", "2 hours 15 minutes", "1 hour 30 minutes".
DURATION = re.compile(r'(?:(\d+)\s*hours?)?\s*(?:(\d+)\s*minutes?)?', re.I)
DUR_LINE = re.compile(r'^\s*(?:(\d+)\s*hours?)\s*(?:(\d+)\s*minutes?)?\s*$|^\s*(\d+)\s*minutes?\s*$', re.I)


def cover_figures(path: Path) -> tuple[int | None, int | None]:
    """
    The paper's stated maximum mark and duration.

    Three pages, not one: papers from about 2023 onward open with a copyright
    notice, so the cover is the second or third page.
    """
    try:
        doc = fitz.open(path)
    except Exception:
        return None, None
    with doc:
        text = "\n".join(doc[i].get_text() for i in range(min(3, doc.page_count)))

    flat = re.sub(r'\s+', ' ', text)
    mark = int(m.group(1)) if (m := MAX_MARK.search(flat)) else None

    # The duration is its own line on the cover -- never prose -- so matching
    # line by line keeps "1 hour" out of a sentence that merely mentions one.
    minutes = None
    for line in text.split("\n"):
        if (d := DUR_LINE.match(line.strip())):
            hours, mins, only_mins = d.group(1), d.group(2), d.group(3)
            minutes = int(only_mins) if only_mins else int(hours or 0) * 60 + int(mins or 0)
            break
    return mark, minutes


def main() -> int:
    wanted = set(sys.argv[1:])
    db = sqlite3.connect(f"file:{STORE}?mode=ro", uri=True)
    rows = db.execute(
        """SELECT s.code, s.level, p.paper_number, p.year, p.source_path
           FROM bank_papers p JOIN bank_subjects s ON s.id = p.subject_id
           WHERE p.board = 'IB' AND p.doc_type = 'qp'
           ORDER BY s.code, s.level, p.paper_number, p.year"""
    ).fetchall()

    seen: dict[tuple[str, str, int], list[tuple[int | None, int | None, int]]] = defaultdict(list)
    missing = unreadable = 0
    for code, level, pn, year, path in rows:
        if wanted and code not in wanted:
            continue
        p = Path(path)
        if not p.exists():
            missing += 1
            continue
        mark, minutes = cover_figures(p)
        if mark is None and minutes is None:
            unreadable += 1
        seen[(code, level or "", pn)].append((mark, minutes, year))

    formats: dict[str, dict] = {}
    for (code, level, pn), obs in sorted(seen.items()):
        marks = [m for m, _, _ in obs if m]
        mins = [d for _, d, _ in obs if d]
        if not marks:
            continue
        entry = formats.setdefault(code, {"source": "IB paper cover pages", "papers": []})

        # The headline figure is what the *newest* papers state, not the median.
        # The IB restructured most subjects for first examinations between 2021
        # and 2025, and our corpus straddles the change: English A HL Paper 1
        # went from two guided analyses to one, so its covers read 40 marks
        # before and 20 after. A median there describes a paper nobody will
        # sit again. The median is kept alongside, and the spread is reported
        # rather than smoothed, because a caller may want to say that the older
        # papers in the pool were a different shape.
        newest = max(y for _, _, y in obs)
        recent = [m for m, _, y in obs if m and y >= newest - 1]
        recent_mins = [d for _, d, y in obs if d and y >= newest - 1]
        entry["papers"].append({
            "level": level or None,
            "paperNumber": str(pn),
            "name": f"Paper {pn}",
            "minutes": int(statistics.median(recent_mins or mins)) if (recent_mins or mins) else None,
            "marks": int(statistics.mode(recent)) if recent else int(statistics.median(marks)),
            "marksMedianAllYears": int(statistics.median(marks)),
            "weightingPercent": None,  # stated only in the guide, which is not public
            "papersRead": len(obs),
            "markSpread": [min(marks), max(marks)],
            "years": [min(y for _, _, y in obs), max(y for _, _, y in obs)],
        })

    groups = sum(len(v["papers"]) for v in formats.values())
    if wanted:
        for code, v in formats.items():
            for p in v["papers"]:
                print(f"  {code} {p['level'] or '-':<5} P{p['paperNumber']:<3} "
                      f"{str(p['minutes'] or '-'):>4}min {p['marks']:>3}mk  "
                      f"spread {p['markSpread']}  {p['papersRead']} papers  {p['years']}")
    else:
        OUT.write_text(json.dumps(formats, indent=2, sort_keys=True) + "\n")
        print(f"wrote {OUT.relative_to(ROOT)}: {len(formats)} subjects, {groups} paper groups")
    print(f"papers read: {sum(len(v) for v in seen.values())}, "
          f"source PDF missing: {missing}, no figures on the cover: {unreadable}")
    spread = [(c, p) for c, v in formats.items() for p in v["papers"]
              if p["markSpread"][0] != p["markSpread"][1]]
    print(f"paper groups whose covers disagree on the total: {len(spread)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
