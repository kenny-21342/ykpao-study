"""Rewrite bare `asset:figN` citations as `![](asset:figN)`.

WHY — some models cite a figure as bare text rather than the markdown image
rule 4 of the transcription prompt asks for. Qwen3-VL never did; Sonnet does it
every time. The difference is not cosmetic: everything downstream matches the
markdown form -- the unknown-id strip in transcribe.py, `_ASSET_CITATION` in
qa.py, and the renderer -- so a bare citation shows the student the literal
text `asset:fig1` where a diagram belongs, and leaves the figure QA check
seeing no citations at all.

`_post_process_transcription` now normalises this at write time. This repairs
the rows written before it did. Safe to re-run: the substitution is idempotent,
and rows already in the markdown form are left alone.

    python3 -m pdf_extraction.bank.repair_asset_citations           # report
    python3 -m pdf_extraction.bank.repair_asset_citations --apply   # write
"""
from __future__ import annotations

import argparse
import re
import sqlite3
from pathlib import Path

from .transcribe import normalize_asset_citations

DB = Path(__file__).resolve().parent / "extract.db"

# One implementation, shared with the write path, so a row repaired here and a
# row written later cannot disagree about what a citation looks like.
normalize = normalize_asset_citations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the changes")
    args = parser.parse_args()

    connection = sqlite3.connect(DB)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        "SELECT id, body_md FROM bank_questions "
        "WHERE body_md LIKE '%asset:%' AND body_md NOT LIKE '%![](asset:%'"
    ).fetchall()

    changed = [(r["id"], normalize(r["body_md"])) for r in rows]
    changed = [(qid, body) for qid, body in changed if body]

    print(f"{len(changed)} question(s) carry a bare citation")
    for qid, body in changed[:3]:
        line = next((l for l in body.splitlines() if "![](asset:" in l), "")
        print(f"  id={qid}: {line.strip()[:70]}")

    if not args.apply:
        print("\ndry run; pass --apply to write")
        connection.close()
        return 0

    with connection:
        connection.executemany(
            "UPDATE bank_questions SET body_md=? WHERE id=?",
            [(body, qid) for qid, body in changed],
        )
    print(f"\nupdated {len(changed)} row(s)")

    left = connection.execute(
        "SELECT COUNT(*) FROM bank_questions "
        "WHERE body_md LIKE '%asset:%' AND body_md NOT LIKE '%![](asset:%'"
    ).fetchone()[0]
    print(f"bare citations remaining: {left}")
    connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
