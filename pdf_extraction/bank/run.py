"""Pipeline runner — drives one document, or a corpus, through all five stages.

Design points that matter operationally:

*   Stages 1-2 always run. They are free and deterministic, so a document can be
    re-segmented and re-cropped any number of times without cost. Only stage 3-4
    consume budget, and they are opt-in via ``use_model``.
*   The ledger is consulted per *question*, not per document. A run interrupted
    halfway through a paper resumes at the exact question it stopped on, and a
    prompt or model change re-runs only what it actually affects.
*   Nothing is discarded. A question that fails QA is still written, with
    ``status='needs_review'`` and its flags recorded next to it.
*   Multiple-choice mark schemes never reach the model: stage 1 recovers the
    whole answer key deterministically.

The run is organised in two phases because a model call takes ~10-100s and is
almost entirely network wait, while SQLite permits exactly one writer:

    phase A (main thread)   segment, render, store papers and assets
    phase B (worker pool)   transcribe and tag — no database access
    write   (main thread)   persist each result as it arrives

Run sequentially this corpus needs over a thousand hours, essentially all of it
spent idle on sockets. The pool collapses that to the provider's rate limit
while keeping every database write on a single thread.
"""

from __future__ import annotations

import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

from . import store
from .qa import ISSUE_NUMBERING_GAP, SEVERITY_MEDIUM, ReviewFlag, RunLedger
from .qa import create_ledger_key, run_qa_checks
from .renderer import RenderedSpan, render_strips_and_assets
from .spans import detect_root_spans
from .store import parse_caie_filename
from .tag import PROMPT_VERSION as TAG_PROMPT_VERSION
from .tag import tag_and_rate
from .transcribe import PROMPT_VERSION as TRANSCRIBE_PROMPT_VERSION
from .transcribe import transcribe_question

# SiliconFlow Qwen3-VL and DeepSeek list prices, USD per million tokens.
VISION_INPUT_PER_MTOK = 0.28
VISION_OUTPUT_PER_MTOK = 1.13
TEXT_INPUT_PER_MTOK = 0.27
TEXT_OUTPUT_PER_MTOK = 1.10

# Measured against SiliconFlow: 3 parallel calls all return in ~4s, while at 6
# one request is held for ~47s and at 8 the run wedges outright. Stay under the
# point where the provider starts queueing.
DEFAULT_CONCURRENCY = 4


@dataclass
class RunStats:
    """Cumulative totals for a run."""

    documents: int = 0
    documents_failed: int = 0
    questions: int = 0
    mark_schemes: int = 0
    answer_keys: int = 0
    assets: int = 0
    flags: int = 0
    needs_review: int = 0
    skipped_cached: int = 0
    vision_input_tokens: int = 0
    vision_output_tokens: int = 0
    text_input_tokens: int = 0
    text_output_tokens: int = 0
    errors: list[dict[str, Any]] = field(default_factory=list)
    seconds: float = 0.0

    @property
    def cost_usd(self) -> float:
        return (
            self.vision_input_tokens / 1e6 * VISION_INPUT_PER_MTOK
            + self.vision_output_tokens / 1e6 * VISION_OUTPUT_PER_MTOK
            + self.text_input_tokens / 1e6 * TEXT_INPUT_PER_MTOK
            + self.text_output_tokens / 1e6 * TEXT_OUTPUT_PER_MTOK
        )

    @property
    def billed_items(self) -> int:
        return self.questions + self.mark_schemes

    @property
    def cost_per_question(self) -> float:
        return self.cost_usd / self.billed_items if self.billed_items else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "documents": self.documents,
            "documents_failed": self.documents_failed,
            "questions": self.questions,
            "mark_schemes": self.mark_schemes,
            "answer_keys": self.answer_keys,
            "assets": self.assets,
            "flags": self.flags,
            "needs_review": self.needs_review,
            "skipped_cached": self.skipped_cached,
            "vision_input_tokens": self.vision_input_tokens,
            "vision_output_tokens": self.vision_output_tokens,
            "text_input_tokens": self.text_input_tokens,
            "text_output_tokens": self.text_output_tokens,
            "cost_usd": round(self.cost_usd, 4),
            "cost_per_question": round(self.cost_per_question, 5),
            "seconds": round(self.seconds, 1),
            "items_per_hour": (
                round(self.billed_items / self.seconds * 3600, 1) if self.seconds else 0.0
            ),
            "errors": self.errors[:50],
        }


@dataclass
class WorkItem:
    """One root question awaiting its model calls."""

    pdf_name: str
    paper_id: int
    doc_type: str
    source_sha256: str
    rendered_span: RenderedSpan
    asset_ids: dict[str, int]
    work_key: str


@dataclass
class WorkResult:
    """What a worker produced for one item. Carries no database handle."""

    item: WorkItem
    transcription: Any = None
    vision_in: int = 0
    vision_out: int = 0
    tagging: Any = None
    text_in: int = 0
    text_out: int = 0
    error: str | None = None
    stage: str = "transcribe"


def prepare_document(
    pdf_path: Path | str,
    connection,
    stats: RunStats,
    *,
    asset_root: Path,
    run_id: str,
    ledger: RunLedger | None,
    use_model: bool,
    model_name: str,
    max_questions: int | None = None,
    log: Callable[[str], None] = print,
) -> list[WorkItem]:
    """Run the free stages for one document and return its pending work.

    Everything here touches the database, so it stays on the calling thread.
    """
    pdf_path = Path(pdf_path)
    identity = parse_caie_filename(pdf_path)
    if identity is None:
        raise ValueError(f"unrecognised filename: {pdf_path.name}")

    doc_type = identity.doc_type
    if doc_type not in {"qp", "ms", "in"}:
        raise ValueError(f"unsupported document type {doc_type!r} in {pdf_path.name}")

    # --- Stage 1: spans (free) --------------------------------------------
    spans = detect_root_spans(pdf_path, doc_type)

    subject_id = store.upsert_subject(
        connection,
        board=identity.board,
        code=identity.code,
        name=f"{identity.board} {identity.code}",
        level="a-level" if identity.code.startswith("9") else "igcse",
    )
    paper_id = store.upsert_paper(
        connection,
        subject_id=subject_id,
        identity=identity,
        source_path=pdf_path,
        source_sha256=spans.source_sha256,
        page_count=spans.page_count,
        span_strategy=spans.strategy,
        used_ocr=spans.used_ocr,
    )

    # A multiple-choice key is fully recovered by stage 1; no model needed.
    if spans.answer_key:
        written = store.record_answer_key(
            connection, paper_id=paper_id, answer_key=spans.answer_key, run_id=run_id
        )
        stats.answer_keys += written
        connection.commit()
        return []

    if not spans.spans:
        stats.errors.append(
            {"file": pdf_path.name, "stage": "spans", "error": "no spans detected"}
        )
        connection.commit()
        return []

    # --- Stage 2: strips and assets (free) --------------------------------
    render = render_strips_and_assets(spans, pdf_path, asset_root)
    asset_ids = {asset.sha256: store.upsert_asset(connection, asset) for asset in render.assets}
    stats.assets += len(render.assets)

    store.clear_paper_flags(connection, paper_id)
    if spans.numbering_gaps:
        store.record_flags(
            connection,
            question_id=None,
            paper_id=paper_id,
            flags=[_gap_flag(spans.numbering_gaps)],
        )
        stats.flags += 1
    connection.commit()

    if not use_model:
        return []

    rendered = render.rendered_spans
    if max_questions is not None:
        rendered = rendered[:max_questions]

    items: list[WorkItem] = []
    for rendered_span in rendered:
        work_key = create_ledger_key(
            spans.source_sha256, rendered_span.root_number,
            model_name, TRANSCRIBE_PROMPT_VERSION, "transcribe",
        )
        if ledger is not None and ledger.is_completed(work_key):
            stats.skipped_cached += 1
            continue
        items.append(WorkItem(
            pdf_name=pdf_path.name,
            paper_id=paper_id,
            doc_type=doc_type,
            source_sha256=spans.source_sha256,
            rendered_span=rendered_span,
            asset_ids=asset_ids,
            work_key=work_key,
        ))
    return items


def _execute(
    item: WorkItem,
    *,
    do_tagging: bool,
    subject_topics: list[str] | None,
    subject_context: str | None,
    vision_settings: dict[str, Any] | None,
    text_settings: dict[str, Any] | None,
) -> WorkResult:
    """Run the billed stages for one item. Called on a worker thread.

    Touches no database and shares no mutable state, so it is safe to run many
    of these at once.
    """
    try:
        transcription, call = transcribe_question(
            item.rendered_span, item.doc_type, settings=vision_settings
        )
    except Exception as error:  # noqa: BLE001 - one bad question must not stop the run
        return WorkResult(item=item, error=str(error)[:400], stage="transcribe")

    result = WorkResult(
        item=item,
        transcription=transcription,
        vision_in=call.input_tokens,
        vision_out=call.output_tokens,
    )

    if do_tagging and item.doc_type == "qp":
        try:
            tagging, tag_call = tag_and_rate(
                transcription.body_md, subject_topics, subject_context,
                settings=text_settings,
            )
            result.tagging = tagging
            result.text_in = tag_call.input_tokens
            result.text_out = tag_call.output_tokens
        except Exception as error:  # noqa: BLE001 - tagging is not worth losing a row over
            # The transcription is still good; record the tagging failure and
            # keep the row rather than discarding real work.
            result.error = f"tagging: {str(error)[:300]}"
            result.stage = "tag"

    return result


def _persist(
    result: WorkResult,
    connection,
    stats: RunStats,
    ledger: RunLedger | None,
    *,
    run_id: str,
    model_name: str,
) -> None:
    """Write one worker result. Main thread only."""
    item = result.item

    if result.transcription is None:
        stats.errors.append({
            "file": item.pdf_name,
            "root": item.rendered_span.root_number,
            "stage": result.stage,
            "error": result.error,
        })
        if ledger is not None:
            ledger.record_failure(
                item.work_key, "transcribe", item.source_sha256,
                item.rendered_span.root_number, result.error or "unknown",
            )
            connection.commit()
        return

    if result.error:
        # Transcription succeeded but tagging did not; keep both facts.
        stats.errors.append({
            "file": item.pdf_name,
            "root": item.rendered_span.root_number,
            "stage": result.stage,
            "error": result.error,
        })

    stats.vision_input_tokens += result.vision_in
    stats.vision_output_tokens += result.vision_out
    stats.text_input_tokens += result.text_in
    stats.text_output_tokens += result.text_out

    transcription = result.transcription
    # The figure inventory is what the model was offered; without it the QA
    # pass cannot tell a correct citation from a confidently wrong one.
    flags = run_qa_checks(
        transcription,
        item.paper_id,
        None,
        figure_inventory=item.rendered_span.figures if item.doc_type != "ms" else None,
    )
    status = "needs_review" if flags else "published"

    if item.doc_type == "ms":
        store.upsert_mark_scheme(
            connection,
            paper_id=item.paper_id,
            transcription=transcription,
            question_id=None,
            run_id=run_id,
            model=model_name,
            prompt_version=TRANSCRIBE_PROMPT_VERSION,
            status=status,
        )
        # A mark scheme has no question row to hang a flag from, but its flags
        # must still be recorded — otherwise a reviewer sees a row marked
        # needs_review with no stated reason.
        store.record_flags(
            connection, question_id=None, paper_id=item.paper_id, flags=flags
        )
        stats.mark_schemes += 1
    else:
        question_id = store.upsert_question(
            connection,
            paper_id=item.paper_id,
            transcription=transcription,
            rendered_span=item.rendered_span,
            asset_ids=item.asset_ids,
            tagging=result.tagging,
            run_id=run_id,
            model=model_name,
            prompt_version=TAG_PROMPT_VERSION if result.tagging else TRANSCRIBE_PROMPT_VERSION,
            status=status,
        )
        store.record_flags(
            connection, question_id=question_id, paper_id=item.paper_id, flags=flags
        )
        stats.questions += 1

    stats.flags += len(flags)
    if flags:
        stats.needs_review += 1

    if ledger is not None:
        ledger.record_success(
            item.work_key, "transcribe", item.source_sha256,
            item.rendered_span.root_number, result.vision_in, result.vision_out,
        )
    connection.commit()


def _gap_flag(gaps: tuple[int, ...]) -> ReviewFlag:
    return ReviewFlag(
        question_id=None,
        paper_id=None,
        issue_type=ISSUE_NUMBERING_GAP,
        severity=SEVERITY_MEDIUM,
        message=f"root numbering has gaps: {list(gaps)}",
        evidence={"gaps": list(gaps)},
    )


def run_corpus(
    pdf_paths: Iterable[Path | str],
    *,
    db_path: Path | str,
    asset_root: Path | str,
    run_id: str | None = None,
    use_model: bool = False,
    do_tagging: bool = True,
    subject_topics: list[str] | None = None,
    subject_context: str | None = None,
    max_questions_per_doc: int | None = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    progress_every: int = 25,
    log: Callable[[str], None] = print,
) -> RunStats:
    """Run a list of documents end to end and return the totals."""
    paths = [Path(path) for path in pdf_paths]
    run_id = run_id or f"run-{int(time.time())}"
    asset_root = Path(asset_root)
    stats = RunStats()
    started = time.time()

    vision_conf: dict[str, Any] | None = None
    text_conf: dict[str, Any] | None = None
    model_name = "none"
    if use_model:
        from .env import text_settings as load_text
        from .env import vision_settings as load_vision

        vision_conf = load_vision()
        model_name = vision_conf["model"]
        log(f"vision: {model_name} @ {vision_conf['endpoint']}")
        if do_tagging:
            try:
                text_conf = load_text()
                log(f"text:   {text_conf['model']} @ {text_conf['endpoint']}")
            except ValueError as error:
                log(f"text:   disabled ({error})")
                do_tagging = False
        log(f"workers: {concurrency}")

    connection = store.connect(db_path)
    # Share the store's connection: SQLite permits one writer, so a second
    # connection would block on the store's open transaction.
    ledger = RunLedger(connection=connection)

    try:
        # --- Phase A: free stages, and collect the billed work -------------
        pending: list[WorkItem] = []
        for index, pdf_path in enumerate(paths, start=1):
            try:
                pending.extend(prepare_document(
                    pdf_path, connection, stats,
                    asset_root=asset_root, run_id=run_id, ledger=ledger,
                    use_model=use_model, model_name=model_name,
                    max_questions=max_questions_per_doc, log=log,
                ))
                stats.documents += 1
            except Exception as error:  # noqa: BLE001 - a bad document must not stop the corpus
                stats.documents_failed += 1
                stats.errors.append({
                    "file": Path(pdf_path).name,
                    "stage": "prepare",
                    "error": str(error)[:400],
                    "traceback": traceback.format_exc(limit=3)[:800],
                })
            if index % progress_every == 0 or index == len(paths):
                log(f"  prepared {index}/{len(paths)} documents, {len(pending)} items queued")

        if not pending:
            return stats

        # --- Phase B: billed stages in parallel, writes on this thread -----
        log(f"transcribing {len(pending)} items with {concurrency} workers")
        done = 0
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            futures = {
                pool.submit(
                    _execute, item,
                    do_tagging=do_tagging,
                    subject_topics=subject_topics,
                    subject_context=subject_context,
                    vision_settings=vision_conf,
                    text_settings=text_conf,
                ): item
                for item in pending
            }
            for future in as_completed(futures):
                try:
                    result = future.result()
                except Exception as error:  # noqa: BLE001 - defensive; _execute catches its own
                    item = futures[future]
                    result = WorkResult(item=item, error=str(error)[:400])
                _persist(
                    result, connection, stats, ledger,
                    run_id=run_id, model_name=model_name,
                )
                done += 1
                if done % progress_every == 0 or done == len(pending):
                    rate = done / max(1e-6, time.time() - started) * 3600
                    log(f"  {done}/{len(pending)} items  "
                        f"${stats.cost_usd:.3f}  {rate:,.0f}/h")
    finally:
        connection.commit()
        connection.close()

    stats.seconds = time.time() - started
    return stats
