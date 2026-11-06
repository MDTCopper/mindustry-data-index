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
  stockScores,
  maintenanceStatus,
  recommendationFor,
  heatIndexFields,
  heatSummaryFields,
  injectHeatIntoIndex,
  injectHeatIntoSummaryRows,
  normalizeByMax,
  activityScores,
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

test('newModMultiplier：180 天内 1+0.325*exp(-age/30)，之后 clamp 1', () => {
  assert.ok(Math.abs(newModMultiplier(0) - 1.325) < 1e-9);
  assert.ok(Math.abs(newModMultiplier(30) - 1.1195) < 0.001);
  assert.ok(Math.abs(newModMultiplier(60) - 1.0439) < 0.001);
  assert.ok(Math.abs(newModMultiplier(90) - 1.0162) < 0.001);
  assert.equal(newModMultiplier(180), 1);
  assert.equal(newModMultiplier(999), 1);
  assert.equal(newModMultiplier(null), 1);
  assert.ok(newModMultiplier(10) > newModMultiplier(40));
  assert.ok(newModMultiplier(40) > newModMultiplier(100));
  // 比 v1 更陡
  assert.ok(newModMultiplier(30) < 1.325 ** (1 - 30 / 180));
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

test('stockScores：占总量百分比为主、sqrt 柔化、极小占比自然接近 0（不硬抹除）', () => {
  const result = stockScores([1000, 250, 0, 0.00001]);
  const sum = result.shares.reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(Math.abs(result.shares[0] - 1000 / 1250.00001) < 1e-12);
  assert.equal(result.mags[0], 1);
  assert.ok(Math.abs(result.mags[1] - Math.sqrt(0.25)) < 1e-9);
  assert.equal(result.mags[2], 0);
  // 极小占比不再强制归 0：mag = sqrt(share/maxShare) 自然很小
  assert.ok(result.mags[3] > 0, '极小占比应保留非零值');
  assert.ok(result.mags[3] < 1e-3, `极小占比应自然接近 0：${result.mags[3]}`);
  assert.ok(result.scores[3] >= 0.2 * result.percentiles[3]);
  assert.equal(stockScores([0, 0]).total, 0);
});

test('maintenanceStatus：≤180 active、180~360 low、>360 stale（缺失活动用年龄兜底）', () => {
  assert.equal(maintenanceStatus({ daysSinceRelease: 0, daysSinceCommit: 0 }), 'active');
  assert.equal(maintenanceStatus({ daysSinceRelease: 180, daysSinceCommit: null }), 'active');
  assert.equal(maintenanceStatus({ daysSinceRelease: 181, daysSinceCommit: 300 }), 'low');
  assert.equal(maintenanceStatus({ daysSinceRelease: null, daysSinceCommit: 360 }), 'low');
  assert.equal(maintenanceStatus({ daysSinceRelease: 361, daysSinceCommit: null }), 'stale');
  assert.equal(maintenanceStatus({ daysSinceRelease: null, daysSinceCommit: null, ageDays: 100 }), 'active');
  assert.equal(maintenanceStatus({ daysSinceRelease: null, daysSinceCommit: null, ageDays: 500 }), 'stale');
  assert.equal(maintenanceStatus({ daysSinceRelease: null, daysSinceCommit: null }), 'stale');
});

test('recommendationFor：score<0 / stale 低活跃两种过滤原因；阈值可覆盖', () => {
  const active = { score: 0.5, totalDownloads: 100, totalStars: 10, maintenance: { status: 'active' } };
  assert.deepEqual(recommendationFor(active), { visible: true, reason: null });
  assert.deepEqual(recommendationFor({ ...active, score: -0.01 }), {
    visible: false,
    reason: 'score-below-min',
  });
  const staleLow = { score: 0.1, totalDownloads: 0, totalStars: 19, maintenance: { status: 'stale' } };
  assert.deepEqual(recommendationFor(staleLow), {
    visible: false,
    reason: 'stale-low-activity',
  });
  // 星标足够或还有下载的 stale 不被隐藏
  assert.equal(recommendationFor({ ...staleLow, totalStars: 20 }).visible, true);
  assert.equal(recommendationFor({ ...staleLow, totalDownloads: 5 }).visible, true);
  // 阈值可调
  assert.equal(recommendationFor(staleLow, { staleMaxStars: 10 }).visible, true);
  assert.deepEqual(
    recommendationFor({ ...active, score: 0.05 }, { minScore: 0.1 }),
    { visible: false, reason: 'score-below-min' },
  );
});

test('activityScores / normalizeByMax：log1p 递减收益 + 最大值归一', () => {
  const raw = activityScores([
    { 7: 1, 30: 1, 90: 1, 180: 1 },
    { 7: 100, 30: 100, 90: 100, 180: 100 },
    { 7: 0, 30: 0, 90: 0, 180: 0 },
  ]);
  assert.equal(raw[2], 0);
  assert.ok(raw[1] > raw[0]);
  // 100 次不是 1 次的 100 倍（递减收益）
  assert.ok(raw[1] < raw[0] * 10);
  const normalized = normalizeByMax(raw);
  assert.equal(normalized[1], 1);
  assert.ok(normalized[0] > 0 && normalized[0] < 1);
  assert.deepEqual(normalizeByMax([0, 0]), [0, 0]);
});

test('computeHeat：非 Java 且无下载数据 → downloadsMissing 并重归一权重；Java 不处理', () => {
  const mods = [
    {
      repo: 'nonjava/missing',
      namePlain: 'Missing',
      source: 'official',
      hasJava: false,
      totalDownloads: 0,
      totalStars: 300,
      downloadChanges: {},
      starChanges: { 1: 0, 7: 0, 30: 0, 180: 0 },
      releaseUpdates: {},
      commits: {},
      ageDays: 200,
      daysSinceRelease: 30,
      daysSinceCommit: 30,
    },
    {
      repo: 'java/zero',
      namePlain: 'JavaZero',
      source: 'official',
      hasJava: true,
      totalDownloads: 0,
      totalStars: 10,
      downloadChanges: {},
      starChanges: {},
      releaseUpdates: {},
      commits: {},
      ageDays: 200,
      daysSinceRelease: 30,
      daysSinceCommit: 30,
    },
    {
      repo: 'normal/mod',
      namePlain: 'Normal',
      source: 'official',
      hasJava: false,
      totalDownloads: 1000,
      totalStars: 20,
      downloadChanges: {},
      starChanges: {},
      releaseUpdates: {},
      commits: {},
      ageDays: 200,
      daysSinceRelease: 30,
      daysSinceCommit: 30,
    },
  ];
  const { entries } = computeHeat(mods);
  const byRepo = new Map(entries.map((entry) => [entry.repo, entry]));
  const missing = byRepo.get('nonjava/missing');
  const javaZero = byRepo.get('java/zero');
  const normal = byRepo.get('normal/mod');
  assert.equal(missing.downloadsMissing, true);
  assert.deepEqual(missing.effectiveWeights, {
    downloads: 0,
    stars: 0.5 / 0.6,
    update: 0.1 / 0.6,
  });
  const expected =
    (missing.starsScore * 0.5 + missing.updateScore * 0.1) / 0.6 - missing.penalty * 0.3;
  assert.ok(Math.abs(missing.score - expected) < 1e-9);
  assert.equal(javaZero.downloadsMissing, false);
  assert.deepEqual(javaZero.effectiveWeights, { downloads: 0.4, stars: 0.5, update: 0.1 });
  assert.equal(normal.downloadsMissing, false);
  assert.equal(entries[0].repo, 'nonjava/missing');
});

test('injectHeatIntoIndex / SummaryRows：热度合并进模组列表与总表', () => {
  const entry = {
    repo: 'owner/mod',
    score: 0.42,
    rank: 7,
    downloadsScore: 0.5,
    starsScore: 0.6,
    updateScore: 0.4,
    newModMultiplier: 1.1,
    penalty: 0.01,
    maintenance: { status: 'active', lastReleaseAt: null, lastCommitAt: null, daysSinceRelease: 1, daysSinceCommit: 1 },
    recommend: { visible: false, reason: 'stale-low-activity' },
    downloadChanges: { 1: 0, 7: 0, 30: 0, 180: 0 },
    starChanges: { 1: 0, 7: 0, 30: 0, 180: 0 },
    releaseUpdates: { 7: 1, 30: 1, 90: 1, 180: 1 },
    commits: { 7: 1, 30: 1, 90: 1, 180: 1 },
  };
  const heatByRepo = new Map([['owner/mod', entry]]);
  const index = injectHeatIntoIndex(
    { formatVersion: 1, mods: [{ repo: 'owner/mod', name: 'Mod' }] },
    heatByRepo,
  );
  assert.equal(index.mods[0].heat.score, 0.42);
  assert.equal(index.mods[0].heat.rank, 7);
  assert.equal(index.mods[0].heat.recommendVisible, false);
  assert.equal(index.mods[0].heat.recommendReason, 'stale-low-activity');
  assert.equal(index.mods[0].name, 'Mod');
  const rows = injectHeatIntoSummaryRows(
    [{ repo: 'owner/mod', totalDownloads: 3 }],
    heatByRepo,
  );
  assert.deepEqual(
    {
      heatScore: rows[0].heatScore,
      heatRank: rows[0].heatRank,
      maintenanceStatus: rows[0].maintenanceStatus,
      recommendVisible: rows[0].recommendVisible,
    },
    { heatScore: 0.42, heatRank: 7, maintenanceStatus: 'active', recommendVisible: false },
  );
  assert.equal(rows[0].totalDownloads, 3);
});

test('computeHeat：缺失窗口按 0；score 可负可 >1；rank 唯一且按分数降序', () => {
  const mods = [
    {
      repo: 'rich/mod',
      namePlain: 'Rich',
      source: 'official',
      totalDownloads: 1e9,
      totalStars: 1e6,
      hasJava: false,
      downloadChanges: { 1: 5000, 7: 5000, 30: 5000, 180: 5000 },
      starChanges: { 1: 100, 7: 100, 30: 100, 180: 100 },
      releaseUpdates: { 7: 1, 30: 1, 90: 1, 180: 1 },
      commits: { 7: 70, 30: 70, 90: 70, 180: 70 },
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
  assert.ok(Math.abs(entries[0].stockShare.downloads - 1) < 1e-9);
  assert.equal(entries[0].stockMag.downloads, 1);
  assert.equal(entries[0].releaseActivity, 1);
  assert.equal(entries[0].commitActivity, 1);
  assert.deepEqual(Object.keys(entries[0].releaseUpdates), ['7', '30', '90', '180']);
  assert.equal(entries[1].stockShare.downloads, 0);
  assert.equal(entries[1].stockMag.stars, 0);
  // task-18：maintenance / recommend / index heat 投影
  assert.equal(entries[0].maintenance.status, 'active');
  assert.equal(entries[0].recommend.visible, true);
  assert.equal(entries[1].maintenance.status, 'stale');
  assert.equal(entries[1].recommend.visible, false);
  assert.equal(entries[1].recommend.reason, 'score-below-min');
  const projected = heatIndexFields(entries[0]);
  assert.equal(projected.score, entries[0].score);
  assert.equal(projected.rank, 1);
  assert.equal(projected.recommendVisible, true);
  assert.equal(projected.maintenance.status, 'active');
  assert.deepEqual(heatSummaryFields(entries[0]), {
    heatScore: entries[0].score,
    heatRank: 1,
    maintenanceStatus: 'active',
    recommendVisible: true,
  });
});
