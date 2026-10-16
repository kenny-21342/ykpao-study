/**
 * Build the printable worksheet: selected bank questions (and optionally their
 * mark schemes) as a PDF.
 *
 * The bank is crops of the original papers, so the worksheet is those crops
 * placed on A4 pages -- nothing is re-typeset, which is why it looks like the
 * real paper. Positions come from `lib/export-layout.ts`; this file fetches the
 * images, draws them, and adds the title and footer.
 *
 * Images are re-encoded as JPEG before embedding. The crops are PNGs of mostly
 * white paper; as JPEG at q82 they are about a fifth of the size, which is the
 * difference between a PDF a phone can open and one it cannot.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from 'pdf-lib';
import sharp from 'sharp';
import { formatQuestionCode } from '@/lib/bank-search';
import { bankSubjectName } from '@/lib/bank-questions';
import {
  layoutQuestions, MARGIN, PAGE,
  type LayoutQuestion, type Placed,
} from '@/lib/export-layout';
import { prisma } from '@/lib/prisma';
import { getStorage } from '@/lib/storage';
import { bankAssetKey } from '@/lib/storage/keys';

export const EXPORT_MAX_QUESTIONS = 100;
/** Ceiling on source image bytes fetched for one worksheet. */
const MAX_SOURCE_BYTES = 150 * 1024 * 1024;
const FETCH_CONCURRENCY = 8;

export class ExportError extends Error {}

type StripRow = { sha256: string };

export type ExportQuestion = {
  id: number;
  header: string;
  strips: StripRow[];
  markScheme: { strips: StripRow[]; answerLetter: string | null } | null;
};

/** Published questions in the order requested; ids that do not resolve are dropped. */
export async function loadExportQuestions(ids: number[]): Promise<ExportQuestion[]> {
  const rows = await prisma.bankQuestion.findMany({
    where: { id: { in: ids }, status: 'published' },
    select: {
      id: true,
      rootNumber: true,
      totalMarks: true,
      strips: { orderBy: { ordering: 'asc' }, select: { asset: { select: { sha256: true } } } },
      markScheme: {
        select: {
          status: true,
          answerLetter: true,
          strips: { orderBy: { ordering: 'asc' }, select: { asset: { select: { sha256: true } } } },
        },
      },
      paper: {
        select: {
          year: true, session: true, paperNumber: true, variant: true, timezone: true,
          subject: { select: { name: true, code: true, level: true, board: true } },
        },
      },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: ExportQuestion[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const code = formatQuestionCode(
      {
        board: row.paper.subject.board, subjectCode: row.paper.subject.code,
        level: row.paper.subject.level, year: row.paper.year, session: row.paper.session,
        paperNumber: row.paper.paperNumber, variant: row.paper.variant, timezone: row.paper.timezone,
      },
      row.rootNumber,
    );
    const marks = row.totalMarks ? ` · ${row.totalMarks} marks` : '';
    out.push({
      id: row.id,
      header: `${bankSubjectName(row.paper.subject)} · ${code}${marks}`,
      strips: row.strips.map((strip) => ({ sha256: strip.asset.sha256 })),
      markScheme:
        row.markScheme && row.markScheme.status === 'published'
          ? {
              answerLetter: row.markScheme.answerLetter,
              strips: row.markScheme.strips.map((strip) => ({ sha256: strip.asset.sha256 })),
            }
          : null,
    });
  }
  return out;
}

/** Helvetica can only draw WinAnsi; anything else would throw mid-render. */
export function toWinAnsi(text: string): string {
  return text.replace(/[^\x20-\x7E -ÿ–—‘’“”•]/g, '?');
}

type Fetched = { jpeg: Buffer; width: number; height: number };

/** Fetch and re-encode each distinct image once, a few at a time. */
async function fetchImages(shas: string[]): Promise<{ images: Map<string, Fetched>; missing: Set<string> }> {
  const images = new Map<string, Fetched>();
  const missing = new Set<string>();
  const store = getStorage();
  const queue = [...new Set(shas)];
  let sourceBytes = 0;

  async function worker() {
    for (let sha = queue.pop(); sha !== undefined; sha = queue.pop()) {
      const key = bankAssetKey(sha);
      const object = key ? await store.get(key).catch(() => null) : null;
      if (!object) { missing.add(sha); continue; }
      sourceBytes += object.size;
      if (sourceBytes > MAX_SOURCE_BYTES) {
        throw new ExportError('That selection is too large to export in one go. Select fewer questions.');
      }
      try {
        const { data, info } = await sharp(object.bytes)
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 82 })
          .toBuffer({ resolveWithObject: true });
        images.set(sha, { jpeg: data, width: info.width, height: info.height });
      } catch {
        missing.add(sha);
      }
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  return { images, missing };
}

export type WorksheetOptions = {
  title: string;
  includeMarkScheme: boolean;
  onePerPage: boolean;
};

export type Worksheet = {
  bytes: Uint8Array;
  pages: number;
  questions: number;
  /** Questions that were asked for with a mark scheme but have none. */
  withoutMarkScheme: number;
  /** Images that could not be fetched; those spots print a note. */
  missingImages: number;
};

export async function buildWorksheet(
  questions: ExportQuestion[],
  options: WorksheetOptions,
): Promise<Worksheet> {
  const wanted = questions.flatMap((q) => [
    ...q.strips.map((s) => s.sha256),
    ...(options.includeMarkScheme ? (q.markScheme?.strips ?? []).map((s) => s.sha256) : []),
  ]);
  const { images, missing } = await fetchImages(wanted);

  const toLayout = (items: Array<{ id: number; header: string; strips: StripRow[]; empty: string }>): LayoutQuestion[] =>
    items.map((item) => {
      const strips = item.strips.filter((s) => images.has(s.sha256));
      const lost = item.strips.length - strips.length;
      return {
        id: item.id,
        header: item.header,
        strips: strips.map((s) => ({ key: s.sha256, width: images.get(s.sha256)!.width, height: images.get(s.sha256)!.height })),
        placeholder: lost > 0 && strips.length === 0 ? 'This image could not be loaded.' : item.empty,
      };
    });

  const questionPages = layoutQuestions(
    toLayout(questions.map((q) => ({ id: q.id, header: q.header, strips: q.strips, empty: 'No image for this question.' }))),
    { onePerPage: options.onePerPage },
  );

  let withoutMarkScheme = 0;
  let schemePages: Placed[][] = [];
  if (options.includeMarkScheme) {
    const items = questions.map((q) => {
      const scheme = q.markScheme;
      const hasContent = !!scheme && (scheme.strips.length > 0 || !!scheme.answerLetter);
      if (!hasContent) withoutMarkScheme += 1;
      return {
        id: q.id,
        header: `Mark scheme · ${q.header}`,
        strips: scheme?.strips ?? [],
        empty: scheme?.answerLetter ? `Answer: ${scheme.answerLetter}` : 'No mark scheme is available for this question.',
      };
    });
    schemePages = layoutQuestions(toLayout(items));
  }

  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const embedded = new Map<string, PDFImage>();
  for (const [sha, image] of images) embedded.set(sha, await doc.embedJpg(image.jpeg));

  const title = toWinAnsi(options.title.trim() || 'Practice worksheet');
  const allPages = [...questionPages, ...schemePages];
  const total = allPages.length;
  const ink = rgb(0.12, 0.12, 0.14);
  const muted = rgb(0.42, 0.42, 0.46);

  allPages.forEach((items, index) => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const flip = (y: number, height = 0) => PAGE.height - MARGIN.top - y - height;
    const isScheme = index >= questionPages.length;

    page.drawText(title, { x: MARGIN.left, y: PAGE.height - 30, size: 10, font: bold, color: ink });
    if (isScheme) {
      page.drawText('Mark scheme', { x: PAGE.width - MARGIN.right - bold.widthOfTextAtSize('Mark scheme', 10), y: PAGE.height - 30, size: 10, font: bold, color: muted });
    }
    page.drawLine({
      start: { x: MARGIN.left, y: PAGE.height - 38 }, end: { x: PAGE.width - MARGIN.right, y: PAGE.height - 38 },
      thickness: 0.5, color: muted,
    });

    for (const item of items) {
      if (item.kind === 'header') {
        const text = toWinAnsi(item.text + (item.continued ? ' (continued)' : ''));
        page.drawText(clip(text, bold, 10, PAGE.width - MARGIN.left - MARGIN.right), {
          x: item.x, y: flip(item.y, 12), size: 10, font: bold, color: ink,
        });
      } else if (item.kind === 'note') {
        page.drawText(toWinAnsi(item.text), { x: item.x, y: flip(item.y, 10), size: 9, font: regular, color: muted });
      } else {
        const image = embedded.get(item.key);
        if (image) page.drawImage(image, { x: item.x, y: flip(item.y, item.height), width: item.width, height: item.height });
      }
    }

    const footer = `YKPao Study — classroom use · Page ${index + 1} of ${total}`;
    page.drawText(footer, { x: MARGIN.left, y: 26, size: 8, font: regular, color: muted });
  });

  doc.setTitle(title);
  doc.setProducer('YKPao Study');
  const bytes = await doc.save();
  return {
    bytes,
    pages: total,
    questions: questions.length,
    withoutMarkScheme,
    missingImages: missing.size,
  };
}

/** Shorten text with an ellipsis so a long subject name cannot run off the page. */
function clip(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(out + '...', size) > maxWidth) out = out.slice(0, -1);
  return out + '...';
}
