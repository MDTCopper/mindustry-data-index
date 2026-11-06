import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFRESH_STATE_REL_PATH,
  REFRESH_TIERS,
  TAGS_REFRESH_INTERVAL_MS,
  bootstrapModState,
  buildRefreshStateFile,
  cloneModState,
  isPageDue,
  isTagsDue,
  normalizeRefreshState,
  pageRefreshIntervalMs,
  stateBodyChanged,
} from '../src/refresh-state.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-06T12:00:00Z');

test('分档常量与每页间隔：1/7/30/90 天', () => {
  assert.equal(REFRESH_STATE_REL_PATH, 'state/refresh.json');
  assert.equal(pageRefreshIntervalMs(1), 1 * DAY);
  assert.equal(pageRefreshIntervalMs(2), 7 * DAY);
  assert.equal(pageRefreshIntervalMs(3), 30 * DAY);
  assert.equal(pageRefreshIntervalMs(4), 90 * DAY);
  assert.equal(pageRefreshIntervalMs(99), 90 * DAY);
  assert.deepEqual(
    REFRESH_TIERS.map((tier) => tier.fromPage),
    [1, 2, 3, 4],
  );
});

test('isPageDue：24h/7d/30d/90d 边界与缺失时间', () => {
  const at = (msAgo) => new Date(NOW - msAgo).toISOString();
  assert.equal(isPageDue(null, 1, NOW), true);
  assert.equal(isPageDue(at(DAY - 1), 1, NOW), false);
  assert.equal(isPageDue(at(DAY), 1, NOW), true);
  assert.equal(isPageDue(at(7 * DAY - 1), 2, NOW), false);
  assert.equal(isPageDue(at(7 * DAY), 2, NOW), true);
  assert.equal(isPageDue(at(30 * DAY - 1), 3, NOW), false);
  assert.equal(isPageDue(at(30 * DAY), 3, NOW), true);
  assert.equal(isPageDue(at(90 * DAY - 1), 4, NOW), false);
  assert.equal(isPageDue(at(90 * DAY), 4, NOW), true);
  assert.equal(isPageDue('not-a-date', 2, NOW), true);
});

test('normalizeRefreshState：清洗形状、保留合法深层页', () => {
  const state = normalizeRefreshState({
    formatVersion: 1,
    updatedAt: '2026-11-06T03:00:00.000Z',
    mods: {
      'owner/demo': {
        page1Etag: 'W/"a"',
        page1FetchedAt: '2026-11-06T03:00:00.000Z',
        pages: { 2: '2026-11-01T03:00:00.000Z', bad: 'x', 1: 'x' },
      },
    },
  });
  assert.equal(state.mods['owner/demo'].page1Etag, 'W/"a"');
  assert.deepEqual(state.mods['owner/demo'].pages, {
    2: '2026-11-01T03:00:00.000Z',
  });
  assert.deepEqual(normalizeRefreshState(null).mods, {});
});

test('bootstrapModState：旧 source 迁移成第 1 页缓存，深层页按 release 数量推断', () => {
  const state = bootstrapModState({
    legacySource: {
      releasesEtag: 'W/"old"',
      releasesFetchedAt: '2026-11-06T03:00:00.000Z',
    },
    releaseCount: 250,
    fallbackFetchedAt: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(state.page1Etag, 'W/"old"');
  assert.equal(state.page1FetchedAt, '2026-11-06T03:00:00.000Z');
  assert.deepEqual(state.pages, {
    2: '2026-11-06T03:00:00.000Z',
    3: '2026-11-06T03:00:00.000Z',
  });
  const empty = bootstrapModState({ releaseCount: 0 });
  assert.equal(empty.page1Etag, null);
  assert.deepEqual(empty.pages, {});
});

test('stateBodyChanged / buildRefreshStateFile / cloneModState', () => {
  const mods = { 'owner/demo': { page1Etag: 'W/"a"', page1FetchedAt: null, pages: {} } };
  const file = buildRefreshStateFile({ mods, updatedAt: '2026-11-06T03:00:00.000Z' });
  assert.equal(file.formatVersion, 1);
  assert.equal(file.updatedAt, '2026-11-06T03:00:00.000Z');

  const same = buildRefreshStateFile({ mods, updatedAt: '2026-11-07T03:00:00.000Z' });
  assert.equal(stateBodyChanged(file, same), false);
  assert.equal(
    stateBodyChanged(file, buildRefreshStateFile({ mods: {}, updatedAt: file.updatedAt })),
    true,
  );

  const clone = cloneModState(mods['owner/demo']);
  clone.pages['2'] = '2026-11-06T03:00:00.000Z';
  assert.deepEqual(mods['owner/demo'].pages, {});
});

test('isTagsDue：tag 列表 24 小时刷新一次，缺失/非法时间视为到期', () => {
  assert.equal(TAGS_REFRESH_INTERVAL_MS, DAY);
  const at = (msAgo) => new Date(NOW - msAgo).toISOString();
  assert.equal(isTagsDue(null, NOW), true);
  assert.equal(isTagsDue(undefined, NOW), true);
  assert.equal(isTagsDue('bad', NOW), true);
  assert.equal(isTagsDue(at(DAY - 1), NOW), false);
  assert.equal(isTagsDue(at(DAY), NOW), true);
});

test('state 保存 tagsFetchedAt；normalize/clone 兼容缺字段', () => {
  const state = normalizeRefreshState({
    formatVersion: 1,
    updatedAt: '2026-11-06T03:00:00.000Z',
    mods: {
      'owner/demo': {
        page1Etag: 'W/"a"',
        page1FetchedAt: '2026-11-06T03:00:00.000Z',
        pages: {},
        tagsFetchedAt: '2026-11-06T04:00:00.000Z',
      },
      'owner/old': { page1Etag: null, page1FetchedAt: null, pages: {} },
    },
  });
  assert.equal(
    state.mods['owner/demo'].tagsFetchedAt,
    '2026-11-06T04:00:00.000Z',
  );
  assert.equal(state.mods['owner/old'].tagsFetchedAt, null);
  assert.equal(
    cloneModState(state.mods['owner/demo']).tagsFetchedAt,
    '2026-11-06T04:00:00.000Z',
  );
  const changed = buildRefreshStateFile({
    mods: {
      'owner/demo': {
        ...state.mods['owner/demo'],
        tagsFetchedAt: '2026-11-07T04:00:00.000Z',
      },
    },
    updatedAt: '2026-11-07T00:00:00.000Z',
  });
  assert.equal(
    stateBodyChanged(
      buildRefreshStateFile({
        mods: { 'owner/demo': state.mods['owner/demo'] },
        updatedAt: '2026-11-06T00:00:00.000Z',
      }),
      changed,
    ),
    true,
  );
});
