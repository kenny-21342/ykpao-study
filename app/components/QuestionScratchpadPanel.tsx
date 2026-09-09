'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { PenTool, ChevronDown, ChevronUp } from 'lucide-react';
import type { DrawingCanvasHandle, DrawingCanvasStrokeData } from './DrawingCanvas';
import { useQuestionScratchpad, type ScratchpadRef } from './useQuestionScratchpad';

const DrawingCanvas = dynamic(() => import('./DrawingCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-40 items-center justify-center text-sm text-gray-500">Loading scratchpad…</div>
  ),
});

type QuestionScratchpadPanelProps = {
  questionRef: ScratchpadRef;
  width?: number;
  height?: number;
  className?: string;
  /** Collapsed by default -- most questions don't need a diagram. */
  defaultOpen?: boolean;
};

/**
 * Shared "Draw diagram" affordance for all three question-taking surfaces
 * (mock exam, practice, bank). Wraps DrawingCanvas with per-question
 * persistence via useQuestionScratchpad, so a student's working-out survives
 * navigating away and reloading, and is available to vision grading.
 */
export default function QuestionScratchpadPanel({
  questionRef,
  width = 760,
  height = 360,
  className = '',
  defaultOpen = false,
}: QuestionScratchpadPanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const canvasRef = useRef<DrawingCanvasHandle | null>(null);
  const importedRef = useRef(false);
  // The ref itself can't drive the import effect -- writing a ref never
  // re-renders. This counter does, and only when the canvas actually mounts
  // or unmounts, because `attachCanvas` has a stable identity (an inline
  // `ref={(h) => setState(h)}` would be re-created every render, so React
  // would detach/re-attach -- and therefore set state -- on every render,
  // which is an unbounded update loop).
  const [canvasEpoch, setCanvasEpoch] = useState(0);

  // The canvas is a fixed pixel surface -- `width` is both its CSS width and
  // its coordinate space -- so a hard 760 was simply cut off on a phone, and
  // the right half of the drawing area could not be reached at all. Measure
  // the space we actually have and never exceed it. Strokes carry the size
  // they were drawn at, so `importStrokes` rescales work moved between a
  // desktop and a phone rather than clipping it.
  const frameRef = useRef<HTMLDivElement | null>(null);
  // Null until measured, and the canvas does not mount until then. It has to
  // be born at its final size: `importStrokes` scales the saved work to the
  // canvas it is loading into, and it only imports once, so a canvas that
  // mounted at 760 and shrank to 340 a tick later would hold strokes scaled
  // for a surface twice as wide. (A viewport resized mid-session is the same
  // problem and is not solved here -- the drawing rescales on the next load.)
  const [canvasWidth, setCanvasWidth] = useState<number | null>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setCanvasWidth(Math.max(240, Math.min(width, frame.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [open, width]);

  const attachCanvas = useCallback((handle: DrawingCanvasHandle | null) => {
    canvasRef.current = handle;
    setCanvasEpoch((value) => value + 1);
  }, []);

  const { strokes, loaded, isDirty, onStrokesChange } = useQuestionScratchpad(
    questionRef,
    () => canvasRef.current?.exportDataURL() ?? null,
  );

  // Import saved strokes once they arrive, but only the first time -- the
  // canvas owns editing after that, and re-importing on every subsequent
  // effect run (e.g. once `loaded` flips true, or once the dynamically
  // imported canvas mounts) would clobber in-progress work.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (loaded && strokes && !importedRef.current && canvas) {
      importedRef.current = true;
      canvas.importStrokes(strokes as DrawingCanvasStrokeData);
    }
  }, [loaded, strokes, canvasEpoch]);

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        <PenTool className="h-4 w-4" />
        Scratchpad
        {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Saving…" />}
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {/* There is no Save button here -- working is autosaved on a debounce --
          so say so in words. Without it a student has no way to know their
          working is being kept. */}
      {open && (
        <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
          {isDirty ? 'Saving…' : 'Working saved automatically'}
        </span>
      )}
      <div ref={frameRef} className="mt-2">
        {open && canvasWidth !== null && (
          <DrawingCanvas
            ref={attachCanvas}
            width={canvasWidth}
            height={Math.round(height * (canvasWidth / width))}
            onStrokesChange={onStrokesChange}
          />
        )}
      </div>
    </div>
  );
}
