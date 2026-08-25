from __future__ import annotations

import argparse
from dataclasses import asdict
from hashlib import sha256
import json
from pathlib import Path
import sys

from .models import DETECTOR_VERSION
from .pilot import pilot_document_ids, save_pilot, select_pilot, validate_signoff
from .pipeline import PipelineConfig, run_batch


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCES = [
    ROOT / "data/v3/manifests/all-caie-2026-07-27.json",
    ROOT / "data/v3/manifests/all-ib-2026-07-27.json",
]
DEFAULT_OUTPUT = ROOT / "data/question-images-v1"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Offline, review-only root-question image extraction.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    pilot_parser = subparsers.add_parser("pilot", help="Create the deterministic 100-paper pilot selection.")
    _source_arguments(pilot_parser)
    pilot_parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT / "pilot-100.json")
    pilot_parser.add_argument("--target", type=int, default=100)
    pilot_parser.add_argument("--edge-case-slots", type=int, default=16)

    run_parser = subparsers.add_parser("run", help="Run a resumable extraction batch.")
    _source_arguments(run_parser)
    run_parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT)
    run_parser.add_argument("--pilot-manifest", type=Path)
    run_parser.add_argument("--document-id", action="append", default=[])
    run_parser.add_argument("--limit", type=int)
    run_parser.add_argument("--full", action="store_true")
    run_parser.add_argument("--pilot-signoff", type=Path)
    run_parser.add_argument("--min-free-gib", type=float, default=2.0)
    run_parser.add_argument("--tesseract", default="tesseract")
    run_parser.add_argument("--no-previews", action="store_true")

    compare_parser = subparsers.add_parser("compare", help="Compare deterministic record and asset identities.")
    compare_parser.add_argument("first", type=Path)
    compare_parser.add_argument("second", type=Path)
    compare_parser.add_argument("--output", type=Path, help="Persist the determinism report as JSON.")

    args = parser.parse_args(argv)
    if args.command == "pilot":
        value = select_pilot(args.source_manifest, target=args.target, edge_case_slots=args.edge_case_slots)
        save_pilot(value, args.output)
        print(json.dumps({
            "status": "PILOT_SELECTED",
            "path": str(args.output.resolve()),
            "selectedCount": value["selectedCount"],
            "representedSubjects": value["representedSubjects"],
            "manualSignoffRequired": True,
        }, sort_keys=True))
        return 0
    if args.command == "compare":
        return _compare(args.first, args.second, output=args.output)
    return _run(args)


def _run(args: argparse.Namespace) -> int:
    selected: set[str] | None = set(args.document_id) if args.document_id else None
    if args.pilot_manifest:
        pilot_ids = pilot_document_ids(args.pilot_manifest)
        selected = pilot_ids if selected is None else selected & pilot_ids

    bounded = selected is not None or args.limit is not None or args.pilot_manifest is not None
    if args.full:
        if not args.pilot_signoff:
            raise ValueError("--full requires --pilot-signoff")
        validate_signoff(args.pilot_signoff)
    elif not bounded:
        raise ValueError(
            "An unbounded run requires --full and an approved pilot sign-off; "
            "use --pilot-manifest, --document-id, or --limit for review batches"
        )
    if args.min_free_gib < 0:
        raise ValueError("--min-free-gib must not be negative")

    result = run_batch(
        args.source_manifest,
        PipelineConfig(
            output_root=args.output_root.resolve(),
            minimum_free_bytes=int(args.min_free_gib * 1024**3),
            tesseract=args.tesseract,
            keep_previews=not args.no_previews,
        ),
        selected_document_ids=selected,
        limit=args.limit,
    )
    print(json.dumps(asdict(result), sort_keys=True))
    return 0 if result.status == "COMPLETE" else 3


def _compare(first: Path, second: Path, *, output: Path | None = None) -> int:
    first_value = json.loads(first.read_text(encoding="utf-8"))
    second_value = json.loads(second.read_text(encoding="utf-8"))
    first_records = _identity_map(first_value)
    second_records = _identity_map(second_value)
    mismatches = []
    for record_id in sorted(set(first_records) | set(second_records)):
        if first_records.get(record_id) != second_records.get(record_id):
            mismatches.append(record_id)
    first_manifest_sha256 = _file_sha256(first)
    second_manifest_sha256 = _file_sha256(second)
    payload = {
        "version": "QuestionImageDeterminismReportV1",
        "detectorVersion": DETECTOR_VERSION,
        "deterministic": not mismatches and first_manifest_sha256 == second_manifest_sha256,
        "firstRecords": len(first_records),
        "secondRecords": len(second_records),
        "firstManifestSha256": first_manifest_sha256,
        "secondManifestSha256": second_manifest_sha256,
        "mismatchedRecordIds": mismatches,
    }
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".partial")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temporary.replace(output)
    print(json.dumps(payload, sort_keys=True))
    return 0 if payload["deterministic"] else 1


def _file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _identity_map(manifest: dict) -> dict[str, dict]:
    return {
        str(record["id"]): {
            "status": record.get("status"),
            "sourceRegions": record.get("sourceRegions"),
            "image": record.get("image"),
            "diagnostics": record.get("diagnostics"),
        }
        for record in manifest.get("records", [])
    }


def _source_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--source-manifest",
        type=Path,
        action="append",
        default=None,
        help="V3 inventory manifest used read-only; may be repeated.",
    )
    parser.set_defaults(source_manifest=DEFAULT_SOURCES)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, FileNotFoundError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
