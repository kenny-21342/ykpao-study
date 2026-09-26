import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resourceUploadFolderId } from '../lib/school-resource-upload.ts';
import { keyFromPublicPath } from '../lib/storage/keys.ts';

const uuid = 'a81d9473-e511-4c03-b66a-9fc4d2897f75';

test('resource upload URLs support old flat keys and new folder keys', () => {
  assert.equal(resourceUploadFolderId(`/uploads/files/${uuid}.pdf`), null);
  assert.equal(resourceUploadFolderId(`/uploads/images/${uuid}.png`), null);
  const url = `/uploads/files/resources/cm123abc/${uuid}.pdf`;
  assert.equal(resourceUploadFolderId(url), 'cm123abc');
  assert.equal(keyFromPublicPath(url), url.slice(1));
});

test('resource upload URL parser rejects other object keys and traversal', () => {
  for (const url of [
    '/uploads/files/../secret.pdf',
    `/uploads/files/resources/../${uuid}.pdf`,
    `/uploads/files/resources/cm123abc/nested/${uuid}.pdf`,
    `/uploads/files/resources/cm123abc/${uuid}.pdf?x=1`,
    '/uploads/files/other.pdf',
    `https://example.com/uploads/files/${uuid}.pdf`,
  ]) {
    assert.equal(resourceUploadFolderId(url), undefined, url);
  }
});
