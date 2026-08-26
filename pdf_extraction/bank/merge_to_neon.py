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
    """The connection string for a bulk merge, preferring the direct endpoint.

    Neon serves two endpoints: a pooled one (host contains "-pooler", PgBouncer
    in front) and a direct one. The pooled endpoint is right for the web app,
    which makes many short connections, and wrong for this script, which holds
    one session open across hundreds of thousands of inserts -- PgBouncer drops
    it partway through and the run dies with "SSL SYSCALL error: Operation
    timed out". That is exactly how the first full run was lost.

    So: DIRECT_DATABASE_URL wins if set. Otherwise DATABASE_URL is used, but if
    it points at the pooler the host is rewritten to the direct one, which on
    Neon is the same host without the "-pooler" suffix.
    """
    for name in ("DIRECT_DATABASE_URL", "DATABASE_URL"):
        url = os.environ.get(name, "")
        if url:
            return _prefer_direct(url)

    env_path = Path(__file__).parent.parent.parent / ".env"
    if env_path.exists():
        wanted = ("DIRECT_DATABASE_URL=", "DATABASE_URL=")
        found: dict[str, str] = {}
        for line in env_path.read_text().splitlines():
            line = line.strip()
            for prefix in wanted:
                if line.startswith(prefix):
                    found[prefix] = line.split("=", 1)[1].strip().strip('"').strip("'")
        for prefix in wanted:
            if prefix in found:
                return _prefer_direct(found[prefix])
    raise RuntimeError("DATABASE_URL not found in env or .env")


def _prefer_direct(url: str) -> str:
    """Rewrite a Neon pooled URL to its direct equivalent."""
    if "-pooler." not in url:
        return url
    print("  [DB] pooled endpoint detected; using the direct one for the bulk merge")
    return url.replace("-pooler.", ".", 1)


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
    from psycopg2.extras import execute_values, register_json

    db_url = load_db_url()
    print(f"\nDestination: {db_url.split('@')[1].split('/')[0] if '@' in db_url else 'Neon'}...")

    def connect_dst():
        conn = psycopg2.connect(db_url, keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3)
        register_json(conn)
        conn.autocommit = False
        return conn

    dst = connect_dst()

    def safe_rollback():
        """Roll back the failed statement without hiding why it failed.

        A per-row handler exists to report a bad row and carry on. But when the
        failure *is* the connection dying, rollback() raises InterfaceError from
        inside the handler -- so the traceback names the rollback and the real
        cause (an SSL timeout, a dropped session) never reaches the log. That
        masking cost a full merge run once already.
        """
        try:
            dst.rollback()
        except Exception:
            pass


    class BatchInserter:
        """Insert rows a thousand at a time instead of one at a time.

        Every insert used to be its own round trip to Neon. Measured against
        the production endpoint that is 2-3 rows a second, so the ~900,000
        rows of a full merge would have taken three to five days.

        Worse, the large stages committed only after their entire loop, so
        assets was a single transaction spanning 400,328 inserts and ~35
        hours. Neon drops long-lived connections -- that is what killed an
        earlier run -- and any such drop would have rolled back every row.

        execute_values sends up to `size` rows per statement, and each batch
        commits as it lands, so progress survives a failure and a re-run
        resumes from it: every insert is ON CONFLICT DO NOTHING.

        A batch that fails is retried row by row. One malformed row would
        otherwise take 999 good ones down with it, and the per-row error
        reporting is the only way to learn which row was bad.
        """

        def __init__(self, sql, label, total, size=1000):
            self.sql = sql
            self.label = label
            self.total = total
            self.size = size
            self.pending = []
            self.written = 0
            self.failed = 0
            self.seen = 0

        def add(self, values):
            self.pending.append(values)
            if len(self.pending) >= self.size:
                self.flush()

        def flush(self):
            if not self.pending:
                return
            batch, self.pending = self.pending, []
            try:
                with dst.cursor() as cur:
                    execute_values(cur, self.sql, batch, page_size=len(batch))
                dst.commit()
                self.written += len(batch)
            except Exception as batch_error:
                safe_rollback()
                print(f"\n  ⚠ {self.label}: batch failed ({batch_error}); retrying row by row")
                for values in batch:
                    try:
                        with dst.cursor() as cur:
                            execute_values(cur, self.sql, [values], page_size=1)
                        dst.commit()
                        self.written += 1
                    except Exception as row_error:
                        safe_rollback()
                        self.failed += 1
                        print(f"    ⚠ {self.label} row: {row_error}")
            self.seen += len(batch)
            if self.total:
                print(f"  ...{self.seen}/{self.total} sent ({self.written} written)")

        def finish(self):
            self.flush()
            return self.written, self.failed

    def execute_with_retry(cur_func, max_retries=3):
        """Execute a cursor operation with reconnection on network failure."""
        nonlocal dst
        for attempt in range(max_retries):
            try:
                return cur_func(dst.cursor())
            except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
                print(f"\n  [DB] connection lost ({e.__class__.__name__}), retry {attempt+1}/{max_retries}...")
                try:
                    safe_rollback()
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
                safe_rollback()
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
                    row["page_count"], row["span_strategy"], bool(row["used_ocr"]),
                    row["created_at"],
                ))
                result = cur.fetchone()
                if result:
                    paper_id_map[old_id] = result[0]
                    existing_papers[source_path] = result[0]
            except Exception as e:
                print(f"\n  ⚠ paper {row['source_path']}: {e}")
                safe_rollback()
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

    # RETURNING id is what forced one round trip per row: it ties each new id
    # to the row that produced it. Batched inserts cannot do that -- ON
    # CONFLICT DO NOTHING returns only the rows it actually inserted, in no
    # guaranteed order -- so the ids are recovered afterwards with a single
    # SELECT over the natural key instead. sha256 is unique, so the mapping is
    # exact.
    batch = BatchInserter(
        """
        INSERT INTO bank_assets
            (sha256, kind, "relativePath", width, height, "byteSize",
             "sourcePage", bbox, "sourceDpi", "createdAt")
        VALUES %s
        ON CONFLICT (sha256) DO NOTHING
        """,
        "asset", len(rows),
    )
    for row in rows:
        if row["sha256"] in existing_assets:
            asset_id_map[row["id"]] = existing_assets[row["sha256"]]
            skipped_assets += 1
            continue
        batch.add((
            row["sha256"], row["kind"], row["relative_path"], row["width"],
            row["height"], row["byte_size"], row["source_page"],
            row["bbox"], row["source_dpi"], row["created_at"],
        ))
    written, failed = batch.finish()

    # Only when something was actually inserted. The loop above already mapped
    # every asset that was already there, so on a re-run this second pass over
    # 400,328 rows recovers nothing and costs minutes of network round trip.
    if written:
        with dst.cursor() as cur:
            cur.execute('SELECT id, sha256 FROM bank_assets')
            existing_assets = {r[1]: r[0] for r in cur.fetchall() if r[1]}
        for row in rows:
            new_id = existing_assets.get(row["sha256"])
            if new_id:
                asset_id_map[row["id"]] = new_id

    print(f"  ✓ {len(rows)} assets ({len(asset_id_map)} mapped, "
          f"{skipped_assets} already existed, {failed} failed)")

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

    batch = BatchInserter(
        """
        INSERT INTO bank_questions
            ("paperId", "rootNumber", "bodyMd", parts, "totalMarks",
             "screenshotId", "pageStart", "pageEnd", confidence, status,
             difficulty, "difficultySource", "difficultyRationale",
             "runId", model, "promptVersion", "createdAt")
        VALUES %s
        ON CONFLICT ("paperId", "rootNumber") DO NOTHING
        """,
        "question", len(rows),
    )
    wanted_keys = []
    for row in rows:
        new_paper_id = paper_id_map.get(row["paper_id"])
        if not new_paper_id:
            continue

        q_key = (new_paper_id, row["root_number"])
        wanted_keys.append((row["id"], q_key))
        if q_key in existing_q:
            question_id_map[row["id"]] = existing_q[q_key]
            skipped_q += 1
            continue

        screenshot_id = asset_id_map.get(row["screenshot_id"]) if row["screenshot_id"] else None
        batch.add((
            new_paper_id, row["root_number"], row["body_md"], row["parts"],
            row["total_marks"], screenshot_id, row["page_start"], row["page_end"],
            row["confidence"], row["status"], row["difficulty"],
            row["difficulty_source"], row["difficulty_rationale"],
            row["run_id"], row["model"], row["prompt_version"], row["created_at"],
        ))
    written, failed_q = batch.finish()

    # Recover the ids the batched inserts could not return, keyed on the
    # (paperId, rootNumber) unique constraint.
    with dst.cursor() as cur:
        cur.execute('SELECT id, "paperId", "rootNumber" FROM bank_questions')
        existing_q = {(r[1], r[2]): r[0] for r in cur.fetchall()}
    for old_id, q_key in wanted_keys:
        new_id = existing_q.get(q_key)
        if new_id:
            question_id_map[old_id] = new_id
    print(f"  ✓ {len(rows)} questions ({len(question_id_map)} mapped, "
          f"{skipped_q} already existed, {failed_q} failed)")

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

    batch = BatchInserter(
        """
        INSERT INTO bank_mark_schemes
            ("questionId", "paperId", "rootNumber", "answerMd",
             "markingPoints", "totalMarks", "answerLetter",
             confidence, status, "runId", model, "promptVersion", "createdAt")
        VALUES %s
        ON CONFLICT ("paperId", "rootNumber") DO NOTHING
        """,
        "mark scheme", len(rows),
    )
    wanted_ms = []
    # Counted, not silently dropped. A mark scheme with no question cannot be
    # merged -- the Postgres column is NOT NULL -- and the old summary printed
    # len(rows), so 21,667 rows vanished behind a line that read as a success.
    skipped_unlinked = 0
    for row in rows:
        new_question_id = question_id_map.get(row["question_id"])
        if not new_question_id:
            skipped_unlinked += 1
            continue
        new_paper_id = paper_id_map.get(row["paper_id"])
        if not new_paper_id:
            continue

        ms_key = (new_paper_id, row["root_number"])
        wanted_ms.append((row["id"], ms_key))
        if ms_key in existing_ms:
            ms_id_map[row["id"]] = existing_ms[ms_key]
            skipped_ms += 1
            continue

        batch.add((
            new_question_id, new_paper_id, row["root_number"], row["answer_md"],
            row["marking_points"], row["total_marks"], row["answer_letter"],
            row["confidence"], row["status"], row["run_id"],
            row["model"], row["prompt_version"], row["created_at"],
        ))
    written, failed_ms = batch.finish()

    with dst.cursor() as cur:
        cur.execute('SELECT id, "paperId", "rootNumber" FROM bank_mark_schemes')
        existing_ms = {(r[1], r[2]): r[0] for r in cur.fetchall()}
    for old_id, ms_key in wanted_ms:
        new_id = existing_ms.get(ms_key)
        if new_id:
            ms_id_map[old_id] = new_id
    print(f"  ✓ {len(ms_id_map)} of {len(rows)} mark schemes mapped "
          f"({skipped_ms} already existed, {skipped_unlinked} have no question, "
          f"{failed_ms} failed)")

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
                safe_rollback()
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
                safe_rollback()
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

    batch = BatchInserter(
        """
        INSERT INTO bank_question_assets ("questionId", "assetId", placeholder, ordering)
        VALUES %s
        ON CONFLICT DO NOTHING
        """,
        "question asset", len(rows),
    )
    for row in rows:
        new_qid = question_id_map.get(row["question_id"])
        new_aid = asset_id_map.get(row["asset_id"])
        if not new_qid or not new_aid:
            continue
        batch.add((new_qid, new_aid, row["placeholder"], row["ordering"]))
    written, failed_qa = batch.finish()
    print(f"  ✓ {written} of {len(rows)} question assets ({failed_qa} failed)")

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
        batch = BatchInserter(
            f"""
            INSERT INTO {table} ("{owner_column}", "assetId", ordering, page)
            VALUES %s
            ON CONFLICT DO NOTHING
            """,
            "strip", len(rows),
        )
        for row in rows:
            new_owner = id_map.get(row[source_column])
            new_asset = asset_id_map.get(row["asset_id"])
            # A strip whose owner was held back by the quality gate has
            # nothing to attach to, and is skipped with it.
            if not new_owner or not new_asset:
                continue
            batch.add((new_owner, new_asset, row["ordering"], row["page"]))
        written, failed_strips = batch.finish()
        print(f"  ✓ {written} of {len(rows)} strips ({failed_strips} failed)")

    # ---- Merge mark scheme assets ----
    print("Merging bank_mark_scheme_assets...")
    rows = src.execute('SELECT mark_scheme_id, asset_id, placeholder, ordering FROM bank_mark_scheme_assets').fetchall()

    batch = BatchInserter(
        """
        INSERT INTO bank_mark_scheme_assets ("markSchemeId", "assetId", placeholder, ordering)
        VALUES %s
        ON CONFLICT DO NOTHING
        """,
        "mark scheme asset", len(rows),
    )
    for row in rows:
        new_ms_id = ms_id_map.get(row["mark_scheme_id"])
        new_aid = asset_id_map.get(row["asset_id"])
        if not new_ms_id or not new_aid:
            continue
        batch.add((new_ms_id, new_aid, row["placeholder"], row["ordering"]))
    written, failed_msa = batch.finish()
    print(f"  ✓ {written} of {len(rows)} mark scheme assets ({failed_msa} failed)")

    # ---- Merge review flags ----
    print("Merging bank_review_flags...")
    rows = src.execute("""
        SELECT id, question_id, paper_id, issue_type, severity, message, evidence, status, created_at
        FROM bank_review_flags
    """).fetchall()

    batch = BatchInserter(
        """
        INSERT INTO bank_review_flags
            ("questionId", "paperId", "issueType", severity, message, evidence, status, "createdAt")
        VALUES %s
        ON CONFLICT DO NOTHING
        """,
        "review flag", len(rows),
    )
    for row in rows:
        new_qid = question_id_map.get(row["question_id"]) if row["question_id"] else None
        new_pid = paper_id_map.get(row["paper_id"]) if row["paper_id"] else None
        if not new_qid and not new_pid:
            continue
        batch.add((new_qid, new_pid, row["issue_type"], row["severity"],
                   row["message"], row["evidence"], row["status"], row["created_at"]))
    written, failed_flags = batch.finish()
    print(f"  ✓ {written} of {len(rows)} review flags ({failed_flags} failed)")

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
