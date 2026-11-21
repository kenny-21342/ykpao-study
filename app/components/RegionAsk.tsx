'use client';

import { useCallback, useRef, useState } from 'react';
import { Loader2, ScanSearch, X } from 'lucide-react';
import FormattedMessage from './FormattedMessage';

type Rect = { x: number; y: number; w: number; h: number };
type Turn = { role: 'user' | 'assistant'; text: string };

/** Longest edge of the crop that is sent. Page strips are 200 DPI; a diagram needs less. */
const MAX_EDGE = 1600;

/**
 * Crop the selected rectangle out of the images inside `container`.
 *
 * The strips are served by redirect to the object store, a different origin, so
 * drawing the <img> straight onto a canvas would taint it and `toDataURL` would
 * throw. The store sends CORS headers for this origin, so each strip is fetched
 * again (a cache hit) as a blob and drawn from that instead. A selection that
 * spans two strips is stitched, top to bottom.
 */
async function cropSelection(container: HTMLElement, rect: Rect): Promise<string | null> {
  const box = container.getBoundingClientRect();
  const pieces: Array<{ bitmap: ImageBitmap; sx: number; sy: number; sw: number; sh: number }> = [];
  for (const img of Array.from(container.querySelectorAll('img'))) {
    const r = img.getBoundingClientRect();
    const left = r.left - box.left;
    const top = r.top - box.top;
    const x0 = Math.max(rect.x, left);
    const y0 = Math.max(rect.y, top);
    const x1 = Math.min(rect.x + rect.w, left + r.width);
    const y1 = Math.min(rect.y + rect.h, top + r.height);
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    const res = await fetch(img.currentSrc || img.src);
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    const kx = bitmap.width / r.width;
    const ky = bitmap.height / r.height;
    pieces.push({ bitmap, sx: (x0 - left) * kx, sy: (y0 - top) * ky, sw: (x1 - x0) * kx, sh: (y1 - y0) * ky });
  }
  if (pieces.length === 0) return null;

  const width = Math.max(...pieces.map((p) => p.sw));
  const height = pieces.reduce((sum, p) => sum + p.sh, 0);
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  for (const p of pieces) {
    ctx.drawImage(p.bitmap, p.sx, p.sy, p.sw, p.sh, 0, y * scale, p.sw * scale, p.sh * scale);
    y += p.sh;
    p.bitmap.close();
  }
  return canvas.toDataURL('image/png');
}

/**
 * Wraps a page's images so a student can drag a box round part of them and ask
 * the AI about just that -- a diagram, a graph, one line of a mark scheme.
 *
 * Selecting is a mode behind a button, not always on, because the images
 * already scroll, zoom and (on a phone) pan by dragging; a permanent overlay
 * would take all of that away.
 */
export default function RegionAsk({
  children,
  bankQuestionId,
  from,
}: {
  children: React.ReactNode;
  bankQuestionId: number;
  from: 'question' | 'markscheme';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [crop, setCrop] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const point = (event: React.PointerEvent) => {
    const box = containerRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - box.left, 0), box.width),
      y: Math.min(Math.max(event.clientY - box.top, 0), box.height),
    };
  };

  const finish = useCallback(async (d: { x0: number; y0: number; x1: number; y1: number }) => {
    const rect = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
    setDrag(null);
    if (rect.w < 16 || rect.h < 16) return; // a tap, not a selection
    try {
      const dataUrl = await cropSelection(containerRef.current!, rect);
      if (!dataUrl) throw new Error('Could not capture that area. Try again.');
      setCrop(dataUrl);
      setTurns([]);
      setError(null);
      setSelecting(false);
    } catch (e) {
      setError((e as Error).message || 'Could not capture that area.');
    }
  }, []);

  const ask = async () => {
    const question = text.trim();
    if (!question || !crop) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/ask-region', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: crop, question, bankQuestionId, from, history: turns }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'The AI could not answer that.');
      setTurns((current) => [...current, { role: 'user', text: question }, { role: 'assistant', text: data.answer }]);
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setCrop(null);
    setTurns([]);
    setText('');
    setError(null);
  };

  const box = drag && { left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) };

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => { setSelecting((on) => !on); setDrag(null); setError(null); }}
          aria-pressed={selecting}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold ${
            selecting ? 'border-accent bg-accent-subtle text-accent-text' : 'border-strong text-secondary hover:bg-surface-hover'
          }`}
        >
          <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />
          {selecting ? 'Cancel selection' : 'Ask AI about part of this'}
        </button>
        {selecting && <span className="text-xs text-muted" role="status">Drag a box around the part you want to ask about.</span>}
      </div>

      <div ref={containerRef} className="relative">
        {children}
        {selecting && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair bg-accent/5"
            // The page must not scroll or pan while the finger is drawing a box.
            style={{ touchAction: 'none' }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              const p = point(event);
              setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
            }}
            onPointerMove={(event) => {
              if (!drag) return;
              const p = point(event);
              setDrag({ ...drag, x1: p.x, y1: p.y });
            }}
            onPointerUp={(event) => {
              event.stopPropagation();
              if (drag) void finish(drag);
            }}
            onClick={(event) => event.stopPropagation()}
          >
            {box && <div className="absolute border-2 border-accent bg-accent/15" style={box} />}
          </div>
        )}
      </div>

      {crop && (
        <div className="mt-2 space-y-2 rounded-md border border-line bg-surface-raised p-3">
          <div className="flex items-start justify-between gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={crop} alt="The area you selected" className="max-h-40 max-w-full rounded-sm border border-line object-contain" style={{ backgroundColor: '#ffffff' }} />
            <button type="button" onClick={close} aria-label="Close" className="rounded-md p-1 text-muted hover:bg-surface-hover">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {turns.map((turn, index) => (
            <div key={index} className={turn.role === 'user' ? 'text-sm font-semibold text-primary' : 'text-sm text-secondary'}>
              {turn.role === 'user' ? turn.text : <FormattedMessage content={turn.text} />}
            </div>
          ))}
          <div className="flex gap-2">
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !busy) void ask(); }}
              maxLength={1000}
              placeholder={turns.length ? 'Ask a follow-up' : 'What do you want to know about this?'}
              className="min-w-0 flex-1 rounded-md border border-strong bg-surface px-3 py-1.5 text-sm text-primary"
            />
            <button
              type="button"
              onClick={() => void ask()}
              disabled={busy || !text.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Ask
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
