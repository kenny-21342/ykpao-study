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
      {open && (
        <div className="mt-2">
          <DrawingCanvas
            ref={attachCanvas}
            width={width}
            height={height}
            onStrokesChange={onStrokesChange}
          />
        </div>
      )}
    </div>
  );
}
