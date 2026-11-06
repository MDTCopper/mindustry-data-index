import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_LIMITS,
  buildSnapshot,
  commitWeekBounds,
  commitsInWindow,
  computeHeat,
  daysSinceLastCommit,
  findSnapshotAtOrBefore,
  formatDateKey,
  formatMonthKey,
  formatWeekKey,
  longInactivityPenalty,
  newModMultiplier,
  percentileRanks,
  releaseUpdatesInWindow,
  selectHistoryFiles,
  signedLog1p,
} from '../src/heat.js';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const DAY = 86_400_000;

test('signedLog1p：负变化对称压缩，0 仍为 0', () => {
  assert.equal(signedLog1p(0), 0);
  assert.equal(signedLog1p(9), Math.log(10));
  assert.equal(signedLog1p(-9), -Math.log(10));
  assert.equal(signedLog1p('x'), 0);
});

test('percentileRanks：0~1 百分位，极端值只占最高位不挤压其余', () => {
  assert.deepEqual(percentileRanks([1, 2, 3]), [0, 0.5, 1]);
  const ranks = percentileRanks([0, 1, 2, 1e12]);
  assert.equal(ranks[0], 0);
  assert.equal(ranks[3], 1);
  // 1 和 2 之间名次连续，不因 1e12 而被压到 0
  assert.ok(ranks[1] > 0 && ranks[1] < ranks[2]);
  assert.equal(percentileRanks([5])[0], 0.5);
  // 并列取平均名次
  assert.deepEqual(percentileRanks([1, 1, 2]), [0.25, 0.25, 1].map((value) => value));
});

test('newModMultiplier：180 天内 1.325→1 指数衰减，之后 clamp 1', () => {
  assert.equal(newModMultiplier(0), 1.325);
  assert.equal(newModMultiplier(180), 1);
  assert.equal(newModMultiplier(999), 1);
  assert.equal(newModMultiplier(null), 1);
  const mid = newModMultiplier(90);
  assert.ok(mid > 1 && mid < 1.325);
  assert.ok(newModMultiplier(30) > newModMultiplier(60));
  assert.ok(newModMultiplier(60) > newModMultiplier(120));
});

test('longInactivityPenalty：360 天内为 0，之后 1-exp(-overrun/180) 饱和合成 7:3', () => {
  assert.equal(longInactivityPenalty({ daysSinceRelease: 360, daysSinceCommit: 360 }), 0);
  assert.equal(longInactivityPenalty({ daysSinceRelease: 0, daysSinceCommit: 0 }), 0);
  const releaseOnly = longInactivityPenalty({ daysSinceRelease: 540, daysSinceCommit: 0 });
  assert.ok(Math.abs(releaseOnly - 0.7 * (1 - Math.exp(-1))) < 1e-9);
  const both = longInactivityPenalty({ daysSinceRelease: 540, daysSinceCommit: 540 });
  assert.ok(both > releaseOnly && both <= 1);
  // 饱和：更久只略微增加
  const later = longInactivityPenalty({ daysSinceRelease: 900, daysSinceCommit: 900 });
  assert.ok(later > both && later - both < 0.4);
});

test('findSnapshotAtOrBefore：取不晚于目标时间的最近快照', () => {
  const snapshots = [
    { generatedAt: '2026-11-01T00:00:00.000Z', mods: {} },
    { generatedAt: '2026-11-05T00:00:00.000Z', mods: {} },
    { generatedAt: '2026-11-06T00:00:00.000Z', mods: {} },
  ];
  assert.equal(
    findSnapshotAtOrBefore(snapshots, Date.parse('2026-11-05T12:00:00.000Z')).generatedAt,
    '2026-11-05T00:00:00.000Z',
  );
  assert.equal(findSnapshotAtOrBefore(snapshots, Date.parse('2026-10-01T00:00:00.000Z')), null);
  assert.equal(findSnapshotAtOrBefore([], NOW), null);
});

test('releaseUpdatesInWindow：只计窗口内、有 Release 且未删除的条目', () => {
  const releases = [
    { tag: 'v3', hasRelease: true, publishedAt: new Date(NOW - 2 * DAY).toISOString() },
    { tag: 'v2', hasRelease: true, publishedAt: new Date(NOW - 20 * DAY).toISOString() },
    { tag: 'v1', hasRelease: false, publishedAt: new Date(NOW - 2 * DAY).toISOString() },
    { tag: 'v0', hasRelease: true, publishedAt: new Date(NOW - 2 * DAY).toISOString(), removed: true },
  ];
  assert.equal(releaseUpdatesInWindow(releases, NOW, 7), 1);
  assert.equal(releaseUpdatesInWindow(releases, NOW, 30), 2);
  assert.equal(releaseUpdatesInWindow(releases, NOW, 180), 2);
});

test('commitsInWindow / daysSinceLastCommit：52 周数组按 fetchedAt 锚定并支持窗口', () => {
  const weeks = Array.from({ length: 52 }, () => 7);
  const fetchedAt = new Date(NOW).toISOString();
  assert.equal(commitWeekBounds(weeks, fetchedAt).length, 52);
  const seven = commitsInWindow(weeks, fetchedAt, NOW, 7);
  assert.ok(Math.abs(seven - 7) < 1e-6);
  assert.ok(Math.abs(commitsInWindow(weeks, fetchedAt, NOW, 1) - 1) < 1e-6);
  assert.equal(commitsInWindow(weeks, null, NOW, 7), 0);
  const none = Array.from({ length: 52 }, (_, index) => (index === 51 ? 0 : 3));
  const days = daysSinceLastCommit(none, fetchedAt, NOW);
  assert.ok(days > 6 && days < 8);
  assert.equal(daysSinceLastCommit(Array(52).fill(0), fetchedAt, NOW), null);
});

test('selectHistoryFiles：按时间倒序保留 7/6/6 份并列出待删除', () => {
  const daily = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'];
  const selected = selectHistoryFiles(daily, 'daily');
  assert.equal(selected.keep.length, HISTORY_LIMITS.daily);
  assert.equal(selected.keep[0], '2026-10-10');
  assert.deepEqual(selected.remove, ['2026-10-03', '2026-10-02', '2026-10-01']);
  assert.equal(selectHistoryFiles(['2026-10'], 'monthly').keep.length, 1);
});

test('buildSnapshot / 日期 key：格式稳定', () => {
  const snapshot = buildSnapshot(
    [
      { repo: 'b/two', totalStars: 2, totalDownloads: 20 },
      { repo: 'a/one', totalStars: 1, totalDownloads: 10 },
    ],
    '2026-11-06T12:00:00.000Z',
  );
  assert.deepEqual(Object.keys(snapshot.mods), ['a/one', 'b/two']);
  assert.deepEqual(snapshot.mods['a/one'], { stars: 1, totalDownloads: 10 });
  assert.equal(snapshot.formatVersion, 1);
  const date = new Date('2026-11-06T12:00:00.000Z');
  assert.equal(formatDateKey(date), '2026-11-06');
  assert.equal(formatMonthKey(date), '2026-11');
  assert.match(formatWeekKey(date), /^2026-W\d{2}$/);
});

test('computeHeat：缺失窗口按 0；score 可负可 >1；rank 唯一且按分数降序', () => {
  const mods = [
    {
      repo: 'rich/mod',
      namePlain: 'Rich',
      source: 'official',
      totalDownloads: 1e9,
      totalStars: 1e6,
      downloadChanges: { 1: 5000, 7: 5000, 30: 5000, 180: 5000 },
      starChanges: { 1: 100, 7: 100, 30: 100, 180: 100 },
      releaseUpdates: { 1: 1, 7: 1, 30: 1, 180: 1 },
      commits: { 1: 7, 7: 7, 30: 7, 180: 7 },
      ageDays: 10,
      daysSinceRelease: 1,
      daysSinceCommit: 1,
    },
    {
      repo: 'dead/mod',
      namePlain: 'Dead',
      source: 'official',
      totalDownloads: 0,
      totalStars: 0,
      downloadChanges: {},
      starChanges: {},
      releaseUpdates: {},
      commits: {},
      ageDays: 1000,
      daysSinceRelease: 1500,
      daysSinceCommit: 1500,
    },
  ];
  const { entries } = computeHeat(mods);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.rank), [1, 2]);
  assert.equal(entries[0].repo, 'rich/mod');
  assert.ok(entries[0].score > 1, `score 可 >1：${entries[0].score}`);
  assert.ok(entries[1].score < 0, `score 可 <0：${entries[1].score}`);
  assert.ok(entries.every((entry) => Number.isFinite(entry.score)));
  assert.deepEqual(entries[0].downloadChanges, { 1: 5000, 7: 5000, 30: 5000, 180: 5000 });
  assert.deepEqual(entries[1].downloadChanges, { 1: 0, 7: 0, 30: 0, 180: 0 });
});
