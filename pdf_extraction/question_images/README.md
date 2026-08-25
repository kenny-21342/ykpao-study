# Question Image Corpus V1

This package creates review-only, lossless PNGs for logical root questions. It is fully offline: it does not call application APIs, model providers, databases, or publication code, and it treats the V3 inventory manifests as read-only inputs.

## Commands

Create the deterministic 100-paper selection:

```sh
python3 -m pdf_extraction.question_images.cli pilot
```

Process or resume that pilot:

```sh
python3 -m pdf_extraction.question_images.cli run \
  --pilot-manifest data/question-images-v1/pilot-100.json
```

Run one document while reviewing detector changes:

```sh
python3 -m pdf_extraction.question_images.cli run --document-id v3d_example
```

An unbounded corpus run is deliberately rejected until a reviewer supplies a `QuestionImagePilotSignoffV1` file whose detector version and all required gates pass:

```sh
python3 -m pdf_extraction.question_images.cli run \
  --full --pilot-signoff data/question-images-v1/pilot-signoff.json
```

Use `data/question-images-v1/pilot-signoff.template.json` as the review handoff. Compare every accepted image with its source regions and inspect every quarantined preview before recording the measured boundary precision, root recall, and material retention. The template is deliberately non-approving and is rejected until a reviewer fills all gates and sets `approved` to `true`.

Compare two independently generated manifests and hashes, retaining the audit result:

```sh
python3 -m pdf_extraction.question_images.cli compare first.json second.json \
  --output data/question-images-v1/determinism-report.json
```

## Artifacts

- `QuestionImageCorpusV1.json`: deterministic corpus manifest with `QuestionImageRecordV1` entries.
- `assets/sha256/<prefix>/<sha256>.png`: accepted, content-addressed question images.
- `previews/<document>/<record>.png`: compact previews for quarantined records only.
- `state/ledger.jsonl`: append-only document completion ledger used for resume.
- `run-report.json`: runtime, bytes, acceptance, quarantine reasons, and board/subject coverage.
- `determinism-report.json`: optional comparison result from two independent runs.

Accepted images are rendered at 200 DPI with 12-point source padding and 24-pixel white strip separators. Images over 30,000 pixels high are retried down to 120 DPI, then quarantined rather than split. Rendering stops before configured free space falls below 2 GiB.

The manifest is separate from V3 and does not imply publication, OCR transcription, semantic marks, or mark-scheme coverage.
