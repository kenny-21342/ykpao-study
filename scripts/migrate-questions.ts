import "dotenv/config";
import Database from "better-sqlite3";
import pg from "pg";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
const SQLITE_PATH = path.join(process.cwd(), "papers.db");
const BATCH_SIZE = 2000;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

type QuestionRow = {
  id: number;
  paper_id: number;
  number: number;
  part: string;
  sub_part: string;
  content: string;
  latex: string;
  marks: number;
  has_diagram: number;
  diagram_ref: string;
  ordering: number;
};

function log(label: string, n: number, total?: number) {
  const pct = total ? ` (${((n / total) * 100).toFixed(1)}%)` : "";
  console.log(`  ${label}: ${n.toLocaleString()}${pct}`);
}

async function migrate() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  sqlite.pragma("journal_mode = WAL");

  const total = sqlite.prepare("SELECT COUNT(*) AS n FROM questions").get() as { n: number };
  console.log(`Source questions: ${total.n.toLocaleString()}`);

  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 15000,
    max: 4,
  });

  const { rows: existing } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM past_paper_questions"
  );
  const alreadyMigrated = existing[0].n;
  log("already in Postgres", alreadyMigrated, total.n);
  if (alreadyMigrated >= total.n) {
    console.log("✅ Nothing to do.");
    return;
  }

  const maxIdRow = await pool.query("SELECT COALESCE(MAX(id), 0)::int AS m FROM past_paper_questions");
  const resumeId = maxIdRow.rows[0].m;
  console.log(`Resuming after question id ${resumeId.toLocaleString()}`);

  const stmt = sqlite.prepare(
    "SELECT * FROM questions WHERE id > ? ORDER BY id LIMIT ?"
  );

  let migrated = alreadyMigrated;
  let lastId = resumeId;
  let batch: QuestionRow[] = [];

  while (true) {
    batch = stmt.all(lastId, BATCH_SIZE) as QuestionRow[];
    if (batch.length === 0) break;

    const values: string[] = [];
    const params: unknown[] = [];
    let i = 0;
    for (const q of batch) {
      const base = i * 11;
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`);
      params.push(
        q.id, q.paper_id, q.number, q.part ?? "", q.sub_part ?? "",
        q.content, q.latex ?? "", q.marks ?? 0, q.has_diagram ?? 0,
        q.diagram_ref ?? "", q.ordering ?? 0
      );
      i++;
    }

    const sql = `
      INSERT INTO past_paper_questions
        (id, "paperId", number, part, "subPart", content, latex, marks, "hasDiagram", "diagramRef", ordering)
      VALUES ${values.join(",")}
      ON CONFLICT (id) DO NOTHING
    `;

    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await pool.connect();
      try {
        await client.query(sql, params);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        console.log(`  retry ${attempt + 1}/3 after:`, (err as Error).message);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      } finally {
        client.release();
      }
    }

    migrated += batch.length;
    lastId = batch[batch.length - 1].id;
    log("questions", migrated, total.n);
  }

  const finalRow = await pool.query(
    "SELECT (SELECT COUNT(*) FROM subjects) AS s, (SELECT COUNT(*) FROM past_papers) AS p, (SELECT COUNT(*) FROM past_paper_questions) AS q"
  );
  const r = finalRow.rows[0];
  console.log("\n=== Migration complete ===");
  console.log(`Postgres: ${r.s} subjects, ${r.p} papers, ${r.q} questions`);

  sqlite.close();
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
