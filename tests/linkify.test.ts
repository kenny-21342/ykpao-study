import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLinks } from '../lib/linkify.ts';

const links = (input: string) =>
  splitLinks(input).filter((s) => s.kind === 'link').map((s) => (s.kind === 'link' ? s.href : ''));

test('a bare URL in a sentence becomes a link and the text around it is kept', () => {
  const out = splitLinks('Notes are at https://example.com/notes today');
  assert.deepEqual(out.map((s) => s.kind), ['text', 'link', 'text']);
  assert.equal(out[1].kind === 'link' && out[1].href, 'https://example.com/notes');
  assert.equal(out.map((s) => s.text).join(''), 'Notes are at https://example.com/notes today');
});

test("the sentence's own punctuation is not part of the address", () => {
  assert.deepEqual(links('See https://example.com/a.'), ['https://example.com/a']);
  assert.deepEqual(links('Is it https://example.com/a?'), ['https://example.com/a']);
  assert.deepEqual(links('a, https://example.com/a, b'), ['https://example.com/a']);
});

test('a closing bracket is dropped only when it is unbalanced', () => {
  assert.deepEqual(links('(see https://example.com/a)'), ['https://example.com/a']);
  assert.deepEqual(
    links('https://en.wikipedia.org/wiki/Torque_(physics)'),
    ['https://en.wikipedia.org/wiki/Torque_(physics)'],
  );
});

test('www. gains a scheme, and a bare scheme or www. is not an address', () => {
  assert.deepEqual(links('go to www.example.com now'), ['https://www.example.com']);
  assert.deepEqual(links('type https:// then the address'), []);
  assert.deepEqual(links('the www. prefix'), []);
});

test('other schemes are never turned into links', () => {
  assert.deepEqual(links('javascript:alert(1) and data:text/html,x and ftp://example.com'), []);
});

test('the host half of an email address is not linked', () => {
  assert.deepEqual(links('mail me at kenny@www.example.com'), []);
});

test('text with no address comes back unchanged', () => {
  assert.deepEqual(splitLinks('nothing here'), [{ kind: 'text', text: 'nothing here' }]);
  assert.deepEqual(splitLinks(''), []);
});

test('two addresses in one string both become links', () => {
  assert.deepEqual(
    links('https://a.example.com and http://b.example.com/x'),
    ['https://a.example.com', 'http://b.example.com/x'],
  );
});
