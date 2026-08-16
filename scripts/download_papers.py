#!/usr/bin/env python3
"""
Download IB past papers from websites without Cloudflare protection.
"""

import requests
from pathlib import Path
from urllib.parse import urljoin, urlparse
import time

def download_pdf(url: str, save_dir: str = "downloads", filename: str = None):
    """Download a single PDF file."""
    save_path = Path(save_dir)
    save_path.mkdir(exist_ok=True)

    if not filename:
        filename = Path(urlparse(url).path).name or "paper.pdf"

    filepath = save_path / filename

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
        return filepath

    except Exception as e:
        print(f"✗ Failed: {filename} - {e}")
        return None

def download_multiple(urls: list, save_dir: str = "downloads", delay: float = 1.0):
    """Download multiple PDFs with rate limiting."""
    for i, url in enumerate(urls, 1):
        print(f"[{i}/{len(urls)}] Downloading: {url}")
        download_pdf(url, save_dir)

        if i < len(urls):
            time.sleep(delay)

if __name__ == "__main__":
    # Example usage
    urls = [
        "https://example.com/paper1.pdf",
        "https://example.com/paper2.pdf",
    ]

    download_multiple(urls, save_dir="ib_papers")
