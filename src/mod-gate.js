// 最小版本门禁：从 Anuken/Mindustry 各 release tag 的源码提取
// minModGameVersion / minJavaModGameVersion，147 之前源码没有常量时用 mmgvm 基线兜底

import { parse as parseHjson } from 'hjson';

export const GATE_REL_PATH = 'mindustry/mod-gate.json';
export const GATE_REPO = 'Anuken/Mindustry';
export const GATE_BASELINE_URL =
  'https://raw.githubusercontent.com/MDTCopper/launcher/main/remote/mmgvm.hjson';
export const GATE_CONSTANTS = ['minModGameVersion', 'minJavaModGameVersion'];

// 代码位置可能变：老版本在 core/src/mindustry/Vars.java，新版可能挪到 core/ 或改名
export const GATE_CANDIDATE_PATHS = [
  'core/src/mindustry/Vars.java',
  'core/src/mindustry/core/Vars.java',
  'core/src/mindustry/Version.java',
  'core/src/mindustry/core/Version.java',
];

// v147 之前官方源码里没有这两个常量（逐 tag 实测：v105/v136/v146 都没有，v147 首次出现），
// 这些版本直接走 mmgvm 基线，不逐版本试 4 个候选路径，冷启动少约 380 次 raw 请求
export const GATE_SOURCE_CONSTANT_SINCE = 147;

// 启动器内置兜底（与 remote/mmgvm.hjson 同源）
export const BUILTIN_GATE_RULES = [
  { min: 97, max: 105, mod: 97, java: 97 },
  { min: 105, max: 136, mod: 105, java: 105 },
  { min: 136, max: 147, mod: 136, java: 136 },
  { min: 147, max: 154.2, mod: 136, java: 147 },
  { min: 154.2, max: null, mod: 136, java: 154 },
];

const GATE_START_VERSION = 97;
const CONSTANT_PATTERNS = {
  minModGameVersion:
    /(?:public\s+)?(?:static\s+)?(?:final\s+)?int\s+minModGameVersion\s*=\s*(\d+)\s*;/,
  minJavaModGameVersion:
    /(?:public\s+)?(?:static\s+)?(?:final\s+)?int\s+minJavaModGameVersion\s*=\s*(\d+)\s*;/,
};

export function rawSourceUrl(tag, filePath) {
  return `https://raw.githubusercontent.com/${GATE_REPO}/${encodeURIComponent(tag)}/${filePath}`;
}

export function treeApiUrl(tag) {
  return `https://api.github.com/repos/${GATE_REPO}/git/trees/${encodeURIComponent(tag)}?recursive=1`;
}

// 从 Vars.java / Version.java 里读两个常量；必须同时出现才算命中
export function parseGateConstants(text) {
  const mod = text.match(CONSTANT_PATTERNS.minModGameVersion);
  const java = text.match(CONSTANT_PATTERNS.minJavaModGameVersion);
  if (!mod || !java) {
    return null;
  }
  return { mod: Number(mod[1]), java: Number(java[1]) };
}

// 只保留正式版 tag 形如 v<数字>[.<数字>]，按数字升序去重
export function regularVersions(releases) {
  const seen = new Set();
  const versions = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    const tag = typeof release?.tag_name === 'string' ? release.tag_name : '';
    const match = /^v(\d+(?:\.\d+)?)$/.exec(tag);
    if (!match) {
      continue;
    }
    const version = Number(match[1]);
    if (seen.has(version)) {
      continue;
    }
    seen.add(version);
    versions.push({ tag, version });
  }
  versions.sort((a, b) => a.version - b.version);
  return versions;
}

// 基线规则清洗：必须 min/mod/java 合法，max 为 null 或大于 min
export function normalizeBaselineRules(rawRules) {
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    return null;
  }
  const rules = [];
  for (const raw of rawRules) {
    const min = Number(raw?.min);
    const max = raw?.max === null || raw?.max === undefined ? null : Number(raw.max);
    const mod = Number(raw?.mod);
    const java = Number(raw?.java);
    if (!Number.isFinite(min) || !Number.isFinite(mod) || !Number.isFinite(java)) {
      return null;
    }
    if (max !== null && !(min < max)) {
      return null;
    }
    rules.push({ min, max, mod: Math.round(mod), java: Math.round(java) });
  }
  rules.sort((a, b) => a.min - b.min);
  return rules;
}

export function parseBaselineText(text) {
  const parsed = parseHjson(text);
  return normalizeBaselineRules(parsed?.rules);
}

// 基线查询：min <= version < max
export function baselineLookup(rules, version) {
  for (const rule of rules) {
    if (version >= rule.min && (rule.max === null || version < rule.max)) {
      return { mod: rule.mod, java: rule.java };
    }
  }
  return null;
}

// 逐版本结果合并成连续规则：min 含、max 不含，最后一条 max 为 null
export function mergeGateRules(versions) {
  const groups = [];
  for (const item of versions) {
    const last = groups[groups.length - 1];
    if (last && last.mod === item.mod && last.java === item.java) {
      last.sources.add(item.source);
      continue;
    }
    if (last) {
      last.max = item.version;
    }
    groups.push({
      min: item.version,
      max: null,
      mod: item.mod,
      java: item.java,
      sources: new Set([item.source]),
    });
  }
  return groups.map((group) => ({
    min: group.min,
    max: group.max,
    mod: group.mod,
    java: group.java,
    source:
      group.sources.size === 1 ? [...group.sources][0] : 'mixed',
  }));
}

// 候选路径都不命中且上一个版本有常量时，用 tree API 找 Vars.java / Version.java
export async function findGateSourcePaths(apiClient, tag) {
  const response = await apiClient.get(treeApiUrl(tag));
  if (response.status !== 200) {
    return [];
  }
  let tree;
  try {
    tree = JSON.parse(response.text)?.tree;
  } catch {
    return [];
  }
  if (!Array.isArray(tree)) {
    return [];
  }
  return tree
    .map((entry) => (typeof entry?.path === 'string' ? entry.path : null))
    .filter(
      (filePath) =>
        filePath &&
        /\/(?:Vars|Version)\.java$/.test(filePath) &&
        filePath.startsWith('core/'),
    )
    .sort((a, b) => {
      const aMindustry = a.includes('/mindustry/') ? 0 : 1;
      const bMindustry = b.includes('/mindustry/') ? 0 : 1;
      return aMindustry - bMindustry || a.length - b.length;
    })
    .slice(0, 5);
}

// 解析一个 tag 的门禁常量；候选 404 且允许时走 tree 兜底
export async function resolveVersionGate({
  tag,
  rawClient,
  apiClient = null,
  allowTree = false,
}) {
  for (const filePath of GATE_CANDIDATE_PATHS) {
    const response = await rawClient.get(rawSourceUrl(tag, filePath));
    if (response.status !== 200) {
      continue;
    }
    const constants = parseGateConstants(response.text);
    if (constants) {
      return { found: true, path: filePath, ...constants };
    }
  }
  if (!allowTree || !apiClient) {
    return { found: false };
  }
  const treePaths = await findGateSourcePaths(apiClient, tag);
  for (const filePath of treePaths) {
    const response = await rawClient.get(rawSourceUrl(tag, filePath));
    if (response.status !== 200) {
      continue;
    }
    const constants = parseGateConstants(response.text);
    if (constants) {
      return { found: true, path: filePath, ...constants };
    }
  }
  return { found: false };
}

export function buildGateFile({ versions, rules, resolvedPaths, generatedAt }) {
  return {
    formatVersion: 1,
    generatedAt,
    source: {
      repo: GATE_REPO,
      baseline: GATE_BASELINE_URL,
      constants: [...GATE_CONSTANTS],
      resolvedPaths: [...new Set(resolvedPaths)].sort(),
    },
    rules,
    versions,
  };
}

export function gateBodyChanged(previous, next) {
  if (!previous) {
    return true;
  }
  if (JSON.stringify(previous.source) !== JSON.stringify(next.source)) {
    return true;
  }
  if (JSON.stringify(previous.rules) !== JSON.stringify(next.rules)) {
    return true;
  }
  return JSON.stringify(previous.versions) !== JSON.stringify(next.versions);
}

export function gateStartVersion() {
  return GATE_START_VERSION;
}
