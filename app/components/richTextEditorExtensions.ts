'use client';

/**
 * The extension list RichTextEditor.tsx builds its live editor from,
 * extracted so it can also be handed to `generateJSON()` when seeding a
 * page's initial Yjs document (Feature 5, flagged off by default) -- that
 * conversion needs the exact same schema (node/mark types, including
 * DrawingBlockExtension's `drawingBlock` node) the real editor uses, or a
 * page with a drawing embedded could lose it the moment collaboration seeds
 * from the saved HTML.
 *
 * `undoRedo: false` is required when a `Collaboration` extension is present:
 * Yjs's own undo manager (wired by `@tiptap/extension-collaboration`)
 * replaces StarterKit's built-in undo/redo history, and having both active
 * at once is explicitly unsupported by TipTap.
 */

import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { Color } from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import { RemoteCursors, type RemoteCursor } from './RemoteCursors';
import { BoldItalicInputRule } from './boldItalicInputRule';
import { LatexLintExtension } from './latexLintExtension';
import { DrawingBlockExtension } from './DrawingBlockExtension';

export function createRichTextEditorExtensions(options?: {
  remoteCursors?: RemoteCursor[];
  history?: boolean;
}): AnyExtension[] {
  return [
    StarterKit.configure({
      undoRedo: (options?.history ?? true) ? undefined : false,
      link: {
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      },
    }),
    TextAlign.configure({
      types: ['heading', 'paragraph'],
    }),
    Highlight.configure({
      multicolor: true,
    }),
    Image.configure({
      inline: true,
      allowBase64: true,
    }),
    TextStyle,
    Color,
    // `***text***` isn't matched by StarterKit's default Bold/Italic input
    // rules (their boundary lookaheads reject an adjacent extra `*`).
    BoldItalicInputRule,
    // Live squiggle-underline feedback for unterminated math/markdown tokens.
    LatexLintExtension,
    // Reopenable, editable inline drawings (OneNote-style), backed by PageDrawing rows.
    DrawingBlockExtension,
    // Remote collaboration cursors (no-op when remoteCursors is empty).
    RemoteCursors.configure({ cursors: options?.remoteCursors ?? [] }),
  ];
}
