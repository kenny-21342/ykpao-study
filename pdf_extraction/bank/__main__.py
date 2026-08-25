#!/usr/bin/env python3
"""
Entry point for `python -m pdf_extraction.bank`.

Delegates to the CLI module.
"""
from __future__ import annotations

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
