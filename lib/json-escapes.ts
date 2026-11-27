/**
 * Double every backslash inside a JSON string that does not start a valid
 * escape.
 *
 * Models writing LaTeX into JSON often emit `\(`, `\Delta` or `\approx` with a
 * single backslash, which `JSON.parse` rejects outright. A valid escape
 * (`\n`, `\"`, `\\`, `é`, ...) is left as it is, so this is only ever a
 * repair of text that would not parse at all. Outside strings nothing changes.
 */
export function escapeStrayBackslashes(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[i + 1] ?? '';
    if (next === 'u') {
      if (/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += text.slice(i, i + 6);
        i += 5;
      } else {
        out += '\\\\';
      }
      continue;
    }
    if ('"\\/bfnrt'.includes(next) && next !== '') {
      out += ch + next;
      i += 1;
      continue;
    }
    out += '\\\\';
  }
  return out;
}
