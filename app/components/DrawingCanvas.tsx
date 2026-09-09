'use client';

import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { getStroke } from 'perfect-freehand';
import {
  Pencil, Eraser, Type, Trash2, Undo2, Redo2, Upload,
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
};

export type DrawingCanvasHandle = {
  exportDataURL: () => string | null;
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
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  ({ width = 800, height = 500, className = '', onSave, onStrokesChange }, ref) => {
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
        ctx.drawImage(bgImage, 0, 0, width, height);
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
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
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
      if (tool === 'text') {
        createTextBox(e);
        return;
      }
      canvasRef.current?.setPointerCapture(e.pointerId);
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
      const point = getPointerPos(e);
      currentStrokeRef.current.points.push(point);
      // Incremental draw: just draw the new segment
      drawCurrentStroke();
    };

    const notifyStrokesChange = () => {
      onStrokesChangeRef.current?.({ strokes: strokesRef.current, textBoxes });
    };

    const onPointerUp = () => {
      if (!isDrawingRef.current || !currentStrokeRef.current) return;
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
      onStrokesChangeRef.current?.({ strokes: strokesRef.current, textBoxes });
    };

    const deleteTextBox = (id: string) => {
      setTextBoxes((boxes) => {
        const next = boxes.filter((box) => box.id !== id);
        onStrokesChangeRef.current?.({ strokes: strokesRef.current, textBoxes: next });
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
          onStrokesChangeRef.current?.({ strokes: strokesRef.current, textBoxes: next });
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
      // This wipes working a student may be part-way through writing, and the
      // canvas is not persisted anywhere, so an accidental click was
      // unrecoverable. Ask first, then leave the strokes on the redo stack so
      // Redo can walk them back.
      if (hasWork && !confirm('Clear everything on this canvas? Your working will be lost.')) {
        return;
      }
      redoStackRef.current = [...strokesRef.current].reverse();
      strokesRef.current = [];
      setTextBoxes([]);
      setBgImage(null);
      redraw();
      if (hasWork) onStrokesChangeRef.current?.({ strokes: [], textBoxes: [] });
    }, [bgImage, redraw, textBoxes]);

    // -----------------------------------------------------------------------
    // Import / Export
    // -----------------------------------------------------------------------

    const exportDataURL = useCallback((): string | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;

      // Composite strokes + text boxes onto a temp canvas at full resolution
      const dpr = window.devicePixelRatio || 1;
      const tmp = document.createElement('canvas');
      tmp.width = width * dpr;
      tmp.height = height * dpr;
      const tctx = tmp.getContext('2d');
      if (!tctx) return null;
      tctx.scale(dpr, dpr);

      // White background
      tctx.fillStyle = '#ffffff';
      tctx.fillRect(0, 0, width, height);

      // Background image
      if (bgImage) {
        tctx.drawImage(bgImage, 0, 0, width, height);
      }

      // Strokes
      tctx.lineCap = 'round';
      tctx.lineJoin = 'round';
      for (const stroke of strokesRef.current) {
        drawStroke(tctx, stroke);
      }

      // Text boxes
      for (const tb of textBoxes) {
        if (tb.text) {
          tctx.fillStyle = tb.color;
          tctx.font = `${tb.fontSize}px sans-serif`;
          // Handle multi-line
          tb.text.split('\n').forEach((line, i) => {
            tctx.fillText(line, tb.x, tb.y + (i + 1) * tb.fontSize * 1.2);
          });
        }
      }

      return tmp.toDataURL('image/png');
    }, [width, height, bgImage, textBoxes]);

    const handleSave = () => {
      const dataUrl = exportDataURL();
      if (dataUrl && onSave) {
        onSave(dataUrl);
      }
    };

    // File upload (user-drawn images on paper)
    const fileInputRef = useRef<HTMLInputElement>(null);
    const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          setBgImage(img);
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    };

    // -----------------------------------------------------------------------
    // Imperative handle (for parent to access export/clear)
    // -----------------------------------------------------------------------

    // The dependency list is not optional here. Without it the factory reruns
    // on every render and React reassigns `ref.current` every time -- which,
    // for a caller passing a callback ref, means a detach/attach pair per
    // render. A caller that records the handle in state then never converges.
    useImperativeHandle(ref, () => ({
      exportDataURL,
      importDataURL: (data: string) => {
        const img = new Image();
        img.onload = () => {
          setBgImage(img);
        };
        img.src = data;
      },
      exportStrokes: () => ({ strokes: strokesRef.current, textBoxes }),
      importStrokes: (data: DrawingCanvasStrokeData) => {
        strokesRef.current = data.strokes;
        redoStackRef.current = [];
        setTextBoxes(data.textBoxes);
        redraw();
      },
      clear: clearAll,
      isEmpty: () => strokesRef.current.length === 0 && textBoxes.length === 0 && !bgImage,
    }), [bgImage, clearAll, exportDataURL, redraw, textBoxes]);

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    return (
      <div className={`drawing-canvas-wrapper ${className}`}>
        {/* Toolbar */}
        <div className="flex items-center gap-1 mb-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 flex-wrap">
          {/* Tool selection */}
          <div className="flex items-center gap-0.5 bg-white dark:bg-gray-900 rounded-md p-0.5 border border-gray-200 dark:border-gray-700">
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
              className="w-8 h-8 rounded-md border border-gray-200 dark:border-gray-700 flex items-center justify-center"
              title="Color"
              style={{ backgroundColor: tool === 'eraser' ? '#fff' : color }}
            >
              {tool === 'eraser' && <span className="text-[10px] text-gray-500">Erase</span>}
            </button>
            {showColorPicker && (
              <div className="absolute top-9 left-0 z-10 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-2 grid grid-cols-4 gap-1.5">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => { setColor(c); setShowColorPicker(false); if (tool === 'eraser') setTool('pen'); }}
                    className="w-6 h-6 rounded-full border-2"
                    style={{
                      backgroundColor: c,
                      borderColor: color === c ? '#10b981' : 'transparent',
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
                  className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                    penSize === s ? 'bg-green-100 dark:bg-green-900/30' : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  <span
                    className="rounded-full"
                    style={{ width: `${s + 1}px`, height: `${s + 1}px`, backgroundColor: color }}
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
          <ToolButton onClick={clearAll} title="Clear all">
            <Trash2 className="w-4 h-4 text-red-500" />
          </ToolButton>

          <Divider />

          {/* Upload */}
          <ToolButton onClick={() => fileInputRef.current?.click()} title="Upload image">
            <Upload className="w-4 h-4" />
          </ToolButton>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleUpload}
            className="hidden"
          />

          {/* Save */}
          <button
            onClick={handleSave}
            className="ml-auto px-3 py-1.5 text-xs font-semibold bg-gradient-to-r from-green-500 to-emerald-500 text-white rounded-md hover:shadow-sm transition-all"
          >
            Save Drawing
          </button>
        </div>

        {/* Canvas */}
        <div className="relative inline-block">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            className={`border border-gray-200 dark:border-gray-700 rounded-lg bg-white touch-none ${
              tool === 'pen' ? 'cursor-crosshair' : tool === 'eraser' ? 'cursor-cell' : 'cursor-text'
            }`}
            style={{ width, height }}
          />
          {/* Text boxes overlay */}
          {textBoxes.map((tb) => (
            <textarea
              key={tb.id}
              value={tb.text}
              onChange={(e) => updateTextBox(tb.id, e.target.value)}
              onBlur={() => commitTextBox(tb.id, tb.text)}
              placeholder="e.g. Force, angle, or x = 3"
              className="absolute bg-transparent border border-dashed border-gray-300 rounded p-1 resize-none outline-none focus:border-green-500 focus:bg-white/50"
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
      title={title}
      className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
        active
          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
          : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-6 bg-gray-200 dark:bg-gray-700 mx-0.5" />;
}

export default DrawingCanvas;
