#!/usr/bin/env python3
"""Check if a website uses Cloudflare protection."""

import requests

def check_cloudflare(url: str):
    """Test if a site uses Cloudflare."""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    }

    try:
        response = requests.get(url, headers=headers, timeout=10)

        # Check for Cloudflare indicators
        cf_indicators = [
            'cloudflare' in response.text.lower(),
            'cf-ray' in str(response.headers).lower(),
            response.status_code == 403,
            'checking your browser' in response.text.lower()
        ]

        if any(cf_indicators):
            print(f"❌ {url} - Uses Cloudflare")
            return True
        else:
            print(f"✓ {url} - No Cloudflare detected")
            return False

    except Exception as e:
        print(f"⚠ {url} - Error: {e}")
        return None

if __name__ == "__main__":
    # Test sites
    sites = [
        "https://ibdocuments.com",
        "https://ibresources.org",
        # Add more URLs to test
    ]

    for site in sites:
        check_cloudflare(site)
