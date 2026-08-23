/**
 * The pure half of error reporting: what a stored error may contain, and how
 * two occurrences of one bug are recognised as the same bug.
 *
 * Separate from `error-reporting.ts` because that module reaches the database,
 * and these rules are the part worth testing directly rather than restating in
 * a test.
 */

/**
 * Strip anything that looks like a credential.
 *
 * Errors quote the thing that failed, and the thing that failed is often a URL
 * with a key in it or an Authorization header. This table is readable by every
 * admin, so redaction happens on the way in, not on the way out.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(bearer)\s+[A-Za-z0-9._\-]+/gi, '$1 [redacted]')
    .replace(/\bsk-[A-Za-z0-9._\-]{6,}/g, 'sk-[redacted]')
    .replace(/\b(postgres(?:ql)?|redis|mongodb(?:\+srv)?):\/\/[^\s"']+/gi, '$1://[redacted]')
    // The keyword may sit anywhere in the parameter name -- `X-Amz-Signature`
    // and `X-Amz-Credential` are the ones that actually show up here, and
    // anchoring on the start of the name missed both.
    .replace(
      /([?&][^=&\s]*(?:api[_-]?key|access[_-]?key|token|secret|password|signature|credential)[^=&\s]*=)[^&\s"']+/gi,
      '$1[redacted]',
    )
    .replace(/\b(AWS4-HMAC-SHA256\s+Credential=)[^\s,]+/gi, '$1[redacted]');
}

/** Group repeats of the same bug: message shape plus where it happened. */
export function fingerprintOf(message: string, routePath: string | undefined): string {
  const normalised = message
    // Ids, uuids and numbers vary per occurrence and would split one bug into many.
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\bc[a-z0-9]{20,}\b/gi, '<cuid>')
    .replace(/\d+/g, '<n>');
  // FNV-1a rather than a crypto hash: this only has to group identical bugs,
  // and `instrumentation.ts` is bundled for the Edge runtime as well, where
  // `node:crypto` does not exist.
  const input = `${routePath ?? ''}\n${normalised}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
