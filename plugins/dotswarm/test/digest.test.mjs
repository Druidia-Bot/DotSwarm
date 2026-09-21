import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedFiles, ledgerDigest, referencedIds } from '../src/digest.mjs';

test('referencedIds reads single ids and ranges', () => {
  assert.deepEqual([...referencedIds('Resolved F-008.')], [8]);
  assert.deepEqual([...referencedIds('after reviewer F-013..F-015')].sort((a, b) => a - b), [13, 14, 15]);
  assert.deepEqual([...referencedIds('All F-005 to F-007 fixed')].sort((a, b) => a - b), [5, 6, 7]);
});

test('ledgerDigest separates answered warnings from open ones', () => {
  const rows = [
    { id: 'F-001', type: 'warning', scope: 'a', message: 'long page' },
    { id: 'F-002', type: 'failure', scope: 'b', message: 'gate exits 0' },
    { id: 'F-003', type: 'warning', scope: 'c', message: 'jargon' },
    { id: 'F-004', type: 'discovery', scope: 'd', message: 'mentions F-002 but is not an answer' },
    { id: 'F-005', type: 'result', scope: 'e', message: 'Resolved F-001..F-001 and F-003' },
  ];
  const digest = ledgerDigest(rows);
  assert.equal(digest.open.length, 1);
  assert.match(digest.open[0], /^F-002 \[failure\]/);
  assert.equal(digest.addressed.length, 2);
});

test('changedFiles lists risky code first and never notes', () => {
  const files = changedFiles(' M package.json\n?? scripts/release-build.mjs\n?? planning/contact-notes.md\n M src/styles/global.css\n?? src/components/forms/Contact.astro\nR  old.js -> src/lib/schema.ts');
  assert.deepEqual(files.readFirst, ['package.json', 'scripts/release-build.mjs', 'src/components/forms/Contact.astro', 'src/lib/schema.ts']);
  assert.deepEqual(files.other, ['planning/contact-notes.md', 'src/styles/global.css']);
  assert.equal(files.count, 6);
});
