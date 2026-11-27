'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Keyboard, PenLine, Plus } from 'lucide-react';
import type { DrawingCanvasHandle, DrawingCanvasStrokeData } from './DrawingCanvas';
import { useQuestionScratchpad, type ScratchpadRef } from './useQuestionScratchpad';
import { useMeasuredCanvasWidth } from './useMeasuredCanvasWidth';

const DrawingCanvas = dynamic(() => import('./DrawingCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-60 items-center justify-center text-sm text-muted">Loading the writing area…</div>
  ),
});

export type HandwrittenAnswerHandle = {
  /** Save any unsaved ink now, so a submit that follows reads the latest image. */
  flush: () => Promise<void>;
};

/** A strip of the question scan, as the bank serves it. */
export type PaperStrip = { url: string; width: number | null; height: number | null };

/** How much paper is added at a time, in canvas pixels. */
const GROW_STEP = 280;
/** Ink this close to the bottom edge adds more paper, as a booklet would. */
const GROW_MARGIN = 90;
const MAX_WIDTH = 900;
/** Ruled space under a question scan, for working that does not fit a box. */
const SPACE_UNDER_PAPER = 240;
/** Width of the image the marker receives when the page is a question scan. */
const PAPER_EXPORT_WIDTH = 1200;
/**
 * Pixel budget for the stitched scan. iOS Safari refuses a canvas over about
 * 16.7 million pixels, and a five-page question at full scan resolution is
 * well past that.
 */
const STITCH_MAX_PIXELS = 10_000_000;

function lowestInk(data: DrawingCanvasStrokeData): number {
  let lowest = 0;
  for (const stroke of data.strokes) {
    for (const [, y] of stroke.points) if (y > lowest) lowest = y;
  }
  for (const box of data.textBoxes) lowest = Math.max(lowest, box.y + box.fontSize * 2);
  return lowest;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`could not load ${src}`));
    image.src = src;
  });
}

/**
 * The question's strips stacked into one page, as `StripStack` shows them:
 * each at its own width, left-aligned, so a narrow part stays narrow. The
 * strips are same-origin, so the canvas stays readable for export.
 */
function useStitchedPaper(strips: PaperStrip[] | undefined) {
  const [paper, setPaper] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const key = strips?.map((strip) => strip.url).join('|') ?? '';
  useEffect(() => {
    if (!strips?.length) return;
    let cancelled = false;
    (async () => {
      try {
        // Same-origin copies: the usual URL redirects to the object store,
        // which sends no CORS headers, and a canvas holding a cross-origin
        // image cannot be exported.
        const images = await Promise.all(
          strips.map((strip) => loadImage(`${strip.url}${strip.url.includes('?') ? '&' : '?'}inline=1`)),
        );
        // Each strip at its size on the page (the strip's `width` is in
        // 200-DPI pixels), not its pixel count: a strip rendered at 147 DPI
        // would otherwise come out narrower than the 200-DPI strip under it.
        const sizes = images.map((image, index) => {
          const width = strips[index].width ?? image.naturalWidth;
          return { width, height: image.naturalHeight * (width / Math.max(image.naturalWidth, 1)) };
        });
        const widest = Math.max(...sizes.map((size) => size.width), 1);
        const total = sizes.reduce((sum, size) => sum + size.height, 0);
        const scale = Math.min(1, Math.sqrt(STITCH_MAX_PIXELS / (widest * total)));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(widest * scale);
        canvas.height = Math.round(total * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        let y = 0;
        images.forEach((image, index) => {
          ctx.drawImage(image, 0, y * scale, sizes[index].width * scale, sizes[index].height * scale);
          y += sizes[index].height;
        });
        const stitched = await loadImage(canvas.toDataURL('image/jpeg', 0.9));
        if (!cancelled) setPaper(stitched);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `key` stands for `strips`: a new array with the same strips is the same page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { paper, failed };
}

/**
 * A handwritten answer, written with a stylus, finger or mouse.
 *
 * Two layouts. Given `paper` (the question's scan strips), the student writes
 * on the question itself -- into the printed answer boxes, as in the exam --
 * with ruled space below it for anything that does not fit. Without it, a
 * blank ruled page. The image the marker receives is the page as written:
 * for a scan, the question with the answers in its boxes, which is exactly
 * what an examiner marks.
 *
 * It replaces the collapsed "Scratchpad" that sat under the typed box. The
 * storage is the same per-question scratchpad row -- autosaved strokes plus a
 * flattened image -- so earlier working still opens, and every grader that
 * reads the scratchpad image marks it without change. Ink drawn on a blank
 * page before the question became the page is moved below the scan rather
 * than drawn over it.
 *
 * The paper grows as the student writes near the bottom, and its height is
 * stored with the strokes, so a long answer reopens at the length it was
 * written at.
 */
type HandwrittenAnswerProps = {
  questionRef: ScratchpadRef;
  /** Write on the question scan instead of a blank page. */
  paper?: PaperStrip[];
  /** Whether there is any ink, for enabling submit. */
  onInkChange?: (hasInk: boolean) => void;
  /** Called with the page's height whenever it changes, for a placeholder. */
  onHeight?: (height: number) => void;
};

const HandwrittenPage = forwardRef<HandwrittenAnswerHandle, HandwrittenAnswerProps>(
  function HandwrittenPage({ questionRef, paper: paperStrips, onInkChange, onHeight }, ref) {
    const onPaper = Boolean(paperStrips?.length);
    const { paper, failed: paperFailed } = useStitchedPaper(paperStrips);
    const canvasRef = useRef<DrawingCanvasHandle | null>(null);
    const importedRef = useRef(false);
    const [canvasEpoch, setCanvasEpoch] = useState(0);
    const frameRef = useRef<HTMLDivElement | null>(null);
    const measured = useMeasuredCanvasWidth(frameRef, onPaper ? 1000 : MAX_WIDTH, true);
    // Over a scan the width is fixed once measured: ink is placed against the
    // printed boxes, and a canvas that resized on rotation would leave it
    // beside them. A blank page may follow the window.
    const [fixedWidth, setFixedWidth] = useState<number | null>(null);
    useEffect(() => {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- latched once from the first measurement
      if (onPaper && fixedWidth === null && measured !== null) setFixedWidth(measured);
    }, [onPaper, fixedWidth, measured]);
    const width = onPaper ? fixedWidth : measured;
    const [height, setHeight] = useState<number | null>(null);
    useEffect(() => {
      if (height !== null) onHeight?.(height);
    }, [height, onHeight]);
    const paperHeight = paper && width ? Math.round(width * (paper.naturalHeight / paper.naturalWidth)) : 0;
    const ready = !onPaper || paper !== null || paperFailed;
    const usePaper = onPaper && paper !== null;

    const attachCanvas = useCallback((handle: DrawingCanvasHandle | null) => {
      canvasRef.current = handle;
      setCanvasEpoch((value) => value + 1);
    }, []);

    const widthRef = useRef(width);
    useEffect(() => {
      widthRef.current = width;
    }, [width]);
    const { strokes, loaded, isDirty, onStrokesChange, flushSave } = useQuestionScratchpad(
      questionRef,
      () => {
        // An empty page has no answer image. Over a scan an "empty" export is
        // the printed question itself, which would be marked as the answer.
        if (!canvasRef.current || canvasRef.current.isEmpty()) return null;
        if (!usePaper) return canvasRef.current.exportDataURL();
        // A scan page is tall: send a fixed width as JPEG, which keeps a
        // five-page question to a few hundred kilobytes and is plenty for the
        // marker to read both print and handwriting.
        const dpr = window.devicePixelRatio || 1;
        const factor = PAPER_EXPORT_WIDTH / ((widthRef.current || PAPER_EXPORT_WIDTH) * dpr);
        return canvasRef.current?.exportDataURL(factor, 'image/jpeg') ?? null;
      },
    );

    useImperativeHandle(ref, () => ({ flush: flushSave }), [flushSave]);

    /**
     * Saved work, in this layout. Ink from a blank page (no `layout`) opened
     * over a scan is moved down below the scan, keeping its own size.
     */
    const savedForLayout = (): DrawingCanvasStrokeData | null => {
      const saved = strokes as DrawingCanvasStrokeData | null;
      if (!saved || !usePaper || saved.layout === 'paper' || !width) return saved;
      const hasInk = saved.strokes?.length || saved.textBoxes?.length;
      if (!hasInk) return { ...saved, layout: 'paper' };
      const savedWidth = saved.width && saved.width > 0 ? saved.width : width;
      const shift = paperHeight * (savedWidth / width);
      return {
        strokes: saved.strokes.map((stroke) => ({
          ...stroke,
          points: stroke.points.map(([x, y, pressure]) => [x, y + shift, pressure] as [number, number, number]),
        })),
        textBoxes: saved.textBoxes.map((box) => ({ ...box, y: box.y + shift })),
        width: savedWidth,
        height: (saved.height ?? 0) + shift,
        layout: 'paper',
      };
    };

    // Decide the paper's height once, when the width, the scan and any saved
    // work are all known: a canvas that resizes after importing would clip.
    useEffect(() => {
      if (!loaded || !ready || width === null || height !== null) return;
      const base = usePaper ? paperHeight + SPACE_UNDER_PAPER : Math.max(360, Math.round(width * 0.62));
      const saved = savedForLayout();
      const restored = saved?.height && saved.width ? Math.round(saved.height * (width / saved.width)) : 0;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sized once from measured width and saved work
      setHeight(Math.max(base, restored));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, ready, width, height, strokes, usePaper, paperHeight]);

    const onInkChangeRef = useRef(onInkChange);
    useEffect(() => {
      onInkChangeRef.current = onInkChange;
    }, [onInkChange]);
    useEffect(() => {
      if (!loaded) return;
      const saved = strokes as DrawingCanvasStrokeData | null;
      onInkChangeRef.current?.(Boolean(saved && (saved.strokes?.length || saved.textBoxes?.length)));
    }, [loaded, strokes]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (loaded && strokes && !importedRef.current && canvas) {
        importedRef.current = true;
        const saved = savedForLayout();
        if (saved) canvas.importStrokes(saved);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, strokes, canvasEpoch]);

    const handleChange = useCallback(
      (data: DrawingCanvasStrokeData) => {
        onStrokesChange(usePaper ? { ...data, layout: 'paper' } : data);
        onInkChangeRef.current?.(data.strokes.length > 0 || data.textBoxes.length > 0);
        if (height !== null && lowestInk(data) > height - GROW_MARGIN) {
          setHeight(height + GROW_STEP);
        }
      },
      [height, onStrokesChange, usePaper],
    );

    return (
      <div>
        {onPaper && paperFailed && (
          <p className="mb-2 text-xs text-warning">
            The question scan could not be loaded to write on, so this is a blank page instead.
          </p>
        )}
        <div ref={frameRef}>
          {width !== null && height !== null && (
            <DrawingCanvas
              ref={attachCanvas}
              width={width}
              height={height}
              ruled
              stylusAware
              backdrop={usePaper ? paper : null}
              onStrokesChange={handleChange}
            />
          )}
          {(width === null || height === null) && (
            <div className="flex h-60 items-center justify-center text-sm text-muted">
              {onPaper ? 'Preparing the question to write on…' : 'Loading the writing area…'}
            </div>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted">
          <span>{isDirty ? 'Saving…' : 'Saved automatically'}</span>
          {height !== null && (
            <button
              type="button"
              onClick={() => setHeight(height + GROW_STEP)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface-hover hover:text-secondary"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              More space
            </button>
          )}
        </div>
      </div>
    );
  },
);

/** Mount the page within this distance of the viewport... */
const NEAR_MARGIN = '1200px 0px';
/** ...and release it beyond this one. */
const FAR_PX = 3000;

/**
 * The page, mounted only while it is near the screen.
 *
 * A paper page lists every question, and in writing mode each would hold a
 * canvas the size of its scan at retina density -- tens of megabytes each,
 * enough to take an iPad's tab down on a 20-question paper. Off-screen pages
 * become a placeholder of the same height: the ink is autosaved when the page
 * unmounts and imported again when it returns. Only undo history is lost.
 */
const HandwrittenAnswer = forwardRef<HandwrittenAnswerHandle, HandwrittenAnswerProps>(
  function HandwrittenAnswer(props, ref) {
    const holderRef = useRef<HTMLDivElement | null>(null);
    const [near, setNear] = useState(false);
    const [lastHeight, setLastHeight] = useState(360);
    const pageRef = useRef<HandwrittenAnswerHandle | null>(null);
    useImperativeHandle(ref, () => ({ flush: async () => { await pageRef.current?.flush(); } }), []);

    useEffect(() => {
      const holder = holderRef.current;
      if (!holder || typeof IntersectionObserver === 'undefined') {
        setNear(true);
        return;
      }
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) setNear(true);
        },
        { rootMargin: NEAR_MARGIN },
      );
      observer.observe(holder);
      // A second, wider band decides when to let go, so a page scrolled just
      // past is not torn down and rebuilt on every small scroll.
      const far = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) setNear(false);
        },
        { rootMargin: `${FAR_PX}px 0px` },
      );
      far.observe(holder);
      return () => {
        observer.disconnect();
        far.disconnect();
      };
    }, []);

    return (
      <div ref={holderRef}>
        {near ? (
          <HandwrittenPage {...props} ref={pageRef} onHeight={setLastHeight} />
        ) : (
          <div
            style={{ height: lastHeight + 60 }}
            className="flex items-center justify-center rounded-md border border-line bg-surface-raised text-sm text-muted"
          >
            Your writing on this question is saved.
          </div>
        )}
      </div>
    );
  },
);

export default HandwrittenAnswer;

const MODE_KEY = 'answer:mode:v1';
export type AnswerMode = 'type' | 'write';

/**
 * Type or write by hand, remembered per device. A device that has used a pen
 * starts in writing mode, since that is almost certainly how it is used.
 */
export function useAnswerMode(): [AnswerMode, (mode: AnswerMode) => void] {
  const [mode, setMode] = useState<AnswerMode>('type');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      const next: AnswerMode = saved === 'write' || saved === 'type'
        ? saved
        : localStorage.getItem('ink:stylus:v1') === '1' ? 'write' : 'type';
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one read of a device preference after mount
      setMode(next);
    } catch {
      /* storage blocked: typing */
    }
  }, []);
  const choose = useCallback((next: AnswerMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* the choice still holds for this page */
    }
  }, []);
  return [mode, choose];
}

export function AnswerModeToggle({ mode, onChange }: { mode: AnswerMode; onChange: (mode: AnswerMode) => void }) {
  return (
    <div role="tablist" aria-label="How to answer" className="inline-flex rounded-md border border-strong p-0.5 text-xs font-semibold">
      {([
        ['type', 'Type', Keyboard],
        ['write', 'Write by hand', PenLine],
      ] as const).map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={mode === value}
          onClick={() => onChange(value)}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 ${
            mode === value ? 'bg-accent-subtle text-accent-text' : 'text-secondary hover:bg-surface-hover'
          }`}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}
