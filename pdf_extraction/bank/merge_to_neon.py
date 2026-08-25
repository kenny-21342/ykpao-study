#!/usr/bin/env python3
"""
Merge v4 extraction store from local SQLite to Neon Postgres.

Reads from pdf_extraction/bank/extract.db and bulk-inserts into the Neon
Postgres bank_* tables. Idempotent: re-running won't duplicate rows
(uses ON CONFLICT ... DO NOTHING for idempotent inserts).

The v4 schema has one row per ROOT question, with sub-parts living inside
body_md. This is fundamentally different from v1/v2, which split sub-parts
into separate rows.

Usage:
  python3 pdf_extraction/bank/merge_to_neon.py                    # default: extract.db → Neon
  python3 pdf_extraction/bank/merge_to_neon.py --source other.db  # custom SQLite path
  python3 pdf_extraction/bank/merge_to_neon.py --dry-run          # show counts without writing
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path


def load_db_url() -> str:
    """Load DATABASE_URL from env or .env file."""
    url = os.environ.get("DATABASE_URL", "")
    if url:
        return url
    env_path = Path(__file__).parent.parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("DATABASE_URL not found in env or .env")


def main():
    parser = argparse.ArgumentParser(description="Merge v4 SQLite → Neon Postgres")
    parser.add_argument("--source", default="pdf_extraction/bank/extract.db", help="Source SQLite file")
    parser.add_argument("--dry-run", action="store_true", help="Show counts without writing")
    parser.add_argument(
        "--include-flagged",
        action="store_true",
        help=(
            "Also merge questions and mark schemes still marked needs_review. "
            "By default only published rows go to production: a needs_review "
            "row is one whose crop QA found the image itself wrong — a cut-off "
            "question number, a missing Marks column, an erased stem."
        ),
    )
    args = parser.parse_args()

    source_path = Path(args.source)
    if not source_path.exists():
        print(f"✗ Source SQLite not found: {source_path}")
        sys.exit(1)

    # ---- Open source (SQLite) ----
    src = sqlite3.connect(str(source_path))
    src.row_factory = sqlite3.Row

    # ---- Count source data ----
    counts = {}
    for table in [
        "bank_subjects", "bank_papers", "bank_questions", "bank_mark_schemes",
        "bank_assets", "bank_question_assets", "bank_mark_scheme_assets",
        "bank_question_strips", "bank_mark_scheme_strips",
        "bank_topics", "bank_question_topics", "bank_tags", "bank_question_tags",
        "bank_review_flags", "bank_run_ledger"
    ]:
        try:
            cur = src.execute(f"SELECT COUNT(*) FROM {table}")
            counts[table] = cur.fetchone()[0]
        except sqlite3.OperationalError:
            counts[table] = 0

    print("Source (SQLite v4 extraction store):")
    for t, c in counts.items():
        print(f"  {t}: {c}")

    if all(c == 0 for c in counts.values()):
        print("\nNothing to merge — source is empty.")
        return

    if args.dry_run:
        print("\n(dry-run — not writing to Neon)")
        src.close()
        return

    # ---- Open destination (Postgres) ----
    import psycopg2
    from psycopg2.extras import register_json

    db_url = load_db_url()
    print(f"\nDestination: {db_url.split('@')[1].split('/')[0] if '@' in db_url else 'Neon'}...")

    def connect_dst():
        conn = psycopg2.connect(db_url, keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3)
        register_json(conn)
        conn.autocommit = False
        return conn

    dst = connect_dst()

    def execute_with_retry(cur_func, max_retries=3):
        """Execute a cursor operation with reconnection on network failure."""
        nonlocal dst
        for attempt in range(max_retries):
            try:
                return cur_func(dst.cursor())
            except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
                print(f"\n  [DB] connection lost ({e.__class__.__name__}), retry {attempt+1}/{max_retries}...")
                try:
                    dst.rollback()
                except Exception:
                    pass
                try:
                    dst.close()
                except Exception:
                    pass
                time.sleep(3)
                dst = connect_dst()
            except Exception:
                raise
        raise RuntimeError(f"Failed after {max_retries} retries")

    # ---- Merge subjects ----
    print("\nMerging bank_subjects...")
    rows = src.execute('SELECT id, board, code, name, level FROM bank_subjects').fetchall()
    subject_id_map: dict[int, int] = {}

    # Pre-load existing subjects by (board, code, level) for idempotency
    with dst.cursor() as cur:
        cur.execute('SELECT id, board, code, level FROM bank_subjects')
        existing_subjects = {(row[1], row[2], row[3] or ''): row[0] for row in cur.fetchall()}

    with dst.cursor() as cur:
        for row in rows:
            old_id = row["id"]
            key = (row["board"], row["code"], row["level"] or '')
            if key in existing_subjects:
                subject_id_map[old_id] = existing_subjects[key]
                continue

            try:
                cur.execute("""
                    INSERT INTO bank_subjects (board, code, name, level)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (board, code, level) DO NOTHING
                    RETURNING id
                """, (row["board"], row["code"], row["name"], row["level"]))
                result = cur.fetchone()
                if result:
                    subject_id_map[old_id] = result[0]
                    existing_subjects[key] = result[0]
            except Exception as e:
                print(f"\n  ⚠ subject {row['code']}: {e}")
                dst.rollback()
                continue
    dst.commit()
    print(f"  ✓ {len(rows)} subjects ({len(subject_id_map)} mapped)")

    # ---- Merge papers ----
    print("Merging bank_papers...")
    rows = src.execute("""
        SELECT id, subject_id, board, year, session, paper_number, variant,
               timezone, doc_type, source_path, source_sha256, page_count,
               span_strategy, used_ocr, created_at
        FROM bank_papers
    """).fetchall()

    paper_id_map: dict[int, int] = {}
    skipped_existing = 0

    # Pre-load existing papers by sourcePath
    with dst.cursor() as cur:
        cur.execute('SELECT id, "sourcePath" FROM bank_papers')
        existing_papers = {row[1]: row[0] for row in cur.fetchall() if row[1]}
    print(f"  (found {len(existing_papers)} papers already in Postgres)")

    with dst.cursor() as cur:
        for i, row in enumerate(rows):
            old_id = row["id"]
            source_path = row["source_path"]

            if source_path in existing_papers:
                paper_id_map[old_id] = existing_papers[source_path]
                skipped_existing += 1
                continue

            old_subject_id = row["subject_id"]
            new_subject_id = subject_id_map.get(old_subject_id)
            if not new_subject_id:
                continue

            try:
                cur.execute("""
                    INSERT INTO bank_papers
                        ("subjectId", board, year, session, "paperNumber", variant,
                         timezone, "docType", "sourcePath", "sourceSha256", "pageCount",
                         "spanStrategy", "usedOcr", "createdAt")
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT ("sourcePath") DO NOTHING
                    RETURNING id
                """, (
                    new_subject_id, row["board"], row["year"], row["session"],
                    row["paper_number"], row["variant"], row["timezone"],
                    row["doc_type"], row["source_path"], row["source_sha256"],
                    row["page_count"], row["span_strategy"], row["used_ocr"],
                    row["created_at"],
                ))
                result = cur.fetchone()
                if result:
                    paper_id_map[old_id] = result[0]
                    existing_papers[source_path] = result[0]
            except Exception as e:
                print(f"\n  ⚠ paper {row['sourcePath']}: {e}")
                dst.rollback()
                continue

            if (i + 1) % 200 == 0:
                dst.commit()
                print(f"  ...{i+1}/{len(rows)} processed ({skipped_existing} already existed)")
    dst.commit()
    print(f"  ✓ {len(rows)} papers ({len(paper_id_map)} mapped, {skipped_existing} already existed)")

    # ---- Merge assets ----
    print("Merging bank_assets...")
    rows = src.execute("""
        SELECT id, sha256, kind, relative_path, width, height, byte_size,
               source_page, bbox, source_dpi, created_at
        FROM bank_assets
    """).fetchall()

    asset_id_map: dict[int, int] = {}
    skipped_assets = 0

    # Pre-load existing assets by sha256
    with dst.cursor() as cur:
        cur.execute('SELECT id, sha256 FROM bank_assets')
        existing_assets = {row[1]: row[0] for row in cur.fetchall() if row[1]}
    print(f"  (found {len(existing_assets)} assets already in Postgres)")

    with dst.cursor() as cur:
        for row in rows:
            old_id = row["id"]
            sha256 = row["sha256"]

            if sha256 in existing_assets:
                asset_id_map[old_id] = existing_assets[sha256]
                skipped_assets += 1
                continue

            try:
                cur.execute("""
                    INSERT INTO bank_assets
                        (sha256, kind, "relativePath", width, height, "byteSize",
                         "sourcePage", bbox, "sourceDpi", "createdAt")
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (sha256) DO NOTHING
                    RETURNING id
                """, (
                    sha256, row["kind"], row["relative_path"], row["width"],
                    row["height"], row["byte_size"], row["source_page"],
                    row["bbox"], row["source_dpi"], row["created_at"],
                ))
                result = cur.fetchone()
                if result:
                    asset_id_map[old_id] = result[0]
                    existing_assets[sha256] = result[0]
            except Exception as e:
                print(f"\n  ⚠ asset {row['sha256'][:8]}...: {e}")
                dst.rollback()
                continue
    dst.commit()
    print(f"  ✓ {len(rows)} assets ({len(asset_id_map)} mapped, {skipped_assets} already existed)")

    # ---- Merge questions ----
    print("Merging bank_questions...")
    rows = src.execute("""
        SELECT id, paper_id, root_number, body_md, parts, total_marks,
               screenshot_id, page_start, page_end, confidence, status,
               difficulty, difficulty_source, difficulty_rationale,
               run_id, model, prompt_version, created_at
        FROM bank_questions
    """).fetchall()

    if not args.include_flagged:
        before = len(rows)
        rows = [row for row in rows if row["status"] == "published"]
        held = before - len(rows)
        if held:
            print(f"  holding back {held} questions still marked needs_review "
                  f"(--include-flagged to merge them anyway)")

    question_id_map: dict[int, int] = {}
    skipped_q = 0

    # Pre-load existing questions by (paperId, rootNumber)
    with dst.cursor() as cur:
        cur.execute('SELECT id, "paperId", "rootNumber" FROM bank_questions')
        existing_q = {(row[1], row[2]): row[0] for row in cur.fetchall()}
    print(f"  (found {len(existing_q)} questions already in Postgres)")

    with dst.cursor() as cur:
        for i, row in enumerate(rows):
            old_id = row["id"]
            old_paper_id = row["paper_id"]
            new_paper_id = paper_id_map.get(old_paper_id)
            if not new_paper_id:
                continue

            q_key = (new_paper_id, row["root_number"])
            if q_key in existing_q:
                question_id_map[old_id] = existing_q[q_key]
                skipped_q += 1
                continue

            # Map screenshot asset if present
            screenshot_id = asset_id_map.get(row["screenshot_id"]) if row["screenshot_id"] else None

            try:
                cur.execute("""
                    INSERT INTO bank_questions
                        ("paperId", "rootNumber", "bodyMd", parts, "totalMarks",
                         "screenshotId", "pageStart", "pageEnd", confidence, status,
                         difficulty, "difficultySource", "difficultyRationale",
                         "runId", model, "promptVersion", "createdAt")
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT ("paperId", "rootNumber") DO NOTHING
                    RETURNING id
                """, (
                    new_paper_id, row["root_number"], row["body_md"], row["parts"],
                    row["total_marks"], screenshot_id, row["page_start"], row["page_end"],
                    row["confidence"], row["status"], row["difficulty"],
                    row["difficulty_source"], row["difficulty_rationale"],
                    row["run_id"], row["model"], row["prompt_version"], row["created_at"],
                ))
                result = cur.fetchone()
                if result:
                    question_id_map[old_id] = result[0]
                    existing_q[q_key] = result[0]
            except Exception as e:
                print(f"\n  ⚠ question Q{row['rootNumber']}: {e}")
                dst.rollback()
                continue

            if (i + 1) % 1000 == 0:
                dst.commit()
                print(f"  ...{i+1}/{len(rows)} processed ({skipped_q} already existed)")
    dst.commit()
    print(f"  ✓ {len(rows)} questions ({len(question_id_map)} mapped, {skipped_q} already existed)")

    # ---- Merge mark schemes ----
    print("Merging bank_mark_schemes...")
    rows = src.execute("""
        SELECT id, question_id, paper_id, root_number, answer_md,
               marking_points, total_marks, answer_letter,
               confidence, status, run_id, model, prompt_version, created_at
        FROM bank_mark_schemes
    """).fetchall()

    if not args.include_flagged:
        before = len(rows)
        rows = [row for row in rows if row["status"] == "published"]
        held = before - len(rows)
        if held:
            print(f"  holding back {held} mark schemes still marked needs_review")

    ms_id_map: dict[int, int] = {}
    skipped_ms = 0

    # Pre-load existing mark schemes by (paperId, rootNumber)
    with dst.cursor() as cur:
        cur.execute('SELECT id, "paperId", "rootNumber" FROM bank_mark_schemes')
        existing_ms = {(row[1], row[2]): row[0] for row in cur.fetchall()}

    with dst.cursor() as cur:
        for row in rows:
            old_id = row["id"]
            old_question_id = row["question_id"]
            new_question_id = question_id_map.get(old_question_id)
            if not new_question_id:
                continue

            old_paper_id = row["paper_id"]
            new_paper_id = paper_id_map.get(old_paper_id)
            if not new_paper_id:
                continue

            ms_key = (new_paper_id, row["root_number"])
            if ms_key in existing_ms:
                ms_id_map[old_id] = existing_ms[ms_key]
                skipped_ms += 1
                continue

            try:
                cur.execute("""
                    INSERT INTO bank_mark_schemes
                        ("questionId", "paperId", "rootNumber", "answerMd",
                         "markingPoints", "totalMarks", "answerLetter",
                         confidence, status, "runId", model, "promptVersion", "createdAt")
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT ("paperId", "rootNumber") DO NOTHING
                    RETURNING id
                """, (
                    new_question_id, new_paper_id, row["root_number"], row["answer_md"],
                    row["marking_points"], row["total_marks"], row["answer_letter"],
                    row["confidence"], row["status"], row["run_id"],
                    row["model"], row["prompt_version"], row["created_at"],
                ))
                result = cur.fetchone()
                if result:
                    ms_id_map[old_id] = result[0]
                    existing_ms[ms_key] = result[0]
            except Exception as e:
                print(f"\n  ⚠ mark scheme Q{row['rootNumber']}: {e}")
                dst.rollback()
                continue
    dst.commit()
    print(f"  ✓ {len(rows)} mark schemes ({len(ms_id_map)} mapped, {skipped_ms} already existed)")

    # ---- Merge topics ----
    print("Merging bank_topics...")
    rows = src.execute('SELECT id, subject_id, code, name FROM bank_topics').fetchall()

    topic_id_map: dict[int, int] = {}

    # Pre-load existing topics by (subjectId, name)
    with dst.cursor() as cur:
        cur.execute('SELECT id, "subjectId", name FROM bank_topics')
        existing_topics = {(row[1], row[2]): row[0] for row in cur.fetchall()}

    with dst.cursor() as cur:
        for row in rows:
            old_id = row["id"]
            old_subject_id = row["subject_id"]
            new_subject_id = subject_id_map.get(old_subject_id)
            if not new_subject_id:
                continue

            key = (new_subject_id, row["name"])
            if key in existing_topics:
                topic_id_map[old_id] = existing_topics[key]
                continue

            try:
                cur.execute("""
                    INSERT INTO bank_topics ("subjectId", code, name)
                    VALUES (%s, %s, %s)
                    ON CONFLICT ("subjectId", name) DO NOTHING
                    RETURNING id
                """, (new_subject_id, row["code"], row["name"]))
                result = cur.fetchone()
                if result:
                    topic_id_map[old_id] = result[0]
                    existing_topics[key] = result[0]
            except Exception as e:
                print(f"\n  ⚠ topic {row['name']}: {e}")
                dst.rollback()
                continue
    dst.commit()
    print(f"  ✓ {len(rows)} topics")

    # ---- Merge tags ----
    print("Merging bank_tags...")
    rows = src.execute('SELECT id, slug, label FROM bank_tags').fetchall()

    tag_id_map: dict[int, int] = {}

    # Pre-load existing tags by slug
    with dst.cursor() as cur:
        cur.execute('SELECT id, slug FROM bank_tags')
        existing_tags = {row[1]: row[0] for row in cur.fetchall()}

    with dst.cursor() as cur:
        for row in rows:
            old_id = row["id"]
            slug = row["slug"]
            if slug in existing_tags:
                tag_id_map[old_id] = existing_tags[slug]
                continue

            try:
                cur.execute("""
                    INSERT INTO bank_tags (slug, label)
                    VALUES (%s, %s)
                    ON CONFLICT (slug) DO NOTHING
                    RETURNING id
                """, (slug, row["label"]))
                result = cur.fetchone()
                if result:
                    tag_id_map[old_id] = result[0]
                    existing_tags[slug] = result[0]
            except Exception as e:
                print(f"\n  ⚠ tag {row['slug']}: {e}")
                dst.rollback()
                continue
    dst.commit()
    print(f"  ✓ {len(rows)} tags")

    # ---- Merge question topics junction ----
    print("Merging bank_question_topics...")
    rows = src.execute('SELECT question_id, topic_id, confidence FROM bank_question_topics').fetchall()

    with dst.cursor() as cur:
        for row in rows:
            new_qid = question_id_map.get(row["question_id"])
            new_tid = topic_id_map.get(row["topic_id"])
            if not new_qid or not new_tid:
                continue

            cur.execute("""
                INSERT INTO bank_question_topics ("questionId", "topicId", confidence)
                VALUES (%s, %s, %s)
                ON CONFLICT DO NOTHING
            """, (new_qid, new_tid, row["confidence"]))
    dst.commit()
    print(f"  ✓ {len(rows)} question-topic links")

    # ---- Merge question tags junction ----
    print("Merging bank_question_tags...")
    rows = src.execute('SELECT question_id, tag_id, confidence FROM bank_question_tags').fetchall()

    with dst.cursor() as cur:
        for row in rows:
            new_qid = question_id_map.get(row["question_id"])
            new_tid = tag_id_map.get(row["tag_id"])
            if not new_qid or not new_tid:
                continue

            cur.execute("""
                INSERT INTO bank_question_tags ("questionId", "tagId", confidence)
                VALUES (%s, %s, %s)
                ON CONFLICT DO NOTHING
            """, (new_qid, new_tid, row["confidence"]))
    dst.commit()
    print(f"  ✓ {len(rows)} question-tag links")

    # ---- Merge question assets ----
    print("Merging bank_question_assets...")
    rows = src.execute('SELECT question_id, asset_id, placeholder, ordering FROM bank_question_assets').fetchall()

    with dst.cursor() as cur:
        for row in rows:
            new_qid = question_id_map.get(row["question_id"])
            new_aid = asset_id_map.get(row["asset_id"])
            if not new_qid or not new_aid:
                continue

            cur.execute("""
                INSERT INTO bank_question_assets ("questionId", "assetId", placeholder, ordering)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT DO NOTHING
            """, (new_qid, new_aid, row["placeholder"], row["ordering"]))
    dst.commit()
    print(f"  ✓ {len(rows)} question assets")

    # ---- Merge crop strips ----
    #
    # The whole crop, in reading order. screenshotId carries only strip 0,
    # which for 89% of questions is the top fragment of the image a student
    # is meant to read.
    for table, owner_column, id_map, source_column in (
        ("bank_question_strips", "questionId", question_id_map, "question_id"),
        ("bank_mark_scheme_strips", "markSchemeId", ms_id_map, "mark_scheme_id"),
    ):
        print(f"Merging {table}...")
        rows = src.execute(
            f"SELECT {source_column}, asset_id, ordering, page FROM {table}"
        ).fetchall()
        written = 0
        with dst.cursor() as cur:
            for row in rows:
                new_owner = id_map.get(row[source_column])
                new_asset = asset_id_map.get(row["asset_id"])
                # A strip whose owner was held back by the quality gate has
                # nothing to attach to, and is skipped with it.
                if not new_owner or not new_asset:
                    continue
                cur.execute(f"""
                    INSERT INTO {table} ("{owner_column}", "assetId", ordering, page)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                """, (new_owner, new_asset, row["ordering"], row["page"]))
                written += 1
        dst.commit()
        print(f"  ✓ {written} of {len(rows)} strips")

    # ---- Merge mark scheme assets ----
    print("Merging bank_mark_scheme_assets...")
    rows = src.execute('SELECT mark_scheme_id, asset_id, placeholder, ordering FROM bank_mark_scheme_assets').fetchall()

    with dst.cursor() as cur:
        for row in rows:
            new_ms_id = ms_id_map.get(row["mark_scheme_id"])
            new_aid = asset_id_map.get(row["asset_id"])
            if not new_ms_id or not new_aid:
                continue

            cur.execute("""
                INSERT INTO bank_mark_scheme_assets ("markSchemeId", "assetId", placeholder, ordering)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT DO NOTHING
            """, (new_ms_id, new_aid, row["placeholder"], row["ordering"]))
    dst.commit()
    print(f"  ✓ {len(rows)} mark scheme assets")

    # ---- Merge review flags ----
    print("Merging bank_review_flags...")
    rows = src.execute("""
        SELECT id, question_id, paper_id, issue_type, severity, message, evidence, status, created_at
        FROM bank_review_flags
    """).fetchall()

    with dst.cursor() as cur:
        for row in rows:
            new_qid = question_id_map.get(row["question_id"]) if row["question_id"] else None
            new_pid = paper_id_map.get(row["paper_id"]) if row["paper_id"] else None
            if not new_qid and not new_pid:
                continue

            cur.execute("""
                INSERT INTO bank_review_flags ("questionId", "paperId", "issueType", severity, message, evidence, status, "createdAt")
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT DO NOTHING
            """, (new_qid, new_pid, row["issue_type"], row["severity"], row["message"], row["evidence"], row["status"], row["created_at"]))
    dst.commit()
    print(f"  ✓ {len(rows)} review flags")

    # ---- Merge run ledger ----
    print("Merging bank_run_ledger...")
    rows = src.execute("""
        SELECT work_key, stage, source_sha256, root_number, status, detail,
               input_tokens, output_tokens, completed_at
        FROM bank_run_ledger
    """).fetchall()

    with dst.cursor() as cur:
        for row in rows:
            cur.execute("""
                INSERT INTO bank_run_ledger ("workKey", stage, "sourceSha256", "rootNumber", status, detail, "inputTokens", "outputTokens", "completedAt")
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT ("workKey") DO UPDATE SET
                    status = EXCLUDED.status,
                    detail = EXCLUDED.detail,
                    "inputTokens" = EXCLUDED."inputTokens",
                    "outputTokens" = EXCLUDED."outputTokens",
                    "completedAt" = EXCLUDED."completedAt"
            """, (
                row["work_key"], row["stage"], row["source_sha256"], row["root_number"],
                row["status"], row["detail"], row["input_tokens"], row["output_tokens"],
                row["completed_at"],
            ))
    dst.commit()
    print(f"  ✓ {len(rows)} ledger entries")

    # ---- Done ----
    src.close()
    dst.close()

    print(f"\n{'=' * 50}")
    print(f"✓ Merge complete!")
    print(f"  {len(paper_id_map)} papers, {len(question_id_map)} questions, {len(ms_id_map)} mark schemes")
    print(f"  {len(asset_id_map)} assets, {len(topic_id_map)} topics, {len(tag_id_map)} tags")
    print(f"  Source: {source_path}")
    print(f"  Destination: Neon Postgres (bank_* tables)")
    print(f"{'=' * 50}")


if __name__ == "__main__":
    main()
