'use client';

import { useRef, useState } from 'react';
import { Camera, ImagePlus, Loader2 } from 'lucide-react';
import { photoToDataUrl } from '@/lib/client-photo';

/**
 * "Answer with a photo": take one with the camera or pick one from the gallery
 * or files, and have the handwriting read into the answer box.
 *
 * The text lands in the box rather than being saved, so the student can fix any
 * misread symbol before it is kept -- handwriting recognition is good, not
 * perfect, and a wrong digit in a calculation is the one error that matters.
 */
export default function PhotoAnswerButtons({ onText }: { onText: (text: string) => void }) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handle = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // so retaking the same shot still fires onChange
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const image = await photoToDataUrl(file);
      const res = await fetch('/api/practice/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.text) {
        throw new Error(data?.error || 'Could not read that photo. Try again with the page flat and well lit, or type your answer.');
      }
      onText(String(data.text).trim());
      setMessage('Read from your photo — check it over and correct anything it got wrong.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const button =
    'inline-flex items-center gap-1.5 rounded-md border border-strong px-2.5 py-1.5 text-xs font-semibold text-secondary hover:bg-surface-hover disabled:opacity-50';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy} onClick={() => cameraRef.current?.click()} className={button}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Camera className="h-4 w-4" aria-hidden="true" />}
        Take photo of your work
      </button>
      <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className={button}>
        <ImagePlus className="h-4 w-4" aria-hidden="true" />
        Upload photo
      </button>
      {/* `capture` opens the rear camera on phones and tablets; desktops get a file picker. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={handle} className="hidden" />
      <input ref={fileRef} type="file" accept="image/*" onChange={handle} className="hidden" />
      {busy && <span className="text-xs text-muted" role="status">Reading your handwriting…</span>}
      {!busy && message && <span className="text-xs text-muted" role="status">{message}</span>}
    </div>
  );
}
