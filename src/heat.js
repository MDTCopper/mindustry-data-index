// 热度表核心计算（纯函数，便于单测）
//
// v2：存量指标用「占全量百分比 + sqrt 柔化 + 少量百分位」；变化量/活动量仍用百分位/log1p，
// 窗口全 0 记 0；release/提交活动改为更长窗口 + log1p 递减收益后按最大值归一化；新 mod 倍率更陡。

export const HEAT_FORMAT_VERSION = 1;
export const HEAT_WINDOWS = [1, 7, 30, 180];
export const UPDATE_WINDOWS = [7, 30, 90, 180];
export const DOWNLOAD_WINDOW_WEIGHTS = { 1: 0.45, 7: 0.3, 30: 0.2, 180: 0.05 };
export const STAR_WINDOW_WEIGHTS = { 1: 0.2, 7: 0.45, 30: 0.3, 180: 0.05 };
export const UPDATE_WINDOW_WEIGHTS = { 7: 0.15, 30: 0.35, 90: 0.25, 180: 0.25 };
export const TOTAL_WEIGHT = 0.6;
export const CHANGE_WEIGHT = 0.4;
export const STOCK_MAG_WEIGHT = 0.8;
export const STOCK_PERCENTILE_WEIGHT = 0.2;
export const STOCK_DROP_RATIO = 1e-4;
export const COMPONENT_WEIGHTS = { downloads: 0.4, stars: 0.5, update: 0.1 };
export const NEW_MOD_DAYS = 180;
export const NEW_MOD_MAX_MULTIPLIER = 1.325;
export const NEW_MOD_DECAY_DAYS = 30;
export const PENALTY_START_DAYS = 360;
export const PENALTY_SATURATION_DAYS = 180;
export const PENALTY_WEIGHT = 0.3;
export const HISTORY_LIMITS = { daily: 7, weekly: 6, monthly: 6 };
export const HEAT_INDEX_REL_PATH = 'heat/index.json';
export const HEAT_SUMMARY_REL_PATH = 'heat/summary.csv';
export const HEAT_HISTORY_DIR = 'heat/history';
export const HEAT_COMMIT_STATE_REL_PATH = 'state/heat-commit-stats.json';
export const HEAT_CREATED_STATE_REL_PATH = 'state/repo-created.json';

export function signedLog1p(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.sign(number) * Math.log1p(Math.abs(number));
}

// 百分位排名 0~1：升序排位（并列取平均名次），n=1 时返回 0.5 避免极端挤压
export function percentileRanks(values) {
  const numbers = values.map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0));
  const count = numbers.length;
  const ranks = new Array(count).fill(0);
  if (count === 0) {
    return ranks;
  }
  if (count === 1) {
    ranks[0] = 0.5;
    return ranks;
  }
  const order = numbers
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  let position = 0;
  while (position < order.length) {
    let end = position;
    while (end + 1 < order.length && order[end + 1].value === order[position].value) {
      end += 1;
    }
    const averageRank = (position + end) / 2;
    for (let index = position; index <= end; index += 1) {
      ranks[order[index].index] = averageRank / (count - 1);
    }
    position = end + 1;
  }
  return ranks;
}

export function weightedChange(percentiles, weights) {
  let sum = 0;
  for (const window of HEAT_WINDOWS) {
    const weight = weights[window] ?? 0;
    sum += weight * (percentiles[window] ?? 0);
  }
  return sum;
}

// v2 新 mod 倍率：180 天内 1 + 0.325 * exp(-age/30)，30d≈1.12、60d≈1.04、90d≈1.016，之后 clamp 1
export function newModMultiplier(ageDays) {
  if (ageDays === null || ageDays === undefined || !Number.isFinite(Number(ageDays))) {
    return 1;
  }
  const age = Number(ageDays);
  if (age >= NEW_MOD_DAYS) {
    return 1;
  }
  const effectiveAge = Math.max(0, age);
  return 1 + (NEW_MOD_MAX_MULTIPLIER - 1) * Math.exp(-effectiveAge / NEW_MOD_DECAY_DAYS);
}

// 存量分数：占全量百分比为主 + sqrt 柔化 + 少量百分位；占比小到可忽略直接抹除
export function stockScores(values) {
  const numbers = values.map((value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0));
  const total = numbers.reduce((sum, value) => sum + value, 0);
  const shares = numbers.map((value) => (total > 0 ? value / total : 0));
  const maxShare = shares.reduce((max, value) => (value > max ? value : max), 0);
  const percentiles = percentileRanks(numbers.map((value) => Math.log1p(value)));
  const mags = shares.map((share) => {
    if (maxShare <= 0 || share < maxShare * STOCK_DROP_RATIO) {
      return 0;
    }
    return Math.sqrt(Math.min(1, share / maxShare));
  });
  const scores = mags.map(
    (mag, index) =>
      STOCK_MAG_WEIGHT * mag + STOCK_PERCENTILE_WEIGHT * percentiles[index],
  );
  return { total, shares, maxShare, mags, percentiles, scores };
}

export function normalizeByMax(values) {
  const numbers = values.map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0));
  const max = numbers.reduce((current, value) => (value > current ? value : current), 0);
  return numbers.map((value) => (max > 0 ? value / max : 0));
}

// 活动量：Σ 窗口权重 × log1p(窗口计数) → 按全量最大值归一化（递减收益）
export function activityScores(countsByWindow) {
  return countsByWindow.map((counts) => {
    let raw = 0;
    for (const window of UPDATE_WINDOWS) {
      raw += (UPDATE_WINDOW_WEIGHTS[window] ?? 0) * Math.log1p(Math.max(0, counts[window] ?? 0));
    }
    return raw;
  });
}

// 长期未更新惩罚（0~1）：超 360 天的 release / 提交各自 1-exp(-overrun/180) 饱和，7:3 合成
export function longInactivityPenalty({ daysSinceRelease = null, daysSinceCommit = null } = {}) {
  const overrunRelease = Math.max(0, (daysSinceRelease ?? 0) - PENALTY_START_DAYS);
  const overrunCommit = Math.max(0, (daysSinceCommit ?? 0) - PENALTY_START_DAYS);
  const releasePart = overrunRelease > 0 ? 1 - Math.exp(-overrunRelease / PENALTY_SATURATION_DAYS) : 0;
  const commitPart = overrunCommit > 0 ? 1 - Math.exp(-overrunCommit / PENALTY_SATURATION_DAYS) : 0;
  return releasePart * 0.7 + commitPart * 0.3;
}

export function parseTime(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function daysBetween(fromMs, toMs) {
  if (fromMs === null || fromMs === undefined) {
    return null;
  }
  return (toMs - fromMs) / 86_400_000;
}

// 最近一个不晚于目标时间的快照（严格不晚于 target）
export function findSnapshotAtOrBefore(snapshots, targetMs) {
  let found = null;
  for (const snapshot of snapshots) {
    const takenAt = parseTime(snapshot.generatedAt);
    if (takenAt === null || takenAt > targetMs) {
      continue;
    }
    if (!found || takenAt > parseTime(found.generatedAt)) {
      found = snapshot;
    }
  }
  return found;
}

export function snapshotValue(snapshot, repo, field) {
  const value = snapshot?.mods?.[repo]?.[field];
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

// 最近若干天的 release 更新数（有 Release、未被删除、publishedAt 在窗口内）
export function releaseUpdatesInWindow(releases, nowMs, days) {
  const since = nowMs - days * 86_400_000;
  let count = 0;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.hasRelease === false || release.removed === true) {
      continue;
    }
    const published = parseTime(release.publishedAt);
    if (published !== null && published > since && published <= nowMs) {
      count += 1;
    }
  }
  return count;
}

// participation 返回 52 周（最旧→最新）；锚定最后一周结束于缓存 fetchedAt，按重叠比例统计窗口
export function commitWeekBounds(weeks, fetchedAt) {
  if (!Array.isArray(weeks) || weeks.length === 0) {
    return [];
  }
  const anchor = parseTime(fetchedAt);
  if (anchor === null) {
    return [];
  }
  const span = 7 * 86_400_000;
  const bounds = [];
  for (let index = 0; index < weeks.length; index += 1) {
    const end = anchor - (weeks.length - 1 - index) * span;
    bounds.push({
      start: end - span,
      end,
      count: Number.isFinite(Number(weeks[index])) ? Number(weeks[index]) : 0,
    });
  }
  return bounds;
}

export function commitsInWindow(weeks, fetchedAt, nowMs, days) {
  const since = nowMs - days * 86_400_000;
  const span = 7 * 86_400_000;
  let total = 0;
  for (const week of commitWeekBounds(weeks, fetchedAt)) {
    const start = Math.max(week.start, since);
    const end = Math.min(week.end, nowMs);
    const overlap = Math.max(0, end - start);
    if (overlap > 0) {
      total += (week.count * overlap) / span;
    }
  }
  return total;
}

// 最近一次有提交的周结束时间转成“多少天前”
export function daysSinceLastCommit(weeks, fetchedAt, nowMs) {
  const validWeeks = commitWeekBounds(weeks, fetchedAt).filter((week) => week.count > 0);
  if (validWeeks.length === 0) {
    return null;
  }
  const lastEnd = Math.max(...validWeeks.map((week) => week.end));
  return (nowMs - lastEnd) / 86_400_000;
}

export function latestReleasePublishedAt(releases) {
  let latest = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.hasRelease === false || release.removed === true) {
      continue;
    }
    const published = parseTime(release.publishedAt);
    if (published !== null && (latest === null || published > latest)) {
      latest = published;
    }
  }
  return latest;
}

export function earliestReleasePublishedAt(releases) {
  let earliest = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.hasRelease === false) {
      continue;
    }
    const published = parseTime(release.publishedAt);
    if (published !== null && (earliest === null || published < earliest)) {
      earliest = published;
    }
  }
  return earliest;
}

function windowPercentile(values, rawValues) {
  if (rawValues.every((value) => value === 0)) {
    return values.map(() => 0);
  }
  return percentileRanks(values);
}

// v2 归一化 + 组件 + 总分/排名
// mods: [{repo, namePlain, source, totalDownloads, totalStars, downloadChanges, starChanges,
//         releaseUpdates(7/30/90/180), commits(7/30/90/180), ageDays, daysSinceRelease, daysSinceCommit}]
export function computeHeat(mods) {
  const count = mods.length;
  const downloadStock = stockScores(mods.map((mod) => mod.totalDownloads));
  const starStock = stockScores(mods.map((mod) => mod.totalStars));

  const downloadPercentiles = {};
  const starPercentiles = {};
  for (const window of HEAT_WINDOWS) {
    const downloadRaw = mods.map((mod) => mod.downloadChanges?.[window] ?? 0);
    downloadPercentiles[window] = windowPercentile(
      downloadRaw.map((value) => signedLog1p(value)),
      downloadRaw,
    );
    const starRaw = mods.map((mod) => mod.starChanges?.[window] ?? 0);
    starPercentiles[window] = windowPercentile(
      starRaw.map((value) => signedLog1p(value)),
      starRaw,
    );
  }

  const releaseRaw = activityScores(mods.map((mod) => mod.releaseUpdates ?? {}));
  const commitRaw = activityScores(mods.map((mod) => mod.commits ?? {}));
  const releaseActivity = normalizeByMax(releaseRaw);
  const commitActivity = normalizeByMax(commitRaw);

  const entries = mods.map((mod, index) => {
    const downloadChangeScore = weightedChange(
      Object.fromEntries(
        HEAT_WINDOWS.map((window) => [window, downloadPercentiles[window][index]]),
      ),
      DOWNLOAD_WINDOW_WEIGHTS,
    );
    const starChangeScore = weightedChange(
      Object.fromEntries(
        HEAT_WINDOWS.map((window) => [window, starPercentiles[window][index]]),
      ),
      STAR_WINDOW_WEIGHTS,
    );
    const downloadsScore =
      TOTAL_WEIGHT * downloadStock.scores[index] + CHANGE_WEIGHT * downloadChangeScore;
    const starsScore =
      TOTAL_WEIGHT * starStock.scores[index] + CHANGE_WEIGHT * starChangeScore;
    const updateScore = 0.7 * releaseActivity[index] + 0.3 * commitActivity[index];
    const multiplier = newModMultiplier(mod.ageDays);
    const penalty = longInactivityPenalty({
      daysSinceRelease: mod.daysSinceRelease ?? null,
      daysSinceCommit: mod.daysSinceCommit ?? null,
    });
    // 非 Java 且没有任何 release 资产下载量：下载项视为缺失（不是 0 分），剩余权重按比例重归一
    const downloadsMissing =
      mod.hasJava === false && (Number(mod.totalDownloads) || 0) === 0;
    const availableWeight =
      COMPONENT_WEIGHTS.stars + COMPONENT_WEIGHTS.update;
    const effectiveWeights = downloadsMissing
      ? {
          downloads: 0,
          stars: COMPONENT_WEIGHTS.stars / availableWeight,
          update: COMPONENT_WEIGHTS.update / availableWeight,
        }
      : { ...COMPONENT_WEIGHTS };
    const score = downloadsMissing
      ? (starsScore * COMPONENT_WEIGHTS.stars + updateScore * COMPONENT_WEIGHTS.update) /
          availableWeight *
          multiplier -
        penalty * PENALTY_WEIGHT
      : (downloadsScore * COMPONENT_WEIGHTS.downloads +
          starsScore * COMPONENT_WEIGHTS.stars +
          updateScore * COMPONENT_WEIGHTS.update) *
          multiplier -
        penalty * PENALTY_WEIGHT;
    return {
      repo: mod.repo,
      namePlain: mod.namePlain ?? '',
      source: mod.source,
      totalDownloads: mod.totalDownloads ?? 0,
      totalStars: mod.totalStars ?? 0,
      downloadsMissing,
      effectiveWeights,
      stockShare: {
        downloads: downloadStock.shares[index],
        stars: starStock.shares[index],
      },
      stockMag: {
        downloads: downloadStock.mags[index],
        stars: starStock.mags[index],
      },
      stockScore: {
        downloads: downloadStock.scores[index],
        stars: starStock.scores[index],
      },
      downloadChanges: Object.fromEntries(
        HEAT_WINDOWS.map((window) => [window, mod.downloadChanges?.[window] ?? 0]),
      ),
      starChanges: Object.fromEntries(
        HEAT_WINDOWS.map((window) => [window, mod.starChanges?.[window] ?? 0]),
      ),
      releaseUpdates: Object.fromEntries(
        UPDATE_WINDOWS.map((window) => [window, mod.releaseUpdates?.[window] ?? 0]),
      ),
      commits: Object.fromEntries(
        UPDATE_WINDOWS.map((window) => [window, mod.commits?.[window] ?? 0]),
      ),
      releaseActivityRaw: releaseRaw[index],
      commitActivityRaw: commitRaw[index],
      releaseActivity: releaseActivity[index],
      commitActivity: commitActivity[index],
      downloadsScore,
      starsScore,
      updateScore,
      newModMultiplier: multiplier,
      penalty,
      score,
      rank: null,
    };
  });

  const sorted = [...entries].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.repo < right.repo ? -1 : left.repo > right.repo ? 1 : 0;
  });
  for (const [index, entry] of sorted.entries()) {
    entry.rank = index + 1;
  }
  return { entries: sorted, count };
}

// 保留最近 N 份历史文件（文件名按字典序即时间序）
export function selectHistoryFiles(files, kind) {
  const limit = HISTORY_LIMITS[kind] ?? 0;
  const sorted = [...files].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
  return {
    keep: sorted.slice(0, limit),
    remove: sorted.slice(limit),
  };
}

export function formatDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function formatMonthKey(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

// ISO 8601 周（YYYY-Www），UTC
export function formatWeekKey(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function buildSnapshot(mods, generatedAt) {
  const snapshotMods = {};
  for (const mod of [...mods].sort((left, right) => (left.repo < right.repo ? -1 : 1))) {
    snapshotMods[mod.repo] = {
      stars: Number(mod.totalStars) || 0,
      totalDownloads: Number(mod.totalDownloads) || 0,
    };
  }
  return {
    formatVersion: 1,
    generatedAt,
    mods: snapshotMods,
  };
}

export function round4(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10000) / 10000 : 0;
}

export const HEAT_SUMMARY_COLUMNS = [
  'repo',
  'namePlain',
  'source',
  'totalDownloads',
  'totalStars',
  'stockShareDownloads',
  'stockShareStars',
  'stockMagDownloads',
  'stockMagStars',
  'downloadsMissing',
  'effectiveWeightDownloads',
  'effectiveWeightStars',
  'effectiveWeightUpdate',
  'downloads1d',
  'downloads7d',
  'downloads30d',
  'downloads180d',
  'stars1d',
  'stars7d',
  'stars30d',
  'stars180d',
  'releaseUpdates7d',
  'releaseUpdates30d',
  'releaseUpdates90d',
  'releaseUpdates180d',
  'commits7d',
  'commits30d',
  'commits90d',
  'commits180d',
  'releaseActivityRaw',
  'commitActivityRaw',
  'releaseActivity',
  'commitActivity',
  'downloadsScore',
  'starsScore',
  'updateScore',
  'newModMultiplier',
  'penalty',
  'score',
  'rank',
];

export function heatSummaryRow(entry) {
  const row = {
    repo: entry.repo,
    namePlain: entry.namePlain,
    source: entry.source,
    totalDownloads: entry.totalDownloads,
    totalStars: entry.totalStars,
    stockShareDownloads: entry.stockShare?.downloads ?? 0,
    stockShareStars: entry.stockShare?.stars ?? 0,
    stockMagDownloads: entry.stockMag?.downloads ?? 0,
    stockMagStars: entry.stockMag?.stars ?? 0,
    downloadsMissing: entry.downloadsMissing === true,
    effectiveWeightDownloads: entry.effectiveWeights?.downloads ?? 0,
    effectiveWeightStars: entry.effectiveWeights?.stars ?? 0,
    effectiveWeightUpdate: entry.effectiveWeights?.update ?? 0,
    releaseActivityRaw: entry.releaseActivityRaw ?? 0,
    commitActivityRaw: entry.commitActivityRaw ?? 0,
    releaseActivity: entry.releaseActivity ?? 0,
    commitActivity: entry.commitActivity ?? 0,
    downloadsScore: entry.downloadsScore,
    starsScore: entry.starsScore,
    updateScore: entry.updateScore,
    newModMultiplier: entry.newModMultiplier,
    penalty: entry.penalty,
    score: entry.score,
    rank: entry.rank,
  };
  for (const window of HEAT_WINDOWS) {
    row[`downloads${window}d`] = entry.downloadChanges?.[window] ?? 0;
    row[`stars${window}d`] = entry.starChanges?.[window] ?? 0;
  }
  for (const window of UPDATE_WINDOWS) {
    row[`releaseUpdates${window}d`] = entry.releaseUpdates?.[window] ?? 0;
    row[`commits${window}d`] = entry.commits?.[window] ?? 0;
  }
  return row;
}
