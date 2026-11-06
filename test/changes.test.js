import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CHANGES,
  diffModEntry,
  diffReleaseFiles,
  mergeChanges,
  normalizeChanges,
} from '../src/changes.js';

const AT = '2026-11-06T03:00:00.000Z';

function entry(tag, extra = {}) {
  return {
    tag,
    name: tag,
    hasRelease: extra.hasRelease ?? true,
    prerelease: false,
    publishedAt: '2026-10-01T00:00:00Z',
    modVersion: extra.modVersion ?? tag.replace(/^v/, ''),
    minGameVersion: '146',
    assets: [],
    ...extra,
  };
}

test('diffModEntry：新增 / 关键字段变化 / 无变化', () => {
  const current = {
    repo: 'a/one',
    name: 'One',
    version: '1.0',
    minGameVersion: '146',
    hasJava: false,
    hasScripts: false,
    latestRelease: { tag: 'v1' },
  };
  assert.deepEqual(
    diffModEntry({ dataset: 'official', repo: 'a/one', previousEntry: null, currentEntry: current, at: AT }),
    [{ at: AT, dataset: 'official', repo: 'a/one', action: 'mod-added' }],
  );
  assert.deepEqual(
    diffModEntry({
      dataset: 'official',
      repo: 'a/one',
      previousEntry: { ...current, version: '0.9' },
      currentEntry: current,
      at: AT,
    }),
    [{ at: AT, dataset: 'official', repo: 'a/one', action: 'mod-updated' }],
  );
  // stars 不参与（高频字段不刷屏）
  assert.deepEqual(
    diffModEntry({
      dataset: 'official',
      repo: 'a/one',
      previousEntry: { ...current, stars: 1 },
      currentEntry: { ...current, stars: 99 },
      at: AT,
    }),
    [],
  );
});

test('diffReleaseFiles：release-added / tag-removed / release-removed / 恢复', () => {
  const previousFile = {
    releases: [
      entry('v1'),
      entry('v2'),
      entry('v3'),
      entry('v4'),
    ],
  };
  const currentFile = {
    releases: [
      entry('v1'),
      entry('v2', { hasRelease: false }),
      entry('v3', { removed: true, removedAt: AT }),
      entry('v4', { removed: true, removedAt: AT }),
      entry('v5'),
    ],
  };
  const changes = diffReleaseFiles({
    dataset: 'official',
    repo: 'a/one',
    previousFile,
    currentFile,
    at: AT,
  });
  const actions = changes.map((change) => `${change.tag}:${change.action}`);
  assert.ok(actions.includes('v5:release-added'));
  // tag 还在但 Release 被删除 → release-removed
  assert.ok(actions.includes('v2:release-removed'));
  assert.ok(actions.includes('v3:release-removed'));
  assert.ok(actions.includes('v4:release-removed'));
  assert.equal(changes.length, 4);

  // 纯 tag-only 条目被删除 → tag-removed
  const tagOnlyRemoved = diffReleaseFiles({
    dataset: 'official',
    repo: 'a/one',
    previousFile: { releases: [entry('v9', { hasRelease: false })] },
    currentFile: { releases: [entry('v9', { hasRelease: false, removed: true, removedAt: AT })] },
    at: AT,
  });
  assert.deepEqual(tagOnlyRemoved, [
    { at: AT, dataset: 'official', repo: 'a/one', action: 'tag-removed', tag: 'v9', version: '9' },
  ]);

  // 恢复（removed → 正常 release）记 release-added
  const restored = diffReleaseFiles({
    dataset: 'community',
    repo: 'a/one',
    previousFile: { releases: [entry('v1', { removed: true, removedAt: AT })] },
    currentFile: { releases: [entry('v1')] },
    at: AT,
  });
  assert.deepEqual(restored, [
    {
      at: AT,
      dataset: 'community',
      repo: 'a/one',
      action: 'release-added',
      tag: 'v1',
      version: '1',
    },
  ]);
});

test('diffReleaseFiles：首次快照 / 无旧文件时不产生 release 变更', () => {
  const currentFile = { releases: [entry('v1')] };
  assert.deepEqual(
    diffReleaseFiles({
      dataset: 'official',
      repo: 'a/one',
      previousFile: null,
      currentFile,
      at: AT,
    }),
    [],
  );
  assert.deepEqual(
    diffReleaseFiles({
      dataset: 'official',
      repo: 'a/one',
      previousFile: { releases: [] },
      currentFile,
      at: AT,
      initialSnapshot: true,
    }),
    [],
  );
});

test('mergeChanges / normalizeChanges：新变更在前并滚动截断到 500', () => {
  const previous = Array.from({ length: 3 }, (_, index) => ({
    at: AT,
    dataset: 'official',
    repo: `old/${index}`,
    action: 'mod-added',
  }));
  const fresh = [{ at: AT, dataset: 'community', repo: 'new/one', action: 'release-added', tag: 'v1' }];
  const merged = mergeChanges(fresh, previous);
  assert.equal(merged[0].repo, 'new/one');
  assert.equal(merged.length, 4);

  const many = Array.from({ length: MAX_CHANGES + 20 }, (_, index) => ({
    at: AT,
    dataset: 'official',
    repo: `x/${index}`,
    action: 'mod-added',
  }));
  assert.equal(mergeChanges(many, previous).length, MAX_CHANGES);
  assert.equal(normalizeChanges(['bad', null, { foo: 1 }]).length, 0);
});
