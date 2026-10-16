/**
 * Page layout for the printable question worksheet.
 *
 * Pure: it turns image sizes into positions on A4 pages and knows nothing about
 * PDF, storage or the database, so the pagination rules can be tested directly.
 * The renderer (`lib/bank-export.ts`) draws whatever this returns.
 *
 * Coordinates are PDF points with the origin at the TOP-left of the page and
 * `y` growing downward; the renderer flips them.
 *
 * Rules, in the order they matter to a person holding the printout:
 *   1. A question is never split across pages when it fits on one. A question
 *      cut in half over a page turn is the thing teachers complain about.
 *   2. A question taller than a page continues on the next, split between
 *      strips (a strip is already a natural break in the paper).
 *   3. A strip taller than the page is scaled down to fit rather than clipped.
 *   4. Crops print at their real size (they are cut at 200 dpi) and only shrink
 *      to the column; a small crop is not blown up to a full-width smear.
 */

export const PAGE = { width: 595.28, height: 841.89 } as const; // A4
export const MARGIN = { top: 56, bottom: 48, left: 40, right: 40 } as const;
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
const CONTENT_HEIGHT = PAGE.height - MARGIN.top - MARGIN.bottom;

/** Header line above each question, and the gaps around it. */
export const HEADER_HEIGHT = 20;
const STRIP_GAP = 4;
const QUESTION_GAP = 16;
/** Strips are cut at this resolution, so this converts pixels to points. */
export const SOURCE_DPI = 200;

export type LayoutStrip = { key: string; width: number; height: number };

export type LayoutQuestion = {
  id: number;
  /** Shown in the header, already formatted. */
  header: string;
  strips: LayoutStrip[];
  /** Shown instead of strips when there are none (e.g. no mark scheme). */
  placeholder?: string;
};

export type Placed =
  | { kind: 'header'; questionId: number; text: string; x: number; y: number; continued: boolean }
  | { kind: 'strip'; questionId: number; key: string; x: number; y: number; width: number; height: number }
  | { kind: 'note'; questionId: number; text: string; x: number; y: number };

export type LayoutOptions = {
  /** Start every question on a fresh page, leaving room to work in. */
  onePerPage?: boolean;
};

const NOTE_HEIGHT = 16;

/** Size in points of a strip of `pixels` wide by `heightPixels` tall. */
export function stripSize(pixelWidth: number, pixelHeight: number): { width: number; height: number } {
  const natural = (pixelWidth * 72) / SOURCE_DPI;
  const width = Math.min(CONTENT_WIDTH, natural);
  const scale = width / pixelWidth;
  return { width, height: pixelHeight * scale };
}

export function layoutQuestions(questions: LayoutQuestion[], options: LayoutOptions = {}): Placed[][] {
  const pages: Placed[][] = [[]];
  let y = 0;

  const page = () => pages[pages.length - 1];
  const newPage = () => {
    if (page().length > 0) pages.push([]);
    y = 0;
  };

  /** Total height a question needs if kept whole. */
  const blockHeight = (question: LayoutQuestion, sizes: Array<{ height: number }>) =>
    HEADER_HEIGHT +
    (sizes.length === 0
      ? NOTE_HEIGHT
      : sizes.reduce((sum, size) => sum + size.height, 0) + STRIP_GAP * (sizes.length - 1));

  for (const question of questions) {
    // Resolve sizes, shrinking any strip that alone exceeds a page.
    const sizes = question.strips.map((strip) => {
      const size = stripSize(strip.width, strip.height);
      const room = CONTENT_HEIGHT - HEADER_HEIGHT;
      if (size.height <= room) return size;
      const scale = room / size.height;
      return { width: size.width * scale, height: room };
    });

    const whole = blockHeight(question, sizes);
    if (options.onePerPage) {
      newPage();
    } else if (y > 0 && y + whole > CONTENT_HEIGHT && whole <= CONTENT_HEIGHT) {
      newPage();
    } else if (y > 0 && y + HEADER_HEIGHT + (sizes[0]?.height ?? NOTE_HEIGHT) > CONTENT_HEIGHT) {
      // Too tall for one page and not even the first strip fits here.
      newPage();
    }

    let continued = false;
    const writeHeader = () => {
      page().push({
        kind: 'header', questionId: question.id, text: question.header,
        x: MARGIN.left, y, continued,
      });
      y += HEADER_HEIGHT;
    };
    writeHeader();

    if (sizes.length === 0) {
      page().push({
        kind: 'note', questionId: question.id,
        text: question.placeholder ?? 'Nothing to show.', x: MARGIN.left, y,
      });
      y += NOTE_HEIGHT;
    }

    sizes.forEach((size, index) => {
      if (y + size.height > CONTENT_HEIGHT && y > HEADER_HEIGHT) {
        newPage();
        continued = true;
        writeHeader();
      }
      page().push({
        kind: 'strip', questionId: question.id, key: question.strips[index].key,
        x: MARGIN.left, y, width: size.width, height: size.height,
      });
      y += size.height + STRIP_GAP;
    });

    y += QUESTION_GAP;
  }

  // Drop a trailing blank page.
  if (pages.length > 1 && pages[pages.length - 1].length === 0) pages.pop();
  return pages;
}

/** Content box, exported so the renderer and the tests agree on it. */
export const CONTENT = { width: CONTENT_WIDTH, height: CONTENT_HEIGHT } as const;
