import type { Prisma } from "@smart-edu/v3-prisma";
import { MarkSchemeDocumentV1Schema, QuestionDocumentV1Schema } from "./contracts.ts";
import { getV3Prisma } from "./db.ts";
import { stableId } from "./ids.ts";
import type { RecordPublisher } from "./storage.ts";

type Assignment = {
  code?: string;
  label?: string;
  canonicalLabel?: string;
  aliases?: string[];
  taxonomyVersion?: string;
  source?: string;
  confidence?: number;
  adminOverride?: boolean;
  effectiveFromYear?: number;
  effectiveToYear?: number | null;
};

type QuestionRecord = {
  id: string;
  rootNumber: string;
  numberSort: number;
  document: unknown;
  schemaVersion: string;
  contentHash: string;
  sourceHash: string;
  marks?: number | null;
  confidence: number;
  publicationStatus: "REVIEW" | "APPROVED";
  assets: Array<{ assetId: string; role: string; ordering: number; blockId?: string }>;
  topics: Assignment[];
  tags: Assignment[];
};

type MarkSchemeRecord = Omit<QuestionRecord, "numberSort" | "topics" | "tags">;

export type V3PublishBundle = {
  version: "V3PublishBundleV1";
  subject: { id: string; board: string; qualification: string; subjectCode: string; name: string };
  paper: {
    id: string;
    subjectId: string;
    qualification: string;
    level: string;
    year: number;
    session: string;
    paperNumber: string;
    paperType: string;
    component: string;
    variant: string;
    timezone: string;
    language: string;
  };
  sourceDocument: Record<string, unknown> & { id: string; documentType: string };
  run: Record<string, unknown> & { id: string };
  questions: QuestionRecord[];
  markSchemes: MarkSchemeRecord[];
  assets: Array<Record<string, unknown> & { id: string; sha256: string }>;
  reviewIssues: Array<Record<string, unknown> & { id: string; issue_type: string; severity: string; message: string }>;
  resources: Array<Record<string, unknown>>;
};

export type PublishResult = {
  paperId: string;
  questionCount: number;
  markSchemeCount: number;
  assetCount: number;
  issueCount: number;
};

export class LocalPostgresRecordPublisher implements RecordPublisher<V3PublishBundle, PublishResult> {
  async publish(bundle: V3PublishBundle): Promise<PublishResult> {
    if (bundle.version !== "V3PublishBundleV1") throw new Error("Unsupported V3 publish bundle");
    const prisma = getV3Prisma();
    return prisma.$transaction(async (transaction) => {
      await transaction.v3Subject.upsert({
        where: { id: bundle.subject.id },
        create: bundle.subject,
        update: {
          board: bundle.subject.board,
          qualification: bundle.subject.qualification,
          subjectCode: bundle.subject.subjectCode,
          name: bundle.subject.name,
        },
      });
      await transaction.v3Paper.upsert({
        where: { id: bundle.paper.id },
        create: { ...bundle.paper, status: "PUBLISHED_LOCAL" },
        update: { ...bundle.paper, status: "PUBLISHED_LOCAL" },
      });

      const source = bundle.sourceDocument;
      await transaction.v3SourceDocument.upsert({
        where: { id: source.id },
        create: {
          id: source.id,
          paperId: bundle.paper.id,
          documentType: source.documentType as never,
          resourceCode: stringValue(source.resourceCode),
          language: stringValue(source.language, "en"),
          status: "PUBLISHED",
          expected: Boolean(source.expected),
          inventoryBasis: stringValue(source.inventoryBasis, "authoritative"),
          sourceUrl: nullableString(source.sourceUrl),
          sourcePaths: stringArray(source.sourcePaths),
          localPath: nullableString(source.localPath),
          sha256: nullableString(source.sha256),
          byteSize: bigintValue(source.byteSize),
          pageCount: numberValue(source.pageCount),
          readable: booleanValue(source.readable),
          validation: jsonValue(source.validation),
          validatedAt: new Date(),
        },
        update: {
          status: "PUBLISHED",
          sourceUrl: nullableString(source.sourceUrl),
          sourcePaths: stringArray(source.sourcePaths),
          localPath: nullableString(source.localPath),
          sha256: nullableString(source.sha256),
          byteSize: bigintValue(source.byteSize),
          pageCount: numberValue(source.pageCount),
          readable: booleanValue(source.readable),
          validation: jsonValue(source.validation),
          lastError: null,
          validatedAt: new Date(),
        },
      });

      const run = bundle.run;
      await transaction.v3ExtractionRun.upsert({
        where: { id: run.id },
        create: {
          id: run.id,
          sourceDocumentId: source.id,
          status: "PASSED",
          extractorModel: stringValue(run.extractorModel),
          verifierModel: stringValue(run.verifierModel),
          promptVersion: stringValue(run.promptVersion),
          schemaVersion: stringValue(run.schemaVersion),
          rendererVersion: stringValue(run.rendererVersion),
          extractorProvider: stringValue(run.extractorProvider),
          verifierProvider: stringValue(run.verifierProvider),
          workPath: stringValue(run.workPath),
          inputSha256: stringValue(run.inputSha256),
          confidence: numberValue(run.confidence),
          usage: jsonValue(run.usage),
          estimatedCostUsd: numberValue(run.estimatedCostUsd) ?? 0,
          stageReport: jsonValue(run.stageReport),
          completedAt: new Date(),
        },
        update: {
          status: "PASSED",
          confidence: numberValue(run.confidence),
          usage: jsonValue(run.usage),
          estimatedCostUsd: numberValue(run.estimatedCostUsd) ?? 0,
          stageReport: jsonValue(run.stageReport),
          failureStage: null,
          failureMessage: null,
          completedAt: new Date(),
        },
      });

      for (const asset of bundle.assets) {
        await transaction.v3Asset.upsert({
          where: { sha256: asset.sha256 },
          create: assetInput(asset, source.id),
          update: assetInput(asset, source.id),
        });
      }

      for (const question of bundle.questions) {
        const document = QuestionDocumentV1Schema.parse(question.document);
        await transaction.v3Question.upsert({
          where: { id: question.id },
          create: {
            id: question.id,
            paperId: bundle.paper.id,
            sourceDocumentId: source.id,
            extractionRunId: run.id,
            rootNumber: question.rootNumber,
            numberSort: question.numberSort,
            document: document as unknown as Prisma.InputJsonValue,
            schemaVersion: question.schemaVersion,
            contentHash: question.contentHash,
            sourceHash: question.sourceHash,
            marks: question.marks,
            confidence: question.confidence,
            publicationStatus: "PUBLISHED_LOCAL",
            approvedAt: new Date(),
            publishedAt: new Date(),
          },
          update: {
            extractionRunId: run.id,
            sourceDocumentId: source.id,
            numberSort: question.numberSort,
            document: document as unknown as Prisma.InputJsonValue,
            contentHash: question.contentHash,
            sourceHash: question.sourceHash,
            marks: question.marks,
            confidence: question.confidence,
            publicationStatus: "PUBLISHED_LOCAL",
            approvedAt: new Date(),
            publishedAt: new Date(),
          },
        });
        await transaction.v3QuestionAsset.deleteMany({ where: { questionId: question.id } });
        if (question.assets.length) {
          await transaction.v3QuestionAsset.createMany({
            data: question.assets.map((asset) => ({ questionId: question.id, ...asset })),
            skipDuplicates: true,
          });
        }
        await this.publishTopics(transaction, bundle, question);
        await this.publishTags(transaction, question);
      }

      for (const markScheme of bundle.markSchemes) {
        const document = MarkSchemeDocumentV1Schema.parse(markScheme.document);
        const exactQuestion = await transaction.v3Question.findUnique({
          where: {
            paperId_rootNumber_schemaVersion: {
              paperId: bundle.paper.id,
              rootNumber: markScheme.rootNumber,
              schemaVersion: "QuestionDocumentV1",
            },
          },
          select: { id: true },
        });
        await transaction.v3MarkScheme.upsert({
          where: { id: markScheme.id },
          create: {
            id: markScheme.id,
            paperId: bundle.paper.id,
            sourceDocumentId: source.id,
            extractionRunId: run.id,
            questionId: exactQuestion?.id,
            rootNumber: markScheme.rootNumber,
            document: document as unknown as Prisma.InputJsonValue,
            schemaVersion: markScheme.schemaVersion,
            contentHash: markScheme.contentHash,
            sourceHash: markScheme.sourceHash,
            marks: markScheme.marks,
            confidence: markScheme.confidence,
            publicationStatus: "PUBLISHED_LOCAL",
            approvedAt: new Date(),
            publishedAt: new Date(),
          },
          update: {
            extractionRunId: run.id,
            sourceDocumentId: source.id,
            questionId: exactQuestion?.id,
            document: document as unknown as Prisma.InputJsonValue,
            contentHash: markScheme.contentHash,
            sourceHash: markScheme.sourceHash,
            marks: markScheme.marks,
            confidence: markScheme.confidence,
            publicationStatus: "PUBLISHED_LOCAL",
            approvedAt: new Date(),
            publishedAt: new Date(),
          },
        });
      }

      for (const question of bundle.questions) {
        const markScheme = await transaction.v3MarkScheme.findUnique({
          where: {
            paperId_rootNumber_schemaVersion: {
              paperId: bundle.paper.id,
              rootNumber: question.rootNumber,
              schemaVersion: "MarkSchemeDocumentV1",
            },
          },
          select: { id: true },
        });
        if (markScheme) {
          await transaction.v3MarkScheme.update({
            where: { id: markScheme.id },
            data: { questionId: question.id },
          });
        }
      }

      for (const resource of bundle.resources) {
        const resourceType = stringValue(resource.resourceType, "other");
        const label = stringValue(resource.label, resourceType);
        const resourceId = stringValue(resource.id) || stableId("v3res", {
          paperId: bundle.paper.id,
          resourceType,
          label,
        });
        await transaction.v3PaperResource.upsert({
          where: { id: resourceId },
          create: {
            id: resourceId,
            paperId: bundle.paper.id,
            sourceDocumentId: nullableString(resource.sourceDocumentId),
            assetId: nullableString(resource.assetId),
            resourceType,
            label,
            mimeType: nullableString(resource.mimeType),
            relativePath: nullableString(resource.relativePath),
            metadata: jsonValue(resource.metadata),
          },
          update: {
            sourceDocumentId: nullableString(resource.sourceDocumentId),
            assetId: nullableString(resource.assetId),
            mimeType: nullableString(resource.mimeType),
            relativePath: nullableString(resource.relativePath),
            metadata: jsonValue(resource.metadata),
          },
        });
      }

      await transaction.v3ReviewIssue.deleteMany({ where: { extractionRunId: run.id } });
      for (const issue of bundle.reviewIssues) {
        await transaction.v3ReviewIssue.create({
          data: {
            id: issue.id,
            extractionRunId: run.id,
            issueType: issue.issue_type,
            severity: stringValue(issue.severity).toUpperCase() as never,
            status: "OPEN",
            fieldPath: nullableString(issue.field_path),
            message: issue.message,
            evidence: jsonValue(issue.evidence),
          },
        });
      }

      return {
        paperId: bundle.paper.id,
        questionCount: bundle.questions.length,
        markSchemeCount: bundle.markSchemes.length,
        assetCount: bundle.assets.length,
        issueCount: bundle.reviewIssues.length,
      };
    }, { timeout: 60_000 });
  }

  private async publishTopics(
    transaction: Parameters<Parameters<ReturnType<typeof getV3Prisma>["$transaction"]>[0]>[0],
    bundle: V3PublishBundle,
    question: QuestionRecord,
  ): Promise<void> {
    await transaction.v3QuestionTopic.deleteMany({ where: { questionId: question.id } });
    for (const assignment of question.topics) {
      const taxonomyVersion = assignment.taxonomyVersion ?? "unversioned";
      const code = assignment.code ?? slug(assignment.label ?? assignment.canonicalLabel ?? "general");
      const topicId = stableId("v3topic", { subjectId: bundle.subject.id, taxonomyVersion, code });
      await transaction.v3Topic.upsert({
        where: { id: topicId },
        create: {
          id: topicId,
          subjectId: bundle.subject.id,
          taxonomyVersion,
          code,
          canonicalLabel: assignment.canonicalLabel ?? assignment.label ?? code,
          aliases: assignment.aliases ?? [],
          effectiveFromYear: assignment.effectiveFromYear ?? bundle.paper.year,
          effectiveToYear: assignment.effectiveToYear,
        },
        update: {
          canonicalLabel: assignment.canonicalLabel ?? assignment.label ?? code,
          aliases: assignment.aliases ?? [],
          effectiveToYear: assignment.effectiveToYear,
        },
      });
      await transaction.v3QuestionTopic.create({
        data: {
          questionId: question.id,
          topicId,
          source: assignment.source ?? "extractor",
          confidence: assignment.confidence ?? question.confidence,
          taxonomyVersion,
          adminOverride: assignment.adminOverride ?? false,
        },
      });
    }
  }

  private async publishTags(
    transaction: Parameters<Parameters<ReturnType<typeof getV3Prisma>["$transaction"]>[0]>[0],
    question: QuestionRecord,
  ): Promise<void> {
    await transaction.v3QuestionTag.deleteMany({ where: { questionId: question.id } });
    for (const assignment of question.tags) {
      const canonicalLabel = slug(assignment.canonicalLabel ?? assignment.label ?? assignment.code ?? "general");
      const tagId = stableId("v3tag", { canonicalLabel });
      await transaction.v3Tag.upsert({
        where: { canonicalLabel },
        create: { id: tagId, canonicalLabel, aliases: assignment.aliases ?? [] },
        update: { aliases: assignment.aliases ?? [] },
      });
      await transaction.v3QuestionTag.create({
        data: {
          questionId: question.id,
          tagId,
          source: assignment.source ?? "extractor",
          confidence: assignment.confidence ?? question.confidence,
          taxonomyVersion: assignment.taxonomyVersion ?? "v1",
          adminOverride: assignment.adminOverride ?? false,
        },
      });
    }
  }
}

function assetInput(asset: Record<string, unknown>, sourceDocumentId: string) {
  return {
    id: stringValue(asset.id),
    sha256: stringValue(asset.sha256),
    relativePath: stringValue(asset.relative_path),
    mimeType: stringValue(asset.mime_type),
    width: numberValue(asset.width) ?? 0,
    height: numberValue(asset.height) ?? 0,
    byteSize: bigintValue(asset.byte_size) ?? BigInt(0),
    sourceDocumentId,
    sourcePage: numberValue(asset.source_page),
    cropX0: numberValue(asset.crop_x0),
    cropY0: numberValue(asset.crop_y0),
    cropX1: numberValue(asset.crop_x1),
    cropY1: numberValue(asset.crop_y1),
    role: stringValue(asset.role, "figure"),
    caption: nullableString(asset.caption),
    provenance: jsonValue(asset.provenance),
    qaOnly: Boolean(asset.qa_only),
  };
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return (value ?? {}) as Prisma.InputJsonValue;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bigintValue(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
