'use client';

import { useEffect, useState, type RefObject } from 'react';

/**
 * Size a drawing canvas to the space it actually has.
 *
 * `DrawingCanvas` takes a fixed pixel `width` that is both its CSS width and
 * its coordinate space, so a hard 760 is not merely wide on a phone -- the
 * right half of the drawing area cannot be reached at all, and a canvas inside
 * a horizontal scroller has to be scrolled with the same pointer that is
 * trying to draw on it.
 *
 * Two callers already solved this identically (`QuestionScratchpadPanel` and
 * `DrawingBlockExtension`) and a third (the note drawing modal in
 * `NotesTextbook`) did not, which is exactly the outcome copy-paste produces.
 * This is that solution, once.
 *
 * Returns null until measured, and callers must not mount the canvas until it
 * is a number. The canvas has to be born at its final size: `importStrokes`
 * scales saved work to the canvas it is loading into and only imports once, so
 * one that mounted at 760 and shrank to 340 a tick later would hold strokes
 * scaled for a surface twice as wide.
 *
 * Strokes carry the size they were drawn at, so work moved between a desktop
 * and a phone is rescaled rather than clipped. A viewport resized *mid-session*
 * is the same problem and is deliberately not solved here -- re-importing live
 * strokes on every resize would race the export/import pair -- so a rotated
 * phone keeps the previous scale until the next load.
 *
 * @param frameRef  the element whose width the canvas must fit inside
 * @param maxWidth  the canonical width; never exceeded, only reduced
 * @param active    false while the surface is closed, so a hidden frame
 *                  measuring 0 is never observed
 */
export function useMeasuredCanvasWidth(
  frameRef: RefObject<HTMLElement | null>,
  maxWidth: number,
  active = true,
): number | null {
  const [canvasWidth, setCanvasWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const frame = frameRef.current;
    if (!frame) return;

    // 240 is the floor: below it the toolbar is unusable anyway, and a canvas
    // narrower than that is not worth rendering.
    const measure = () => setCanvasWidth(Math.max(240, Math.min(maxWidth, frame.clientWidth)));
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameRef, maxWidth, active]);

  return canvasWidth;
}
