'use client';

import { useMemo } from 'react';
import { renderLatexSpans, renderTeX, renderMarkdownWithMath } from '@/lib/latex';
import { sanitizeHtml } from '@/lib/sanitize-html';

/**
 * Renders content produced by the TipTap RichTextEditor (read-only view),
 * with automatic backward-compatibility for legacy markdown content.
 *
 * Detection rule:
 *  - If the string contains HTML block/inline tags (<p>, <h1>, <strong>, etc.)
 *    it is treated as pre-formatted HTML from the rich editor and injected as-is.
 *  - Otherwise it is treated as legacy markdown (+ `$...$` math) and run through
 *    renderMarkdownWithMath first.
 * This means existing threads/replies/answers authored as markdown continue to
 * render correctly after the input is upgraded to the WYSIWYG editor.
 *
 * LaTeX conventions handled after injection:
 *  1. Legacy `.latex-formula[data-latex]` spans (older notes) — re-rendered
 *     via renderLatexSpans.
 *  2. Current `$...$` / `$$...$$` inline math text inserted by the editor's
 *     Σ button — converted to KaTeX HTML in place.
 */
export default function RichContent({ html, className }: { html: string; className?: string }) {
  const renderedHtml = useMemo(() => normalizeContent(html), [html]);

  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}

/**
 * Decide whether stored content is HTML (from RichTextEditor) or legacy
 * markdown, and return a single HTML string ready for display.
 */
function normalizeContent(src: string | undefined | null): string {
  const raw = (src ?? '').trim();
  if (!raw) return '';
  // A leading '<' that matches a known HTML tag, or any block/inline tag
  // anywhere in the string, indicates the rich editor's HTML output.
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(raw);

  // Markdown branch: sanitise the *output*. Sanitising the source first would
  // entity-escape characters like `<` that marked then escapes again, so a
  // student writing "a < b" would see "a &amp;lt; b".
  if (!looksLikeHtml) return sanitizeHtml(renderMarkdownWithMath(raw));

  // HTML branch: sanitise before the string ever becomes DOM nodes, so the
  // detached tree below can't contain an event handler or a resource-loading
  // attribute. Everything added afterwards is KaTeX output we generate.
  const s = sanitizeHtml(raw);
  if (typeof document === 'undefined' || !s) return s;

  const root = document.createElement('div');
  root.innerHTML = s;
  renderLatexSpans(root);
  renderMathTextNodes(root);
  return root.innerHTML;
}

// Replace $$...$$ and $...$ in a plain string with KaTeX HTML spans.
function renderMathInString(s: string): string {
  let out = s;
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, latex) =>
    wrapMath(renderTeX(latex.trim(), true)),
  );
  out = out.replace(/\$([^\$\n]+?)\$/g, (_m, latex) =>
    wrapMath(renderTeX(latex.trim(), false)),
  );
  return out;
}

function wrapMath(html: string): string {
  return `<span class="inline-math">${html}</span>`;
}

function renderMathTextNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let parent: Node | null = node.parentNode;
      while (parent && parent !== root) {
        if (parent.nodeName === 'CODE' || parent.nodeName === 'PRE') {
          return NodeFilter.FILTER_REJECT;
        }
        parent = parent.parentNode;
      }
      return node.nodeValue?.includes('$')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) targets.push(node as Text);

  for (const textNode of targets) {
    const original = textNode.nodeValue ?? '';
    const rendered = renderMathInString(original);
    if (rendered === original) continue;

    const span = document.createElement('span');
    span.innerHTML = rendered;
    textNode.replaceWith(span);
  }
}
