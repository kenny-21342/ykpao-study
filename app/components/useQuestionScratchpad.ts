'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DrawingCanvasStrokeData } from './DrawingCanvas';

export type ScratchpadRef =
  | { pastPaperQuestionId: number }
  | { bankQuestionId: number }
  | { mockExamItemId: string };

function refQueryString(ref: ScratchpadRef): string {
  const params = new URLSearchParams();
  if ('pastPaperQuestionId' in ref) params.set('pastPaperQuestionId', String(ref.pastPaperQuestionId));
  else if ('bankQuestionId' in ref) params.set('bankQuestionId', String(ref.bankQuestionId));
  else params.set('mockExamItemId', ref.mockExamItemId);
  return params.toString();
}

async function uploadPreviewPng(dataUrl: string): Promise<string | null> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const form = new FormData();
    form.append('file', blob, 'scratchpad.png');
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    if (!res.ok) return null;
    const data = await res.json();
    return data.fileUrl ?? null;
  } catch {
    return null;
  }
}

const AUTOSAVE_DELAY_MS = 1500;

/**
 * Loads and autosaves a per-question scratchpad. The drawing itself lives in
 * `DrawingCanvas`; this hook only owns the load-on-mount / debounced-save
 * lifecycle around `/api/scratchpads`, keyed to whichever question surface
 * is currently open. `getPreviewDataUrl` is called once per debounced flush
 * (not per stroke) to upload a flattened PNG snapshot alongside the raw
 * stroke JSON -- that snapshot is what grading and "answerImageUrl" read.
 */
export function useQuestionScratchpad(ref: ScratchpadRef | null, getPreviewDataUrl: () => string | null) {
  const [strokes, setStrokes] = useState<DrawingCanvasStrokeData | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStrokesRef = useRef<DrawingCanvasStrokeData | null>(null);
  const getPreviewRef = useRef(getPreviewDataUrl);
  useEffect(() => {
    getPreviewRef.current = getPreviewDataUrl;
  }, [getPreviewDataUrl]);
  const refKey = ref ? refQueryString(ref) : null;

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset load state when the question ref changes
    setLoaded(false);
    setStrokes(null);
    setPreviewImageUrl(null);
    if (!refKey) return;
    fetch(`/api/scratchpads?${refKey}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setStrokes(data?.scratchpad?.strokesJson ?? null);
        setPreviewImageUrl(data?.scratchpad?.previewImageUrl ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refKey]);

  const flushSave = useCallback(async () => {
    if (!ref || !pendingStrokesRef.current) return;
    const strokesJson = pendingStrokesRef.current;
    pendingStrokesRef.current = null;
    setIsDirty(false);

    const dataUrl = getPreviewRef.current();
    const uploadedUrl = dataUrl ? await uploadPreviewPng(dataUrl) : null;
    if (uploadedUrl) setPreviewImageUrl(uploadedUrl);

    await fetch('/api/scratchpads', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ref, strokesJson, previewImageUrl: uploadedUrl }),
    }).catch(() => {
      // Best-effort autosave; the next stroke's debounce retries with the
      // latest strokes, which still include whatever failed to save here.
    });
  }, [ref]);

  const onStrokesChange = useCallback(
    (data: DrawingCanvasStrokeData) => {
      pendingStrokesRef.current = data;
      setIsDirty(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushSave, AUTOSAVE_DELAY_MS);
    },
    [flushSave],
  );

  // Flush on unmount so navigating away right after drawing doesn't lose it.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      void flushSave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey]);

  return { strokes, previewImageUrl, loaded, isDirty, onStrokesChange, flushSave };
}
