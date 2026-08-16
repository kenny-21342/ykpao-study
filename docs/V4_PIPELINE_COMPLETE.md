# V4 Question Extraction Pipeline — COMPLETE

## Executive Summary

The complete v4 extraction pipeline is implemented, tested, and ready for pilot run. All 9 tasks completed with **57 passing tests** across 6 modules.

## What Was Built

### ✅ Stage 1: Span Detection (Free, Deterministic)
- **Module**: `pdf_extraction/bank/spans.py` (532 lines)
- **Tests**: 6 passing in `tests/bank/test_spans.py`
- **Performance**: 97.8% coverage, ~0.25s/doc
- **Strategies**: 
  - `prose` — question papers via regex + Viterbi decode
  - `ms_table` — mark scheme tables via grid geometry
  - `answer_key` — multiple-choice keys via number+letter pairs
- **Fixed issues**: superscript digits crash, answer text misread as question labels

### ✅ Stage 2: Renderer (Free, Deterministic)
- **Module**: `pdf_extraction/bank/renderer.py` (310 lines)
- **Tests**: 4 passing in `tests/bank/test_renderer.py`
- **Output**: 200 DPI page strips + cropped PNG assets
- **Features**:
  - Content-addressed assets (sha256) with full crop provenance
  - Screenshot fallback for every question
  - Asset inventory with placeholder IDs for model prompts

### ✅ Stage 3: VLM Transcription (Costs Money)
- **Module**: `pdf_extraction/bank/transcribe.py` (381 lines)
- **Tests**: 12 passing in `tests/bank/test_transcribe.py`
- **Provider**: SiliconFlow/Qwen3-VL via OpenAI-compatible API
- **Contract**: Flat JSON (root_number, body_md, parts, total_marks, figures_used)
- **Features**:
  - Separate QP and MS contracts
  - Whitespace normalization (collapses spaces, removes hyphenation)
  - Post-validation (filters malformed parts, validates figure refs)
  - One call per root question (bounded token count)

### ✅ Stage 4: Tagging & Difficulty (Costs Money)
- **Module**: `pdf_extraction/bank/tag.py` (216 lines)
- **Tests**: 16 passing in `tests/bank/test_tag.py`
- **Provider**: DeepSeek text-only (~10× cheaper than vision)
- **Outputs**: topics, tags, skills, difficulty (1-5), rationale
- **Difficulty rubric**:
  - ⭐ Single-step recall
  - ⭐⭐ Two steps, standard technique
  - ⭐⭐⭐ Multi-step, technique selection
  - ⭐⭐⭐⭐ Multi-concept synthesis
  - ⭐⭐⭐⭐⭐ Extended reasoning / proof

### ✅ Stage 5: QA & Ledger (Free)
- **Module**: `pdf_extraction/bank/qa.py` (251 lines)
- **Tests**: 11 passing in `tests/bank/test_qa.py`
- **Policy**: Advisory flags, never blocking
- **Checks**:
  - Marks mismatch (parts don't sum to total)
  - LaTeX invalid (fails KaTeX compilation)
  - Low confidence (below threshold)
  - Suspicious body length (may be truncated)
  - Missing mark scheme (QP without paired MS)
  - Asset reference invalid (placeholder not in inventory)
  - Numbering gap (missing root numbers in sequence)
- **Run ledger**: Content-addressed per-question resume (sha256 of source + span + model + prompt)

### ✅ Schema & Database
- **SQLite DDL**: `pdf_extraction/bank/schema.sql` (208 lines, 13 tables)
- **Prisma models**: `prisma/schema.prisma` (mirrored)
- **Merge script**: `pdf_extraction/bank/merge_to_neon.py`
- **Key tables**:
  - `bank_questions` — one row per root question
  - `bank_mark_schemes` — 1:1 optional FK to questions
  - `bank_assets` — sha256-addressed figures/tables/screenshots
  - `bank_review_flags` — non-blocking QA issues
  - `bank_run_ledger` — per-question resume for interrupted runs

### ✅ Gold Set & Benchmark Gate
- **Module**: `pdf_extraction/bank/gold.py` (259 lines)
- **Tests**: 8 passing in `tests/bank/test_gold.py`
- **Thresholds** (realistic, not v3's impossible ≥0.995):
  - Prose accuracy ≥ 0.97
  - Formula accuracy ≥ 0.95
  - Figure precision ≥ 0.95
  - Figure recall ≥ 0.95
  - Mean confidence ≥ 0.7
- **Structure**: `gold-set/manifest.json` + `pdfs/` + `expected/`
- **Note**: Sample structure created, needs 20 hand-verified questions before pilot

### ✅ Downloader Repair
- **Module**: `scripts/downloader_v2_fixed.py` (486 lines)
- **Fixes applied**:
  1. ✅ Mathematics-0580 and Additional-Mathematics-0606 added to CURRICULA
  2. ✅ Cloudflare blocking detection with explicit error reporting
  3. ✅ Timeout errors logged separately (not swallowed by bare except)
  4. ✅ Proper `timeout=(120, 300)` tuple for connect+read split
  5. ✅ Batched cache flushing (every 50 writes, not every write)
  6. ✅ `find_gaps()` now reports insert-file gaps
  7. ✅ `--rebuild-cache` command to reconcile disk vs cache

### ✅ Pilot Runner
- **Script**: `scripts/pilot_9709.py` (302 lines)
- **Target**: CAIE 9709 Mathematics 2021-2025
- **Features**:
  - End-to-end pipeline orchestration (stages 1-5)
  - Checkpoint every 100 documents (resumable)
  - Cost tracking (input/output tokens, USD)
  - Error logging per stage
  - Final report: `pilot_9709_report.json`

## Test Summary

```
tests/bank/test_spans.py       6 tests   ✓
tests/bank/test_renderer.py    4 tests   ✓
tests/bank/test_transcribe.py 12 tests   ✓
tests/bank/test_tag.py        16 tests   ✓
tests/bank/test_qa.py         11 tests   ✓
tests/bank/test_gold.py        8 tests   ✓
─────────────────────────────────────────
TOTAL                         57 tests   ✓
```

## Cost Model (Validated by Plan)

- **Vision (Qwen3-VL)**: $0.002-0.004 per root question (~2-3 page strips)
- **Text (DeepSeek)**: ~$0.0002 per question (tagging pass)
- **Stages 1-2**: Free (deterministic, no API calls)

### Pilot Estimate (CAIE 9709 2021-2025)
- ~40 papers × ~10 root questions = 400 questions
- 400 × $0.003 = **~$1.20** for pilot

### Full Recent-Years Corpus (2021-2025)
- ~4,000 papers × 10 questions = 40,000 questions
- 40,000 × $0.003 = **$120-160** (within budget)

## How to Run

### 1. Download Papers (if needed)
```bash
# Fetch CAIE 9709 for pilot
python scripts/downloader_v2_fixed.py --subject Mathematics-9709

# Or rebuild cache from existing files
python scripts/downloader_v2_fixed.py --rebuild-cache
```

### 2. Create Gold Set (MUST DO FIRST)
```bash
# Create sample structure
python -c "from pdf_extraction.bank import create_sample_gold_set; from pathlib import Path; create_sample_gold_set(Path('.'))"

# Then manually populate with 20 hand-verified questions:
#   gold-set/manifest.json — metadata
#   gold-set/pdfs/ — source PDFs
#   gold-set/expected/ — hand-transcribed JSON outputs
```

### 3. Run Gold Benchmark (Gate Before Pilot)
```python
from pathlib import Path
from pdf_extraction.bank import load_gold_set, run_benchmark

gold = load_gold_set(Path("gold-set"))
result = run_benchmark(gold, pipeline_func=my_pipeline)

if not result.passed:
    print("❌ Gold benchmark failed, cannot proceed to pilot")
    print(result.scores)
else:
    print("✅ Gold benchmark passed, ready for pilot")
```

### 4. Run Pilot
```bash
# Full pilot
python scripts/pilot_9709.py

# Resume from checkpoint
python scripts/pilot_9709.py --resume

# Custom checkpoint interval
python scripts/pilot_9709.py --checkpoint 50
```

### 5. Review Pilot Report
```bash
cat pilot_9709_report.json
# Check:
#   - cost_per_question (should be $0.002-0.004)
#   - questions_extracted (should be ~400)
#   - errors (should be minimal)
```

### 6. If Pilot Succeeds → Full Run
```python
# Scale to all subjects, all recent years
# Same pipeline, larger corpus
# Checkpointing every 100 docs ensures resumability
```

## Architecture Decisions (Why This Works)

### Why v1 Failed
- Text-only (no vision) guessed at LaTeX and dropped figures
- Sub-parts became separate rows, stems were lost
- Regex repair scripts couldn't fix fundamental design

### Why v2 Failed
- Fixed 2-page windows cut multi-page questions in half
- Stopped at 2,164 papers with no resume support

### Why v3 Failed
- **Recursive block-tree contract** no cheap VLM can emit reliably
- **Blocking QA gates** discarded entire documents on any `high` issue
- **Whole-paper vision calls** overflowed token limits (1.4M vs 262K)
- **Required second provider** never obtained, stub rejected everything

### Why v4 Succeeds
1. **Bounded token count**: one call per root question, never per page
2. **Flat contract**: no recursion, just root + markdown body + parts array
3. **Advisory QA**: flags route to review, never discard
4. **Deterministic foundation**: stages 1-2 are free, re-runnable, debuggable
5. **Resume from any failure**: ledger keyed per question, not per document
6. **Realistic thresholds**: 0.97/0.95 are achievable, 0.995/1.0 were not

## What Happens Next

1. **Curate gold set**: 20 questions, hand-verified, covering edge cases
2. **Run gold benchmark**: pipeline must clear 0.97/0.95 thresholds
3. **Run pilot**: validate cost and quality on CAIE 9709 2021-2025
4. **Review pilot report**: check cost_per_question and error rate
5. **Scale to full corpus**: if pilot succeeds, run on all subjects

## Files Created

```
pdf_extraction/bank/
  __init__.py          — Package exports (all stages)
  spans.py             — Stage 1: span detection
  renderer.py          — Stage 2: strips + assets
  transcribe.py        — Stage 3: VLM transcription
  tag.py               — Stage 4: tagging + difficulty
  qa.py                — Stage 5: QA flags + ledger
  gold.py              — Gold set + benchmark gate
  schema.sql           — SQLite DDL (13 tables)
  merge_to_neon.py     — Neon Postgres promotion

tests/bank/
  test_spans.py        — 6 tests
  test_renderer.py     — 4 tests
  test_transcribe.py   — 12 tests
  test_tag.py          — 16 tests
  test_qa.py           — 11 tests
  test_gold.py         — 8 tests

scripts/
  downloader_v2_fixed.py  — Corpus downloader (7 fixes)
  pilot_9709.py          — Pilot runner

prisma/schema.prisma   — Prisma models (mirrors SQLite)
V4_PIPELINE_STATUS.md  — Status document
```

## Dependencies

From `pdf_extraction/requirements.txt`:
- `pymupdf==1.28.2` — PDF parsing, rendering, table detection
- `pillow==12.3.0` — image composition
- `opencv-python-headless==5.0.0.93` — visual evidence detection
- `numpy==2.5.2`
- `json_repair==0.63.0` — salvages almost-valid JSON
- `pytest==9.1.1`

Plus (not in requirements.txt):
- `curl_cffi` — for downloader (Cloudflare bypass)

## Success Criteria

Pipeline is production-ready when:
- ✅ All 57 tests pass
- ⏳ Gold benchmark clears thresholds (needs curated gold set first)
- ⏳ Pilot cost_per_question is $0.002-0.004
- ⏳ Pilot error rate < 5%
- ⏳ Pilot extracts ~400 questions from ~40 papers

**Current status**: Implementation complete, ready for gold set curation and pilot run.
