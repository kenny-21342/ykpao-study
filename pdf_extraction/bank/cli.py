#!/usr/bin/env python3
"""
Command-line interface for the v4 extraction bank.

Provides commands for initializing the store, merging to Neon, and running
benchmarks. This is the main entrypoint for pipeline operations.

Usage:
  python -m pdf_extraction.bank.cli init-store
  python -m pdf_extraction.bank.cli merge [--dry-run]
  python -m pdf_extraction.bank.cli gold-benchmark
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def cmd_init_store(args: argparse.Namespace) -> int:
    """Initialize the SQLite extraction store."""
    from .init_store import main as init_main

    try:
        init_main()
        return 0
    except Exception as e:
        print(f"✗ Failed to initialize store: {e}", file=sys.stderr)
        return 1


def cmd_merge(args: argparse.Namespace) -> int:
    """Merge local SQLite to Neon Postgres."""
    from .merge_to_neon import main as merge_main

    sys.argv = ["merge_to_neon.py"]
    if args.dry_run:
        sys.argv.append("--dry-run")
    if args.source:
        sys.argv.extend(["--source", args.source])

    try:
        merge_main()
        return 0
    except Exception as e:
        print(f"✗ Merge failed: {e}", file=sys.stderr)
        return 1


def cmd_gold_benchmark(args: argparse.Namespace) -> int:
    """Run gold set benchmark (placeholder for stage 7)."""
    print("Gold benchmark command will be implemented in stage 7.")
    print("This will verify the pipeline against a hand-checked set of ~20 real questions.")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="V4 extraction bank CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Commands:
  init-store        Initialize the SQLite extraction store
  merge             Merge local SQLite to Neon Postgres
  gold-benchmark    Run gold set benchmark (stage 7)

Examples:
  python -m pdf_extraction.bank.cli init-store
  python -m pdf_extraction.bank.cli merge --dry-run
  python -m pdf_extraction.bank.cli merge --source custom.db
        """,
    )

    parser.add_argument(
        "command",
        choices=["init-store", "merge", "gold-benchmark"],
        help="Command to run",
    )

    # Merge-specific arguments (parsed only for the merge command)
    args, remaining = parser.parse_known_args()

    if args.command == "merge":
        merge_parser = argparse.ArgumentParser()
        merge_parser.add_argument("--source", help="Source SQLite file")
        merge_parser.add_argument("--dry-run", action="store_true", help="Show counts without writing")
        merge_args = merge_parser.parse_args(remaining)
        return cmd_merge(merge_args)

    if args.command == "init-store":
        return cmd_init_store(args)

    if args.command == "gold-benchmark":
        return cmd_gold_benchmark(args)

    return 1


if __name__ == "__main__":
    sys.exit(main())
