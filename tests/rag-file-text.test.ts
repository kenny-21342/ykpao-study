import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

import { extractFileText } from '../lib/rag-file-text.ts';

/**
 * The local store roots at `process.cwd()` and maps the `uploads/` prefix to
 * `public/uploads`, with no environment override -- so these fixtures go where
 * a real upload goes, under a directory this file owns and removes.
 */
const scratch = `rag-file-text-${randomUUID()}`;
const scratchRoot = join(process.cwd(), 'public', 'uploads', scratch);

after(() => rmSync(scratchRoot, { recursive: true, force: true }));

function writeUpload(name: string, contents: Buffer | string) {
  const full = join(scratchRoot, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return `/uploads/${scratch}/${name}`;
}

test('reads a plain-text upload', async () => {
  const url = writeUpload(
    'notes.md',
    '# Photosynthesis\n\nThe light-dependent reactions occur in the thylakoid membrane.',
  );
  const result = await extractFileText(url, 'text/markdown', 'notes.md');
  assert.equal(result.reason, 'ok');
  assert.match(result.text, /thylakoid membrane/);
});

test('refuses a path outside the upload prefixes', async () => {
  // keyFromPublicPath is the guard. A traversal must not become a file read.
  const result = await extractFileText('/etc/passwd', 'text/plain', 'passwd');
  assert.equal(result.reason, 'unsupported-type');
  assert.equal(result.text, '');
});

test('reports a missing file rather than throwing', async () => {
  const result = await extractFileText(`/uploads/${scratch}/absent.txt`, 'text/plain', 'absent.txt');
  assert.equal(result.reason, 'missing-file');
});

test('skips a type it cannot read', async () => {
  const url = writeUpload('slides.pptx', 'binary-ish');
  const result = await extractFileText(
    url,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'slides.pptx',
  );
  assert.equal(result.reason, 'unsupported-type');
});

test('treats a near-empty file as having no text layer', async () => {
  // The scanned-PDF case: page furniture yields a few stray characters, and
  // indexing those as the document's contents would be a lie.
  const url = writeUpload('scan.txt', 'p. 4');
  const result = await extractFileText(url, 'text/plain', 'scan.txt');
  assert.equal(result.reason, 'no-text-layer');
  assert.equal(result.text, '');
});

test('a corrupt PDF degrades to a reason code instead of throwing', async () => {
  const url = writeUpload('broken.pdf', Buffer.from('%PDF-1.4 not really a pdf'));
  const result = await extractFileText(url, 'application/pdf', 'broken.pdf');
  assert.notEqual(result.reason, 'ok');
  assert.equal(result.text, '');
});

test('reads the text out of a real PDF', async () => {
  // A minimal but genuine PDF: one page, one Tj string, uncompressed. Built
  // here rather than committed as a binary so the expectation is readable.
  const body = `BT /F1 24 Tf 72 700 Td (Explain how enzymes lower activation energy) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const url = writeUpload('question.pdf', Buffer.from(pdf, 'latin1'));
  const result = await extractFileText(url, 'application/pdf', 'question.pdf');
  assert.equal(result.reason, 'ok');
  assert.match(result.text, /activation energy/);
  assert.equal(result.pages, 1);
});

test('a passage has to be long enough to retrieve', async () => {
  const { isRetrievableText, RETRIEVABLE_CHARS } = await import('../lib/rag-file-text.ts');
  // The MCQ answer key that put 19,441 one-character chunks into the index.
  assert.equal(isRetrievableText('B'), false);
  assert.equal(isRetrievableText(''), false);
  assert.equal(isRetrievableText(null), false);
  assert.equal(isRetrievableText(' '.repeat(200)), false, 'whitespace is not prose');
  assert.equal(isRetrievableText('x'.repeat(RETRIEVABLE_CHARS - 1)), false);
  assert.equal(isRetrievableText('x'.repeat(RETRIEVABLE_CHARS)), true);
});
