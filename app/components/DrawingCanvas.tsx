'use client';

import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { useConfirm } from './useConfirm';
import { getStroke } from 'perfect-freehand';
import {
  Pencil, Eraser, Type, Trash2, Undo2, Redo2, Upload, Camera,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tool = 'pen' | 'eraser' | 'text';

type Point = [number, number, number]; // x, y, pressure

export type Stroke = {
  tool: Tool;
  color: string;
  size: number;
  points: Point[];
};

export type TextBox = {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
};

export type DrawingCanvasStrokeData = {
  strokes: Stroke[];
  textBoxes: TextBox[];
  /**
   * The canvas the coordinates below were drawn on.
   *
   * Points are stored in raw canvas pixels, so working drawn on a 760px-wide
   * desktop canvas used to reappear clipped on a phone. Recording the size
   * lets `importStrokes` scale it to whatever canvas it is being loaded into.
   * Optional because rows written before this existed have no size -- those
   * are imported unscaled, exactly as they were.
   */
  width?: number;
  height?: number;
  /**
   * 'paper': drawn over a question scan (`backdrop`), so the coordinates are
   * relative to the top of the scan. Absent on a blank page.
   */
  layout?: 'paper';
};

export type DrawingCanvasHandle = {
  /**
   * Flatten to a PNG. `scale` multiplies the output resolution without
   * touching the canvas being drawn on, so a caller editing at a phone's
   * width can still rasterise at the size the drawing is stored at --
   * otherwise a single edit on a small screen permanently halves the
   * thumbnail everyone else sees.
   */
  exportDataURL: (scale?: number, type?: 'image/png' | 'image/jpeg') => string | null;
  importDataURL: (data: string) => void;
  exportStrokes: () => DrawingCanvasStrokeData;
  importStrokes: (data: DrawingCanvasStrokeData) => void;
  clear: () => void;
  isEmpty: () => boolean;
};

type DrawingCanvasProps = {
  width?: number;
  height?: number;
  className?: string;
  onSave?: (dataUrl: string) => void;
  // Fires once per committed stroke (pointer-up), undo/redo, clear, or
  // text-box edit -- not on every pointermove -- so callers can debounce an
  // autosave off of it without reacting to every drawn segment.
  onStrokesChange?: (data: DrawingCanvasStrokeData) => void;
  /**
   * Faint ruled lines behind the ink, like answer-booklet paper. Painted as
   * the canvas's CSS background, so they never reach the exported image.
   */
  ruled?: boolean;
  /**
   * Stylus-first input, for writing an answer with an Apple Pencil or a pen.
   * Once a pen has touched any canvas on this device, fingers stop drawing:
   * they scroll the page instead, and a resting palm leaves no marks. Without
   * it a full-width answer box traps an iPad's scroll the moment a finger
   * lands on it. Off by default so the note and diagram canvases keep
   * finger-drawing.
   */
  stylusAware?: boolean;
  /**
   * A page to write on: drawn full-width at the top, behind the ink, and
   * flattened under it on export. It sits under the canvas as a CSS
   * background, so the eraser removes ink and never the page.
   */
  backdrop?: HTMLImageElement | null;
};

/**
 * Most pixels one canvas may hold. iOS Safari refuses a canvas over about
 * 16.7 million, and a long question written on at a retina density gets there,
 * so a tall canvas trades a little sharpness for existing at all.
 */
const MAX_CANVAS_PIXELS = 14_000_000;
function pixelRatio(width: number, height: number, wanted: number): number {
  return Math.min(wanted, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height)));
}

/** Set once a pen is seen on this device, so fingers scroll from then on. */
const STYLUS_KEY = 'ink:stylus:v1';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Largest edge a photographed page keeps. A 12 MP phone photo is ~48 MB decoded. */
const MAX_PHOTO_EDGE = 2000;

/**
 * Draw a photo onto the canvas without changing its shape.
 *
 * It used to be stretched to the canvas's own width and height, so an upright
 * photo of a page was squashed into a landscape box and its writing distorted.
 * Fit it inside instead, centred.
 */
function drawFitted(ctx: CanvasRenderingContext2D, img: HTMLImageElement, width: number, height: number) {
  const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
}

/** Decode a chosen photo, shrinking it first when it is larger than a screen needs. */
function loadPhoto(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      if (longest <= MAX_PHOTO_EDGE) {
        resolve(img);
        return;
      }
      const factor = MAX_PHOTO_EDGE / longest;
      const small = document.createElement('canvas');
      small.width = Math.round(img.naturalWidth * factor);
      small.height = Math.round(img.naturalHeight * factor);
      const sctx = small.getContext('2d');
      if (!sctx) {
        resolve(img);
        return;
      }
      sctx.drawImage(img, 0, 0, small.width, small.height);
      const shrunk = new Image();
      shrunk.onload = () => resolve(shrunk);
      shrunk.onerror = () => reject(new Error('Could not read that photo'));
      shrunk.src = small.toDataURL('image/jpeg', 0.88);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that photo'));
    };
    img.src = url;
  });
}

const COLORS = [
  '#1a1a1a', '#dc2626', '#2563eb', '#059669',
  '#d97706', '#7c3aed', '#db2777', '#6b7280',
];

const PEN_SIZES = [2, 4, 6, 10];
const ERASER_SIZE = 25;

// Convert a perfect-freehand stroke to an SVG path string.
function strokeToPath(stroke: Stroke): string {
  const outline = getStroke(stroke.points, {
    size: stroke.size,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: stroke.points[0]?.[2] === 0.5, // mouse = constant pressure
  });
  if (!outline.length) return '';
  return outline.reduce(
    (acc, [x, y], i) =>
      i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : `${acc} L ${x.toFixed(1)} ${y.toFixed(1)}`,
    '',
  );
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  if (stroke.points.length < 2) return;
  if (stroke.tool === 'eraser') {
    // Eraser: use destination-out to actually erase
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = stroke.size;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
    }
    ctx.stroke();
    ctx.restore();
  } else {
    // Pen: use perfect-freehand for natural strokes
    const path = strokeToPath(stroke);
    if (path) {
      ctx.save();
      ctx.fillStyle = stroke.color;
      ctx.fill(new Path2D(path));
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DrawingCanvas = forwardRef<DrawingCanvasHandle, DrawingCanvasProps>(
  ({ width = 800, height = 500, className = '', onSave, onStrokesChange, ruled = false, stylusAware = false, backdrop = null }, ref) => {
    const backdropHeight = backdrop && backdrop.naturalWidth > 0
      ? Math.round(width * (backdrop.naturalHeight / backdrop.naturalWidth))
      : 0;
    const { confirm, confirmDialog } = useConfirm();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

    const [tool, setTool] = useState<Tool>('pen');
    const [color, setColor] = useState(COLORS[0]);
    const [penSize, setPenSize] = useState(PEN_SIZES[1]);
    const [showColorPicker, setShowColorPicker] = useState(false);

    // Drawing state
    const strokesRef = useRef<Stroke[]>([]);
    const redoStackRef = useRef<Stroke[]>([]);
    const [textBoxes, setTextBoxes] = useState<TextBox[]>([]);
    const currentStrokeRef = useRef<Stroke | null>(null);
    const isDrawingRef = useRef(false);
    /** The pointer drawing the current stroke; any other contact is ignored. */
    const activePointerRef = useRef<number | null>(null);

    // Pen-only mode, remembered per device. Read after mount: storage is not
    // there during the server render.
    const [stylusMode, setStylusMode] = useState(false);
    useEffect(() => {
      if (!stylusAware) return;
      try {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one read of a device preference after mount
        if (localStorage.getItem(STYLUS_KEY) === '1') setStylusMode(true);
      } catch {
        /* storage blocked: start in finger mode */
      }
    }, [stylusAware]);
    const setStylusPreference = (on: boolean) => {
      setStylusMode(on);
      try {
        if (on) localStorage.setItem(STYLUS_KEY, '1');
        else localStorage.removeItem(STYLUS_KEY);
      } catch {
        /* storage blocked: the mode still holds for this page */
      }
    };
    const penOnly = stylusAware && stylusMode;
    const nextTextBoxIdRef = useRef(0);

    // Uploaded background image
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);

    // Callers pass this as an inline arrow, so it is a different function on
    // every one of their renders. Reading it through a ref keeps it out of the
    // dependency lists below -- otherwise every callback here, and with them
    // the imperative handle, would be rebuilt on every parent render, and a
    // parent that reacts to the handle changing would never settle.
    const onStrokesChangeRef = useRef(onStrokesChange);
    useEffect(() => {
      onStrokesChangeRef.current = onStrokesChange;
    }, [onStrokesChange]);

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    const redraw = useCallback(() => {
      const ctx = ctxRef.current;
      const canvas = canvasRef.current;
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, width, height);

      if (bgImage) {
        drawFitted(ctx, bgImage, width, height);
      }

      for (const stroke of strokesRef.current) {
        drawStroke(ctx, stroke);
      }
    }, [bgImage, height, width]);

    // -----------------------------------------------------------------------
    // Canvas setup
    // -----------------------------------------------------------------------

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = pixelRatio(width, height, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(dpr, dpr);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctxRef.current = ctx;
      }
      redraw();
    }, [width, height, redraw]);

    // In pen-only mode the canvas allows panning so fingers scroll the page.
    // Safari pans for an Apple Pencil too unless its touch is cancelled, so
    // stylus touches are stopped here; finger touches pass through.
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !penOnly) return;
      const stopStylus = (event: TouchEvent) => {
        const touches = Array.from(event.changedTouches) as (Touch & { touchType?: string })[];
        if (touches.some((touch) => touch.touchType === 'stylus')) event.preventDefault();
      };
      canvas.addEventListener('touchstart', stopStylus, { passive: false });
      canvas.addEventListener('touchmove', stopStylus, { passive: false });
      return () => {
        canvas.removeEventListener('touchstart', stopStylus);
        canvas.removeEventListener('touchmove', stopStylus);
      };
    }, [penOnly]);

    // -----------------------------------------------------------------------
    // Drawing logic
    // -----------------------------------------------------------------------

    const getPointerPos = (e: React.PointerEvent): Point => {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      return [
        e.clientX - rect.left,
        e.clientY - rect.top,
        e.pressure > 0 ? e.pressure : 0.5,
      ];
    };

    const onPointerDown = (e: React.PointerEvent) => {
      if (stylusAware && e.pointerType === 'pen' && !stylusMode) setStylusPreference(true);
      // A finger or palm in pen-only mode: let it scroll, draw nothing.
      if (penOnly && e.pointerType === 'touch') return;
      if (isDrawingRef.current) return; // a second contact mid-stroke
      if (tool === 'text') {
        createTextBox(e);
        return;
      }
      canvasRef.current?.setPointerCapture(e.pointerId);
      activePointerRef.current = e.pointerId;
      isDrawingRef.current = true;
      const point = getPointerPos(e);
      currentStrokeRef.current = {
        tool,
        color: tool === 'eraser' ? '#ffffff' : color,
        size: tool === 'eraser' ? ERASER_SIZE : penSize,
        points: [point],
      };
      redoStackRef.current = []; // clear redo on new stroke
    };

    const onPointerMove = (e: React.PointerEvent) => {
      if (!isDrawingRef.current || !currentStrokeRef.current) return;
      if (activePointerRef.current !== null && e.pointerId !== activePointerRef.current) return;
      const point = getPointerPos(e);
      currentStrokeRef.current.points.push(point);
      // Incremental draw: just draw the new segment
      drawCurrentStroke();
    };

    const notifyStrokesChange = () => {
      onStrokesChangeRef.current?.({ strokes: strokesRef.current, textBoxes, width, height });
    };

    const onPointerUp = (e?: React.PointerEvent) => {
      if (!isDrawingRef.current || !currentStrokeRef.current) return;
      if (e && activePointerRef.current !== null && e.pointerId !== activePointerRef.current) return;
      activePointerRef.current = null;
      isDrawingRef.current = false;
      let committed = false;
      if (currentStrokeRef.current.points.length > 1) {
        strokesRef.current.push(currentStrokeRef.current);
        committed = true;
      }
      currentStrokeRef.current = null;
      redraw();
      if (committed) notifyStrokesChange();
    };

    const drawCurrentStroke = () => {
      const ctx = ctxRef.current;
      const stroke = currentStrokeRef.current;
      if (!ctx || !stroke) return;
      // For live feedback, just draw the latest segment on top
      drawStroke(ctx, stroke);
    };

    // -----------------------------------------------------------------------
    // Text boxes (simple overlay)
    // -----------------------------------------------------------------------

    const createTextBox = (e: React.PointerEvent) => {
      const pos = getPointerPos(e);
      nextTextBoxIdRef.current += 1;
      const id = `tb-${nextTextBoxIdRef.current}`;
      const tb: TextBox = {
        id,
        x: pos[0],
        y: pos[1],
        text: '',
        color,
        fontSize: 16,
      };
      setTextBoxes((boxes) => [...boxes, tb]);
    };

    const updateTextBox = (id: string, text: string) => {
      setTextBoxes((boxes) =>
        boxes.map((box) => (box.id === id ? { ...box, text } : box)),
      );
    };

    // Fires once the text box loses focus, not on every keystroke -- keeps
    // the same "commit, don't stream" contract as stroke changes.
    const commitTextBox = (id: string, text: string) => {
      if (!text) {
        deleteTextBox(id);
        return;
      }
      onStrokesChangeRef.current?.({ strokes: strokesRef.current, textBoxes, width, height });
    };

    const deleteTextBox = (id: string) => {
      setTextBoxes((boxes) => {
        const next = boxes.filter((box) => box.id !== id);
        onStrokesChangeRef.current?.({ strokes: strokesRef.current, textBoxes: next, width, height });
        return next;
      });
    };

    // -----------------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------------

    const undo = () => {
      if (strokesRef.current.length > 0) {
        const last = strokesRef.current.pop()!;
        redoStackRef.current.push(last);
        redraw();
        notifyStrokesChange();
      } else if (textBoxes.length > 0) {
        setTextBoxes((boxes) => {
          const next = boxes.slice(0, -1);
          onStrokesChangeRef.current?.({ strokes: strokesRef.current, textBoxes: next, width, height });
          return next;
        });
      }
    };

    const redo = () => {
      const stroke = redoStackRef.current.pop();
      if (stroke) {
        strokesRef.current.push(stroke);
        redraw();
        notifyStrokesChange();
      }
    };

    const clearAll = useCallback(() => {
      const hasWork =
        strokesRef.current.length > 0 ||
        textBoxes.length > 0 ||
        bgImage !== null;
      redoStackRef.current = [...strokesRef.current].reverse();
      strokesRef.current = [];
      setTextBoxes([]);
      setBgImage(null);
      redraw();
      if (hasWork) onStrokesChangeRef.current?.({ strokes: [], textBoxes: [], width, height });
    }, [bgImage, height, redraw, textBoxes, width]);

    // -----------------------------------------------------------------------
    // Import / Export
    // -----------------------------------------------------------------------

    const exportDataURL = useCallback((scale = 1, type: 'image/png' | 'image/jpeg' = 'image/png'): string | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;

      // `scale` enlarges (or shrinks) the output only: everything below still
      // draws in this canvas's coordinates, and the transform maps them.
      const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
      const ratio = pixelRatio(width, height, (window.devicePixelRatio || 1) * factor);
      const sized = () => {
        const layer = document.createElement('canvas');
        layer.width = Math.round(width * ratio);
        layer.height = Math.round(height * ratio);
        const lctx = layer.getContext('2d');
        lctx?.scale(ratio, ratio);
        return { layer, lctx };
      };

      // Ink on its own layer, so an eraser stroke (destination-out) removes
      // ink only -- never the page or the photo beneath it.
      const { layer: ink, lctx: ictx } = sized();
      if (!ictx) return null;
      ictx.lineCap = 'round';
      ictx.lineJoin = 'round';
      for (const stroke of strokesRef.current) {
        drawStroke(ictx, stroke);
      }
      for (const tb of textBoxes) {
        if (tb.text) {
          ictx.fillStyle = tb.color;
          ictx.font = `${tb.fontSize}px sans-serif`;
          tb.text.split('\n').forEach((line, i) => {
            ictx.fillText(line, tb.x, tb.y + (i + 1) * tb.fontSize * 1.2);
          });
        }
      }

      const { layer: tmp, lctx: tctx } = sized();
      if (!tctx) return null;
      tctx.fillStyle = '#ffffff';
      tctx.fillRect(0, 0, width, height);
      if (backdrop && backdropHeight > 0) {
        tctx.drawImage(backdrop, 0, 0, width, backdropHeight);
      }
      if (bgImage) {
        drawFitted(tctx, bgImage, width, height);
      }
      tctx.drawImage(ink, 0, 0, width, height);

      return type === 'image/jpeg' ? tmp.toDataURL('image/jpeg', 0.85) : tmp.toDataURL('image/png');
    }, [width, height, bgImage, textBoxes, backdrop, backdropHeight]);

    const handleSave = () => {
      const dataUrl = exportDataURL();
      if (dataUrl && onSave) {
        onSave(dataUrl);
      }
    };

    // File upload (user-drawn images on paper)
    const fileInputRef = useRef<HTMLInputElement>(null);
    const cameraInputRef = useRef<HTMLInputElement>(null);
    const [photoError, setPhotoError] = useState<string | null>(null);
    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset so choosing the same photo twice (retake) still fires a change.
      e.target.value = '';
      if (!file) return;
      setPhotoError(null);
      try {
        setBgImage(await loadPhoto(file));
      } catch (error) {
        setPhotoError((error as Error).message);
      }
    };

    // -----------------------------------------------------------------------
    // Imperative handle (for parent to access export/clear)
    // -----------------------------------------------------------------------

    // The dependency list is not optional here. Without it the factory reruns
    // on every render and React reassigns `ref.current` every time -- which,
    // for a caller passing a callback ref, means a detach/attach pair per
    // render. A caller that records the handle in state then never converges.
    /**
     * The toolbar's Clear, which asks first.
     *
     * `clearAll` itself stays synchronous and silent because it is also the
     * imperative `clear()` on the handle: a programmatic caller resetting the
     * canvas must not be interrupted by a dialog aimed at the student. The
     * prompt belongs to the button, not to the operation -- and it is worth
     * having, because this wipes working a student may be part-way through and
     * the canvas is not persisted anywhere. The strokes are left on the redo
     * stack either way, so Redo can walk them back.
     */
    const handleClearClick = useCallback(async () => {
      const hasWork =
        strokesRef.current.length > 0 || textBoxes.length > 0 || bgImage !== null;
      if (hasWork) {
        const ok = await confirm({
          title: 'Clear the canvas?',
          message:
            'Everything drawn here is removed. You can bring it back with Redo, but only until you leave the page.',
          confirmLabel: 'Clear canvas',
        });
        if (!ok) return;
      }
      clearAll();
    }, [bgImage, clearAll, confirm, textBoxes]);

    useImperativeHandle(ref, () => ({
      exportDataURL,
      importDataURL: (data: string) => {
        const img = new Image();
        img.onload = () => {
          setBgImage(img);
        };
        img.src = data;
      },
      exportStrokes: () => ({ strokes: strokesRef.current, textBoxes, width, height }),
      importStrokes: (data: DrawingCanvasStrokeData) => {
        // Scale to this canvas if the work was drawn on a differently sized
        // one. Both axes use the same factor: the panel keeps the aspect
        // ratio, and scaling them independently would shear the drawing.
        const scale = data.width && data.width > 0 ? width / data.width : 1;
        strokesRef.current =
          scale === 1
            ? data.strokes
            : data.strokes.map((stroke) => ({
                ...stroke,
                size: stroke.size * scale,
                points: stroke.points.map(([x, y, pressure]) => [x * scale, y * scale, pressure] as Point),
              }));
        redoStackRef.current = [];
        setTextBoxes(
          scale === 1
            ? data.textBoxes
            : data.textBoxes.map((box) => ({
                ...box,
                x: box.x * scale,
                y: box.y * scale,
                fontSize: box.fontSize * scale,
              })),
        );
        redraw();
      },
      clear: clearAll,
      isEmpty: () => strokesRef.current.length === 0 && textBoxes.length === 0 && !bgImage,
    }), [bgImage, clearAll, exportDataURL, height, redraw, textBoxes, width]);

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    return (
      <div className={`drawing-canvas-wrapper ${className}`}>
        {confirmDialog}
        {/* Toolbar */}
        <div className="flex items-center gap-1 mb-2 p-1.5 bg-surface-raised rounded-md border border-line flex-wrap">
          {/* Tool selection */}
          <div className="flex items-center gap-0.5 bg-surface rounded-md p-0.5 border border-line">
            <ToolButton active={tool === 'pen'} onClick={() => setTool('pen')} title="Pen">
              <Pencil className="w-4 h-4" />
            </ToolButton>
            <ToolButton active={tool === 'eraser'} onClick={() => setTool('eraser')} title="Eraser">
              <Eraser className="w-4 h-4" />
            </ToolButton>
            <ToolButton active={tool === 'text'} onClick={() => setTool('text')} title="Text">
              <Type className="w-4 h-4" />
            </ToolButton>
          </div>

          <Divider />

          {/* Color picker */}
          <div className="relative">
            <button
              onClick={() => setShowColorPicker((s) => !s)}
              className="w-8 h-8 rounded-md border border-strong flex items-center justify-center"
              title="Color" aria-label="Pen colour" aria-expanded={showColorPicker}
              style={{
                backgroundColor: tool === 'eraser' ? '#fff' : color,
                // An outline on top of the fill: near-black ink on a dark toolbar
                // otherwise reads as an empty box.
                boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.75)',
              }}
            >
              {tool === 'eraser' && <span className="text-[10px] text-muted">Erase</span>}
            </button>
            {showColorPicker && (
              <div
                role="listbox"
                aria-label="Pen colours"
                className="absolute top-9 left-0 z-10 bg-surface rounded-md shadow-overlay border border-line p-2"
                // Explicit sizes: the swatches collapsed on top of each other when
                // the grid shrank to fit its absolutely-positioned container.
                style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 28px)', gap: 8 }}
              >
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="option"
                    aria-selected={color === c}
                    aria-label={`Colour ${c}`}
                    onClick={() => { setColor(c); setShowColorPicker(false); if (tool === 'eraser') setTool('pen'); }}
                    className="shrink-0 rounded-full"
                    style={{
                      width: 28,
                      height: 28,
                      backgroundColor: c,
                      boxShadow: color === c
                        ? '0 0 0 2px var(--surface, #161616), 0 0 0 4px #1A7F4B'
                        : 'inset 0 0 0 1px rgba(128,128,128,0.6)',
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Pen size */}
          {tool === 'pen' && (
            <div className="flex items-center gap-0.5">
              {PEN_SIZES.map((s) => (
                <button
                  key={s}
                  onClick={() => setPenSize(s)}
                  type="button"
                  aria-label={`Pen size ${s}`}
                  aria-pressed={penSize === s}
                  className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                    penSize === s ? 'bg-accent-subtle ring-1 ring-accent' : 'hover:bg-surface-hover'
                  }`}
                >
                  {/* Neutral dot: tinting it with the pen colour made it vanish for
                      near-black ink on a dark toolbar. */}
                  <span
                    className="rounded-full"
                    style={{ width: `${s + 2}px`, height: `${s + 2}px`, backgroundColor: 'var(--text-primary)' }}
                  />
                </button>
              ))}
            </div>
          )}

          <Divider />

          {/* Undo / Redo */}
          <ToolButton onClick={undo} title="Undo">
            <Undo2 className="w-4 h-4" />
          </ToolButton>
          <ToolButton onClick={redo} title="Redo">
            <Redo2 className="w-4 h-4" />
          </ToolButton>
          <ToolButton onClick={handleClearClick} title="Clear all">
            <Trash2 className="w-4 h-4 text-danger" />
          </ToolButton>

          <Divider />

          {/* Photo of written work: straight from the camera, or from files/gallery. */}
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            title="Take a photo of your work" aria-label="Take a photo of your work"
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-muted hover:bg-surface-hover"
          >
            <Camera className="w-4 h-4" /> <span>Take photo</span>
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Upload a photo or image" aria-label="Upload a photo or image"
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-muted hover:bg-surface-hover"
          >
            <Upload className="w-4 h-4" /> <span>Upload</span>
          </button>
          {/* `capture` opens the rear camera on phones and tablets; desktops fall back to a file picker. */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleUpload}
            className="hidden"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleUpload}
            className="hidden"
          />

          {/* Save -- only when a caller actually wants one. The scratchpad
              autosaves on a debounce and the note drawing block owns its own
              Save button below the canvas; rendering this unconditionally gave
              both a prominent green button that did nothing at all. */}
          {onSave && (
            <button
              onClick={handleSave}
              // `sm:ml-auto`, not `ml-auto`: on a narrow toolbar the row wraps
              // and an auto margin puts Save alone on the far right of its own
              // line, a long way from the tools it belongs with.
              className="sm:ml-auto px-3 py-1.5 text-xs font-semibold bg-accent text-white rounded-md transition-all"
            >
              Save Drawing
            </button>
          )}
        </div>

        {stylusAware && (
          <p className="mb-2 text-xs text-muted">
            {penOnly ? (
              <>
                Pencil mode: only a pen writes, fingers scroll.{' '}
                <button type="button" onClick={() => setStylusPreference(false)} className="underline hover:no-underline">
                  Draw with fingers
                </button>
              </>
            ) : (
              'Write with a stylus, finger or mouse. With an Apple Pencil, fingers switch to scrolling.'
            )}
          </p>
        )}

        {photoError && <p role="alert" className="mb-2 text-xs text-danger">{photoError}</p>}

        {/* Canvas.
            `inline-block` shrink-wraps the canvas's own pixel width, which is
            correct -- the drawing surface *is* that many pixels and cannot be
            scaled without breaking the coordinate space strokes are recorded
            in. `max-w-full` plus the scroll container keeps that from forcing
            the whole page sideways when a caller mounts the canvas without
            measuring first; callers that do measure (via
            `useMeasuredCanvasWidth`) never reach the overflow at all. */}
        <div className="max-w-full overflow-x-auto">
        <div className="relative inline-block">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onPointerCancel={onPointerUp}
            className={`border border-line rounded-md ${penOnly ? 'touch-pan-y' : 'touch-none'} ${
              tool === 'pen' ? 'cursor-crosshair' : tool === 'eraser' ? 'cursor-cell' : 'cursor-text'
            }`}
            // White paper in both themes: ink defaults to near-black, the eraser paints
            // white and the saved image is flattened onto white.
            style={{
              width,
              height,
              backgroundColor: '#ffffff',
              // The page, then white under it (a scan can be transparent), then
              // lines every 36px -- the spacing of an answer booklet at this
              // size -- which the page covers and the space below it keeps.
              ...(backdrop || ruled
                ? {
                    backgroundImage: [
                      ...(backdrop ? [`url("${backdrop.src}")`, 'linear-gradient(#ffffff, #ffffff)'] : []),
                      ...(ruled ? ['repeating-linear-gradient(to bottom, transparent 0, transparent 35px, #dbe2ec 35px, #dbe2ec 36px)'] : []),
                    ].join(', '),
                    backgroundSize: [
                      ...(backdrop ? [`${width}px ${backdropHeight}px`, `${width}px ${backdropHeight}px`] : []),
                      ...(ruled ? ['auto'] : []),
                    ].join(', '),
                    backgroundPosition: [
                      ...(backdrop ? ['0 0', '0 0'] : []),
                      ...(ruled ? [`0 ${backdropHeight}px`] : []),
                    ].join(', '),
                    backgroundRepeat: [
                      ...(backdrop ? ['no-repeat', 'no-repeat'] : []),
                      ...(ruled ? ['repeat'] : []),
                    ].join(', '),
                  }
                : {}),
            }}
          />
          {/* Text boxes overlay */}
          {textBoxes.map((tb) => (
            <textarea
              key={tb.id}
              value={tb.text}
              onChange={(e) => updateTextBox(tb.id, e.target.value)}
              onBlur={() => commitTextBox(tb.id, tb.text)}
              placeholder="e.g. Force, angle, or x = 3"
              className="absolute bg-transparent border border-dashed border-strong rounded-sm p-1 resize-none outline-none focus:border-accent focus:bg-surface"
              style={{
                left: `${tb.x}px`,
                top: `${tb.y}px`,
                color: tb.color,
                fontSize: `${tb.fontSize}px`,
                minWidth: '60px',
                minHeight: `${tb.fontSize * 1.5}px`,
              }}
              autoFocus
            />
          ))}
        </div>
        </div>
      </div>
    );
  }
);

DrawingCanvas.displayName = 'DrawingCanvas';

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function ToolButton({
  active, onClick, title, children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title} aria-label={title}
      className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
        active
          ? 'bg-accent-subtle text-accent-text'
          : 'text-muted hover:bg-surface-hover'
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-6 bg-surface-active mx-0.5" />;
}

export default DrawingCanvas;
