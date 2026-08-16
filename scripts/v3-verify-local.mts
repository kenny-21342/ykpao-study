import { createHash } from "node:crypto";
import { MarkSchemeDocumentV1Schema, QuestionDocumentV1Schema } from "../lib/v3/contracts.ts";
import { getV3Config } from "../lib/v3/config.ts";
import { disconnectV3Prisma, getV3Prisma } from "../lib/v3/db.ts";
import { LocalAssetStore } from "../lib/v3/storage.ts";

const errors: string[] = [];
const prisma = getV3Prisma();
try {
  const [subjects, papers, questions, markSchemes, assets, tags, topics, openBlockingIssues] = await Promise.all([
    prisma.v3Subject.count(),
    prisma.v3Paper.count(),
    prisma.v3Question.findMany({
      where: { publicationStatus: "PUBLISHED_LOCAL" },
      include: { assets: { include: { asset: true } }, markScheme: true },
    }),
    prisma.v3MarkScheme.findMany({ where: { publicationStatus: "PUBLISHED_LOCAL" } }),
    prisma.v3Asset.count(),
    prisma.v3Tag.count(),
    prisma.v3Topic.count(),
    prisma.v3ReviewIssue.count({
      where: {
        status: "OPEN",
        severity: { in: ["HIGH", "CRITICAL"] },
        OR: [
          { question: { publicationStatus: "PUBLISHED_LOCAL" } },
          { markScheme: { publicationStatus: "PUBLISHED_LOCAL" } },
        ],
      },
    }),
  ]);
  const store = new LocalAssetStore(getV3Config().assetRoot);
  for (const question of questions) {
    const parsed = QuestionDocumentV1Schema.safeParse(question.document);
    if (!parsed.success) errors.push(`${question.id}: invalid question schema`);
    for (const link of question.assets) {
      if (!await store.exists(link.asset.relativePath)) {
        errors.push(`${question.id}: missing asset ${link.asset.id}`);
        continue;
      }
      const bytes = await store.read(link.asset.relativePath);
      if (createHash("sha256").update(bytes).digest("hex") !== link.asset.sha256) {
        errors.push(`${question.id}: asset hash mismatch ${link.asset.id}`);
      }
    }
    if (question.markScheme && (
      question.markScheme.paperId !== question.paperId
      || question.markScheme.rootNumber !== question.rootNumber
    )) {
      errors.push(`${question.id}: mark scheme is not an exact paper/root match`);
    }
  }
  for (const markScheme of markSchemes) {
    if (!MarkSchemeDocumentV1Schema.safeParse(markScheme.document).success) {
      errors.push(`${markScheme.id}: invalid mark-scheme schema`);
    }
  }
  if (openBlockingIssues) errors.push(`${openBlockingIssues} published records have open blocking issues`);
  const report = {
    ok: errors.length === 0,
    counts: {
      subjects,
      papers,
      questions: questions.length,
      markSchemes: markSchemes.length,
      assets,
      tags,
      topics,
      openBlockingIssues,
    },
    errors,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (errors.length) process.exitCode = 1;
} finally {
  await disconnectV3Prisma();
}
