// changes.json：滚动变更流（供启动器提示「有更新」），保留最近 500 条

export const CHANGES_REL_PATH = 'changes.json';
export const MAX_CHANGES = 500;
export const CHANGE_ACTIONS = [
  'mod-added',
  'mod-updated',
  'release-added',
  'tag-removed',
  'release-removed',
];

function isChange(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.at === 'string' &&
    (entry.dataset === 'official' || entry.dataset === 'community') &&
    typeof entry.repo === 'string' &&
    CHANGE_ACTIONS.includes(entry.action)
  );
}

export function normalizeChanges(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isChange).map((entry) => ({
    at: entry.at,
    dataset: entry.dataset,
    repo: entry.repo,
    action: entry.action,
    ...(typeof entry.tag === 'string' && entry.tag.length > 0 ? { tag: entry.tag } : {}),
    ...(typeof entry.version === 'string' && entry.version.length > 0
      ? { version: entry.version }
      : {}),
    ...(typeof entry.namePlain === 'string' && entry.namePlain.length > 0
      ? { namePlain: entry.namePlain }
      : {}),
  }));
}

// 新变更在前，滚动保留 max 条
export function mergeChanges(newEntries, previousChanges = [], { max = MAX_CHANGES } = {}) {
  const merged = [...normalizeChanges(newEntries), ...normalizeChanges(previousChanges)];
  return merged.slice(0, max);
}

// 模组级变更：新增 / 关键展示字段变化（stars 等高频字段不记，避免刷屏）
const MOD_UPDATE_FIELDS = ['name', 'version', 'minGameVersion', 'hasJava', 'hasScripts'];

export function diffModEntry({ dataset, repo, previousEntry, currentEntry, at, namePlain }) {
  if (!currentEntry) {
    return [];
  }
  const make = (action) => ({
    at,
    dataset,
    repo,
    action,
    ...(namePlain ? { namePlain } : {}),
  });
  if (!previousEntry) {
    return [make('mod-added')];
  }
  const changed = MOD_UPDATE_FIELDS.some(
    (field) => previousEntry[field] !== currentEntry[field],
  );
  if (changed || previousEntry.latestRelease?.tag !== currentEntry.latestRelease?.tag) {
    return [make('mod-updated')];
  }
  return [];
}

// 删除/新增 release/tag：上一份 per-mod 文件 vs 本次结果
export function diffReleaseFiles({
  dataset,
  repo,
  previousFile,
  currentFile,
  at,
  namePlain,
  initialSnapshot = false,
}) {
  if (initialSnapshot || !previousFile || !Array.isArray(currentFile?.releases)) {
    return [];
  }
  const previousByTag = new Map(
    (Array.isArray(previousFile.releases) ? previousFile.releases : [])
      .filter((entry) => entry && typeof entry.tag === 'string')
      .map((entry) => [entry.tag, entry]),
  );
  const result = [];
  const push = (action, entry) => {
    result.push({
      at,
      dataset,
      repo,
      action,
      ...(typeof entry.tag === 'string' ? { tag: entry.tag } : {}),
      ...(typeof entry.modVersion === 'string' && entry.modVersion
        ? { version: entry.modVersion }
        : {}),
      ...(namePlain ? { namePlain } : {}),
    });
  };
  for (const entry of currentFile.releases) {
    if (!entry || typeof entry.tag !== 'string') {
      continue;
    }
    const previous = previousByTag.get(entry.tag);
    const hasRelease = entry.hasRelease !== false;
    if (!previous) {
      if (hasRelease) {
        push('release-added', entry);
      }
      continue;
    }
    const wasRemoved = previous.removed === true;
    const nowRemoved = entry.removed === true;
    if (!wasRemoved && nowRemoved) {
      push(hasRelease ? 'release-removed' : 'tag-removed', entry);
      continue;
    }
    if (wasRemoved && !nowRemoved) {
      if (hasRelease) {
        push('release-added', entry);
      }
      continue;
    }
    // tag 还在但 Release 被删 → release-removed；后来补建 Release → release-added
    if (previous.hasRelease !== false && !hasRelease) {
      push('release-removed', entry);
    } else if (previous.hasRelease === false && hasRelease) {
      push('release-added', entry);
    }
  }
  return result;
}
