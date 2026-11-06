import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_INTERVAL_MS,
  PAGE1_INTERVAL_MS,
  PAGE2_INTERVAL_MS,
  REFRESH_STATE_REL_PATH,
  REFRESH_TIERS,
  bootstrapModState,
  buildRefreshStateFile,
  cloneModState,
  isFullDue,
  isPage1Due,
  isPage2Due,
  isPageDue,
  isTagsDue,
  lastRefreshedAt,
  normalizeRefreshState,
  pageRefreshIntervalMs,
  stateBodyChanged,
} from '../src/refresh-state.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-06T12:00:00Z');

test('刷新分档：第 1 页 2 小时、第 2 页每周、全量每月', () => {
  assert.equal(REFRESH_STATE_REL_PATH, 'state/refresh.json');
  assert.equal(PAGE1_INTERVAL_MS, 2 * HOUR);
  assert.equal(PAGE2_INTERVAL_MS, 7 * DAY);
  assert.equal(FULL_INTERVAL_MS, 30 * DAY);
  assert.deepEqual(
    REFRESH_TIERS.map((tier) => tier.label),
    ['2h', 'week', 'month'],
  );
  assert.equal(pageRefreshIntervalMs(1), PAGE1_INTERVAL_MS);
  assert.equal(pageRefreshIntervalMs(2), PAGE2_INTERVAL_MS);
  assert.equal(pageRefreshIntervalMs(3), FULL_INTERVAL_MS);
  assert.equal(pageRefreshIntervalMs('full'), FULL_INTERVAL_MS);
});

test('到期判断：2h / 7d / 30d 边界，now 可注入', () => {
  const at = (msAgo) => new Date(NOW - msAgo).toISOString();
  assert.equal(isPage1Due(at(2 * HOUR - 1), NOW), false);
  assert.equal(isPage1Due(at(2 * HOUR), NOW), true);
  assert.equal(isPage2Due(at(7 * DAY - 1), NOW), false);
  assert.equal(isPage2Due(at(7 * DAY), NOW), true);
  assert.equal(isFullDue(at(30 * DAY - 1), NOW), false);
  assert.equal(isFullDue(at(30 * DAY), NOW), true);
  assert.equal(isPage1Due(null, NOW), true);
  assert.equal(isPage2Due(undefined, NOW), true);
  assert.equal(isFullDue('bad', NOW), true);
  // 通用 isPageDue：>=3 页按全量间隔
  assert.equal(isPageDue(at(DAY), 3, NOW), false);
  assert.equal(isPageDue(at(30 * DAY), 3, NOW), true);
  // tag 列表跟随 2 小时 tier
  assert.equal(isTagsDue(at(2 * HOUR - 1), NOW), false);
  assert.equal(isTagsDue(at(2 * HOUR), NOW), true);
});

test('normalizeRefreshState：旧 pages 格式迁移到 page2/full 字段', () => {
  const state = normalizeRefreshState({
    formatVersion: 1,
    updatedAt: '2026-11-06T03:00:00.000Z',
    mods: {
      'owner/demo': {
        page1Etag: 'W/"a"',
        page1FetchedAt: '2026-11-06T03:00:00.000Z',
        pages: { 2: '2026-11-05T03:00:00.000Z', 3: '2026-11-01T03:00:00.000Z' },
        tagsFetchedAt: '2026-11-06T04:00:00.000Z',
      },
      'owner/small': {
        page1Etag: null,
        page1FetchedAt: '2026-11-06T02:00:00.000Z',
        pages: {},
      },
    },
  });
  assert.deepEqual(state.mods['owner/demo'], {
    page1Etag: 'W/"a"',
    page1FetchedAt: '2026-11-06T03:00:00.000Z',
    page2FetchedAt: '2026-11-05T03:00:00.000Z',
    fullFetchedAt: '2026-11-01T03:00:00.000Z',
    tagsFetchedAt: '2026-11-06T04:00:00.000Z',
  });
  // 没有深层页时 full 回落到 page1 时间
  assert.equal(state.mods['owner/small'].page2FetchedAt, null);
  assert.equal(state.mods['owner/small'].fullFetchedAt, '2026-11-06T02:00:00.000Z');
  assert.deepEqual(normalizeRefreshState(null).mods, {});
});

test('normalizeRefreshState：新格式原样保留、忽略旧 pages', () => {
  const state = normalizeRefreshState({
    mods: {
      'owner/demo': {
        page1Etag: 'W/"b"',
        page1FetchedAt: '2026-11-06T10:00:00.000Z',
        page2FetchedAt: '2026-11-01T10:00:00.000Z',
        fullFetchedAt: '2026-10-10T10:00:00.000Z',
        tagsFetchedAt: '2026-11-06T10:00:00.000Z',
        pages: { 2: '2000-01-01T00:00:00.000Z' },
      },
    },
  });
  assert.deepEqual(state.mods['owner/demo'], {
    page1Etag: 'W/"b"',
    page1FetchedAt: '2026-11-06T10:00:00.000Z',
    page2FetchedAt: '2026-11-01T10:00:00.000Z',
    fullFetchedAt: '2026-10-10T10:00:00.000Z',
    tagsFetchedAt: '2026-11-06T10:00:00.000Z',
  });
});

test('bootstrapModState：旧文件迁移出 page1/page2/full 时间，避免立刻重抓', () => {
  const fetchedAt = '2026-11-06T03:00:00.000Z';
  const state = bootstrapModState({
    legacySource: { releasesEtag: 'W/"old"', releasesFetchedAt: fetchedAt },
    releaseCount: 250,
    fallbackFetchedAt: '2026-11-05T00:00:00.000Z',
  });
  assert.deepEqual(state, {
    page1Etag: 'W/"old"',
    page1FetchedAt: fetchedAt,
    page2FetchedAt: fetchedAt,
    fullFetchedAt: fetchedAt,
    tagsFetchedAt: null,
  });
  const empty = bootstrapModState({ releaseCount: 0 });
  assert.equal(empty.page1FetchedAt, null);
  assert.equal(empty.page2FetchedAt, null);
  assert.equal(empty.fullFetchedAt, null);
});

test('lastRefreshedAt：取最近一次刷新时间；无记录为 0（排最前）', () => {
  assert.equal(
    lastRefreshedAt({
      page1FetchedAt: '2026-11-06T10:00:00.000Z',
      page2FetchedAt: '2026-11-01T10:00:00.000Z',
      fullFetchedAt: '2026-10-10T10:00:00.000Z',
      tagsFetchedAt: '2026-11-06T10:00:00.000Z',
    }),
    Date.parse('2026-11-06T10:00:00.000Z'),
  );
  assert.equal(lastRefreshedAt(null), 0);
  assert.equal(lastRefreshedAt({ page1FetchedAt: null }), 0);
});

test('stateBodyChanged / buildRefreshStateFile / cloneModState', () => {
  const mods = {
    'owner/demo': {
      page1Etag: 'W/"a"',
      page1FetchedAt: null,
      page2FetchedAt: null,
      fullFetchedAt: null,
      tagsFetchedAt: null,
    },
  };
  const file = buildRefreshStateFile({ mods, updatedAt: '2026-11-06T03:00:00.000Z' });
  assert.equal(file.formatVersion, 1);
  const same = buildRefreshStateFile({ mods, updatedAt: '2026-11-07T03:00:00.000Z' });
  assert.equal(stateBodyChanged(file, same), false);
  assert.equal(
    stateBodyChanged(file, buildRefreshStateFile({ mods: {}, updatedAt: file.updatedAt })),
    true,
  );
  const changed = buildRefreshStateFile({
    mods: {
      'owner/demo': { ...mods['owner/demo'], tagsFetchedAt: '2026-11-06T10:00:00.000Z' },
    },
    updatedAt: file.updatedAt,
  });
  assert.equal(stateBodyChanged(file, changed), true);

  const clone = cloneModState(mods['owner/demo']);
  clone.page2FetchedAt = '2026-11-06T03:00:00.000Z';
  assert.equal(mods['owner/demo'].page2FetchedAt, null);
});
