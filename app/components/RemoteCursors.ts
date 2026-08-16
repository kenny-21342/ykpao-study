'use client';

/**
 * TipTap extension for rendering remote collaboration cursors as decorations.
 *
 * Each remote cursor is rendered as:
 *   - A colored caret (for collapsed selections) via a widget decoration
 *   - A colored highlight (for range selections) via an inline decoration
 *   - A floating name label at the caret position
 *
 * The cursor list is passed via the extension's options and updated by
 * re-configuring the plugin when the list changes (handled automatically
 * by TipTap's `extension.configure()` reactivity).
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';

export type RemoteCursor = {
  userId: string;
  userName: string | null;
  userColor: string;
  from: number;
  to: number;
};

const pluginKey = new PluginKey<DecorationSet>('remoteCursors');

/**
 * Build a set of caret *widget* decorations (separately from highlights) so
 * that each caret also carries a name label.
 */
function buildCaretWidgets(cursors: RemoteCursor[], doc: PmNode): Decoration[] {
  const widgets: Decoration[] = [];
  for (const c of cursors) {
    const from = Math.max(0, Math.min(c.from, doc.content.size));
    const to = Math.max(0, Math.min(c.to, doc.content.size));
    const pos = Math.min(from, to);

    // Caret element
    const caret = document.createElement('span');
    caret.className = 'remote-cursor-caret';
    caret.style.borderLeftColor = c.userColor;
    caret.setAttribute('data-user-id', c.userId);

    // Name label attached to caret
    const label = document.createElement('span');
    label.className = 'remote-cursor-label';
    label.textContent = c.userName || 'Anonymous';
    label.style.backgroundColor = c.userColor;
    caret.appendChild(label);

    widgets.push(Decoration.widget(pos, caret, { side: -1 }));
  }
  return widgets;
}

function buildRangeHighlights(cursors: RemoteCursor[], doc: PmNode): Decoration[] {
  const highlights: Decoration[] = [];
  for (const c of cursors) {
    if (c.from === c.to) continue;
    const from = Math.max(0, Math.min(c.from, doc.content.size));
    const to = Math.max(0, Math.min(c.to, doc.content.size));
    if (from >= to) continue;
    highlights.push(
      Decoration.inline(from, to, {
        style: `background-color: ${c.userColor}22;`,
      })
    );
  }
  return highlights;
}

export const RemoteCursors = Extension.create<{
  cursors: RemoteCursor[];
}>({
  name: 'remoteCursors',

  addOptions() {
    return { cursors: [] };
  },

  addProseMirrorPlugins() {
    const cursors = this.options.cursors;
    return [
      new Plugin<DecorationSet>({
        key: pluginKey,
        state: {
          init(_, { doc }) {
            const decos = [...buildRangeHighlights(cursors, doc), ...buildCaretWidgets(cursors, doc)];
            return DecorationSet.create(doc, decos);
          },
          apply(tr, old) {
            // Map existing decorations through the transaction so they stay
            // anchored to the right text as the document changes.
            const mapped = old.map(tr.mapping, tr.doc);
            // If the document changed, rebuild from the latest cursor list
            // (the options are updated by the parent component on re-render).
            if (tr.docChanged) {
              const decos = [
                ...buildRangeHighlights(cursors, tr.doc),
                ...buildCaretWidgets(cursors, tr.doc),
              ];
              return DecorationSet.create(tr.doc, decos);
            }
            return mapped;
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
