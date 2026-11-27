/**
 * List production's published questions that look multi-part but have no
 * per-part rows, with production's own text, for `tag_parts --from-json`.
 *
 *   node --env-file=.env scripts/export-untagged-parts.mjs OUT.json
 *
 * Production, not the local store, decides what is published: questions
 * published from review in production are still `needs_review` locally, and a
 * local-only selection never reaches them. Read-only.
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const out = process.argv[2];
if (!out) { console.error('usage: export-untagged-parts.mjs OUT.json'); process.exit(1); }
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const client = new pg.Client({ ...pgConfig(url), connectionTimeoutMillis: 30_000 });
await client.connect();
const { rows } = await client.query(`
  SELECT q.id AS "questionId", s.code, s.level, p.year, q."bodyMd" AS body, q.parts
  FROM bank_questions q
  JOIN bank_papers p ON p.id = q."paperId"
  JOIN bank_subjects s ON s.id = p."subjectId"
  WHERE q.status = 'published' AND coalesce(q."bodyMd", '') <> ''
    AND NOT EXISTS (SELECT 1 FROM bank_question_parts bp WHERE bp."questionId" = q.id)
    AND (
      (q.parts LIKE '[{%' AND jsonb_array_length(q.parts::jsonb) >= 2)
      OR q."bodyMd" ~ '\\((b|ii)\\)'
    )
  ORDER BY s.code, q.id`);
await client.end();
writeFileSync(out, JSON.stringify(rows));
console.log(`${rows.length} candidate questions -> ${out}`);
