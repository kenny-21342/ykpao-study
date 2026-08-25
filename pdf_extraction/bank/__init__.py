"""V4 question extraction pipeline.

Stages 1-2 are deterministic and free; only stages 3-4 call a model.

    PDF -> root-question spans -> strips + assets -> VLM transcription -> tagging

The span detector reuses ``pdf_extraction.question_images``, which already
decodes root-question boundaries offline at 97.8% coverage.
"""

from .client import CallResult, ProviderError, call_json
from .env import ensure_loaded, load_dotenv, text_settings, vision_settings
from .gold import (
    THRESHOLD_CONFIDENCE,
    THRESHOLD_FIGURE_PRECISION,
    THRESHOLD_FIGURE_RECALL,
    THRESHOLD_FORMULA_ACCURACY,
    THRESHOLD_PROSE_ACCURACY,
    BenchmarkResult,
    GoldItem,
    create_sample_gold_set,
    load_gold_set,
    run_benchmark,
)
from .qa import (
    ISSUE_ASSET_REFERENCE,
    ISSUE_LATEX_INVALID,
    ISSUE_LOW_CONFIDENCE,
    ISSUE_MARKS_MISMATCH,
    ISSUE_MISSING_MARK_SCHEME,
    ISSUE_NUMBERING_GAP,
    ISSUE_SUSPICIOUS_LENGTH,
    SEVERITY_HIGH,
    SEVERITY_LOW,
    SEVERITY_MEDIUM,
    ReviewFlag,
    RunLedger,
    create_ledger_key,
    run_qa_checks,
)
from .renderer import (
    AssetRecord,
    RenderOutput,
    RenderedSpan,
    StripRecord,
    render_strips_and_assets,
)
from .spans import (
    SPAN_DETECTOR_VERSION,
    DocumentSpans,
    PageRegion,
    RootSpan,
    detect_root_spans,
)
from .store import PaperIdentity, connect, parse_caie_filename, store_counts
from .tag import COMMAND_WORDS, DIFFICULTY_RUBRIC, TaggingResult, extract_command_words, tag_and_rate
from .transcribe import (
    MarkSchemeTranscription,
    QuestionTranscription,
    transcribe_question,
)

__all__ = [
    # Stage 1 — span detection
    "DocumentSpans",
    "PageRegion",
    "RootSpan",
    "SPAN_DETECTOR_VERSION",
    "detect_root_spans",
    # Stage 2 — rendering
    "AssetRecord",
    "RenderOutput",
    "RenderedSpan",
    "StripRecord",
    "render_strips_and_assets",
    # Stage 3 — transcription
    "MarkSchemeTranscription",
    "QuestionTranscription",
    "transcribe_question",
    # Stage 4 — tagging and difficulty
    "COMMAND_WORDS",
    "DIFFICULTY_RUBRIC",
    "TaggingResult",
    "extract_command_words",
    "tag_and_rate",
    # Stage 5 — QA and ledger
    "ISSUE_ASSET_REFERENCE",
    "ISSUE_LATEX_INVALID",
    "ISSUE_LOW_CONFIDENCE",
    "ISSUE_MARKS_MISMATCH",
    "ISSUE_MISSING_MARK_SCHEME",
    "ISSUE_NUMBERING_GAP",
    "ISSUE_SUSPICIOUS_LENGTH",
    "ReviewFlag",
    "RunLedger",
    "SEVERITY_HIGH",
    "SEVERITY_LOW",
    "SEVERITY_MEDIUM",
    "create_ledger_key",
    "run_qa_checks",
    # Storage
    "PaperIdentity",
    "connect",
    "parse_caie_filename",
    "store_counts",
    # Providers
    "CallResult",
    "ProviderError",
    "call_json",
    "ensure_loaded",
    "load_dotenv",
    "text_settings",
    "vision_settings",
    # Gold set and benchmark gate
    "BenchmarkResult",
    "GoldItem",
    "THRESHOLD_CONFIDENCE",
    "THRESHOLD_FIGURE_PRECISION",
    "THRESHOLD_FIGURE_RECALL",
    "THRESHOLD_FORMULA_ACCURACY",
    "THRESHOLD_PROSE_ACCURACY",
    "create_sample_gold_set",
    "load_gold_set",
    "run_benchmark",
]
