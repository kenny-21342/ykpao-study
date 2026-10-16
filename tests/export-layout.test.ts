import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTENT, HEADER_HEIGHT, layoutQuestions, stripSize, MARGIN, PAGE,
  type LayoutQuestion, type Placed,
} from '../lib/export-layout.ts';

const q = (id: number, heights: number[], width = 1200): LayoutQuestion => ({
  id, header: `Q${id}`, strips: heights.map((height, i) => ({ key: `${id}-${i}`, width, height })),
});
const bottom = (item: Placed) => ('height' in item ? item.y + item.height : item.y + HEADER_HEIGHT);

test('a crop prints at its real size and only shrinks to the column', () => {
  const small = stripSize(400, 200); // 400 px at 200 dpi = 144 pt: not blown up
  assert.ok(Math.abs(small.width - 144) < 0.01);
  const wide = stripSize(1601, 800);
  assert.ok(Math.abs(wide.width - CONTENT.width) < 0.01);
  assert.ok(Math.abs(wide.height / wide.width - 800 / 1601) < 1e-9, 'aspect ratio kept');
});

test('nothing is placed outside the content box', () => {
  const pages = layoutQuestions([q(1, [900, 900]), q(2, [600]), q(3, [1600, 1200, 400]), q(4, [5000])]);
  for (const items of pages) {
    for (const item of items) {
      assert.ok(item.x >= MARGIN.left - 1e-9);
      assert.ok(bottom(item) <= CONTENT.height + 1e-6, `${item.kind} of Q${item.questionId} overflows`);
      if (item.kind === 'strip') assert.ok(item.x + item.width <= PAGE.width - MARGIN.right + 1e-6);
    }
  }
});

test('a question that fits on one page is not split across two', () => {
  const pages = layoutQuestions([q(1, [700, 700]), q(2, [700, 700]), q(3, [500])]);
  for (const id of [1, 2, 3]) {
    const spans = pages.filter((items) => items.some((i) => i.questionId === id));
    assert.equal(spans.length, 1, `Q${id} spans ${spans.length} pages`);
  }
});

test('an oversized question continues on the next page with a marked header', () => {
  const pages = layoutQuestions([q(1, [1500, 1500, 1500, 1500])]);
  assert.ok(pages.length > 1);
  const headers = pages.flat().filter((i) => i.kind === 'header');
  assert.equal(headers.length, pages.length);
  assert.equal(headers[0].kind === 'header' && headers[0].continued, false);
  assert.equal(headers[1].kind === 'header' && headers[1].continued, true);
});

test('a strip taller than a page is scaled down, not clipped', () => {
  const [page] = layoutQuestions([q(1, [20000], 1200)]);
  const strip = page.find((i) => i.kind === 'strip');
  assert.ok(strip && strip.kind === 'strip' && strip.height <= CONTENT.height - HEADER_HEIGHT + 1e-6);
});

test('onePerPage starts each question on its own page', () => {
  const pages = layoutQuestions([q(1, [100]), q(2, [100]), q(3, [100])], { onePerPage: true });
  assert.equal(pages.length, 3);
});

test('a question with no strips prints its placeholder', () => {
  const [page] = layoutQuestions([{ id: 9, header: 'Q9', strips: [], placeholder: 'No mark scheme' }]);
  assert.ok(page.some((i) => i.kind === 'note' && i.text === 'No mark scheme'));
});

test('no blank trailing page and an empty list gives one empty page', () => {
  assert.equal(layoutQuestions([]).length, 1);
  const pages = layoutQuestions([q(1, [100])]);
  assert.ok(pages[pages.length - 1].length > 0);
});
