import type { Prisma } from "@smart-edu/v3-prisma";
import { getV3Prisma } from "@/lib/v3/db";

export type QuestionSearch = {
  query?: string;
  boards?: string[];
  qualifications?: string[];
  levels?: string[];
  subjects?: string[];
  years?: number[];
  sessions?: string[];
  paperTypes?: string[];
  variants?: string[];
  timezones?: string[];
  tags?: string[];
  topics?: string[];
  page: number;
  pageSize: number;
};

export async function searchV3Questions(input: QuestionSearch) {
  const prisma = getV3Prisma();
  const where: Prisma.V3QuestionWhereInput = {
    publicationStatus: "PUBLISHED_LOCAL",
    ...(input.query ? {
      OR: [
        { rootNumber: { contains: input.query, mode: "insensitive" } },
        { paper: { subject: { name: { contains: input.query, mode: "insensitive" } } } },
        { paper: { subject: { subjectCode: { contains: input.query, mode: "insensitive" } } } },
      ],
    } : {}),
    paper: {
      ...(input.boards?.length ? { subject: { board: { in: input.boards } } } : {}),
      ...(input.qualifications?.length ? { qualification: { in: input.qualifications } } : {}),
      ...(input.levels?.length ? { level: { in: input.levels } } : {}),
      ...(input.subjects?.length ? { subjectId: { in: input.subjects } } : {}),
      ...(input.years?.length ? { year: { in: input.years } } : {}),
      ...(input.sessions?.length ? { session: { in: input.sessions } } : {}),
      ...(input.paperTypes?.length ? { paperType: { in: input.paperTypes } } : {}),
      ...(input.variants?.length ? { variant: { in: input.variants } } : {}),
      ...(input.timezones?.length ? { timezone: { in: input.timezones } } : {}),
    },
    ...(input.tags?.length ? { tags: { some: { tagId: { in: input.tags } } } } : {}),
    ...(input.topics?.length ? { topics: { some: { topicId: { in: input.topics } } } } : {}),
  };
  const [total, questions] = await prisma.$transaction([
    prisma.v3Question.count({ where }),
    prisma.v3Question.findMany({
      where,
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      orderBy: [
        { paper: { year: "desc" } },
        { paper: { subject: { subjectCode: "asc" } } },
        { paper: { paperNumber: "asc" } },
        { numberSort: "asc" },
      ],
      include: {
        paper: { include: { subject: true } },
        topics: { include: { topic: true } },
        tags: { include: { tag: true } },
        assets: { orderBy: { ordering: "asc" }, include: { asset: true } },
        markScheme: { select: { id: true } },
      },
    }),
  ]);
  return {
    page: input.page,
    pageSize: input.pageSize,
    total,
    pageCount: Math.ceil(total / input.pageSize),
    items: questions.map((question) => ({
      id: question.id,
      rootNumber: question.rootNumber,
      marks: question.marks,
      confidence: question.confidence,
      document: question.document,
      paper: paperMetadata(question.paper),
      topics: question.topics.map(({ topic, source, confidence, taxonomyVersion, adminOverride }) => ({
        id: topic.id,
        code: topic.code,
        label: topic.canonicalLabel,
        source,
        confidence,
        taxonomyVersion,
        adminOverride,
      })),
      tags: question.tags.map(({ tag, source, confidence, taxonomyVersion, adminOverride }) => ({
        id: tag.id,
        label: tag.canonicalLabel,
        source,
        confidence,
        taxonomyVersion,
        adminOverride,
      })),
      assets: question.assets.map(({ asset, role, ordering, blockId }) => assetResponse(asset, role, ordering, blockId)),
      hasMarkScheme: Boolean(question.markScheme),
    })),
  };
}

export async function getV3Question(questionId: string) {
  const prisma = getV3Prisma();
  const question = await prisma.v3Question.findFirst({
    where: { id: questionId, publicationStatus: "PUBLISHED_LOCAL" },
    include: {
      paper: {
        include: {
          subject: true,
          resources: { include: { asset: true, sourceDocument: true } },
        },
      },
      sourceDocument: { select: { id: true, sha256: true, pageCount: true, documentType: true } },
      topics: { include: { topic: true } },
      tags: { include: { tag: true } },
      assets: { orderBy: { ordering: "asc" }, include: { asset: true } },
      markScheme: {
        include: { assets: { orderBy: { ordering: "asc" }, include: { asset: true } } },
      },
    },
  });
  if (!question) return null;
  return {
    id: question.id,
    rootNumber: question.rootNumber,
    marks: question.marks,
    confidence: question.confidence,
    schemaVersion: question.schemaVersion,
    sourceHash: question.sourceHash,
    document: question.document,
    paper: paperMetadata(question.paper),
    sourceDocument: question.sourceDocument,
    topics: question.topics.map(({ topic, source, confidence, taxonomyVersion, adminOverride }) => ({
      id: topic.id,
      code: topic.code,
      label: topic.canonicalLabel,
      source,
      confidence,
      taxonomyVersion,
      adminOverride,
    })),
    tags: question.tags.map(({ tag, source, confidence, taxonomyVersion, adminOverride }) => ({
      id: tag.id,
      label: tag.canonicalLabel,
      source,
      confidence,
      taxonomyVersion,
      adminOverride,
    })),
    assets: question.assets.map(({ asset, role, ordering, blockId }) => assetResponse(asset, role, ordering, blockId)),
    resources: question.paper.resources.map((resource) => ({
      id: resource.id,
      type: resource.resourceType,
      label: resource.label,
      mimeType: resource.mimeType,
      assetId: resource.assetId,
      sourceDocumentId: resource.sourceDocumentId,
      url: resource.assetId ? `/api/v3/assets/${resource.assetId}` : null,
      metadata: resource.metadata,
    })),
    markScheme: question.markScheme ? {
      id: question.markScheme.id,
      rootNumber: question.markScheme.rootNumber,
      marks: question.markScheme.marks,
      confidence: question.markScheme.confidence,
      document: question.markScheme.document,
      assets: question.markScheme.assets.map(({ asset, role, ordering, blockId }) => assetResponse(asset, role, ordering, blockId)),
    } : null,
  };
}

export async function getV3FilterMetadata() {
  const prisma = getV3Prisma();
  const [papers, tags, topics] = await prisma.$transaction([
    prisma.v3Paper.findMany({
      where: { questions: { some: { publicationStatus: "PUBLISHED_LOCAL" } } },
      select: {
        qualification: true,
        level: true,
        year: true,
        session: true,
        paperType: true,
        variant: true,
        timezone: true,
        subject: { select: { id: true, board: true, subjectCode: true, name: true } },
      },
    }),
    prisma.v3Tag.findMany({
      where: { questions: { some: { question: { publicationStatus: "PUBLISHED_LOCAL" } } } },
      select: { id: true, canonicalLabel: true },
      orderBy: { canonicalLabel: "asc" },
    }),
    prisma.v3Topic.findMany({
      where: { questions: { some: { question: { publicationStatus: "PUBLISHED_LOCAL" } } } },
      select: { id: true, code: true, canonicalLabel: true, taxonomyVersion: true, subjectId: true },
      orderBy: { canonicalLabel: "asc" },
    }),
  ]);
  return {
    boards: unique(papers.map((paper) => paper.subject.board)),
    qualifications: unique(papers.map((paper) => paper.qualification)),
    levels: unique(papers.map((paper) => paper.level)),
    subjects: uniqueBy(papers.map((paper) => paper.subject), (item) => item.id)
      .sort((left, right) => left.subjectCode.localeCompare(right.subjectCode)),
    years: unique(papers.map((paper) => paper.year)).sort((left, right) => right - left),
    sessions: unique(papers.map((paper) => paper.session)),
    paperTypes: unique(papers.map((paper) => paper.paperType)),
    variants: unique(papers.map((paper) => paper.variant).filter(Boolean)),
    timezones: unique(papers.map((paper) => paper.timezone).filter(Boolean)),
    tags: tags.map((tag) => ({ id: tag.id, label: tag.canonicalLabel })),
    topics: topics.map((topic) => ({
      id: topic.id,
      code: topic.code,
      label: topic.canonicalLabel,
      taxonomyVersion: topic.taxonomyVersion,
      subjectId: topic.subjectId,
    })),
  };
}

export type ReviewSearch = {
  issueType?: string;
  subjectId?: string;
  runId?: string;
  maxConfidence?: number;
  page: number;
  pageSize: number;
};

export async function searchV3ReviewIssues(input: ReviewSearch) {
  const prisma = getV3Prisma();
  const where: Prisma.V3ReviewIssueWhereInput = {
    status: "OPEN",
    ...(input.issueType ? { issueType: input.issueType } : {}),
    ...(input.runId ? { extractionRunId: input.runId } : {}),
    ...(typeof input.maxConfidence === "number" ? {
      OR: [
        { question: { confidence: { lte: input.maxConfidence } } },
        { markScheme: { confidence: { lte: input.maxConfidence } } },
      ],
    } : {}),
    ...(input.subjectId ? {
      extractionRun: { sourceDocument: { paper: { subjectId: input.subjectId } } },
    } : {}),
  };
  const [total, issues] = await prisma.$transaction([
    prisma.v3ReviewIssue.count({ where }),
    prisma.v3ReviewIssue.findMany({
      where,
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
      include: {
        sourceCrop: true,
        question: { include: { paper: { include: { subject: true } }, assets: { include: { asset: true } } } },
        markScheme: { include: { paper: { include: { subject: true } } } },
        extractionRun: { include: { sourceDocument: { include: { paper: { include: { subject: true } } } } } },
      },
    }),
  ]);
  return {
    page: input.page,
    pageSize: input.pageSize,
    total,
    pageCount: Math.ceil(total / input.pageSize),
    items: issues.map((issue) => {
      const paper = issue.question?.paper ?? issue.markScheme?.paper ?? issue.extractionRun.sourceDocument.paper;
      return {
        id: issue.id,
        issueType: issue.issueType,
        severity: issue.severity,
        fieldPath: issue.fieldPath,
        message: issue.message,
        evidence: issue.evidence,
        createdAt: issue.createdAt,
        runId: issue.extractionRunId,
        question: issue.question ? {
          id: issue.question.id,
          rootNumber: issue.question.rootNumber,
          confidence: issue.question.confidence,
          document: issue.question.document,
          assets: issue.question.assets.map(({ asset, role, ordering, blockId }) => assetResponse(asset, role, ordering, blockId)),
        } : null,
        markScheme: issue.markScheme ? {
          id: issue.markScheme.id,
          rootNumber: issue.markScheme.rootNumber,
          confidence: issue.markScheme.confidence,
          document: issue.markScheme.document,
        } : null,
        paper: paperMetadata(paper),
        sourceCrop: issue.sourceCrop ? assetResponse(issue.sourceCrop, "qa-source", 0, null) : null,
      };
    }),
  };
}

type PaperWithSubject = Prisma.V3PaperGetPayload<{ include: { subject: true } }>;
type AssetShape = Prisma.V3AssetGetPayload<Record<string, never>>;

function paperMetadata(paper: PaperWithSubject) {
  return {
    id: paper.id,
    board: paper.subject.board,
    qualification: paper.qualification,
    subjectId: paper.subject.id,
    subjectCode: paper.subject.subjectCode,
    subjectName: paper.subject.name,
    level: paper.level,
    year: paper.year,
    session: paper.session,
    paperNumber: paper.paperNumber,
    paperType: paper.paperType,
    component: paper.component,
    variant: paper.variant,
    timezone: paper.timezone,
    language: paper.language,
  };
}

function assetResponse(asset: AssetShape, role: string, ordering: number, blockId: string | null) {
  return {
    id: asset.id,
    url: `/api/v3/assets/${asset.id}`,
    sha256: asset.sha256,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    byteSize: Number(asset.byteSize),
    sourcePage: asset.sourcePage,
    crop: asset.cropX0 === null ? null : { x0: asset.cropX0, y0: asset.cropY0, x1: asset.cropX1, y1: asset.cropY1 },
    role,
    caption: asset.caption,
    ordering,
    blockId,
    qaOnly: asset.qaOnly,
  };
}

function unique<T extends string | number>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}
