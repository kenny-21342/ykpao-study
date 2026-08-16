#!/usr/bin/env python3
"""End-to-end example: one PDF through all five stages.

This is the reference for how the stages compose. For real runs use
``pdf_extraction.bank.run.run_corpus``, which adds the ledger, persistence,
resumability, and per-document error isolation.

Stages 1-2 are free, so ``--dry-run`` exercises the whole deterministic path
without spending anything.

Usage:
    python scripts/pipeline_integration_example.py <paper.pdf> [--dry-run]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pdf_extraction.bank import (  # noqa: E402
    detect_root_spans,
    parse_caie_filename,
    render_strips_and_assets,
    run_qa_checks,
    tag_and_rate,
    transcribe_question,
    vision_settings,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one PDF through the pipeline")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--dry-run", action="store_true", help="stages 1-2 only")
    parser.add_argument("--assets", type=Path, default=Path("data/bank-example/assets"))
    args = parser.parse_args()

    if not args.pdf.is_file():
        print(f"not found: {args.pdf}")
        return 1

    identity = parse_caie_filename(args.pdf)
    doc_type = identity.doc_type if identity else "qp"
    print(f"{args.pdf.name}  (doc_type={doc_type})\n")

    # --- Stage 1: root-question spans (free, deterministic) ---------------
    spans = detect_root_spans(args.pdf, doc_type)
    print(f"stage 1  {len(spans.spans)} roots via '{spans.strategy}'"
          f"{'  ocr' if spans.used_ocr else ''}")
    if spans.numbering_gaps:
        print(f"         numbering gaps: {list(spans.numbering_gaps)}")
    if spans.answer_key:
        # Multiple-choice keys are fully recovered here; no model call needed.
        print(f"         answer key recovered: {len(spans.answer_key)} entries")
        return 0
    if not spans.spans:
        print("         no spans detected")
        return 1

    # --- Stage 2: strips and figure assets (free, deterministic) ----------
    render = render_strips_and_assets(spans, args.pdf, args.assets)
    kinds: dict[str, int] = {}
    for asset in render.assets:
        kinds[asset.kind] = kinds.get(asset.kind, 0) + 1
    print(f"stage 2  {len(render.rendered_spans)} spans rendered, assets: {kinds}")

    if args.dry_run:
        print("\n(dry run — stages 3-5 skipped, nothing spent)")
        return 0

    settings = vision_settings()
    first = render.rendered_spans[0]

    # --- Stage 3: transcription (billed) ----------------------------------
    transcription, call = transcribe_question(first, doc_type, settings=settings)
    print(f"stage 3  Q{first.root_number}: {call.input_tokens} in / "
          f"{call.output_tokens} out, confidence {transcription.confidence:.2f}")

    body = getattr(transcription, "body_md", None) or transcription.answer_md

    # --- Stage 4: tagging and difficulty (billed, text only) --------------
    if doc_type == "qp":
        tagging, tag_call = tag_and_rate(body, subject_context="CAIE A-Level")
        print(f"stage 4  difficulty {tagging.difficulty}/5 — {tagging.difficulty_rationale}")
        print(f"         tags: {', '.join(tagging.tags) or '(none)'}")
        print(f"         skills: {', '.join(tagging.skills) or '(none)'}")

    # --- Stage 5: QA — advisory only, never blocking ----------------------
    flags = run_qa_checks(transcription, None, None)
    if flags:
        print(f"stage 5  {len(flags)} flag(s) -> needs_review")
        for flag in flags:
            print(f"         [{flag.severity}] {flag.issue_type}: {flag.message}")
    else:
        print("stage 5  clean -> published")

    print(f"\n--- transcription ---\n{body}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
