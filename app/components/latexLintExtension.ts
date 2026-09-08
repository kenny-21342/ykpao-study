'use client';

/**
 * Live Markdown/LaTeX linting for the notes editor.
 *
 * Scans the document on a debounced timer (not on every keystroke -- KaTeX
 * parsing a formula on every character would visibly stutter on a longer
 * note) and marks two kinds of problem inline:
 *   - Invalid LaTeX inside a math span ($...$, $$...$$, \(...\), \[...\]),
 *     found with the same `findMathSpans` helper the read-only renderer uses
 *     in lib/latex.ts, so live-typing and the saved-note view never disagree
 *     on what counts as a math span.
 *   - An unterminated math delimiter or an unbalanced `**`/backtick token.
 *
 * The debounce is implemented as a ProseMirror plugin `view()` hook that
 * schedules a delayed dispatch of a "rescan" transaction, rather than
 * recomputing decorations synchronously in `apply()` on every keystroke.
 * `apply()` itself only maps existing decorations through the transaction
 * (cheap, keeps them anchored) unless it sees the rescan meta, mirroring the
 * cursor-mapping pattern in RemoteCursors.ts.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import katex from 'katex';
import { findMathSpans } from '@/lib/latex';

const pluginKey = new PluginKey<DecorationSet>('latexLint');
const RESCAN_META = 'latexLintRescan';
const DEBOUNCE_MS = 400;

interface LintProblem {
  from: number;
  to: number;
  message: string;
}

/** Flag a markdown token (`**`, backtick) that opens without a matching close. */
function findUnbalancedToken(text: string, token: string): LintProblem | null {
  let count = 0;
  let lastIndex = -1;
  let searchFrom = 0;
  for (;;) {
    const idx = text.indexOf(token, searchFrom);
    if (idx === -1) break;
    count++;
    lastIndex = idx;
    searchFrom = idx + token.length;
  }
  if (count % 2 === 1) {
    return {
      from: lastIndex,
      to: lastIndex + token.length,
      message: `Unbalanced "${token}" -- this one has no matching closing "${token}"`,
    };
  }
  return null;
}

/** Blank out matched math spans so a stray leftover `$` isn't double-counted. */
function blankSpans(text: string, spans: Array<{ start: number; end: number }>): string {
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end } = spans[i];
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

/** Lint the plain text of one block (paragraph, heading, ...), offsets relative to its start. */
function lintBlockText(text: string): LintProblem[] {
  const problems: LintProblem[] = [];
  const spans = findMathSpans(text);

  for (const span of spans) {
    try {
      katex.renderToString(span.latex, { throwOnError: true, displayMode: span.display });
    } catch (err) {
      problems.push({
        from: span.start,
        to: span.end,
        message: err instanceof Error
          ? err.message.replace(/^KaTeX parse error: /, '')
          : 'Invalid LaTeX',
      });
    }
  }

  const withoutMath = blankSpans(text, spans);
  const strayDollar = withoutMath.indexOf('$');
  if (strayDollar !== -1) {
    problems.push({
      from: strayDollar,
      to: strayDollar + 1,
      message: 'Unterminated math delimiter -- this "$" has no matching closing "$"',
    });
  }

  const unbalancedBold = findUnbalancedToken(withoutMath, '**');
  if (unbalancedBold) problems.push(unbalancedBold);
  const unbalancedCode = findUnbalancedToken(withoutMath, '`');
  if (unbalancedCode) problems.push(unbalancedCode);

  return problems;
}

function buildDecorations(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    const text = node.textContent;
    if (!text) return;
    for (const problem of lintBlockText(text)) {
      const from = pos + 1 + problem.from;
      const to = pos + 1 + problem.to;
      if (from >= to) continue;
      // A native `title` attribute is the tooltip -- the browser's own
      // hover affordance, rather than a hand-rolled floating element that
      // has to track scroll/resize/unmount itself.
      decorations.push(
        Decoration.inline(from, to, {
          class: 'latex-lint-error',
          title: problem.message,
        })
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const LatexLintExtension = Extension.create({
  name: 'latexLint',

  addProseMirrorPlugins() {
    let timer: ReturnType<typeof setTimeout> | null = null;

    return [
      new Plugin<DecorationSet>({
        key: pluginKey,
        state: {
          init(_, { doc }) {
            return buildDecorations(doc);
          },
          apply(tr, old) {
            if (tr.getMeta(RESCAN_META)) return buildDecorations(tr.doc);
            if (tr.docChanged) return old.map(tr.mapping, tr.doc);
            return old;
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state);
          },
        },
        view() {
          return {
            update(view, prevState) {
              if (view.state.doc === prevState.doc) return;
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => {
                if (view.isDestroyed) return;
                view.dispatch(view.state.tr.setMeta(RESCAN_META, true));
              }, DEBOUNCE_MS);
            },
            destroy() {
              if (timer) clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});
