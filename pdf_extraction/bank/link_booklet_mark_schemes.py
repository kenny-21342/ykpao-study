#!/usr/bin/env python3
"""
Attach mark schemes to the IB question *booklets* they belong to.

    python3 -m pdf_extraction.bank.link_booklet_mark_schemes            # report only
    python3 -m pdf_extraction.bank.link_booklet_mark_schemes --apply

History, Geography, ESS and ITGS paper 1 ship as a `question_booklet` plus a
separate `text_booklet`/resource booklet. The question booklet is stored with
doc_type 'in', and `relink_mark_schemes` only pairs a mark scheme with
doc_type 'qp', so ~800 mark schemes never found their questions even though the
root numbers line up one to one.

A pair is linked only when
  * the question booklet and the mark scheme name the same level (HL/SL; a
    HLSL mark scheme fits either),
  * the mark scheme root is unique for that booklet question and vice versa,
  * the question has no mark scheme yet, and
  * the two paper totals do not contradict each other (both known and unequal
    is a different question, usually the HL booklet against the SL scheme).

Nothing calls a model. Every row it would change is reported; with --apply the
previous question_id values (all NULL) are written to backups/ first.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
from collections import Counter, defaultdict
from pathlib import Path

DB = Path(__file__).resolve().parent / "extract.db"
BACKUPS = Path(__file__).resolve().parents[2] / "backups"

CANDIDATES = """
    SELECT ms.id AS ms_id, q.id AS q_id, q.total_marks AS qm, ms.total_marks AS mm,
           mp.source_path AS ms_path, ip.source_path AS in_path, s.code AS code
    FROM bank_mark_schemes ms
    JOIN bank_papers mp ON mp.id = ms.paper_id
    JOIN bank_subjects s ON s.id = mp.subject_id
    JOIN bank_papers ip ON ip.subject_id = mp.subject_id
        AND ip.doc_type = 'in'
        AND ip.year = mp.year AND ip.session = mp.session
        AND ip.paper_number = mp.paper_number AND ip.variant = mp.variant
        AND IFNULL(ip.timezone, '') = IFNULL(mp.timezone, '')
        AND ip.source_path LIKE '%question%booklet%'
    JOIN bank_questions q ON q.paper_id = ip.id AND q.root_number = ms.root_number
    WHERE ms.question_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM bank_mark_schemes x WHERE x.question_id = q.id)
"""

_LEVEL = re.compile(r"_(HLSL|HL|SL)(?:_|\.|$)", re.IGNORECASE)


def level(path: str) -> str | None:
    match = _LEVEL.search(Path(path).stem + ".")
    return match.group(1).upper() if match else None


def compatible(ms_path: str, in_path: str) -> bool:
    ms_level, in_level = level(ms_path), level(in_path)
    if ms_level is None or in_level is None:
        return True
    return ms_level == in_level or "HLSL" in (ms_level, in_level)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    connection = sqlite3.connect(DB, timeout=60)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(CANDIDATES).fetchall()

    by_q: dict[int, list[sqlite3.Row]] = defaultdict(list)
    by_ms: dict[int, list[sqlite3.Row]] = defaultdict(list)
    skipped: Counter[str] = Counter()
    for row in rows:
        if not compatible(row["ms_path"], row["in_path"]):
            skipped["level differs"] += 1
            continue
        if row["qm"] and row["mm"] and row["qm"] != row["mm"]:
            skipped["totals contradict"] += 1
            continue
        by_q[row["q_id"]].append(row)
        by_ms[row["ms_id"]].append(row)

    links = []
    for q_id, group in by_q.items():
        if len(group) != 1 or len(by_ms[group[0]["ms_id"]]) != 1:
            skipped["ambiguous"] += 1
            continue
        links.append(group[0])

    per_subject = Counter(row["code"] for row in links)
    print(f"{len(links)} mark schemes can be attached to booklet questions")
    for code, count in per_subject.most_common():
        print(f"  {code:45s} {count}")
    for reason, count in skipped.items():
        print(f"  left alone: {count} ({reason})")
    if not args.apply:
        print("Report only. Re-run with --apply.")
        return

    BACKUPS.mkdir(exist_ok=True)
    path = BACKUPS / f"booklet-ms-links-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps([[row["ms_id"], row["q_id"]] for row in links]))
    with connection:
        for row in links:
            connection.execute(
                "UPDATE bank_mark_schemes SET question_id = ? WHERE id = ? AND question_id IS NULL",
                (row["q_id"], row["ms_id"]),
            )
    print(f"linked {len(links)}; ids recorded in {path}")


if __name__ == "__main__":
    main()
