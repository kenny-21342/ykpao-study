"""Offline, review-only root-question image extraction."""

from .models import (
    CorpusManifest,
    QuestionImageRecord,
    SourceRegion,
    DETECTOR_VERSION,
)
from .pipeline import PipelineConfig, process_document

__all__ = [
    "CorpusManifest",
    "DETECTOR_VERSION",
    "PipelineConfig",
    "QuestionImageRecord",
    "SourceRegion",
    "process_document",
]
