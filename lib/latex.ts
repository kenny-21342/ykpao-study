import katex from 'katex';

// A placeholder-wrapping character guaranteed not to appear in real user
// text, so a stashed MATH/CODE placeholder can never collide with content
// someone actually typed (e.g. the literal text "MATH0").
const NUL = String.fromCharCode(0);

/**
 * Render a single LaTeX string to HTML via KaTeX.
 *
 * KaTeX's default output is two subtrees: the styled spans a sighted reader
 * sees (marked `aria-hidden`) and a MathML twin that assistive tech reads.
 * Asking for `output: 'html'` emitted only the first, so every formula on the
 * platform was silent to a screen reader -- the visible half is hidden from
 * them by design, and there was nothing behind it. Take the default; the
 * sanitiser's allow-list already covers the MathML tags.
 */
export function renderTeX(latex: string, displayMode = false): string {
  try {
    return katex.renderToString(latex, { displayMode, throwOnError: false });
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

export interface MathSpan {
  /** Index into the source string where the delimiter (e.g. `$` or `\[`) begins. */
  start: number;
  /** Index one past the closing delimiter. */
  end: number;
  /** The LaTeX source, delimiters stripped and trimmed. */
  latex: string;
  display: boolean;
}

// Display math (`$$...$$`, `\[...\]`) is tried before inline math
// (`\(...\)`, `$...$`) in the alternation below: at a position starting with
// `$$`, the two-dollar form must win or the single-dollar alternative would
// consume only one `$` and misparse the pair. Shared by
// `renderMarkdownWithMath` (the read-only renderer) and the live editor's
// lint extension, so the two can't quietly drift apart on what counts as a
// math span.
const MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;

/** Find every math span in a source string, in document order. */
export function findMathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  const pattern = new RegExp(MATH_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const [, displayDollar, displayBracket, inlineParen, inlineDollar] = m;
    const latex = (displayDollar ?? displayBracket ?? inlineParen ?? inlineDollar ?? '').trim();
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      latex,
      display: displayDollar !== undefined || displayBracket !== undefined,
    });
  }
  return spans;
}

/**
 * Convert a source string (markdown + LaTeX) to safe HTML.
 *
 * Order matters: math delimiters are turned into KaTeX HTML FIRST (so the
 * markdown pass never touches their contents -- previously the `*`/`_` rules
 * corrupted subscripts and products inside `$...$`). Backslash-brace / bracket
 * and `$`/`$$` delimiters are all supported.
 */
export function renderMarkdownWithMath(src: string): string {
  if (!src) return '';

  // 1) Extract math into placeholders so the markdown pass can't mangle it.
  // NUL-wrapped so a placeholder can never collide with real user text.
  let s = '';
  const store: string[] = [];
  let last = 0;
  for (const span of findMathSpans(src)) {
    s += src.slice(last, span.start);
    store.push(renderTeX(span.latex, span.display));
    s += `${NUL}MATH${store.length - 1}${NUL}`;
    last = span.end;
  }
  s += src.slice(last);

  // 2) Markdown formatting.
  // Code blocks first so their contents aren't formatted.
  const codeStore: string[] = [];
  s = s.replace(/```([\s\S]*?)```/g, (_m, code) => {
    codeStore.push(code);
    return `${NUL}CODE${codeStore.length - 1}${NUL}`;
  });
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
    codeStore.push(code);
    return `${NUL}CODE${codeStore.length - 1}${NUL}`;
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
  // despite the prompt asking for LaTeX arrays -- this ensures they still render.
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
  s = s.replace(new RegExp(`${NUL}CODE(\\d+)${NUL}`, 'g'), (_m, i) =>
    `<code>${escapeHtml(codeStore[Number(i)] ?? '')}</code>`
  );

  // 4) Restore math.
  s = s.replace(new RegExp(`${NUL}MATH(\\d+)${NUL}`, 'g'), (_m, i) => store[Number(i)] ?? '');

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
 * assigned to `innerHTML`, every non-math span must be re-escaped -- otherwise a
 * post containing the literal text `<img src=x onerror=...>` plus any `$...$`
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

/**
 * Reduce a markdown + LaTeX source string to readable plain text.
 *
 * For places that show a one- or two-line clamped preview of stored content --
 * the flashcard list, for instance -- where rendering real KaTeX would break
 * the clamp but showing the raw source spills `$$\begin{array}{c}` and `**B**`
 * at the reader. Math spans collapse to their bare LaTeX (still not prose, but
 * `\frac{a}{b}` beats `$$\frac{a}{b}$$`) and markdown emphasis, code and
 * heading markers are dropped.
 */
/**
 * Turn LaTeX into something readable in a one-line preview.
 *
 * A preview is line-clamped text in a card; KaTeX never runs on it, so
 * whatever is left here is what the student reads. Leaving the source intact
 * put `\begin{array}{c} \text{energy} \\ \uparrow` on the Study page's focus
 * queue, and `CuCO3(s) + H2SO4(aq) \rightarrow CuSO4(aq)` on the one beside
 * it -- the most-used revision surface in the app, showing markup.
 *
 * Unicode is the right answer *here* even though `SYSTEM_PROMPTS` forbids it
 * when generating content: that rule exists so KaTeX gets LaTeX to render, and
 * in a preview there is nothing to render with.
 *
 * Applied to bare commands as well as delimited spans, because the content
 * that exposed this had `\rightarrow` sitting in ordinary prose with no `$`
 * around it at all.
 */
function readableLatex(text: string): string {
  return text
    // Structure that carries no words.
    .replace(/\\(?:begin|end)\{[^}]*\}(?:\{[^}]*\})?/g, ' ')
    .replace(/\\\\/g, ' ')
    // Wrappers whose argument is the content.
    .replace(/\\(?:text|mathrm|mathbf|textbf|textit|mathit|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
    // The symbols this corpus actually uses.
    .replace(/\\(?:rightarrow|to|longrightarrow)\b/g, '→')
    .replace(/\\(?:leftarrow|longleftarrow)\b/g, '←')
    .replace(/\\(?:leftrightarrow|rightleftharpoons)\b/g, '⇌')
    .replace(/\\uparrow\b/g, '↑')
    .replace(/\\downarrow\b/g, '↓')
    .replace(/\\times\b/g, '×')
    .replace(/\\div\b/g, '÷')
    .replace(/\\pm\b/g, '±')
    .replace(/\\(?:le|leq)\b/g, '≤')
    .replace(/\\(?:ge|geq)\b/g, '≥')
    .replace(/\\(?:ne|neq)\b/g, '≠')
    .replace(/\\approx\b/g, '≈')
    .replace(/\\cdot\b/g, '·')
    .replace(/\\degree\b|\\circ\b/g, '°')
    .replace(/\\(?:alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|omega|Delta|Omega)\b/g,
      (match) => ({
        '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\theta': 'θ',
        '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π', '\\sigma': 'σ', '\\omega': 'ω',
        '\\Delta': 'Δ', '\\Omega': 'Ω',
      })[match] ?? match)
    // Anything still backslashed is a command we do not translate; drop the
    // marker and keep the word, which reads better than `\upharpoonright`.
    .replace(/\\([a-zA-Z]+)/g, '$1')
    // Alignment and grouping leftovers.
    .replace(/[{}&]/g, ' ')
    .replace(/\s*\$\s*/g, ' ');
}

export function plainTextPreview(src: string): string {
  const spans = findMathSpans(src);
  let out = '';
  let last = 0;
  for (const span of spans) {
    out += src.slice(last, span.start) + span.latex;
    last = span.end;
  }
  out += src.slice(last);

  return readableLatex(out)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*\*|\*\*|\*|__|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
