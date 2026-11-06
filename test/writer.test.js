import test from 'node:test';
import assert from 'node:assert/strict';
import { indexBodyChanged, releaseFileBodyChanged } from '../src/writer.js';

function indexFile(overrides = {}) {
  return {
    formatVersion: 1,
    generatedAt: '2026-11-06T03:00:00.000Z',
    source: { modsUrl: 'https://example.com/mods.json', modCount: 1 },
    mods: [{ repo: 'owner/demo' }],
    skipped: [],
    ...overrides,
  };
}

test('indexBodyChanged：只有 generatedAt 变化不算内容变化', () => {
  const previous = indexFile();
  const next = indexFile({ generatedAt: '2026-11-07T03:00:00.000Z' });
  assert.equal(indexBodyChanged(previous, next), false);
});

test('indexBodyChanged：mods / source / skipped / formatVersion 变化都算变化', () => {
  const previous = indexFile();
  assert.equal(
    indexBodyChanged(previous, indexFile({ mods: [{ repo: 'owner/other' }] })),
    true,
  );
  assert.equal(
    indexBodyChanged(previous, indexFile({ source: { modsUrl: 'https://x', modCount: 2 } })),
    true,
  );
  assert.equal(
    indexBodyChanged(previous, indexFile({ skipped: [{ repo: 'owner/demo', reason: 'network' }] })),
    true,
  );
  assert.equal(indexBodyChanged(previous, indexFile({ formatVersion: 2 })), true);
  assert.equal(indexBodyChanged(null, previous), true);
});

test('releaseFileBodyChanged：忽略 generatedAt / 旧 source，只有 releases 变化才重写', () => {
  const previous = {
    formatVersion: 1,
    repo: 'owner/demo',
    generatedAt: '2026-11-06T03:00:00.000Z',
    source: { releasesEtag: 'W/"a"', releasesFetchedAt: '2026-11-06T03:00:00.000Z' },
    releases: [{ tag: 'v1' }],
  };
  const next = {
    formatVersion: 1,
    repo: 'owner/demo',
    generatedAt: '2026-11-07T03:00:00.000Z',
    releases: [{ tag: 'v1' }],
  };
  assert.equal(releaseFileBodyChanged(previous, next), false);
  assert.equal(
    releaseFileBodyChanged(previous, { ...next, releases: [{ tag: 'v2' }] }),
    true,
  );
  assert.equal(releaseFileBodyChanged(null, previous), true);
});
