import katex from 'katex';

/**
 * Render a single LaTeX string to HTML via KaTeX.
 */
export function renderTeX(latex: string, displayMode = false): string {
  try {
    return katex.renderToString(latex, { displayMode, throwOnError: false, output: 'html' });
  } catch {
    return `<span style="color:#dc2626">[invalid LaTeX: ${escapeHtml(latex)}]</span>`;
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert a source string (markdown + LaTeX) to safe HTML.
 *
 * Order matters: math delimiters are turned into KaTeX HTML FIRST (so the
 * markdown pass never touches their contents — previously the `*`/`_` rules
 * corrupted subscripts and products inside `$...$`). Backslash-brace / bracket
 * and `$`/`$$` delimiters are all supported.
 */
export function renderMarkdownWithMath(src: string): string {
  if (!src) return '';

  // 1) Extract math into placeholders so the markdown pass can't mangle it.
  const store: string[] = [];
  const stash = (html: string) => {
    store.push(html);
    return `\u0000MATH${store.length - 1}\u0000`;
  };

  let s = src;

  // Display math first (longest delimiter wins).
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, latex) => stash(renderTeX(latex.trim(), true)));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_m, latex) => stash(renderTeX(latex.trim(), true)));
  // Inline math.
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_m, latex) => stash(renderTeX(latex.trim(), false)));
  // $...$ — avoid matching across newlines or currency-like usage.
  s = s.replace(/\$([^\$\n]+?)\$/g, (_m, latex) => stash(renderTeX(latex.trim(), false)));

  // 2) Markdown formatting.
  // Code blocks first so their contents aren't formatted.
  const codeStore: string[] = [];
  s = s.replace(/```([\s\S]*?)```/g, (_m, code) => {
    codeStore.push(code);
    return `\u0000CODE${codeStore.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
    codeStore.push(code);
    return `\u0000CODE${codeStore.length - 1}\u0000`;
  });

  // Headers.
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold / italic.
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_|\w)/g, '$1<em>$2</em>');

  // Lists.
  s = s.replace(/^(?:- |\* )(.+)$/gm, '<li>$1</li>');
  s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Wrap consecutive <li> into <ul>.
  s = s.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);

  // Markdown tables (GFM pipe syntax). Matches a header row, a separator row
  // (|:---| or |---|:---:|), and 1+ body rows. Gemini sometimes produces these
  // despite the prompt asking for LaTeX arrays — this ensures they still render.
  s = s.replace(
    /(?:^|\n)((?:\|[^\n]+\|\s*\n)(?:\|[ :|-]+\|\s*\n)(?:\|[^\n]+\|\s*\n?)+)/g,
    (_m, tableBlock: string) => {
      const lines = tableBlock.trim().split('\n');
      // Parse header
      const headerCells = lines[0].split('|').slice(1, -1).map((c) => c.trim());
      // Body rows (skip separator at index 1)
      const bodyRows = lines.slice(2).map((line) =>
        line.split('|').slice(1, -1).map((c) => c.trim())
      );
      let html = '<table class="question-table"><thead><tr>';
      headerCells.forEach((c) => { html += `<th>${c}</th>`; });
      html += '</tr></thead><tbody>';
      bodyRows.forEach((row) => {
        html += '<tr>';
        row.forEach((c) => { html += `<td>${c}</td>`; });
        html += '</tr>';
      });
      html += '</tbody></table>';
      return `\n${html}\n`;
    }
  );

  // Line breaks.
  s = s.replace(/\n{2,}/g, '<br/><br/>');
  s = s.replace(/\n/g, '<br/>');

  // Auto-link bare URLs. Runs AFTER code-stashing so code-block URLs are
  // left alone, and AFTER markdown so existing <a href> aren't double-wrapped.
  // Match http(s):// or www. up to the first whitespace/< (angle brackets
  // often delimit URLs pasted in plain text).
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+|www\.[^\s<)]+)/gi, (match, prefix, url) => {
    const href = url.toLowerCase().startsWith('www.') ? `https://${url}` : url;
    return `${prefix}<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(url)}</a>`;
  });

  // 3) Restore code.
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) =>
    `<code>${escapeHtml(codeStore[Number(i)] ?? '')}</code>`
  );

  // 4) Restore math.
  s = s.replace(/\u0000MATH(\d+)\u0000/g, (_m, i) => store[Number(i)] ?? '');

  return s;
}

/**
 * Given a DOM root, find every `.latex-formula[data-latex]` span produced by
 * the TipTap RichTextEditor and render its KaTeX into the span. Idempotent.
 *
 * This is the counterpart to RichTextEditor's insertLatex(): the editor renders
 * live while editing, but when the same HTML is later shown read-only (e.g. the
 * note viewer) we must re-run KaTeX because the saved HTML only contains an
 * empty span with the source in data-latex.
 */
export function renderLatexSpans(root: HTMLElement) {
  const spans = root.querySelectorAll<HTMLElement>('.latex-formula[data-latex]:not([data-katex-rendered])');
  spans.forEach((el) => {
    const latex = el.getAttribute('data-latex');
    if (!latex) return;
    el.innerHTML = renderTeX(latex, false);
    el.setAttribute('data-katex-rendered', '1');
  });
}

/**
 * Replace `$$...$$` / `$...$` in a **text node's value** with KaTeX HTML.
 *
 * The input is text, not markup: by the time we see it the sanitiser has
 * already entity-escaped anything a student typed that looked like a tag, and
 * reading `.nodeValue` decodes those entities back. Since the result is
 * assigned to `innerHTML`, every non-math span must be re-escaped — otherwise a
 * post containing the literal text `<img src=x onerror=…>` plus any `$…$`
 * reconstitutes that tag as a live element, which is stored XSS straight past
 * DOMPurify.
 */
export function renderMathInText(text: string): string {
  const pattern = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, match.index));
    const display = match[1] !== undefined;
    const latex = (match[1] ?? match[2] ?? '').trim();
    out += `<span class="inline-math">${renderTeX(latex, display)}</span>`;
    last = match.index + match[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/**
 * Walk a (already sanitised) DOM tree and render `$...$` math found in text
 * nodes, skipping `code`/`pre` where dollar signs are literal.
 */
export function renderMathTextNodes(root: HTMLElement) {
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
    const rendered = renderMathInText(original);
    if (rendered === escapeHtml(original)) continue;

    const span = document.createElement('span');
    span.innerHTML = rendered;
    textNode.replaceWith(span);
  }
}
