import { z } from "zod";
import type { Prisma } from "@smart-edu/v3-prisma";
import { requireAdmin } from "@/lib/auth";
import { MarkSchemeDocumentV1Schema, QuestionDocumentV1Schema } from "@/lib/v3/contracts";
import { getV3Config } from "@/lib/v3/config";
import { getV3Prisma } from "@/lib/v3/db";
import { canonicalJson, sha256 } from "@/lib/v3/ids";
import { v3DisabledResponse, v3ErrorResponse } from "@/lib/v3/http";
import { getV3AssetStore } from "@/lib/v3/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("correct"), document: z.unknown(), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal("approve"), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal("reject"), note: z.string().min(1).max(1000) }),
  z.object({ action: z.literal("reextract"), note: z.string().max(1000).optional() }),
]);

export async function PATCH(request: Request, { params }: { params: Promise<{ issueId: string }> }) {
  const disabled = v3DisabledResponse();
  if (disabled) return disabled;
  const admin = await requireAdmin();
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    const { issueId } = await params;
    const action = ActionSchema.parse(await request.json());
    const prisma = getV3Prisma();
    const issue = await prisma.v3ReviewIssue.findUnique({
      where: { id: issueId },
      include: {
        question: { include: { assets: { include: { asset: true } } } },
        markScheme: true,
        extractionRun: { include: { sourceDocument: true } },
      },
    });
    if (!issue) return Response.json({ error: "Review issue not found" }, { status: 404 });

    if (action.action === "correct") {
      let correction: Prisma.InputJsonValue;
      if (issue.questionId) {
        const document = QuestionDocumentV1Schema.parse(action.document);
        correction = document as unknown as Prisma.InputJsonValue;
        await prisma.v3Question.update({
          where: { id: issue.questionId },
          data: {
            document: correction,
            contentHash: sha256(canonicalJson(document)),
            publicationStatus: "REVIEW",
          },
        });
      } else if (issue.markSchemeId) {
        const document = MarkSchemeDocumentV1Schema.parse(action.document);
        correction = document as unknown as Prisma.InputJsonValue;
        await prisma.v3MarkScheme.update({
          where: { id: issue.markSchemeId },
          data: {
            document: correction,
            contentHash: sha256(canonicalJson(document)),
            publicationStatus: "REVIEW",
          },
        });
      } else {
        return Response.json({ error: "This issue has no editable record" }, { status: 409 });
      }
      await prisma.v3ReviewIssue.update({
        where: { id: issue.id },
        data: {
          status: "RESOLVED",
          correction,
          resolutionNote: action.note ?? "Corrected in review",
          reviewedBy: admin.id,
          reviewedAt: new Date(),
        },
      });
    }

    if (action.action === "approve") {
      const remaining = await prisma.v3ReviewIssue.count({
        where: {
          id: { not: issue.id },
          status: "OPEN",
          severity: { in: ["HIGH", "CRITICAL"] },
          ...(issue.questionId ? { questionId: issue.questionId } : { markSchemeId: issue.markSchemeId }),
        },
      });
      if (remaining) return Response.json({ error: "Resolve all high-severity issues before approval" }, { status: 409 });
      if (issue.question) {
        QuestionDocumentV1Schema.parse(issue.question.document);
        const store = await getV3AssetStore(getV3Config().assetRoot);
        const missing = [];
        for (const link of issue.question.assets) {
          if (!await store.exists(link.asset.relativePath)) missing.push(link.asset.id);
        }
        if (missing.length) return Response.json({ error: "Question assets are missing", missing }, { status: 409 });
        await prisma.v3Question.update({
          where: { id: issue.question.id },
          data: { publicationStatus: "PUBLISHED_LOCAL", approvedAt: new Date(), publishedAt: new Date() },
        });
      } else if (issue.markScheme) {
        MarkSchemeDocumentV1Schema.parse(issue.markScheme.document);
        await prisma.v3MarkScheme.update({
          where: { id: issue.markScheme.id },
          data: { publicationStatus: "PUBLISHED_LOCAL", approvedAt: new Date(), publishedAt: new Date() },
        });
      }
      await prisma.v3ReviewIssue.update({
        where: { id: issue.id },
        data: { status: "RESOLVED", resolutionNote: action.note ?? "Approved", reviewedBy: admin.id, reviewedAt: new Date() },
      });
    }

    if (action.action === "reject") {
      if (issue.questionId) await prisma.v3Question.update({ where: { id: issue.questionId }, data: { publicationStatus: "REJECTED" } });
      if (issue.markSchemeId) await prisma.v3MarkScheme.update({ where: { id: issue.markSchemeId }, data: { publicationStatus: "REJECTED" } });
      await prisma.v3ReviewIssue.update({
        where: { id: issue.id },
        data: { status: "REJECTED", resolutionNote: action.note, reviewedBy: admin.id, reviewedAt: new Date() },
      });
    }

    if (action.action === "reextract") {
      await prisma.$transaction([
        prisma.v3SourceDocument.update({
          where: { id: issue.extractionRun.sourceDocumentId },
          data: { status: "READY", lastError: null },
        }),
        prisma.v3ReviewIssue.update({
          where: { id: issue.id },
          data: {
            status: "RESOLVED",
            resolutionNote: action.note ?? "Queued for re-extraction",
            reviewedBy: admin.id,
            reviewedAt: new Date(),
          },
        }),
      ]);
    }
    return Response.json({ ok: true, action: action.action, issueId });
  } catch (error) {
    return v3ErrorResponse(error);
  }
}
