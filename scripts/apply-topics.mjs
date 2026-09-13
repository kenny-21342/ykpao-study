/**
 * Push syllabus topics and their question links from the local extraction store
 * to production.
 *
 * WHY NOT merge_to_neon.py. That script would merge these correctly -- topics
 * and their junction rows are genuinely new, so its insert-only behaviour is
 * right for them -- but it is not a topics tool. It merges every table it
 * knows, and the local store holds 18,847 `needs_review` questions against
 * production's 3,289. Running it to collect the topics would also insert
 * ~15,558 crop-failed questions that were deliberately left out, inflating the
 * review queue by a factor of six. The selective merge that produced
 * production's corpus was a decision, and this script exists so that collecting
 * the topics does not quietly reverse it.
 *
 * The topics themselves cost nothing to land: the tagging pass already ran
 * locally and produced 313 topics and 21,187 question links, none of which ever
 * reached production. lib/mock-exam-selection.ts names `bank_topics` having no
 * rows as the reason a generated paper cannot be topic-matched, and
 * lib/bank-questions.ts hides the topic filter entirely while the table is
 * empty. Both start working the moment this lands.
 *
 *   node scripts/apply-topics.mjs              # verify only, writes nothing
 *   node scripts/apply-topics.mjs --apply      # verify, then insert
 *   node scripts/apply-topics.mjs --source other.db
 *
 * Reads DIRECT_DATABASE_URL, falling back to DATABASE_URL. Use the direct
 * (non `-pooler`) endpoint.
 *
 * Idempotent: topics are matched on (subjectId, name) and links are inserted
 * ON CONFLICT DO NOTHING, so a re-run writes nothing.
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sourceIdx = args.indexOf('--source');
const sourcePath = sourceIdx >= 0 && args[sourceIdx + 1] ? args[sourceIdx + 1] : 'pdf_extraction/bank/extract.db';

const BATCH = 500;

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DIRECT_DATABASE_URL (or DATABASE_URL) first.');
  process.exit(1);
}
if (url.includes('-pooler')) {
  console.error('That is the pooled endpoint. Use the direct one (drop "-pooler" from the host).');
  process.exit(1);
}
if (!existsSync(sourcePath)) {
  console.error(`Source SQLite not found: ${sourcePath}`);
  process.exit(1);
}

const src = new Database(sourcePath, { readonly: true });
const client = new pg.Client({ connectionString: url });

const counts = async () => {
  const { rows } = await client.query(`
    SELECT (SELECT count(*) FROM bank_topics)          AS topics,
           (SELECT count(*) FROM bank_question_topics) AS links
  `);
  return rows[0];
};

try {
  await client.connect();
  console.log(`connected: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`source:    ${sourcePath}\n`);

  const before = await counts();
  console.log(`BEFORE   topics: ${Number(before.topics).toLocaleString()}   links: ${Number(before.links).toLocaleString()}`);

  // --- subject and question identity maps ---------------------------------
  // Subjects are matched on code, papers on sourcePath, questions on
  // (paperId, rootNumber) -- the same keys merge_to_neon.py uses.
  const { rows: subjectRows } = await client.query('SELECT id, code FROM bank_subjects');
  const prodSubject = new Map(subjectRows.map((r) => [r.code, r.id]));

  const { rows: paperRows } = await client.query('SELECT id, "sourcePath" FROM bank_papers');
  const prodPaper = new Map(paperRows.map((r) => [r.sourcePath, r.id]));

  const { rows: questionRows } = await client.query('SELECT id, "paperId", "rootNumber" FROM bank_questions');
  const prodQuestion = new Map(questionRows.map((r) => [`${r.paperId}:${r.rootNumber}`, r.id]));

  const localTopics = src.prepare(`
    SELECT t.id, t.code, t.name, s.code AS subject_code
    FROM bank_topics t JOIN bank_subjects s ON s.id = t.subject_id
  `).all();

  const localLinks = src.prepare(`
    SELECT qt.topic_id, qt.confidence, p.source_path, q.root_number
    FROM bank_question_topics qt
    JOIN bank_questions q ON q.id = qt.question_id
    JOIN bank_papers p ON p.id = q.paper_id
  `).all();

  console.log(`local    topics: ${localTopics.length.toLocaleString()}   links: ${localLinks.length.toLocaleString()}`);

  if (!apply) {
    const resolvableTopics = localTopics.filter((t) => prodSubject.has(t.subject_code)).length;
    let resolvableLinks = 0;
    for (const l of localLinks) {
      const paperId = prodPaper.get(l.source_path);
      if (paperId !== undefined && prodQuestion.has(`${paperId}:${l.root_number}`)) resolvableLinks += 1;
    }
    console.log(`\nwould resolve: ${resolvableTopics.toLocaleString()} topics, ${resolvableLinks.toLocaleString()} links`);
    console.log(`(${(localLinks.length - resolvableLinks).toLocaleString()} links point at questions not in production -- the crop-failed rows that were deliberately never merged)`);
    console.log('\nVerification only. Re-run with --apply to write.');
    process.exit(0);
  }

  // --- topics --------------------------------------------------------------
  const topicId = new Map();
  let topicsInserted = 0;
  for (const t of localTopics) {
    const subjectId = prodSubject.get(t.subject_code);
    if (subjectId === undefined) continue;
    const { rows } = await client.query(
      `INSERT INTO bank_topics ("subjectId", code, name) VALUES ($1, $2, $3)
       ON CONFLICT ("subjectId", name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, (xmax = 0) AS inserted`,
      [subjectId, t.code, t.name],
    );
    topicId.set(t.id, rows[0].id);
    if (rows[0].inserted) topicsInserted += 1;
  }
  console.log(`\ntopics: ${topicsInserted.toLocaleString()} inserted, ${(topicId.size - topicsInserted).toLocaleString()} already present`);

  // --- links ---------------------------------------------------------------
  const resolved = [];
  let unresolved = 0;
  for (const l of localLinks) {
    const paperId = prodPaper.get(l.source_path);
    const questionId = paperId === undefined ? undefined : prodQuestion.get(`${paperId}:${l.root_number}`);
    const topic = topicId.get(l.topic_id);
    if (questionId === undefined || topic === undefined) { unresolved += 1; continue; }
    resolved.push([questionId, topic, l.confidence ?? null]);
  }
  if (unresolved > 0) {
    console.log(`  ! ${unresolved.toLocaleString()} links skipped (question or topic absent from production)`);
  }

  let linksInserted = 0;
  for (let i = 0; i < resolved.length; i += BATCH) {
    const slice = resolved.slice(i, i + BATCH);
    const params = [];
    const tuples = slice.map((row, r) => {
      params.push(...row);
      return `($${r * 3 + 1}::int, $${r * 3 + 2}::int, $${r * 3 + 3}::float)`;
    });
    const result = await client.query(
      `INSERT INTO bank_question_topics ("questionId", "topicId", confidence)
       VALUES ${tuples.join(',')}
       ON CONFLICT DO NOTHING`,
      params,
    );
    linksInserted += result.rowCount ?? 0;
    process.stdout.write(`\r  links: ${Math.min(i + BATCH, resolved.length).toLocaleString()}/${resolved.length.toLocaleString()} — ${linksInserted.toLocaleString()} inserted`);
  }
  if (resolved.length) process.stdout.write('\n');

  const after = await counts();
  console.log(`\nAFTER    topics: ${Number(after.topics).toLocaleString()}   links: ${Number(after.links).toLocaleString()}`);
  console.log('\nThe topic filter in lib/bank-questions.ts stops hiding itself once these exist.');
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
} finally {
  src.close();
  await client.end().catch(() => {});
}
