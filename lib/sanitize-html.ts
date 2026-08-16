import DOMPurify from 'dompurify';

/**
 * Allow-list HTML sanitiser for every `dangerouslySetInnerHTML` site in the app.
 *
 * Three kinds of untrusted HTML end up in the DOM here:
 *  - Rich-text authored by *any signed-in student* (discussion threads and
 *    posts, shared notes, notebook pages) — the highest-risk source, since a
 *    stored `<img onerror>` would fire for every classmate who opens the thread.
 *  - Markdown rendered by `marked`, which passes raw HTML through untouched, so
 *    a student can smuggle tags into any markdown field.
 *  - Announcement bodies authored by admins.
 *
 * The allow-list is the union of what TipTap emits (see RichTextEditor's
 * extension list), what `marked` produces, and what KaTeX needs. KaTeX renders
 * MathML plus deeply nested styled spans, so `math`/`semantics`/`annotation`
 * and inline `style` are permitted — see SAFE_STYLE below for why that is not a
 * hole.
 */

// Tags TipTap, marked, and KaTeX between them can legitimately produce.
const ALLOWED_TAGS = [
  // Block structure
  'p', 'div', 'br', 'hr', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // Inline formatting
  'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark',
  'code', 'sub', 'sup', 'small', 'a', 'img',
  // KaTeX MathML output
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext',
  'mfrac', 'msqrt', 'mroot', 'msub', 'msup', 'msubsup', 'munder', 'mover',
  'munderover', 'mspace', 'mtable', 'mtr', 'mtd', 'mpadded', 'mphantom',
  'menclose', 'mstyle', 'moperator',
];

const ALLOWED_ATTR = [
  'href', 'title', 'target', 'rel',
  'src', 'alt', 'width', 'height', 'loading',
  'class', 'style',
  'colspan', 'rowspan', 'start', 'type',
  // KaTeX / accessibility
  'aria-hidden', 'aria-label', 'role',
  'mathvariant', 'displaystyle', 'scriptlevel', 'encoding', 'stretchy',
  'data-latex',
];

let configured = false;

function configure() {
  if (configured || typeof window === 'undefined') return;
  configured = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // Any link that survives opens in a new tab without handing the opener a
    // reference back to our window.
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }

    // `style` is allowed for KaTeX's layout spans, but CSS is an injection
    // surface of its own (url(), position:fixed overlays covering the page,
    // behavior: in old engines). Keep only the harmless layout properties
    // KaTeX and TipTap actually emit.
    const style = node.getAttribute?.('style');
    if (style) {
      const safe = filterStyle(style);
      if (safe) node.setAttribute('style', safe);
      else node.removeAttribute('style');
    }
  });
}

// Layout properties emitted by KaTeX, plus the colour/highlight marks
// TipTap's Color and Highlight extensions produce.
const SAFE_STYLE_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-family', 'font-weight',
  'font-style', 'text-align', 'text-decoration', 'vertical-align',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'top', 'bottom', 'left', 'right', 'border', 'border-bottom', 'border-top',
  'border-width', 'border-style', 'border-color', 'display', 'white-space',
]);

function filterStyle(style: string): string {
  return style
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => {
      const idx = decl.indexOf(':');
      if (idx === -1) return false;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const value = decl.slice(idx + 1).toLowerCase();
      if (!SAFE_STYLE_PROPS.has(prop)) return false;
      // No external/embedded resources, no expression() legacy execution.
      return !/url\(|expression\(|javascript:/.test(value);
    })
    .join('; ');
}

/**
 * Sanitise untrusted HTML for injection via dangerouslySetInnerHTML.
 *
 * On the server this returns an empty string rather than the input: every
 * caller is a client component whose content arrives from a `fetch` in an
 * effect (RichContent is even loaded with `ssr: false`), so nothing real is
 * rendered during SSR and there is no hydration mismatch to create. Failing
 * closed here means a future server-rendered caller cannot silently
 * reintroduce the hole.
 */
export function sanitizeHtml(dirty: string | null | undefined): string {
  if (!dirty) return '';
  if (typeof window === 'undefined') return '';
  configure();
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Block every URI scheme except the ones below — in particular javascript:
    // and data: (an <a href="data:text/html,..."> is same-origin script).
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):|^[^a-z]*[/#?]/i,
    // Keep `<math>`/`<svg>` semantics from being used to smuggle HTML back in.
    USE_PROFILES: { html: true, mathMl: true },
  });
}
