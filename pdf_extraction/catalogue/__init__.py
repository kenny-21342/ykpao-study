"""Paper catalogue: filename/path parsing for the past paper browser.

This is deliberately separate from the v3 extraction pipeline. The browser only
needs paper-level identity (board, subject, year, series, paper) and never looks
at question content, so it must not depend on extraction state.
"""

from .parser import (
    CatalogueEntry,
    ParseError,
    parse_caie_path,
    parse_ib_path,
    parse_path,
)

__all__ = [
    "CatalogueEntry",
    "ParseError",
    "parse_caie_path",
    "parse_ib_path",
    "parse_path",
]
