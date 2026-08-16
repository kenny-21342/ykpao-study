#!/usr/bin/env python3
"""
Scrape and download IB past papers from a website.
Extracts PDF links from a page and downloads them.
"""

import requests
from bs4 import BeautifulSoup
from pathlib import Path
from urllib.parse import urljoin
import time
import re

def scrape_pdf_links(url: str):
    """Extract all PDF links from a webpage."""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    }

    response = requests.get(url, headers=headers, timeout=30)
    response.raise_for_status()

    soup = BeautifulSoup(response.content, 'html.parser')
    pdf_links = []

    # Find all links ending in .pdf
    for link in soup.find_all('a', href=True):
        href = link['href']
        if href.endswith('.pdf') or 'pdf' in href.lower():
            absolute_url = urljoin(url, href)
            pdf_links.append(absolute_url)

    return list(set(pdf_links))

def download_pdf(url: str, save_dir: Path):
    """Download a PDF file."""
    filename = Path(url).name or f"paper_{hash(url)}.pdf"
    filepath = save_dir / filename

    if filepath.exists():
        print(f"⊙ Skipped (exists): {filename}")
        return

    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    }

    try:
        response = requests.get(url, headers=headers, stream=True, timeout=30)
        response.raise_for_status()

        with open(filepath, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)

        print(f"✓ Downloaded: {filename}")

    except Exception as e:
        print(f"✗ Failed: {filename} - {e}")

def download_from_page(page_url: str, save_dir: str = "ib_papers"):
    """Scrape a page and download all PDFs."""
    save_path = Path(save_dir)
    save_path.mkdir(exist_ok=True)

    print(f"Scraping: {page_url}")
    pdf_links = scrape_pdf_links(page_url)

    print(f"Found {len(pdf_links)} PDF(s)\n")

    for i, url in enumerate(pdf_links, 1):
        print(f"[{i}/{len(pdf_links)}] {url}")
        download_pdf(url, save_path)
        time.sleep(0.5)

    print(f"\nDone! Downloaded to: {save_path}")

if __name__ == "__main__":
    # Example: scrape IB papers from a page
    page_url = input("Enter the webpage URL containing PDF links: ").strip()
    save_dir = input("Save directory [ib_papers]: ").strip() or "ib_papers"

    download_from_page(page_url, save_dir)
