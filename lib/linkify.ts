/**
 * Turn bare URLs in already-written text into links.
 *
 * The editor autolinks as you type (`link.autolink` in richTextEditorExtensions),
 * but anything written before that, pasted in as plain text, or stored as
 * markdown-less HTML is just characters, and rendered as plain text. Posts
 * showed `https://...` the same colour as the sentence around it.
 *
 * The splitting is pure so it can be tested without a DOM; `linkifyTextNodes`
 * below applies it to a parsed tree.
 */

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string };

/**
 * http(s):// or www. up to whitespace or an angle bracket / quote. Trailing
 * punctuation is peeled off afterwards, because the sentence's own full stop is
 * not part of the address.
 */
const CANDIDATE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

function trimTrailing(raw: string): string {
  let value = raw;
  for (;;) {
    const before = value;
    value = value.replace(TRAILING_PUNCTUATION, '');
    // A closing bracket belongs to the address only when it is balanced, as in
    // en.wikipedia.org/wiki/Torque_(physics); "(see https://x.com/a)" must not
    // swallow the closing parenthesis of the sentence around it.
    for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
      while (value.endsWith(close) && count(value, close) > count(value, open)) {
        value = value.slice(0, -1);
      }
    }
    if (value === before) return value;
  }
}

function count(value: string, char: string): number {
  return value.split(char).length - 1;
}

export function splitLinks(input: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of input.matchAll(CANDIDATE)) {
    const start = match.index ?? 0;
    const url = trimTrailing(match[0]);
    // The host half of an email address (user@www.example.com) is not a link.
    if (start > 0 && input[start - 1] === '@') continue;
    // A bare scheme or a bare "www." is not an address.
    if (!/^(?:https?:\/\/|www\.)[^\s/.]/i.test(url)) continue;
    if (start > cursor) segments.push({ kind: 'text', text: input.slice(cursor, start) });
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    segments.push({ kind: 'link', text: url, href });
    cursor = start + url.length;
  }
  if (cursor < input.length) segments.push({ kind: 'text', text: input.slice(cursor) });
  return segments;
}

/** Elements whose text must never be rewritten into links. */
const SKIP = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

function insideSkipped(node: Node, root: Node): boolean {
  for (let el: Node | null = node.parentNode; el && el !== root; el = el.parentNode) {
    if (el.nodeType !== 1) continue;
    const element = el as Element;
    // KaTeX output and the editor's formula spans are maths, not prose: a `/`
    // or `.` inside one is not a web address.
    if (
      SKIP.has(element.tagName) ||
      element.classList.contains('katex') ||
      element.classList.contains('latex-formula')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Replace bare URLs in a tree's text nodes with anchors, in place.
 *
 * The caller sanitises afterwards: the anchors made here carry no attributes
 * beyond `href`, and DOMPurify's hook adds `target`/`rel`, so a link made here
 * is held to the same rules as one the author wrote.
 */
export function linkifyTextNodes(root: Element): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue && /(?:https?:\/\/|www\.)/i.test(node.nodeValue) && !insideSkipped(node, root)) {
      targets.push(node as Text);
    }
  }

  for (const textNode of targets) {
    const segments = splitLinks(textNode.nodeValue ?? '');
    if (!segments.some((segment) => segment.kind === 'link')) continue;
    const fragment = doc.createDocumentFragment();
    for (const segment of segments) {
      if (segment.kind === 'text') {
        fragment.appendChild(doc.createTextNode(segment.text));
      } else {
        const anchor = doc.createElement('a');
        anchor.setAttribute('href', segment.href);
        anchor.textContent = segment.text;
        fragment.appendChild(anchor);
      }
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}
