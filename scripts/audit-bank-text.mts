/**
 * Audit question transcriptions against their scans and record the verdict.
 *
 *   node --env-file=.env --import tsx scripts/audit-bank-text.mts --limit 50              # report only
 *   node --env-file=.env --import tsx scripts/audit-bank-text.mts --limit 50 --apply      # record it
 *   ... --subject 0625 --concurrency 6 --apply
 *
 * For each published question with text and no verdict yet, the scan and the
 * transcription go to the vision model, which says clean / minor / major. The
 * result lands in bank_questions.textAudit; the app shows text by default only
 * for 'clean'. Resumable: re-running skips questions already audited. Run it
 * where the database and object store are close (the VPS), not from a laptop.
 *
 * Needs the shared AI vision route (SHARED_AI_BASE_URL / _API_KEY / _VISION_MODEL).
 */
import pg from 'pg';

import { sharedVisionCredential } from '../lib/ai-credentials.ts';
import { pgConfig } from '../lib/db-ssl.ts';
import { bankAssetKey } from '../lib/storage/keys.ts';
import { parseTextAudit } from '../lib/text-audit.ts';
import { auditTranscription } from '../lib/vision.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.indexOf(name);
const value = (name: string) => (flag(name) >= 0 ? args[flag(name) + 1] : undefined);
const apply = args.includes('--apply');
const limit = Number(value('--limit') ?? 50);
const concurrency = Math.max(1, Math.min(12, Number(value('--concurrency') ?? 4)));
const subject = value('--subject');
const random = args.includes('--random');

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('Set DIRECT_DATABASE_URL.');
const credential = sharedVisionCredential();
if (!credential) throw new Error('No shared vision credential: set SHARED_AI_BASE_URL, SHARED_AI_API_KEY and SHARED_AI_VISION_MODEL.');

const client = new pg.Client(pgConfig(url));
await client.connect();

const { rows: todo } = await client.query<{ id: number; bodyMd: string; code: string; year: number; rootNumber: number }>(
  `SELECT q.id, q."bodyMd", s.code, p.year, q."rootNumber"
     FROM bank_questions q
     JOIN bank_papers p ON p.id = q."paperId"
     JOIN bank_subjects s ON s.id = p."subjectId"
    WHERE q.status = 'published' AND length(trim(q."bodyMd")) > 0 AND q."textAudit" IS NULL
      AND p."docType" = 'qp' ${subject ? 'AND s.code = $2' : ''}
    ${random ? 'ORDER BY random()' : 'ORDER BY q.id'} LIMIT $1`,
  subject ? [limit, subject] : [limit],
);
console.log(`${todo.length} questions to audit with ${credential.model} (${apply ? 'recording' : 'report only'}, concurrency ${concurrency})`);

const tally = { clean: 0, minor: 0, major: 0, unaudited: 0 };
let tokensIn = 0;
let tokensOut = 0;
let next = 0;
const started = Date.now();

async function one(row: (typeof todo)[number]) {
  const { rows } = await client.query<{ sha256: string }>(
    `SELECT a.sha256 FROM bank_question_strips s JOIN bank_assets a ON a.id = s.asset_id
      WHERE s."questionId" = $1 ORDER BY s.ordering`,
    [row.id],
  );
  const paths = rows.map((r) => bankAssetKey(r.sha256)).filter((k): k is string => Boolean(k)).map((k) => `/${k}`);
  const out = paths.length ? await auditTranscription(paths, row.bodyMd, credential!) : null;
  tokensIn += out?.usage?.tokensIn ?? 0;
  tokensOut += out?.usage?.tokensOut ?? 0;
  const verdict = out ? parseTextAudit(out.reply) : null;
  if (!verdict) {
    tally.unaudited += 1;
    return;
  }
  tally[verdict.level] += 1;
  if (verdict.level === 'major') console.log(`  major  ${row.code} ${row.year} Q${row.rootNumber} (#${row.id}): ${verdict.issues.slice(0, 2).join(' | ').slice(0, 200)}`);
  if (apply) {
    await client.query(
      `UPDATE bank_questions SET "textAudit" = $2, "textAuditNote" = $3, "textAuditedAt" = now() WHERE id = $1`,
      [row.id, verdict.level, verdict.issues.join(' | ').slice(0, 500) || null],
    );
  }
}

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < todo.length) {
      const row = todo[next++];
      try {
        await one(row);
      } catch (error) {
        tally.unaudited += 1;
        console.warn(`  #${row.id} failed: ${(error as Error).message.slice(0, 120)}`);
      }
      const done = tally.clean + tally.minor + tally.major + tally.unaudited;
      if (done % 25 === 0) console.log(`  ${done}/${todo.length}  clean ${tally.clean}  minor ${tally.minor}  major ${tally.major}  unaudited ${tally.unaudited}`);
    }
  }),
);

const seconds = (Date.now() - started) / 1000;
console.log(`\ndone in ${seconds.toFixed(0)}s: clean ${tally.clean}, minor ${tally.minor}, major ${tally.major}, unaudited ${tally.unaudited}`);
console.log(`tokens: ${tokensIn.toLocaleString()} in, ${tokensOut.toLocaleString()} out (${todo.length ? Math.round((tokensIn + tokensOut) / todo.length) : 0} per question)`);
await client.end();
