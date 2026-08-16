/**
 * Parses the raw STEP database index (plain-text, copy-pasted from
 * https://stepdatabase.maths.org/database/index.html) into a structured array.
 *
 * Input line format (one of):
 *   "Spec-S1-Q1 Inequalities, Binomial coefficient"
 *   "16-S1-Q1 Polynomials"
 *   "93-S2-Q7 Roots of equation Modulo arithmetic"  (multi-label, split on capitalised boundaries)
 *   blank / header lines ("Start", "Clear", etc.)  → ignored
 *
 * Output:
 *   { code: "Spec-S1-Q1", yearLabel: "Spec", paper: "S1", number: 1, labels: ["Inequalities", "Binomial coefficient"] }
 *
 * Run:  npx tsx scripts/step-data/parse-index.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

type StepEntry = {
  code: string;        // e.g. "16-S2-Q9"
  yearLabel: string;   // e.g. "16" or "Spec"
  paper: string;       // "S1" | "S2" | "S3"
  number: number;      // 1..16
  labels: string[];    // topic tags
};

// Match: <year>-<paper>-Q<number><space><label text>
// yearLabel may be "Spec" or 2 digits. paper is S1/S2/S3.
const LINE_RE = /^(Spec|\d{2})-(S[123])-Q(\d{1,2})\s+(.+)$/;

function parse(raw: string): StepEntry[] {
  const out: StepEntry[] = [];
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/);

  for (const original of lines) {
    const line = original.trim();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;

    const [, yearLabel, paper, numStr, labelRaw] = m;
    const number = parseInt(numStr, 10);
    if (!number || number < 1 || number > 20) continue;

    const code = `${yearLabel}-${paper}-Q${number}`;
    // Skip duplicate codes (the raw paste has some, e.g. 90-S2-Q1 appears 3×, 16-S1-Q1 3×).
    if (seen.has(code)) continue;
    seen.add(code);

    // Labels: the source uses commas and/or capitalised word boundaries to
    // separate multiple tags. Normalise: split on commas, then trim each.
    const labels = labelRaw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length < 80) // drop junk / stray long runs
      // Drop pure-noise fragments that leaked from the paste.
      .filter((s) => !/^(pdf|tex|Start|Clear|Show all|Back to home)$/i.test(s));

    out.push({ code, yearLabel, paper, number, labels });
  }

  return out;
}

function main() {
  const rawPath = path.join(__dirname, 'raw-index.txt');
  const outPath = path.join(__dirname, 'index.json');

  if (!fs.existsSync(rawPath)) {
    console.error(`Missing ${rawPath}. Paste the STEP index text into that file first.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(rawPath, 'utf8');
  const entries = parse(raw);

  fs.writeFileSync(outPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  // Summary
  const byPaper = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.paper] = (acc[e.paper] ?? 0) + 1;
    return acc;
  }, {});
  const allLabels = new Set(entries.flatMap((e) => e.labels));

  console.log(`Parsed ${entries.length} STEP questions → ${outPath}`);
  console.log('By paper:', byPaper);
  console.log(`Distinct labels: ${allLabels.size}`);
  console.log('First 3:', entries.slice(0, 3));
}

main();
