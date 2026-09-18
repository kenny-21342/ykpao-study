"""
Central configuration: subjects, API key, constants.
Single source of truth shared by all extraction scripts.
"""
import os
from pathlib import Path

# ---------------------------------------------------------
# Paths
# ---------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent  # pdf_extraction/
CAISE_PDF_DIR = BASE_DIR / "my_raw_pdfs"
IB_PDF_DIR = BASE_DIR / "IB PAST PAPERS - YEAR"
IMAGES_DIR = BASE_DIR / "extracted_images"
DB_FILE = str(BASE_DIR / "papers.db")
IB_DB_FILE = str(BASE_DIR / "papers_ib.db")

# ---------------------------------------------------------
# DeepSeek API (NEVER hardcode — read from env)
# ---------------------------------------------------------
API_KEY = os.environ.get("DEEPSEEK_API_KEY")
API_URL = "https://api.deepseek.com/v1/chat/completions"
MODEL = "deepseek-chat"
MAX_TOKENS = 8192
TEMPERATURE = 0.1
REQUEST_TIMEOUT = 90
MAX_RETRIES = 3
RETRY_DELAY = 2

# ---------------------------------------------------------
# Canonical subject registry — code → display name.
# Fixes Problem 4 (placeholder "Subject XXXX" names).
# Drives both extraction and the UI dropdown.
# ---------------------------------------------------------
SUBJECTS = {
    # IGCSE / Cambridge Lower
    "0500": "English First Language",
    "0509": "Chinese First Language",
    "0455": "Economics",
    "0460": "Geography",
    "0470": "History",
    "0478": "Computer Science",
    "0606": "Additional Mathematics",
    "0607": "Mathematics (International)",
    "0610": "Biology",
    "0620": "Chemistry",
    "0625": "Physics",
    # A-Level
    "9709": "Mathematics",
    "9231": "Further Mathematics",
    "9702": "Physics",
    "9708": "Economics",
    "9608": "Computer Science",
    "9618": "Computer Science",
    # Legacy
    "0420": "Computer Studies",
    "0580": "Mathematics",
}

# Reverse: sometimes we only have a name and need the code.
NAME_TO_CODE = {v.lower(): k for k, v in SUBJECTS.items()}


def get_subject_name(code: str) -> str:
    """Return canonical subject name, or a readable fallback."""
    return SUBJECTS.get(code, f"Subject {code}")


# ---------------------------------------------------------
# Image extraction thresholds
# ---------------------------------------------------------
MIN_IMAGE_BYTES = 3000      # skip icons/logos (< 3 KB)
MIN_PAPER_PAGES = 2         # PDF verify: real papers have ≥ 2 pages
MAX_TEXT_CHARS = 40000      # single-pass API limit
MAX_INSERT_CHARS = 80000    # insert/booklet text limit
CHUNK_MAX_CHARS = 5000      # chunked extraction target
