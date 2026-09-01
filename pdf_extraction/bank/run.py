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
from .qa import DEFAULT_CONFIDENCE_THRESHOLD, ISSUE_CROP_NO_MARKS
from .qa import ISSUE_NUMBERING_GAP
from .qa import SEVERITY_HIGH, SEVERITY_MEDIUM, ReviewFlag, RunLedger
from .qa import create_ledger_key, run_crop_checks, run_qa_checks
from .renderer import RenderedSpan, render_strips_and_assets
from .spans import detect_root_spans
from .store import parse_paper_path
from .tag import PROMPT_VERSION as TAG_PROMPT_VERSION
from .tag import tag_and_rate
from .transcribe import PROMPT_VERSION as TRANSCRIBE_PROMPT_VERSION

# Recorded on rows written without a model, so a later text pass can find the
# questions that still need one.
CROP_ONLY_VERSION = "crop-only-v1"
from .transcribe import transcribe_question

# SiliconFlow Qwen3-VL and DeepSeek list prices, USD per million tokens.
VISION_INPUT_PER_MTOK = 0.28
VISION_OUTPUT_PER_MTOK = 1.13
TEXT_INPUT_PER_MTOK = 0.27
TEXT_OUTPUT_PER_MTOK = 1.10

# Re-measured against SiliconFlow on 2026-09-01, on 9709 question papers with
# the same model and prompt version:
#
#     concurrency  4   328 items/hour
#     concurrency 10   692 items/hour
#     concurrency 24   418 items/hour   (no failures; the provider throttles)
#
# The earlier note here -- "at 6 one request is held for ~47s and at 8 the run
# wedges outright" -- no longer holds, and at 4 the corpus is a 35-day run
# rather than an 8-day one. Past ten the provider gives the throughput back, so
# this is a peak and not a floor: re-measure before raising it, because the
# whole corpus is a week either way and a wedged run costs more than it saves.
DEFAULT_CONCURRENCY = 10


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
    # What stage 1 found wrong with the IMAGE. Carried through because the
    # model cannot see it: a cut-off question number or an erased stem is
    # invisible to a transcription, so a pass that decided status from its own
    # flags alone published exactly the questions the crop QA held back.
    crop_flags: list = field(default_factory=list)


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
    identity = parse_paper_path(pdf_path)
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
        name=identity.subject_name or f"{identity.board} {identity.code}",
        level=identity.level or ("a-level" if identity.code.startswith("9") else "igcse"),
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
        # An insert is a data or resource booklet — a periodic table, a set of
        # sources, a case study. It carries no numbered questions by design, so
        # finding none is the correct outcome and recording it as an error only
        # buries the failures that matter. 102 of them did exactly that in one
        # chunk of the corpus run.
        if doc_type != "in":
            stats.errors.append(
                {"file": pdf_path.name, "stage": "spans",
                 "error": "no spans detected"}
            )
        connection.commit()
        return []

    # --- Stage 2: strips and assets (free) --------------------------------
    render = render_strips_and_assets(spans, pdf_path, asset_root)
    asset_ids = {asset.sha256: store.upsert_asset(connection, asset) for asset in render.assets}
    stats.assets += len(render.assets)

    store.clear_paper_flags(connection, paper_id)

    # Crop QA runs here, on geometry, because the crop is the product in
    # crop-first mode and there may never be a transcription to check.
    crop_flags: dict[int, list[ReviewFlag]] = {}
    for span in spans.spans:
        rendered_span = render.span_for(span.root_number)
        if rendered_span is None:
            continue
        crop_flags[span.root_number] = run_crop_checks(
            pdf_path, span, rendered_span, spans.doc_type, paper_id)
    _drop_paper_wide_marks_flag(crop_flags)

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
        # Crop-first: the image is the product, so the rows are written here
        # with no model involved. Without this the whole corpus could be
        # rendered and still contain no questions.
        _store_crops(
            connection, spans, render, asset_ids, crop_flags,
            paper_id=paper_id, run_id=run_id, stats=stats,
        )
        connection.commit()
        return []

    # A mark scheme has no question row to hang a flag from, so its crop flags
    # are recorded against the paper. A question's travel with it into phase B
    # and are attached to the row there, which also keeps them out of the
    # paper-level set that clear_paper_flags rebuilds on every run.
    if doc_type == "ms":
        paper_flags = [flag for flags in crop_flags.values() for flag in flags]
        if paper_flags:
            store.record_flags(
                connection, question_id=None, paper_id=paper_id, flags=paper_flags)
            stats.flags += len(paper_flags)
    connection.commit()

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
            crop_flags=list(crop_flags.get(rendered_span.root_number, [])),
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
    # Both halves, through the same severity rule stage 1 uses. A question is
    # published only when neither the image nor the text gives a reason to
    # hold it, and transcribing a bad crop pays to record the damage rather
    # than repairing it.
    status = _crop_status(list(item.crop_flags) + flags, transcription.confidence)

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
            connection, question_id=question_id, paper_id=item.paper_id,
            flags=list(item.crop_flags) + flags,
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


@dataclass(frozen=True)
class _CropOnlyQuestion:
    """Stands in for a transcription when the crop is the whole product.

    store.upsert_question reads a handful of attributes off a transcription; a
    crop-only run has none, so this supplies the same shape with the text
    fields empty. Text arrives later without the row having to be recreated.
    """

    root_number: int
    confidence: float
    body_md: str = ""
    parts: list = field(default_factory=list)
    total_marks: int | None = None


@dataclass(frozen=True)
class _CropOnlyMarkScheme:
    root_number: int
    confidence: float
    answer_md: str = ""
    marking_points: list = field(default_factory=list)
    total_marks: int | None = None
    answer_letter: str | None = None


# Above this share of a paper's questions showing no marks, the paper does not
# print them at all rather than every crop being wrong.
_NO_MARKS_PAPER_SHARE = 0.6


def _drop_paper_wide_marks_flag(crop_flags: dict[int, list[ReviewFlag]]) -> None:
    """A whole paper with no marks is a multiple-choice paper, not 40 faults.

    Multiple-choice papers print no per-question mark allocation — each
    question is worth one mark implicitly — so the marks check fired on every
    question in them. Across the corpus that was 75% of paper 1 and 45% of
    paper 2, against 1-3% of the structured papers, and it pushed three
    quarters of the bank into review.

    The check still earns its place on a structured paper, where a missing
    "[3]" means the crop stopped short of the end of the question.
    """
    if not crop_flags:
        return
    flagged = [
        root for root, flags in crop_flags.items()
        if any(flag.issue_type == ISSUE_CROP_NO_MARKS for flag in flags)
    ]
    if len(flagged) < len(crop_flags) * _NO_MARKS_PAPER_SHARE:
        return
    for root in flagged:
        crop_flags[root] = [
            flag for flag in crop_flags[root]
            if flag.issue_type != ISSUE_CROP_NO_MARKS
        ]


def _crop_status(flags: list[ReviewFlag], confidence: float) -> str:
    """Publish a crop unless something says a human should look first.

    Furniture in the margin is cosmetic and rates around 7%, so blocking on it
    would send a fifteenth of the corpus to a review queue nobody has time for.
    A cut-off question number, a missing Marks column or an erased stem all
    mean the image itself is wrong, and those hold the row back.
    """
    if confidence < DEFAULT_CONFIDENCE_THRESHOLD:
        return "needs_review"
    if any(flag.severity in (SEVERITY_HIGH, SEVERITY_MEDIUM) for flag in flags):
        return "needs_review"
    return "published"


def _store_crops(
    connection,
    spans,
    render,
    asset_ids: dict[str, int],
    crop_flags: dict[int, list[ReviewFlag]],
    *,
    paper_id: int,
    run_id: str,
    stats: RunStats,
) -> None:
    """Write one row per rendered question, with no model in the loop."""
    for span in spans.spans:
        rendered_span = render.span_for(span.root_number)
        if rendered_span is None or not rendered_span.strips:
            continue
        flags = crop_flags.get(span.root_number, [])
        status = _crop_status(flags, span.confidence)

        if spans.doc_type == "ms":
            owner_id = store.upsert_mark_scheme(
                connection,
                paper_id=paper_id,
                transcription=_CropOnlyMarkScheme(
                    root_number=span.root_number, confidence=span.confidence),
                question_id=None,
                run_id=run_id,
                model="crop-only",
                prompt_version=CROP_ONLY_VERSION,
                status=status,
                rendered_span=rendered_span,
                asset_ids=asset_ids,
            )
            question_id = None
        else:
            owner_id = store.upsert_question(
                connection,
                paper_id=paper_id,
                transcription=_CropOnlyQuestion(
                    root_number=span.root_number, confidence=span.confidence),
                rendered_span=rendered_span,
                asset_ids=asset_ids,
                run_id=run_id,
                model="crop-only",
                prompt_version=CROP_ONLY_VERSION,
                status=status,
            )
            question_id = owner_id
            stats.questions += 1

        if flags:
            store.record_flags(
                connection, question_id=question_id, paper_id=paper_id, flags=flags)
            stats.flags += len(flags)


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
    max_spend_usd: float | None = None,
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
        if do_tagging and not subject_topics:
            # Every topic outside the supplied list is discarded, so with no
            # list the pass is billed per question and writes none. Callers
            # that mean this should say so; callers that do not, should see it.
            log("text:   WARNING no syllabus topics supplied — topics will be empty")
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
        queue = iter(pending)
        stopped_on_budget = False

        def submit_next(pool, futures) -> bool:
            """Start one more item, unless the budget says stop.

            Work is submitted a few at a time rather than all at once. Every
            item is billed, so a cap can only mean anything if the decision to
            spend more is taken after the last result came back -- submitting
            all 7,600 upfront makes the cap a suggestion. It also keeps phase B
            from holding a RenderedSpan for every item in the subject before
            the first call fires.

            The cap is therefore a ceiling on what is *started*, not a
            guarantee: up to `concurrency * 2` items are already in flight when
            it trips, so the final total can exceed it by that many items.
            Sized against the cap it is a rounding error, and stopping mid
            call would waste the tokens already spent on it.
            """
            nonlocal stopped_on_budget
            if max_spend_usd is not None and stats.cost_usd >= max_spend_usd:
                stopped_on_budget = True
                return False
            item = next(queue, None)
            if item is None:
                return False
            futures[pool.submit(
                _execute, item,
                do_tagging=do_tagging,
                subject_topics=subject_topics,
                subject_context=subject_context,
                vision_settings=vision_conf,
                text_settings=text_conf,
            )] = item
            return True

        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            futures: dict = {}
            for _ in range(max(1, concurrency) * 2):
                if not submit_next(pool, futures):
                    break

            while futures:
                for future in as_completed(list(futures)):
                    item = futures.pop(future)
                    try:
                        result = future.result()
                    except Exception as error:  # noqa: BLE001 - defensive
                        result = WorkResult(item=item, error=str(error)[:400])
                    _persist(
                        result, connection, stats, ledger,
                        run_id=run_id, model_name=model_name,
                    )
                    done += 1
                    submit_next(pool, futures)
                    break

            if stopped_on_budget:
                log(f"  stopped: spend cap ${max_spend_usd:.2f} reached "
                    f"at ${stats.cost_usd:.2f} after {done} items. "
                    f"The ledger has recorded them, so a re-run resumes here.")
                if done % progress_every == 0 or done == len(pending):
                    rate = done / max(1e-6, time.time() - started) * 3600
                    log(f"  {done}/{len(pending)} items  "
                        f"${stats.cost_usd:.3f}  {rate:,.0f}/h")
    finally:
        # A question paper and its mark scheme are separate documents, so the
        # pairing can only be made once both have been processed.
        try:
            linked = store.link_mark_schemes_to_questions(connection)
            if linked:
                log(f"  linked {linked} mark schemes to their questions")
        except Exception as error:  # pragma: no cover - diagnostics only
            # Loud, with the traceback. This swallowed a UNIQUE violation that
            # left every mark scheme in the corpus unlinked, and the one-line
            # message it printed was indistinguishable from a warning.
            log(f"  ! mark-scheme linking FAILED: {error}\n{traceback.format_exc()}")
        connection.commit()
        connection.close()

    stats.seconds = time.time() - started
    return stats
