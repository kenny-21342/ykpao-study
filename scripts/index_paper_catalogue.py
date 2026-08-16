#!/usr/bin/env python3
"""Walk the past paper PDF trees and emit a catalogue manifest.

    python3 scripts/index_paper_catalogue.py [--out data/paper-catalogue.json]

Reads every PDF under ``pdf_extraction/`` (Cambridge under ``my_raw_pdfs/``, IB
under ``IB PAST PAPERS - YEAR/``), resolves each to its place in the browse
hierarchy, and writes a JSON manifest for ``scripts/load-paper-catalogue.ts``.

Unparseable or corrupt files are reported to stderr and skipped: with ~13k files
a handful of stragglers must not block the rest of the corpus.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PDF_ROOT = REPO_ROOT / "pdf_extraction"
sys.path.insert(0, str(PDF_ROOT))

from catalogue.parser import CatalogueEntry, ParseError, parse_path  # noqa: E402

# Directories that hold papers. Everything else under pdf_extraction/ (work
# dirs, extracted images, caches) is ignored.
PAPER_TREES = ("my_raw_pdfs", "IB PAST PAPERS - YEAR")

def read_pdf_stats(path: Path) -> tuple[int | None, int]:
    """Return (page_count, size_bytes). page_count is None if unreadable."""
    size = path.stat().st_size
    try:
        import fitz  # PyMuPDF

        with fitz.open(path) as doc:
            return doc.page_count, size
    except Exception:
        return None, size


def collect(pdf_root: Path, with_stats: bool = True) -> tuple[list[dict], list[str]]:
    entries: list[dict] = []
    failures: list[str] = []
    seen: dict[str, str] = {}

    for tree in PAPER_TREES:
        base = pdf_root / tree
        if not base.is_dir():
            failures.append(f"missing paper tree: {tree}")
            continue

        for path in sorted(base.rglob("*.pdf")):
            if not path.is_file():
                continue
            try:
                entry: CatalogueEntry = parse_path(path, pdf_root)
            except ParseError as error:
                failures.append(str(error))
                continue

            record = entry.to_dict()

            # filepath is both the loader's upsert key and how the app locates
            # the file on disk, so it is stored exactly as found -- including the
            # one oddly named 9618 directory. Subject identity comes from the
            # code in the filename, so the directory name never matters.
            if record["filepath"] in seen:
                failures.append(f"duplicate filepath: {record['filepath']}")
                continue
            seen[record["filepath"]] = str(path)

            if with_stats:
                page_count, size_bytes = read_pdf_stats(path)
                if page_count is None:
                    failures.append(f"unreadable PDF, skipped: {path}")
                    continue
                record["page_count"] = page_count
                record["size_bytes"] = size_bytes
            else:
                record["page_count"] = None
                record["size_bytes"] = None

            entries.append(record)

    return entries, failures


def derive_subjects(entries: list[dict]) -> list[dict]:
    subjects: dict[str, dict] = {}
    for entry in entries:
        code = entry["subject_code"]
        if code not in subjects:
            subjects[code] = {
                "code": code,
                "name": entry["subject_name"],
                "board": entry["board"],
                "qualification": entry["qualification"],
            }
    return sorted(subjects.values(), key=lambda s: (s["board"], s["code"]))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=REPO_ROOT / "data" / "paper-catalogue.json",
        help="manifest destination (default: data/paper-catalogue.json)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report counts without writing the manifest",
    )
    parser.add_argument(
        "--skip-stats",
        action="store_true",
        help="skip page counts (faster; leaves pageCount null)",
    )
    args = parser.parse_args()

    entries, failures = collect(PDF_ROOT, with_stats=not args.skip_stats)
    subjects = derive_subjects(entries)

    by_board = Counter(e["board"] for e in entries)
    by_doc_type = Counter(e["doc_type"] for e in entries)
    by_qualification = Counter(e["qualification"] for e in entries)

    print(f"parsed   {len(entries)} papers", file=sys.stderr)
    print(f"subjects {len(subjects)}", file=sys.stderr)
    print(f"board    {dict(by_board)}", file=sys.stderr)
    print(f"level    {dict(by_qualification)}", file=sys.stderr)
    print(f"docType  {dict(by_doc_type)}", file=sys.stderr)
    if failures:
        print(f"skipped  {len(failures)}", file=sys.stderr)
        for failure in failures[:50]:
            print(f"  - {failure}", file=sys.stderr)
        if len(failures) > 50:
            print(f"  ... and {len(failures) - 50} more", file=sys.stderr)

    if args.dry_run:
        return 0

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "pdfRoot": "pdf_extraction",
        "counts": {
            "papers": len(entries),
            "subjects": len(subjects),
            "skipped": len(failures),
            "byBoard": dict(by_board),
            "byDocType": dict(by_doc_type),
        },
        "subjects": subjects,
        "papers": entries,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    print(f"wrote    {args.out.relative_to(REPO_ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
