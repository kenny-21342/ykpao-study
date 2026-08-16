/**
 * scripts/normalize-questions.ts
 *
 * One-shot maintenance script for the past-paper question bank.
 *
 * It does two things:
 *  1. TOPIC BACKFILL: sets `topic` on every past_paper_questions row that still
 *     has the default 'General'. Topics are inferred from keyword matches in the
 *     question content (works for both qp and ms rows). This is a best-effort
 *     heuristic; re-running the DeepSeek extractor will produce more accurate
 *     topic labels going forward.
 *  2. LATEX MERGE: if a row has content in `latex` but no math in `content`,
 *     append it as `$...$` so the UI renders a single unified field.
 *
 * Usage:
 *   npx tsx scripts/normalize-questions.ts          # backfill topic + merge latex
 *   npx tsx scripts/normalize-questions.ts --dry   # preview without writing
 *
 * Requires DATABASE_URL in the environment.
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { reindexRagCorpus } from "../lib/rag-index";

const TOPIC_RULES: Array<{ topic: string; keywords: RegExp[] }> = [
  // ---- Physics ----
  { topic: "Mechanics", keywords: [/kinematic/, /velocity/, /acceleration/, /Newton/, /momentum/, /force/, /projectile/, /friction/] },
  { topic: "Electromagnetism", keywords: [/electric field/, /magnetic field/, /circuit/, /voltage/, /current/, /capacitor/, /electromagnetic/, /\bEMF\b/] },
  { topic: "Thermodynamics", keywords: [/temperature/, /heat/, /thermal/, /entropy/, /gas$/, /ideal gas/, /specific heat/] },
  { topic: "Waves", keywords: [/wave/, /frequency/, /wavelength/, /amplitude/, /diffraction/, /interference/, /sound wave/] },
  { topic: "Optics", keywords: [/lens/, /mirror/, /refract/, /reflect/, /Snell/, /focal length/] },
  { topic: "Quantum & Nuclear", keywords: [/photon/, /photoelectric/, /nucleus/, /radioactiv/, /fission/, /fusion/, /half-life/] },
  { topic: "Circular Motion", keywords: [/circular motion/, /centripetal/, /angular/] },
  { topic: "Gravitation", keywords: [/gravit/, /orbit/, /planet/] },
  // ---- Mathematics ----
  { topic: "Algebra", keywords: [/solve.*equation/, /polynomial/, /factor/, /quadratic/, /simultaneous/] },
  { topic: "Calculus", keywords: [/differentiat/, /integrat/, /derivative/, /\bdy\/dx\b/, /limit/] },
  { topic: "Trigonometry", keywords: [/sin\b/, /cos\b/, /tan\b/, /triangle/, /angle/] },
  { topic: "Coordinate Geometry", keywords: [/coordinate/, /gradient/, /straight line/, /circle equation/] },
  { topic: "Probability", keywords: [/probability/, /dice/, /coin/, /random/] },
  { topic: "Statistics", keywords: [/mean\b/, /median/, /standard deviation/, /distribution/, /histogram/] },
  { topic: "Vectors", keywords: [/vector/, /scalar/, /magnitude/] },
  // ---- Chemistry ----
  { topic: "Organic Chemistry", keywords: [/alkane/, /alkene/, /alcohol/, /polymer/, /ester/, /hydrocarbon/] },
  { topic: "Inorganic Chemistry", keywords: [/transition metal/, /halogen/, /acid.*base/, /salt/] },
  { topic: "Physical Chemistry", keywords: [/mole/, /concentration/, /reaction rate/, /equilibrium/, /enthalpy/] },
  { topic: "Electrochemistry", keywords: [/electrolysis/, /electrode/, /cell potential/] },
  // ---- Biology ----
  { topic: "Cell Biology", keywords: [/cell membrane/, /mitochondri/, /ribosome/, /organelle/] },
  { topic: "Genetics", keywords: [/DNA/, /RNA/, /gene/, /chromosome/, /inheritance/, /mutation/] },
  { topic: "Ecology", keywords: [/ecosystem/, /food chain/, /population/, /trophic/] },
  { topic: "Human Physiology", keywords: [/respiration/, /circulation/, /digestion/, /nervous/] },
  // ---- Economics ----
  { topic: "Microeconomics", keywords: [/demand/, /supply/, /elasticity/, /market structure/] },
  { topic: "Macroeconomics", keywords: [/GDP/, /inflation/, /unemployment/, /fiscal/, /monetary policy/] },
];

function inferTopic(content: string): string {
  if (!content) return "General";
  const lower = content.toLowerCase();
  for (const rule of TOPIC_RULES) {
    if (rule.keywords.some((k) => k.test(lower))) return rule.topic;
  }
  return "General";
}

async function main() {
  const dry = process.argv.includes("--dry");
  console.log(dry ? "[DRY RUN] no changes will be written" : "Applying changes");

  // 1) Topic backfill
  const needsTopic = await prisma.pastPaperQuestion.count({
    where: { OR: [{ topic: "General" }, { topic: { equals: "" } }] },
  });
  console.log(`\n1) Topic backfill: ${needsTopic.toLocaleString()} rows to inspect`);

  let topicUpdated = 0;
  if (needsTopic > 0) {
    // Process in batches of 1000 to avoid loading everything into memory.
    // Collect (id, inferredTopic) pairs, then group updates by topic so we
    // can issue a single `updateMany({ where: { id: { in } }})` per topic
    // per batch — far cheaper than one update per row inside a transaction.
    let cursor = 0;
    while (true) {
      const batch = await prisma.pastPaperQuestion.findMany({
        where: { OR: [{ topic: "General" }, { topic: { equals: "" } }], id: { gt: cursor } },
        orderBy: { id: "asc" },
        take: 1000,
        select: { id: true, content: true, topic: true },
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;

      // Bucket ids by their inferred topic.
      const byTopic = new Map<string, number[]>();
      for (const q of batch) {
        const t = inferTopic(q.content);
        if (t === "General") continue;
        const arr = byTopic.get(t) ?? [];
        arr.push(q.id);
        byTopic.set(t, arr);
      }

      if (!dry) {
        for (const [topic, ids] of byTopic) {
          await prisma.pastPaperQuestion.updateMany({
            where: { id: { in: ids } },
            data: { topic },
          });
          topicUpdated += ids.length;
        }
      } else {
        for (const ids of byTopic.values()) topicUpdated += ids.length;
      }
      if (batch.length === 1000) {
        console.log(`   scanned to id ${cursor.toLocaleString()} (${topicUpdated.toLocaleString()} relabelled)`);
      }
    }
  }
  console.log(`   → ${topicUpdated.toLocaleString()} rows got a non-General topic${dry ? " (not written)" : ""}`);

  // 2) LaTeX merge — rows whose content has no math delimiters but whose latex
  //    field is non-empty: append the latex inline so FormattedMessage renders it.
  const needsLatex = await prisma.pastPaperQuestion.count({
    where: { NOT: [{ latex: "" }], content: { not: { contains: "$" } } },
  });
  console.log(`\n2) LaTeX merge: ${needsLatex.toLocaleString()} candidate rows`);
  let latexUpdated = 0;
  if (needsLatex > 0) {
    let cursor = 0;
    while (true) {
      const batch = await prisma.pastPaperQuestion.findMany({
        where: { NOT: [{ latex: "" }], content: { not: { contains: "$" } }, id: { gt: cursor } },
        orderBy: { id: "asc" },
        take: 200,
        select: { id: true, content: true, latex: true },
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;

      // Issue individual updates (no wrapping transaction — large
      // transactions against Neon time out on the 5s default).
      if (!dry) {
        for (const q of batch) {
          await prisma.pastPaperQuestion.update({
            where: { id: q.id },
            data: { content: `${q.content}\n\n$$${q.latex}$$`, latex: "" },
          });
        }
      }
      latexUpdated += batch.length;
      if (batch.length === 200) {
        console.log(`   merged to id ${cursor.toLocaleString()} (${latexUpdated.toLocaleString()} rows)`);
      }
    }
  } else if (needsLatex > 0 && dry) {
    latexUpdated = needsLatex;
  }
  console.log(`   → ${latexUpdated.toLocaleString()} rows had inline latex appended${dry ? " (not written)" : ""}`);

  if (!dry) {
    const rag = await reindexRagCorpus();
    console.log(`\nRAG index refreshed: ${rag.indexed.toLocaleString()} records`);
  }
  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error("Normalization failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
