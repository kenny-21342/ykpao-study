import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyResourceFolderPath } from '../lib/school-resource-organization.ts';

test('legacy resources group by subject, category, and upload month', () => {
  const createdAt = new Date('2025-03-22T10:00:00Z');
  assert.equal(legacyResourceFolderPath({ subject: 'Physics', category: 'Worksheet', createdAt }), 'Physics/Worksheet/2025/03');
  assert.equal(legacyResourceFolderPath({ subject: null, category: null, createdAt }), 'Unsorted/General/2025/03');
  assert.equal(legacyResourceFolderPath({ subject: 'Science/Physics', category: 'Exam\\MS', createdAt }), 'Science Physics/Exam MS/2025/03');
});
