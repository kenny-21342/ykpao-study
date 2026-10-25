"""Re-extract the mark schemes whose question headings were mis-selected.

    python3 -m pdf_extraction.bank.repair_ms_roots --audit report.json            # report only
    python3 -m pdf_extraction.bank.repair_ms_roots --audit report.json --apply

`audit_ms_roots` finds the mark schemes where the run-aware heading choice
covers more of the question paper than the old one. This re-runs the free
stages (spans, strips) on just those, and removes the rows the old pass stored
for roots that are no longer headings (the generic notes at the front of an IB
mark scheme were being filed as the answers to questions 1 and 2).

Every row it replaces or removes is first written, with its strips, to
`backups/ms-repair-<timestamp>.json`. Nothing here calls a model. Afterwards run
`relink_mark_schemes` to attach the new rows to their questions.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path

from . import store
from .run import run_corpus

DB = Path(__file__).with_name("extract.db")
ASSETS = Path(__file__).resolve().parent / "assets"


def improved(report: list[dict]) -> list[dict]:
    out = []
    for item in report:
        expected = set(item["expected"])
        if not expected or item.get("new") is None:
            continue
        if len(expected & set(item["new"])) > len(expected & set(item["old"])):
            out.append(item)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    todo = improved(json.loads(Path(args.audit).read_text()))
    gain = sum(len(set(i["expected"]) & set(i["new"])) - len(set(i["expected"]) & set(i["old"])) for i in todo)
    print(f"{len(todo)} mark schemes would gain {gain} covered questions")
    if not args.apply:
        print("Report only. Re-run with --apply.")
        return

    connection = store.connect(DB)
    connection.execute("PRAGMA busy_timeout = 30000")
    backup = {"made": time.strftime("%Y-%m-%d %H:%M:%S"), "papers": []}
    for item in todo:
        rows = connection.execute("SELECT * FROM bank_mark_schemes WHERE paper_id = ?", (item["id"],)).fetchall()
        entry = {"paper_id": item["id"], "path": item["path"], "rows": []}
        for row in rows:
            strips = connection.execute(
                "SELECT * FROM bank_mark_scheme_strips WHERE mark_scheme_id = ?", (row["id"],)).fetchall()
            entry["rows"].append({"row": dict(row), "strips": [dict(s) for s in strips]})
        backup["papers"].append(entry)
    Path("backups").mkdir(exist_ok=True)
    backup_path = Path("backups") / f"ms-repair-{time.strftime('%Y%m%d-%H%M%S')}.json"
    backup_path.write_text(json.dumps(backup))
    print(f"backup: {backup_path}")

    stats = run_corpus([i["path"] for i in todo], db_path=DB, asset_root=ASSETS,
                       use_model=False, do_tagging=False, concurrency=1)
    print(f"re-extracted: {stats.assets} assets, {len(stats.errors)} errors")

    removed = 0
    for item in todo:
        keep = set(item["new"])
        for (row_id, root) in connection.execute(
                "SELECT id, root_number FROM bank_mark_schemes WHERE paper_id = ?", (item["id"],)).fetchall():
            if root not in keep:
                connection.execute("DELETE FROM bank_mark_scheme_strips WHERE mark_scheme_id = ?", (row_id,))
                connection.execute("DELETE FROM bank_mark_schemes WHERE id = ?", (row_id,))
                removed += 1
    connection.commit()
    print(f"removed {removed} stale rows. Now run: python3 -m pdf_extraction.bank.relink_mark_schemes")


if __name__ == "__main__":
    main()
