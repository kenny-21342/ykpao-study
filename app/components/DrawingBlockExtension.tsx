'use client';

/**
 * OneNote-style editable drawing embedded inline in a note.
 *
 * Unlike a plain `<img>`, this TipTap node keeps a reference (`drawingId`) to
 * a `PageDrawing` row holding the actual stroke data, so clicking the
 * thumbnail reopens `DrawingCanvas` pre-loaded via `importStrokes()` for
 * continued editing instead of only offering "delete and redraw."
 *
 * The node still renders a plain `<img>` inside its wrapper `div` (see
 * `renderHTML`) so the read-only page view (`RichContent.tsx`, which never
 * mounts TipTap) degrades to a static image -- and so DOMPurify's allow-list,
 * which only recognizes the `img`/`src`/`alt` attributes and not the
 * `data-drawing-id`/`data-thumbnail-url`/`data-width`/`data-height` markers,
 * still leaves something visible after sanitizing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Loader2, Pencil, X } from 'lucide-react';
import type { DrawingCanvasHandle, DrawingCanvasStrokeData } from './DrawingCanvas';
import { useMeasuredCanvasWidth } from './useMeasuredCanvasWidth';

const DrawingCanvas = dynamic(() => import('./DrawingCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-40 items-center justify-center text-sm text-muted">Loading drawing…</div>
  ),
});

interface DrawingBlockAttrs {
  drawingId: string | null;
  thumbnailUrl: string | null;
  width: number;
  height: number;
}

function DrawingBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const attrs = node.attrs as DrawingBlockAttrs;
  const { drawingId, thumbnailUrl, width, height } = attrs;
  const editable = editor.isEditable;

  const [editing, setEditing] = useState(false);
  const [loadingStrokes, setLoadingStrokes] = useState(false);
  const [saving, setSaving] = useState(false);
  const [strokes, setStrokes] = useState<DrawingCanvasStrokeData | null>(null);
  const canvasRef = useRef<DrawingCanvasHandle | null>(null);
  const importedRef = useRef(false);
  // A note drawing is 760px wide by default, which does not fit a phone. The
  // canvas is mounted at whatever the frame can actually show and the strokes
  // are rescaled into it on import (DrawingCanvas records the size it was
  // drawn at). `width`/`height` stay the node's canonical size throughout --
  // an edit made on a phone must not shrink the drawing for everyone else --
  // so the save below rasterises back up to it.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasWidth = useMeasuredCanvasWidth(frameRef, width, editing);
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



  useEffect(() => {
    const canvas = canvasRef.current;
    if (editing && strokes && !importedRef.current && canvas) {
      importedRef.current = true;
      canvas.importStrokes(strokes);
    }
  }, [editing, strokes, canvasEpoch]);

  const openEditor = async () => {
    if (!editable || !drawingId) return;
    setLoadingStrokes(true);
    try {
      const res = await fetch(`/api/page-drawings/${drawingId}`);
      const data = await res.json();
      if (res.ok && data.drawing) {
        importedRef.current = false;
        setStrokes(data.drawing.strokesJson as DrawingCanvasStrokeData);
        setEditing(true);
      }
    } finally {
      setLoadingStrokes(false);
    }
  };

  const save = async () => {
    const handle = canvasRef.current;
    if (!handle || !drawingId || canvasWidth === null) return;
    // Rasterise at the node's canonical width, not the width being edited at,
    // so saving from a phone does not silently drop the thumbnail's
    // resolution for every later reader.
    const dataUrl = handle.exportDataURL(width / canvasWidth);
    if (!dataUrl) return;
    setSaving(true);
    try {
      const blob = await fetch(dataUrl).then((r) => r.blob());
      const file = new File([blob], `drawing-${drawingId}.png`, { type: 'image/png' });
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok || !uploadData.fileUrl) throw new Error('Upload failed');

      const patchRes = await fetch(`/api/page-drawings/${drawingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The stroke data records the width it was drawn at, and
          // `importStrokes` rescales on the way back in, so a phone-sized
          // edit round-trips into the canonical canvas correctly. The node's
          // own width/height are sent unchanged.
          strokesJson: handle.exportStrokes(),
          thumbnailUrl: uploadData.fileUrl,
          width,
          height,
        }),
      });
      const patchData = await patchRes.json();
      if (!patchRes.ok) throw new Error('Save failed');
      updateAttributes({ thumbnailUrl: patchData.drawing.thumbnailUrl });
      setEditing(false);
    } catch {
      // The drawing stays open on failure so the student's edit isn't lost --
      // they can retry Save rather than losing the session to a flaky upload.
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <NodeViewWrapper className="drawing-block-editing" contentEditable={false}>
        <div
          ref={frameRef}
          className="rounded-md border border-line bg-surface p-2"
        >
          {canvasWidth !== null && (
            <DrawingCanvas
              ref={attachCanvas}
              width={canvasWidth}
              height={Math.round((height * canvasWidth) / width)}
            />
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-secondary"
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </button>
          </div>
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="drawing-block inline-block" contentEditable={false}>
      <div className="group relative inline-block">
        {thumbnailUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary uploaded/user-drawn content, not a static asset Next can optimize
          <img
            src={thumbnailUrl}
            alt="Note drawing"
            className="max-w-full rounded-md border border-line"
          />
        )}
        {editable && (
          <button
            type="button"
            onClick={openEditor}
            disabled={loadingStrokes}
            title="Edit drawing" aria-label="Edit drawing"
            className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-surface/90 px-2 py-1 text-xs font-medium text-secondary opacity-0 shadow-overlay transition-opacity group-hover:opacity-100 disabled:opacity-100"
          >
            {loadingStrokes ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
            Edit
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const DrawingBlockExtension = Node.create({
  name: 'drawingBlock',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      drawingId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-drawing-id'),
        renderHTML: (attrs: DrawingBlockAttrs) => ({ 'data-drawing-id': attrs.drawingId }),
      },
      thumbnailUrl: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-thumbnail-url'),
        renderHTML: (attrs: DrawingBlockAttrs) => ({ 'data-thumbnail-url': attrs.thumbnailUrl }),
      },
      width: {
        default: 760,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-width')) || 760,
        renderHTML: (attrs: DrawingBlockAttrs) => ({ 'data-width': attrs.width }),
      },
      height: {
        default: 420,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-height')) || 420,
        renderHTML: (attrs: DrawingBlockAttrs) => ({ 'data-height': attrs.height }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="drawing-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'drawing-block' }),
      ['img', { src: HTMLAttributes['data-thumbnail-url'], alt: 'Note drawing' }],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DrawingBlockView);
  },
});
