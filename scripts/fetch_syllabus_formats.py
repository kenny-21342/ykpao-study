"""
Fetch the official assessment overview for every syllabus we serve.

Why this exists
---------------
`lib/paper-templates.ts` measures a paper's shape from the papers we extracted:
how many questions, and what each position is worth. That is the only place a
per-question mark ladder can come from -- no syllabus states it.

What it cannot give is the *official* figures, because our extraction is
lossy. Measured against production on 27 Sep 2026, Physics 0625 Paper 4 came
out at 9 questions and 70 marks; the syllabus says 80 marks in 1 hour 15,
called "Theory (Extended)". A student pacing themselves against 70 marks is
being told something untrue about the exam they are sitting.

So this fetches the facts only the syllabus has -- paper name, official total,
duration, weighting -- to be overlaid on the measured ladder. Two sources,
each answering what it alone can, the same split the AI model picker uses
between the gateway's own list and the status page.

Stages, each writing its output so a failure costs one stage and not the run:

  discover  subject name -> Cambridge subject page -> syllabus PDF URL
  download  fetch each PDF once, cached on disk by URL
  extract   pull the text of the "Assessment overview" pages

Parsing that text into figures is deliberately NOT done here -- see
`scripts/parse_syllabus_formats.mjs`. The overview is a two-column table that
flattens into "two paper names, then two blocks of figures", and the column
count differs between syllabuses, so positional parsing is guesswork. That
step uses a model and is checked against the corpus.

Usage:
    python3 scripts/fetch_syllabus_formats.py            # all CAIE syllabuses
    python3 scripts/fetch_syllabus_formats.py 0625 0620  # just these
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

import requests

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover - the message is the whole point
    sys.exit("PyMuPDF is required: pip install pymupdf")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ops" / "syllabus"
PDFS = OUT / "pdf"
TEXT = OUT / "text"
MANIFEST = OUT / "sources.json"
TOPICS = ROOT / "pdf_extraction" / "bank" / "syllabus_topics.json"

BASE = "https://www.cambridgeinternational.org"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

# Cambridge's own page naming differs from the names in `syllabus_topics.json`,
# and not in one consistent way, so every one of these was verified by fetching
# it rather than derived. The pattern, where there is one, is that Cambridge
# puts the *subject* first and the qualifier second -- "Mathematics -
# Additional", "English - First Language" -- where we and everyone else say
# "Additional Mathematics". 0475 is stranger still: its page carries no
# qualification prefix at all.
#
# A wrong slug is not a 404 here. Cambridge answers an unknown subject page
# with a 500, which is why these have to be confirmed one at a time and cannot
# be told apart from the site being down.
SLUG_OVERRIDES = {
    "0400": "cambridge-igcse-art-and-design-0400",
    "0475": "english-literature-0475",
    "0500": "cambridge-igcse-english-first-language-0500",
    "0509": "cambridge-igcse-chinese-first-language-0509",
    "0606": "cambridge-igcse-mathematics-additional-0606",
    "0607": "cambridge-igcse-international-mathematics-0607",
    "9231": "cambridge-international-as-and-a-level-mathematics-further-9231",
    "9709": "cambridge-international-as-and-a-level-mathematics-9709",
}

# A retired syllabus has no subject page left -- Cambridge removes it once the
# replacement takes over -- but the final PDF stays on the CDN. 9608 ran to
# 2021 and was replaced by 9618; our corpus holds its papers, so the 9608
# syllabus is the one that describes them, not 9618's.
PDF_OVERRIDES = {
    "9608": ("2021", f"{BASE}/Images/502960-2021-syllabus.pdf"),
}

# The years our extracted papers actually span. This is the whole point of the
# selection below: a subject page links only the current and upcoming
# syllabuses, so "the newest one" is routinely a paper structure that no paper
# we hold was ever sat under. Physics 9702's newest is 2028-2030; our papers
# stop at 2025.
CORPUS_YEARS = (2016, 2025)


def _years_range(years: str) -> tuple[int, int]:
    """'2023-2025' -> (2023, 2025); '2029' -> (2029, 2029)."""
    parts = years.split("-")
    lo = int(parts[0])
    return (lo, int(parts[1]) if len(parts) > 1 else lo)


def _overlap(years: str) -> int:
    """How many of our corpus years this syllabus actually governs."""
    lo, hi = _years_range(years)
    return max(0, min(hi, CORPUS_YEARS[1]) - max(lo, CORPUS_YEARS[0]) + 1)


def slug_for(code: str, name: str) -> str:
    if code in SLUG_OVERRIDES:
        return SLUG_OVERRIDES[code]
    # "Cambridge IGCSE Physics 0625" -> subject words between the qualification
    # and the code.
    body = re.sub(r"\(retired \d+\)", "", name).strip()
    body = re.sub(r"\s*\d{4}\s*$", "", body)
    is_a_level = bool(re.search(r"A[ -]Level|AS & A", body, re.I))
    subject = re.sub(r"^(Cambridge\s+)?(IGCSE|AS & A Level|A-Level|International)\s*", "", body, flags=re.I)
    subject = subject.replace("&", "and")
    subject = re.sub(r"[()]", "", subject)
    subject = re.sub(r"[^A-Za-z0-9]+", "-", subject).strip("-").lower()
    prefix = "cambridge-international-as-and-a-level" if is_a_level else "cambridge-igcse"
    return f"{prefix}-{subject}-{code}"


def discover(code: str, name: str, session: requests.Session) -> dict | None:
    """Subject page -> the syllabus PDF that best covers our corpus years."""
    if code in PDF_OVERRIDES:
        years, url = PDF_OVERRIDES[code]
        return {"code": code, "name": name, "slug": None, "years": years,
                "url": url, "overlap": _overlap(years),
                "retired": True}

    slug = slug_for(code, name)
    url = f"{BASE}/programmes-and-qualifications/{slug}/"
    res = session.get(url, headers=HEADERS, timeout=40)
    if res.status_code != 200:
        # Cambridge returns 500, not 404, for a subject page that does not
        # exist, so this cannot distinguish a wrong slug from an outage.
        print(f"  {code}: subject page {res.status_code} at {slug}")
        return None

    # Syllabus PDFs only -- the same pages link grade thresholds, specimen
    # papers and "syllabus update" notes, none of which carry the overview.
    found = re.findall(r'/[Ii]mages/(\d+)-(\d{4}(?:-\d{4})?)-syllabus\.pdf', res.text)
    if not found:
        print(f"  {code}: no syllabus PDF linked on {slug}")
        return None

    # Pick by how much of our corpus the syllabus actually governs, not by
    # recency. A fixed list of preferred year-spans was tried first and was
    # wrong for half the subjects: the spans are per-subject ("2024-2026",
    # "2025-2027", a bare "2025"), so anything not on the list fell through to
    # "newest", which is exactly the syllabus our papers were never sat under.
    by_years = {years: ident for ident, years in found}
    best = max(by_years, key=lambda y: (_overlap(y), _years_range(y)[1]))
    overlap = _overlap(best)
    if not overlap:
        print(f"  {code}: WARNING no syllabus overlaps {CORPUS_YEARS[0]}-{CORPUS_YEARS[1]}; "
              f"using {best} of {sorted(by_years)}")
    return {
        "code": code, "name": name, "slug": slug, "years": best,
        "url": f"{BASE}/Images/{by_years[best]}-{best}-syllabus.pdf",
        "overlap": overlap,
    }


def download(entry: dict, session: requests.Session) -> Path | None:
    PDFS.mkdir(parents=True, exist_ok=True)
    target = PDFS / f"{entry['code']}-{entry['years']}.pdf"
    if target.exists() and target.stat().st_size > 50_000:
        return target
    res = session.get(entry["url"], headers=HEADERS, timeout=90)
    if res.status_code != 200 or not res.content.startswith(b"%PDF"):
        print(f"  {entry['code']}: download failed ({res.status_code})")
        return None
    target.write_bytes(res.content)
    return target


def extract_overview(pdf: Path) -> str | None:
    """
    The assessment-overview pages, as text.

    Takes the page carrying the heading plus the one after it: several
    syllabuses run the table across a page break, and cutting it in half loses
    whole papers -- which reads as a subject that simply does not have a Paper
    4 rather than as a parsing failure.
    """
    doc = fitz.open(pdf)
    pages: list[str] = []
    for i in range(doc.page_count):
        text = doc[i].get_text()
        # The contents page lists the heading too; the real section has the
        # figures under it.
        # Syllabuses retired before ~2022 head this section "Assessment at a
        # glance" instead; 9608 is the one we still serve papers for.
        if re.search(r"^\s*Assessment (overview|at a glance)\s*$", text, re.M) and re.search(r"\d+\s*marks", text):
            pages.append(text)
            if i + 1 < doc.page_count:
                nxt = doc[i + 1].get_text()
                if re.search(r"\d+\s*marks", nxt):
                    pages.append(nxt)
            break
    return "\n".join(pages) if pages else None


def main() -> int:
    args = sys.argv[1:]
    rediscover = "--rediscover" in args
    args = [a for a in args if not a.startswith("--")]
    names = {c: v["context"] for c, v in json.loads(TOPICS.read_text()).items()}
    wanted = args or sorted(names)
    OUT.mkdir(parents=True, exist_ok=True)
    TEXT.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    session = requests.Session()
    ok = failed = 0

    for code in wanted:
        name = names.get(code)
        if not name:
            print(f"  {code}: no name in syllabus_topics.json")
            failed += 1
            continue
        print(f"{code} {name}")
        # Entries written before year-overlap selection existed carry no
        # `overlap` key and were chosen by recency, so half of them point at a
        # syllabus our papers predate. Re-discover those rather than trusting
        # the cache -- it is one request and the alternative is silently
        # describing the wrong exam.
        cached = manifest.get(code)
        if cached is not None and (rediscover or "overlap" not in cached):
            cached = None
        entry = cached or discover(code, name, session)
        if not entry:
            failed += 1
            continue
        pdf = download(entry, session)
        if not pdf:
            failed += 1
            continue
        overview = extract_overview(pdf)
        if not overview:
            print(f"  {code}: no assessment overview found in the PDF")
            failed += 1
            continue
        (TEXT / f"{code}.txt").write_text(overview)
        entry["pages_chars"] = len(overview)
        manifest[code] = entry
        MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        flag = "" if entry.get("overlap") else "  [NO CORPUS OVERLAP]"
        print(f"  ok  {entry['years']}  {len(overview)} chars{flag}")
        ok += 1
        time.sleep(0.5)  # a courtesy to someone else's server, not a limit

    print(f"\n{ok} ok, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
