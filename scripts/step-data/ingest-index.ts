/**
 * One-off: reads the full STEP index from stdin (or a file arg), parses every
 * "YY-Sn-Qm Label" line, dedupes, and writes scripts/step-data/index.json.
 *
 * Usage:
 *   npx tsx scripts/step-data/ingest-index.ts < /path/to/pasted.txt
 *   npx tsx scripts/step-data/ingest-index.ts pasted.txt
 *
 * The pasted text is the copy-paste from
 *   https://stepdatabase.maths.org/database/index.html
 * (select all on the rendered page → copy). Non-matching lines are ignored.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

type StepEntry = {
  code: string;
  yearLabel: string;
  paper: string;
  number: number;
  labels: string[];
};

const LINE_RE = /^(Spec|\d{2})-(S[123])-Q(\d{1,2})\s+(.+)$/;

function parse(raw: string): StepEntry[] {
  const out: StepEntry[] = [];
  const seen = new Set<string>();

  for (const original of raw.split(/\r?\n/)) {
    const line = original.trim();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, yearLabel, paper, numStr, labelRaw] = m;
    const number = parseInt(numStr, 10);
    if (!number || number < 1 || number > 20) continue;

    const code = `${yearLabel}-${paper}-Q${number}`;
    if (seen.has(code)) continue; // dedupe (paste has a few duplicates)
    seen.add(code);

    const labels = labelRaw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length < 80)
      .filter((s) => !/^(pdf|tex|Start|Clear|Show all|Back to home)$/i.test(s));

    out.push({ code, yearLabel, paper, number, labels });
  }
  return out;
}

function main() {
  // Read from file arg or stdin.
  let raw: string;
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) {
    raw = fs.readFileSync(arg, 'utf8');
  } else {
    raw = fs.readFileSync(0, 'utf8').toString();
  }

  const entries = parse(raw);
  const outPath = path.join(__dirname, 'index.json');
  fs.writeFileSync(outPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  const byPaper = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.paper] = (acc[e.paper] ?? 0) + 1;
    return acc;
  }, {});
  const years = new Set(entries.map((e) => e.yearLabel));
  const allLabels = new Set(entries.flatMap((e) => e.labels));

  console.log(`✓ Parsed ${entries.length} STEP questions → ${outPath}`);
  console.log(`  Years: ${[...years].sort().join(', ')}`);
  console.log(`  By paper:`, byPaper);
  console.log(`  Distinct labels: ${allLabels.size}`);
}

main();
