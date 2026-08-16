import katex from "katex";
import { z } from "zod";

export const QUESTION_SCHEMA_VERSION = "QuestionDocumentV1" as const;
export const MARK_SCHEME_SCHEMA_VERSION = "MarkSchemeDocumentV1" as const;

export const BoundingBoxSchema = z.object({
  x0: z.number().finite().nonnegative(),
  y0: z.number().finite().nonnegative(),
  x1: z.number().finite().positive(),
  y1: z.number().finite().positive(),
}).refine((box) => box.x1 > box.x0 && box.y1 > box.y0, {
  message: "Bounding box must have positive area",
});

export const ProvenanceSchema = z.object({
  sourceDocumentId: z.string().min(1),
  page: z.number().int().positive(),
  bbox: BoundingBoxSchema.optional(),
  nativeBlockIds: z.array(z.string().min(1)).default([]),
});

const TextSegmentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const InlineMathSegmentSchema = z.object({
  type: z.literal("math"),
  latex: z.string().min(1),
  displayMode: z.literal("inline"),
});

export const InlineSegmentSchema = z.discriminatedUnion("type", [
  TextSegmentSchema,
  InlineMathSegmentSchema,
]);

const BlockBaseSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  provenance: z.array(ProvenanceSchema).default([]),
});

const ParagraphBlockSchema = BlockBaseSchema.extend({
  type: z.literal("paragraph"),
  content: z.object({ segments: z.array(InlineSegmentSchema).min(1) }),
});

const MathBlockSchema = BlockBaseSchema.extend({
  type: z.literal("math"),
  content: z.object({
    latex: z.string().min(1),
    displayMode: z.enum(["inline", "display"]),
  }),
});

const CaptionBlockSchema = BlockBaseSchema.extend({
  type: z.literal("caption"),
  content: z.object({ segments: z.array(InlineSegmentSchema).min(1) }),
});

const SourceExcerptBlockSchema = BlockBaseSchema.extend({
  type: z.literal("source_excerpt"),
  content: z.object({
    label: z.string().optional(),
    segments: z.array(InlineSegmentSchema).min(1),
  }),
});

const FigureBlockSchema = BlockBaseSchema.extend({
  type: z.literal("figure"),
  content: z.object({
    assetId: z.string().min(1),
    role: z.enum(["figure", "diagram", "graph", "map", "photo", "source", "table_fallback"]),
    caption: z.string().optional(),
    displayOrder: z.number().int().nonnegative(),
  }),
});

type QuestionBlockInput = {
  id: string;
  type: string;
  order: number;
  provenance?: z.input<typeof ProvenanceSchema>[];
  content: unknown;
};

export const QuestionBlockSchema: z.ZodType<QuestionBlockInput> = z.lazy(() =>
  z.discriminatedUnion("type", [
    ParagraphBlockSchema,
    MathBlockSchema,
    CaptionBlockSchema,
    SourceExcerptBlockSchema,
    FigureBlockSchema,
    BlockBaseSchema.extend({
      type: z.literal("list"),
      content: z.object({
        style: z.enum(["ordered", "unordered", "choices"]),
        items: z.array(z.object({
          id: z.string().min(1),
          label: z.string().optional(),
          blocks: z.array(QuestionBlockSchema).min(1),
        })).min(1),
      }),
    }),
    BlockBaseSchema.extend({
      type: z.literal("subpart"),
      content: z.object({
        label: z.string().min(1),
        path: z.array(z.string().min(1)).min(1),
        marks: z.number().int().nonnegative().optional(),
        blocks: z.array(QuestionBlockSchema).min(1),
      }),
    }),
    BlockBaseSchema.extend({
      type: z.literal("table"),
      content: z.object({
        caption: z.string().optional(),
        columnCount: z.number().int().positive(),
        confidence: z.number().min(0).max(1),
        fallbackAssetId: z.string().min(1),
        rows: z.array(z.object({
          id: z.string().min(1),
          cells: z.array(z.object({
            id: z.string().min(1),
            header: z.boolean().default(false),
            rowSpan: z.number().int().positive().default(1),
            colSpan: z.number().int().positive().default(1),
            content: z.array(z.union([ParagraphBlockSchema, MathBlockSchema])).min(1),
          })).min(1),
        })).min(1),
      }),
    }),
  ]),
);

export const QuestionDocumentV1Schema = z.object({
  version: z.literal(QUESTION_SCHEMA_VERSION),
  rootNumber: z.string().min(1),
  marks: z.number().int().nonnegative().optional(),
  blocks: z.array(QuestionBlockSchema).min(1),
}).superRefine((document, context) => {
  const ids = new Set<string>();
  walkBlocks(document.blocks, (block) => {
    if (ids.has(block.id)) {
      context.addIssue({ code: "custom", message: `Duplicate block id: ${block.id}` });
    }
    ids.add(block.id);
    for (const expression of mathInBlock(block)) {
      const error = validateLatex(expression.latex, expression.displayMode === "display");
      if (error) {
        context.addIssue({
          code: "custom",
          message: `Invalid LaTeX in ${block.id}: ${error}`,
        });
      }
    }
  });
});

const MarkPointSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  markCode: z.string().optional(),
  marks: z.number().int().nonnegative(),
  answer: z.array(InlineSegmentSchema).min(1),
  alternatives: z.array(z.array(InlineSegmentSchema).min(1)).default([]),
  acceptableAnswers: z.array(z.array(InlineSegmentSchema).min(1)).default([]),
  notes: z.array(z.array(InlineSegmentSchema).min(1)).default([]),
  provenance: z.array(ProvenanceSchema).default([]),
});

export const MarkSchemeDocumentV1Schema = z.object({
  version: z.literal(MARK_SCHEME_SCHEMA_VERSION),
  rootNumber: z.string().min(1),
  marks: z.number().int().nonnegative().optional(),
  sections: z.array(z.object({
    id: z.string().min(1),
    order: z.number().int().nonnegative(),
    path: z.array(z.string().min(1)),
    label: z.string().min(1),
    points: z.array(MarkPointSchema).min(1),
  })).min(1),
}).superRefine((document, context) => {
  const ids = new Set<string>();
  for (const section of document.sections) {
    if (ids.has(section.id)) {
      context.addIssue({ code: "custom", message: `Duplicate section id: ${section.id}` });
    }
    ids.add(section.id);
    for (const point of section.points) {
      if (ids.has(point.id)) {
        context.addIssue({ code: "custom", message: `Duplicate mark point id: ${point.id}` });
      }
      ids.add(point.id);
      const groups = [point.answer, ...point.alternatives, ...point.acceptableAnswers, ...point.notes];
      for (const segment of groups.flat()) {
        if (segment.type !== "math") continue;
        const error = validateLatex(segment.latex, false);
        if (error) context.addIssue({ code: "custom", message: `Invalid LaTeX in ${point.id}: ${error}` });
      }
    }
  }
});

export type QuestionDocumentV1 = z.infer<typeof QuestionDocumentV1Schema>;
export type QuestionBlock = z.infer<typeof QuestionBlockSchema>;
export type MarkSchemeDocumentV1 = z.infer<typeof MarkSchemeDocumentV1Schema>;
export type InlineSegment = z.infer<typeof InlineSegmentSchema>;

export function validateLatex(latex: string, displayMode: boolean): string | null {
  if (/\$|\\\(|\\\)|\\\[|\\\]/.test(latex)) {
    return "Math content must be delimiter-free";
  }
  try {
    katex.renderToString(latex, {
      displayMode,
      throwOnError: true,
      strict: "error",
      output: "html",
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "KaTeX rejected the expression";
  }
}

export function normalizeProseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeQuestionDocument(input: unknown): QuestionDocumentV1 {
  const document = structuredClone(input) as Record<string, unknown>;
  if (Array.isArray(document.blocks)) normalizeBlocks(document.blocks as QuestionBlockInput[]);
  return QuestionDocumentV1Schema.parse(document);
}

function normalizeBlocks(blocks: QuestionBlockInput[]): void {
  for (const block of blocks) {
    const content = block.content as Record<string, unknown>;
    if (Array.isArray(content.segments)) normalizeSegments(content.segments as Array<Record<string, unknown>>);
    if (typeof content.caption === "string") content.caption = normalizeProseWhitespace(content.caption);
    if (Array.isArray(content.blocks)) normalizeBlocks(content.blocks as QuestionBlockInput[]);
    if (Array.isArray(content.items)) {
      for (const item of content.items as Array<Record<string, unknown>>) {
        if (Array.isArray(item.blocks)) normalizeBlocks(item.blocks as QuestionBlockInput[]);
      }
    }
    if (Array.isArray(content.rows)) {
      for (const row of content.rows as Array<Record<string, unknown>>) {
        if (!Array.isArray(row.cells)) continue;
        for (const cell of row.cells as Array<Record<string, unknown>>) {
          if (Array.isArray(cell.content)) normalizeBlocks(cell.content as QuestionBlockInput[]);
        }
      }
    }
  }
}

function normalizeSegments(segments: Array<Record<string, unknown>>): void {
  for (const segment of segments) {
    if (segment.type === "text" && typeof segment.text === "string") {
      segment.text = normalizeProseWhitespace(segment.text);
    }
  }
}

function walkBlocks(blocks: QuestionBlockInput[], visit: (block: QuestionBlockInput) => void): void {
  for (const block of blocks) {
    visit(block);
    const content = block.content as Record<string, unknown>;
    if (Array.isArray(content.blocks)) walkBlocks(content.blocks as QuestionBlockInput[], visit);
    if (Array.isArray(content.items)) {
      for (const item of content.items as Array<Record<string, unknown>>) {
        if (Array.isArray(item.blocks)) walkBlocks(item.blocks as QuestionBlockInput[], visit);
      }
    }
    if (Array.isArray(content.rows)) {
      for (const row of content.rows as Array<Record<string, unknown>>) {
        if (!Array.isArray(row.cells)) continue;
        for (const cell of row.cells as Array<Record<string, unknown>>) {
          if (Array.isArray(cell.content)) walkBlocks(cell.content as QuestionBlockInput[], visit);
        }
      }
    }
  }
}

function mathInBlock(block: QuestionBlockInput): Array<{ latex: string; displayMode: string }> {
  const content = block.content as Record<string, unknown>;
  if (block.type === "math" && typeof content.latex === "string") {
    return [{ latex: content.latex, displayMode: String(content.displayMode) }];
  }
  const expressions: Array<{ latex: string; displayMode: string }> = [];
  if (Array.isArray(content.segments)) {
    for (const segment of content.segments as Array<Record<string, unknown>>) {
      if (segment.type === "math" && typeof segment.latex === "string") {
        expressions.push({ latex: segment.latex, displayMode: "inline" });
      }
    }
  }
  return expressions;
}
