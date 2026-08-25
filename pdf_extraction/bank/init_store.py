#!/usr/bin/env python3
"""
Initialize the v4 extraction store SQLite database.

Creates pdf_extraction/bank/extract.db and applies the schema DDL.
Idempotent: running multiple times is safe (the DB is created fresh).

Usage:
  python3 pdf_extraction/bank/init_store.py
"""
from __future__ import annotations

import sqlite3
from pathlib import Path


def main():
    # Paths
    bank_dir = Path(__file__).parent
    schema_path = bank_dir / "schema.sql"
    db_path = bank_dir / "extract.db"

    # Remove existing DB if present
    if db_path.exists():
        print(f"Removing existing DB: {db_path}")
        db_path.unlink()

    # Read schema
    if not schema_path.exists():
        raise FileNotFoundError(f"Schema not found: {schema_path}")
    schema_ddl = schema_path.read_text()

    # Create database and apply schema
    print(f"Creating extraction store: {db_path}")
    conn = sqlite3.connect(str(db_path))

    # Use executescript to handle multi-line SQL and comments properly
    # This is the recommended way to apply a full schema DDL
    try:
        conn.executescript(schema_ddl)
    except Exception as e:
        print(f"  ✗ Schema application failed: {e}")
        conn.close()
        db_path.unlink()
        raise

    conn.commit()
    conn.close()

    # Verify tables were created
    conn = sqlite3.connect(str(db_path))
    tables = [
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bank_%' ORDER BY name"
        ).fetchall()
    ]
    conn.close()

    print(f"\n✓ Extraction store initialized with {len(tables)} tables:")
    for table in tables:
        print(f"  - {table}")
    print(f"\nDB location: {db_path}")


if __name__ == "__main__":
    main()
