'use client';

/**
 * The extension list RichTextEditor.tsx builds its live editor from.
 *
 * It was extracted so the same schema could seed a notebook page's Yjs
 * document; the notebook was removed on 28 Sep 2026 and took the Yjs layer,
 * the remote-cursor extension and the embedded drawing node with it. The
 * module stays because it is still the one place the editor's schema is
 * declared, and four surfaces build an editor from it -- announcements,
 * discussions, mock exams and the question browser.
 *
 * `history` survives for the same reason it was added: a caller that wants no
 * undo stack. Nothing passes it today.
 */

import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { Color } from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import { BoldItalicInputRule } from './boldItalicInputRule';
import { LatexLintExtension } from './latexLintExtension';

export function createRichTextEditorExtensions(options?: {
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
  ];
}
