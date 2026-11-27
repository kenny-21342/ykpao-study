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

/** How much paper is added at a time, in canvas pixels. */
const GROW_STEP = 280;
/** Ink this close to the bottom edge adds more paper, as a booklet would. */
const GROW_MARGIN = 90;
const MAX_WIDTH = 900;

function lowestInk(data: DrawingCanvasStrokeData): number {
  let lowest = 0;
  for (const stroke of data.strokes) {
    for (const [, y] of stroke.points) if (y > lowest) lowest = y;
  }
  for (const box of data.textBoxes) lowest = Math.max(lowest, box.y + box.fontSize * 2);
  return lowest;
}

/**
 * A handwritten answer: ruled paper the full width of the answer box, written
 * on with a stylus, finger or mouse.
 *
 * It replaces the collapsed "Scratchpad" that sat under the typed box. The
 * storage is the same per-question scratchpad row -- autosaved strokes plus a
 * flattened PNG -- so working drawn before this existed opens here, and every
 * grader that already reads the scratchpad image (mock exams, practice, the
 * bank) marks it without change.
 *
 * The paper grows as the student writes near the bottom, and its height is
 * stored with the strokes, so a long answer reopens at the length it was
 * written at.
 */
const HandwrittenAnswer = forwardRef<
  HandwrittenAnswerHandle,
  { questionRef: ScratchpadRef; /** Whether there is any ink, for enabling submit. */ onInkChange?: (hasInk: boolean) => void }
>(
  function HandwrittenAnswer({ questionRef, onInkChange }, ref) {
    const canvasRef = useRef<DrawingCanvasHandle | null>(null);
    const importedRef = useRef(false);
    const [canvasEpoch, setCanvasEpoch] = useState(0);
    const frameRef = useRef<HTMLDivElement | null>(null);
    const width = useMeasuredCanvasWidth(frameRef, MAX_WIDTH, true);
    const [height, setHeight] = useState<number | null>(null);

    const attachCanvas = useCallback((handle: DrawingCanvasHandle | null) => {
      canvasRef.current = handle;
      setCanvasEpoch((value) => value + 1);
    }, []);

    const { strokes, loaded, isDirty, onStrokesChange, flushSave } = useQuestionScratchpad(
      questionRef,
      // Rasterised at the size the strokes are stored at, not this screen's.
      () => canvasRef.current?.exportDataURL() ?? null,
    );

    useImperativeHandle(ref, () => ({ flush: flushSave }), [flushSave]);

    // Decide the paper's height once, when both the width and any saved work
    // are known: a canvas that resizes after importing would clip or stretch.
    useEffect(() => {
      if (!loaded || width === null || height !== null) return;
      const base = Math.max(360, Math.round(width * 0.62));
      const saved = strokes as DrawingCanvasStrokeData | null;
      const restored = saved?.height && saved.width ? Math.round(saved.height * (width / saved.width)) : 0;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sized once from measured width and saved work
      setHeight(Math.max(base, restored));
    }, [loaded, width, height, strokes]);

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
        canvas.importStrokes(strokes as DrawingCanvasStrokeData);
      }
    }, [loaded, strokes, canvasEpoch]);

    const handleChange = useCallback(
      (data: DrawingCanvasStrokeData) => {
        onStrokesChange(data);
        onInkChangeRef.current?.(data.strokes.length > 0 || data.textBoxes.length > 0);
        if (height !== null && lowestInk(data) > height - GROW_MARGIN) {
          setHeight(height + GROW_STEP);
        }
      },
      [height, onStrokesChange],
    );

    return (
      <div>
        <div ref={frameRef}>
          {width !== null && height !== null && (
            <DrawingCanvas
              ref={attachCanvas}
              width={width}
              height={height}
              ruled
              stylusAware
              onStrokesChange={handleChange}
            />
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
