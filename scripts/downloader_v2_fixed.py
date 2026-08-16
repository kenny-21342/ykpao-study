#!/usr/bin/env python3
"""
Downloader v2 (Fixed) — fast, resilient past-paper downloader.

FIXES from v4 pipeline plan:
1. Mathematics-0580 and Additional-Mathematics-0606 now in CURRICULA (were missing)
2. Cloudflare blocking detection with explicit error reporting
3. Timeout errors logged separately (not swallowed by bare except)
4. Proper timeout=(120, 300) tuple for connect+read split
5. Batched cache flushing (not on every write)
6. find_gaps() now reports insert-file gaps
7. Corpus reconciliation to catch un-ingested PDFs on disk

Usage:
  python downloader_v2_fixed.py                    # full run
  python downloader_v2_fixed.py --gap-fill         # download only missing
  python downloader_v2_fixed.py --subject Biology-0610
  python downloader_v2_fixed.py --verify           # check existing PDFs
  python downloader_v2_fixed.py --rebuild-cache    # rebuild from disk
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import fitz
from curl_cffi.requests import AsyncSession

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------

CURRICULA: dict[str, dict] = {
    "IGCSE": {
        "base_url": "https://pastpapers.co/api/file/caie/IGCSE",
        "subjects": {
            "Biology-0610":                 {"code": "0610", "types": ["qp", "ms", "in"]},
            "Chemistry-0620":               {"code": "0620", "types": ["qp", "ms", "in"]},
            "Physics-0625":                 {"code": "0625", "types": ["qp", "ms", "in"]},
            "Mathematics-0580":             {"code": "0580", "types": ["qp", "ms"]},  # FIX 1: was missing
            "Additional-Mathematics-0606":  {"code": "0606", "types": ["qp", "ms"]},  # FIX 1: was missing
            "Mathematics-International-0607": {"code": "0607", "types": ["qp", "ms"]},
            "Computer-Science-0478":        {"code": "0478", "types": ["qp", "ms"]},
            "Economics-0455":               {"code": "0455", "types": ["qp", "ms"]},
            "English-First-Language-0500":  {"code": "0500", "types": ["qp", "ms", "in"]},
            "Geography-0460":               {"code": "0460", "types": ["qp", "ms", "in"]},
            "History-0470":                 {"code": "0470", "types": ["qp", "ms"]},
            "Chinese-First-Language-0509":  {"code": "0509", "types": ["qp", "ms", "in"]},
        },
    },
    "A-Level": {
        "base_url": "https://pastpapers.co/api/file/caie/A-Level",
        "subjects": {
            "Mathematics-9709":             {"code": "9709", "types": ["qp", "ms"]},
            "Mathematics-Further-9231":     {"code": "9231", "types": ["qp", "ms"]},
            "Physics-9702":                 {"code": "9702", "types": ["qp", "ms"]},
            "Economics-9708":               {"code": "9708", "types": ["qp", "ms"]},
            "Computer-Science-9608":        {"code": "9608", "types": ["qp", "ms"]},
            "Computer-Science-9618":        {"code": "9618", "types": ["qp", "ms"]},
        },
    },
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Referer": "https://pastpapers.co/",
    "Accept": "application/pdf,*/*",
}

OUTPUT_DIR = Path("./pdf_extraction/my_raw_pdfs")
CACHE_FILE = Path(".download_cache.json")

START_YEAR = 2015
END_YEAR = 2025

ALL_SESSIONS = ["s", "w", "m"]
SESSION_FOLDER = {"s": "May-June", "w": "Oct-Nov", "m": "March"}
LEGACY_SESSION_FOLDER = {"s": "Jun", "w": "Nov", "m": "Mar"}

ALL_VARIANTS = [
    "11", "12", "13", "21", "22", "23", "31", "32", "33",
    "41", "42", "43", "51", "52", "53", "61", "62", "63",
]

# ---------------------------------------------------------------------------
# CACHE (FIX 5: batched flushing)
# ---------------------------------------------------------------------------

_cache: dict[str, str] = {}
_cache_dirty = 0
_CACHE_FLUSH_EVERY = 50  # flush every 50 writes, not every write


def load_cache() -> None:
    global _cache
    if CACHE_FILE.exists():
        try:
            _cache = json.loads(CACHE_FILE.read_text())
            print(f"Loaded cache: {len(_cache)} entries")
        except Exception as e:
            print(f"Cache load failed: {e}")
            _cache = {}


def flush_cache(force: bool = False) -> None:
    global _cache_dirty
    if force or _cache_dirty >= _CACHE_FLUSH_EVERY:
        CACHE_FILE.write_text(json.dumps(_cache, indent=2))
        _cache_dirty = 0


def cache_set(key: str, path: str) -> None:
    global _cache_dirty
    _cache[key] = path
    _cache_dirty += 1
    # FIX 5: Only flush when threshold is reached, not on every write
    if _cache_dirty >= _CACHE_FLUSH_EVERY:
        flush_cache()


def rebuild_cache_from_disk() -> None:
    """FIX 7: Rebuild cache from files on disk."""
    global _cache
    _cache = {}
    count = 0
    for pdf in OUTPUT_DIR.rglob("*.pdf"):
        if verify_pdf(pdf):
            # Build cache key from path structure
            parts = pdf.relative_to(OUTPUT_DIR).parts
            if len(parts) >= 3:
                curriculum = parts[0]
                subject = parts[1]
                filename = pdf.name
                key = f"{curriculum}/{subject}/{filename}"
                _cache[key] = str(pdf)
                count += 1
    flush_cache(force=True)
    print(f"Rebuilt cache: {count} valid PDFs")


# ---------------------------------------------------------------------------
# PDF VERIFICATION
# ---------------------------------------------------------------------------

def verify_pdf(path: Path) -> bool:
    """True if path is a real, non-corrupted PDF with ≥2 pages."""
    try:
        if not path.exists() or path.stat().st_size < 2000:
            return False
        with open(path, "rb") as f:
            if f.read(5) != b"%PDF-":
                return False
        doc = fitz.open(path)
        ok = doc.page_count >= 2 and (
            any(len(doc[i].get_text().strip()) > 20 for i in range(min(doc.page_count, 5)))
            or any(len(doc[i].get_images()) > 0 for i in range(min(doc.page_count, 5)))
        )
        doc.close()
        return ok
    except Exception:
        return False


# ---------------------------------------------------------------------------
# URL BUILDER
# ---------------------------------------------------------------------------

def folder_for_year_session(year: int, session: str) -> str:
    if year < 2018:
        return f"{year}/{year} {LEGACY_SESSION_FOLDER[session]}"
    return f"{year}-{SESSION_FOLDER[session]}"


def build_url(base_url: str, subject_folder: str, year: int, session: str, filename: str) -> str:
    return f"{base_url}/{subject_folder}/{folder_for_year_session(year, session)}/{filename}"


# ---------------------------------------------------------------------------
# DISCOVERY (FIX 2: explicit Cloudflare detection)
# ---------------------------------------------------------------------------

_cloudflare_blocked_count = 0


async def discover_files(
    session: AsyncSession,
    sem: asyncio.Semaphore,
    base_url: str,
    subject_folder: str,
    year: int,
    sess: str,
) -> tuple[set[str], bool]:
    """
    List .pdf filenames for one (subject, year, session) combo.

    FIX 2: Returns (filenames, cloudflare_blocked) so caller can report.
    """
    global _cloudflare_blocked_count
    list_url = f"{base_url}/{subject_folder}/{folder_for_year_session(year, sess)}"
    async with sem:
        try:
            resp = await session.get(list_url, headers=HEADERS, impersonate="chrome124", timeout=30)
            if getattr(resp, "status_code", 200) != 200:
                return (set(), False)
            body = resp.text if hasattr(resp, "text") else resp.content.decode("utf-8", "ignore")

            # FIX 2: Detect Cloudflare challenge
            if "Just a moment" in body[:500] or "<!DOCTYPE html>" in body[:50]:
                _cloudflare_blocked_count += 1
                return (set(), True)

            return ({Path(m).name for m in re.findall(r"([\w/]+\.pdf)", body, re.IGNORECASE)}, False)
        except Exception as e:
            return (set(), False)


async def discover_all(
    session: AsyncSession,
    subjects: list[tuple[str, str, dict]],
    concurrency: int,
) -> dict[tuple[str, int, str], set[str]]:
    """
    Discover available files for all (subject, year, session) combos.
    FIX 2: Reports Cloudflare blocking explicitly.
    """
    global _cloudflare_blocked_count
    _cloudflare_blocked_count = 0

    sem = asyncio.Semaphore(concurrency)
    tasks: list[asyncio.Task] = []
    index: dict[int, tuple[str, int, str]] = {}

    for i, (curriculum, folder, cfg) in enumerate(subjects):
        base_url = CURRICULA[curriculum]["base_url"]
        for year in range(START_YEAR, END_YEAR + 1):
            for sess in ALL_SESSIONS:
                task_i = len(tasks)
                index[task_i] = (f"{curriculum}/{folder}", year, sess)
                tasks.append(asyncio.create_task(
                    discover_files(session, sem, base_url, folder, year, sess)
                ))

    print(f"Discovery: {len(tasks)} directory listings...")
    results = await asyncio.gather(*tasks)

    # FIX 2: Report Cloudflare blocking
    if _cloudflare_blocked_count > 0:
        print(f"⚠️  Cloudflare blocked {_cloudflare_blocked_count} listings - falling back to variant probing")

    return {index[i]: results[i][0] for i in range(len(tasks)) if results[i][0]}


# ---------------------------------------------------------------------------
# DOWNLOAD (FIX 3 & 4: proper timeout + error logging)
# ---------------------------------------------------------------------------

_error_counts: dict[str, int] = {"timeout": 0, "404": 0, "5xx": 0, "other": 0}


async def download_one(
    session: AsyncSession,
    sem: asyncio.Semaphore,
    url: str,
    dest: Path,
    max_retries: int = 3,
) -> bool:
    """
    Download with retry.
    FIX 3: Timeout errors logged separately
    FIX 4: timeout=(120, 300) for connect+read split (docstring was correct, code wasn't)
    """
    global _error_counts
    part = dest.with_suffix(".part")

    async with sem:
        for attempt in range(max_retries):
            try:
                resp = await session.get(
                    url, headers=HEADERS, impersonate="chrome124",
                    timeout=(120, 300),  # FIX 4: (connect, read) split
                )
                status = getattr(resp, "status_code", 200)

                if status == 404:
                    _error_counts["404"] += 1
                    return False
                if status == 429:
                    await asyncio.sleep(5 * (attempt + 1))
                    continue
                if status >= 500:
                    _error_counts["5xx"] += 1
                    await asyncio.sleep(2 ** attempt)
                    continue
                if status != 200:
                    _error_counts["other"] += 1
                    return False

                content = resp.content if hasattr(resp, "content") else bytes(resp)
                dest.parent.mkdir(parents=True, exist_ok=True)
                part.write_bytes(content)

                if verify_pdf(part):
                    part.rename(dest)
                    return True
                else:
                    part.unlink(missing_ok=True)
                    if attempt < max_retries - 1:
                        await asyncio.sleep(2 ** attempt)
                        continue
                    _error_counts["other"] += 1
                    return False

            except asyncio.TimeoutError:
                # FIX 3: Explicit timeout logging
                _error_counts["timeout"] += 1
                if attempt < max_retries - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                return False
            except Exception as e:
                # FIX 3: Log other errors
                _error_counts["other"] += 1
                if attempt < max_retries - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                return False

    return False


# ---------------------------------------------------------------------------
# GAP ANALYSIS (FIX 6: report insert-file gaps)
# ---------------------------------------------------------------------------

def find_gaps() -> list[dict[str, Any]]:
    """
    Find missing MS pairs and insert files.
    FIX 6: Now actually reports insert-file gaps.
    """
    gaps: list[dict[str, Any]] = []
    for curriculum, config in CURRICULA.items():
        for folder, cfg in config["subjects"].items():
            dir_lower = OUTPUT_DIR / curriculum.lower() / folder.lower()
            if not dir_lower.exists():
                continue

            qps = sorted(dir_lower.glob(f"{cfg['code']}_*_qp_*.pdf"))

            for qp in qps:
                # Check MS pair
                ms_name = qp.name.replace("_qp_", "_ms_")
                ms_path = dir_lower / ms_name
                if not ms_path.exists() or not verify_pdf(ms_path):
                    gaps.append({
                        "filename": ms_name,
                        "subject_folder": folder,
                        "curriculum": curriculum,
                        "code": cfg["code"],
                        "reason": f"missing MS for {qp.name}",
                        "year": _extract_year(qp.name),
                        "session": _extract_session(qp.name),
                    })

                # FIX 6: Check insert files
                if "in" in cfg["types"]:
                    # Extract paper number (11, 12, etc.)
                    paper_match = re.search(r"_qp_(\d{2})", qp.name)
                    if paper_match:
                        paper_num = paper_match.group(1)
                        # Inserts use first variant only (11, 21, 31, etc.)
                        if paper_num.endswith("1"):
                            in_name = qp.name.replace(f"_qp_{paper_num}", f"_in_{paper_num}")
                            in_path = dir_lower / in_name
                            if not in_path.exists() or not verify_pdf(in_path):
                                gaps.append({
                                    "filename": in_name,
                                    "subject_folder": folder,
                                    "curriculum": curriculum,
                                    "code": cfg["code"],
                                    "reason": f"missing INSERT for {qp.name}",
                                    "year": _extract_year(qp.name),
                                    "session": _extract_session(qp.name),
                                })

    return gaps


def _extract_year(filename: str) -> int:
    m = re.search(r"_[swm](\d{2})_", filename)
    return 2000 + int(m.group(1)) if m else 2020


def _extract_session(filename: str) -> str:
    m = re.search(r"_([swm])\d{2}_", filename)
    return m.group(1) if m else "s"


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

async def run_download(
    subjects_filter: str | None,
    concurrency: int,
    gap_fill: bool,
) -> None:
    load_cache()

    subjects: list[tuple[str, str, dict]] = []
    for curriculum, config in CURRICULA.items():
        for folder, cfg in config["subjects"].items():
            if subjects_filter and subjects_filter.lower() not in folder.lower():
                continue
            subjects.append((curriculum, folder, cfg))

    if not subjects:
        print("No subjects matched filter.")
        return

    print(f"Subjects: {[s[1] for s in subjects]}")
    print(f"Years: {START_YEAR}-{END_YEAR}, Concurrency: {concurrency}\n")

    async with AsyncSession() as http:
        file_map = await discover_all(http, subjects, concurrency=max(4, concurrency // 2))
        total_found = sum(len(v) for v in file_map.values())
        print(f"Discovery: {total_found} files found\n")

        # Build download queue
        queue: list[tuple[str, Path, str]] = []
        skipped = 0

        for curriculum, folder, cfg in subjects:
            base_url = CURRICULA[curriculum]["base_url"]
            code = cfg["code"]
            dir_lower = OUTPUT_DIR / curriculum.lower() / folder.lower()

            for year in range(START_YEAR, END_YEAR + 1):
                for sess in ALL_SESSIONS:
                    key = f"{curriculum}/{folder}"
                    available = file_map.get((key, year, sess), set())

                    # Probe all variants when discovery is empty
                    if not available:
                        available = {
                            f"{code}_{sess}{year % 100:02d}_{dt}_{var}.pdf"
                            for dt in cfg["types"] for var in ALL_VARIANTS
                        }

                    for filename in available:
                        cache_key = f"{curriculum}/{folder}/{filename}"
                        dest = dir_lower / filename

                        if gap_fill and dest.exists() and verify_pdf(dest):
                            skipped += 1
                            continue

                        if cache_key in _cache and Path(_cache[cache_key]).exists():
                            skipped += 1
                            continue

                        url = build_url(base_url, folder, year, sess, filename)
                        queue.append((cache_key, dest, url))

        print(f"Queue: {len(queue)} downloads, {skipped} skipped\n")

        # Download
        sem = asyncio.Semaphore(concurrency)
        tasks = [asyncio.create_task(download_one(http, sem, url, dest)) for _, dest, url in queue]

        done = 0
        for i, task in enumerate(asyncio.as_completed(tasks)):
            success = await task
            if success:
                cache_key, dest, _ = queue[i]
                cache_set(cache_key, str(dest))
                done += 1
                if done % 50 == 0:
                    print(f"Progress: {done}/{len(queue)}")

        flush_cache(force=True)

        # FIX 3: Report error breakdown
        print(f"\nComplete: {done}/{len(queue)} succeeded")
        print(f"Errors: {_error_counts}")


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="CAIE past-paper downloader (v2 fixed)")
    parser.add_argument("--subject", help="Filter to one subject")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--gap-fill", action="store_true")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--rebuild-cache", action="store_true")
    args = parser.parse_args()

    if args.rebuild_cache:
        rebuild_cache_from_disk()
        return

    if args.verify:
        corrupt = []
        for p in OUTPUT_DIR.rglob("*.pdf"):
            if not verify_pdf(p):
                corrupt.append(p)
        if corrupt:
            print(f"Found {len(corrupt)} corrupt PDFs:")
            for p in corrupt:
                print(f"  {p}")
        else:
            print("All PDFs verified OK")
        return

    asyncio.run(run_download(args.subject, args.concurrency, args.gap_fill))


if __name__ == "__main__":
    main()
