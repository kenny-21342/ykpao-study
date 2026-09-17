/**
 * Mark transcripts that look like they lost content, so the push to production
 * can leave them behind.
 *
 * The transcription itself is faithful -- six transcripts checked against their
 * source scans came back word for word, including a 16-value data table and a
 * mark scheme's EITHER/OR structure -- and the model does not invent content.
 * What it does, on long questions carrying several embedded tables and figures,
 * is silently drop a part. One 9608 logic question lost part (b), its truth
 * table and all, and carried [1] where the paper said [3].
 *
 * That failure is safe in the app as it stands: every transcribed question
 * still has its original strip images, and those are what a student reads. The
 * text feeds search, progressive hints and AI marking. So the cost of holding
 * a doubtful transcript back is a question that stays exactly as it is today,
 * while the cost of shipping one is a student marked against a question with a
 * part missing. Hold it back.
 *
 * Three detectors, all of them arithmetic rather than judgement:
 *
 *   part_gap      top-level part letters skip one -- (a), (c) with no (b)
 *   marks_differ  the question and its mark scheme, transcribed from two
 *                 different documents, disagree on the total
 *   parts_sum     the parts add up to something other than total_marks
 *
 *   node scripts/flag-suspect-transcripts.mjs           # report only
 *   node scripts/flag-suspect-transcripts.mjs --apply   # write the flags
 */
import Database from 'better-sqlite3';

const apply = process.argv.includes('--apply');
const DB = process.argv.includes('--source')
  ? process.argv[process.argv.indexOf('--source') + 1]
  : 'pdf_extraction/bank/extract.db';

const db = new Database(DB, { readonly: !apply });
// The transcription batch writes to this file for days at a time, so a write
// here will meet a lock. Wait for it rather than failing: the flags are cheap
// to compute and there is no hurry, whereas stopping the batch to take the
// lock costs a chunk's phase A.
db.pragma('busy_timeout = 120000');

if (apply) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_transcript_flags (
      question_id INTEGER NOT NULL,
      side        TEXT    NOT NULL,   -- question | mark_scheme
      reason      TEXT    NOT NULL,
      detail      TEXT,
      flagged_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (question_id, side, reason)
    )`);
}

const flags = [];            // {question_id, side, reason, detail}
const add = (id, side, reason, detail) => flags.push({ id, side, reason, detail });

// 1. A missing middle part. Only gaps are detectable without the source: a
//    dropped trailing part looks exactly like a question that ends there.
const TOP_LEVEL = /\*\*\(([a-h])\)\*\*/g;
for (const q of db.prepare(
  `SELECT id, body_md FROM bank_questions WHERE body_md IS NOT NULL AND body_md <> ''`).iterate()) {
  const seen = [...new Set([...q.body_md.matchAll(TOP_LEVEL)].map((m) => m[1]))].sort();
  if (seen.length < 2) continue;
  const span = [];
  for (let c = seen[0].charCodeAt(0); c <= seen[seen.length - 1].charCodeAt(0); c++) span.push(String.fromCharCode(c));
  const missing = span.filter((c) => !seen.includes(c));
  if (missing.length) add(q.id, 'question', 'part_gap', `has ${seen.join('')}, missing ${missing.join('')}`);
}

// 2. Question and mark scheme disagree on the total. Flag both sides: which of
//    the two lost the content is not knowable from here, and the whole point is
//    to not guess.
for (const r of db.prepare(`
  SELECT q.id, q.total_marks AS q_total, m.total_marks AS m_total
    FROM bank_questions q
    JOIN bank_mark_schemes m ON m.question_id = q.id
   WHERE q.body_md <> '' AND m.answer_md <> ''
     AND (m.answer_letter IS NULL OR m.answer_letter = '')
     AND q.total_marks IS NOT NULL AND m.total_marks IS NOT NULL
     AND q.total_marks <> m.total_marks`).iterate()) {
  const detail = `question ${r.q_total} vs mark scheme ${r.m_total}`;
  add(r.id, 'question', 'marks_differ', detail);
  add(r.id, 'mark_scheme', 'marks_differ', detail);
}

// 3. The parts do not add up to the total the same transcript reports.
for (const q of db.prepare(
  `SELECT id, parts, total_marks FROM bank_questions
    WHERE body_md <> '' AND total_marks IS NOT NULL AND parts <> '[]'`).iterate()) {
  let parts = [];
  try { parts = JSON.parse(q.parts || '[]'); } catch { continue; }
  if (!parts.length) continue;
  const sum = parts.reduce((a, p) => a + (p.marks || 0), 0);
  if (sum !== q.total_marks) add(q.id, 'question', 'parts_sum', `parts ${sum} vs total ${q.total_marks}`);
}

const byReason = {};
for (const f of flags) byReason[`${f.side}/${f.reason}`] = (byReason[`${f.side}/${f.reason}`] || 0) + 1;
const questions = new Set(flags.filter((f) => f.side === 'question').map((f) => f.id));
const schemes = new Set(flags.filter((f) => f.side === 'mark_scheme').map((f) => f.id));

const totalQ = db.prepare(`SELECT count(*) n FROM bank_questions WHERE body_md <> ''`).get().n;
const totalM = db.prepare(`SELECT count(*) n FROM bank_mark_schemes WHERE answer_md <> ''`).get().n;

console.log(`transcribed questions    : ${totalQ.toLocaleString()}`);
console.log(`transcribed mark schemes : ${totalM.toLocaleString()}`);
console.log();
for (const [k, v] of Object.entries(byReason).sort()) console.log(`  ${k.padEnd(26)} ${v.toLocaleString()}`);
console.log();
console.log(`questions to hold back    : ${questions.size.toLocaleString()} (${(100 * questions.size / totalQ).toFixed(2)}%)`);
console.log(`mark schemes to hold back : ${schemes.size.toLocaleString()} (${(100 * schemes.size / totalM).toFixed(2)}%)`);
console.log(`questions that will ship  : ${(totalQ - questions.size).toLocaleString()}`);

if (!apply) {
  console.log('\nreport only. re-run with --apply to write the flags.');
} else {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO bank_transcript_flags (question_id, side, reason, detail) VALUES (?, ?, ?, ?)`);
  db.transaction(() => { db.prepare('DELETE FROM bank_transcript_flags').run();
    for (const f of flags) ins.run(f.id, f.side, f.reason, f.detail); })();
  console.log(`\nwrote ${flags.length.toLocaleString()} flags to bank_transcript_flags.`);
}
db.close();
