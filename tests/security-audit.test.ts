import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every HTML injection site has a sanitization or generated-output boundary', async () => {
  const cases: Array<[string, RegExp]> = [
    ['app/announcements/page.tsx', /sanitizeHtml\(a\.body\)/],
    ['app/components/AnnouncementBanner.tsx', /sanitizeHtml\(a\.body\)/],
    ['app/components/CompetitionVault.tsx', /sanitizeHtml\(selected\.body\)/],
    ['app/components/FormattedMessage.tsx', /sanitizeHtml\(renderMarkdownWithMath/],
    ['app/components/ResourceLibrary.tsx', /sanitizeHtml\(note\.content\)/],
    ['app/components/RichContent.tsx', /sanitizeHtml\(root\.innerHTML\)/],
    // This is a client-only KaTeX render with throwOnError and no user HTML
    // interpolation; it does not consume arbitrary stored markup.
    ['app/v3/components/QuestionDocumentRenderer.tsx', /katex\.renderToString\([\s\S]*throwOnError: true/],
  ];

  for (const [relative, boundary] of cases) {
    const source = await readFile(join(root, relative), 'utf8');
    assert.match(source, /dangerouslySetInnerHTML/, `${relative} is no longer an audited sink`);
    assert.match(source, boundary, `${relative} must keep its output boundary`);
  }
});

test('uploads are session-gated before object storage is touched', async () => {
  const source = await readFile(join(root, 'app/uploads/[...path]/route.ts'), 'utf8');
  assert.match(source, /getServerSession\(authOptions\)/);
  assert.match(source, /status: 401/);
  assert.match(source, /serveStoredObject/);
});

test('admin and V3 route segments are protected server-side', async () => {
  const adminLayout = await readFile(join(root, 'app/admin/layout.tsx'), 'utf8');
  const v3Layout = await readFile(join(root, 'app/v3/layout.tsx'), 'utf8');
  const v3Http = await readFile(join(root, 'lib/v3/http.ts'), 'utf8');
  assert.match(adminLayout, /requireAdmin\(\)/);
  assert.match(v3Layout, /requireAdmin\(\)/);
  assert.match(v3Http, /requireAdmin\(\)/);
  assert.match(v3Http, /status: 403/);
});
