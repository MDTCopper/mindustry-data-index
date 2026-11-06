// 官方模组列表：拉取 mods.json 并只保留索引需要的字段

import { assertRepo } from './paths.js';

export const MODS_URL =
  'https://raw.githubusercontent.com/Anuken/MindustryMods/master/mods.json';
// 官方图标地址：icons/<owner>_<repo>，不带扩展名（与启动器 githubModIconBase 一致）
export const MOD_ICON_BASE =
  'https://raw.githubusercontent.com/Anuken/MindustryMods/master/icons';

// 官方列表里的字段原样保留类型与脏值（如 minGameVersion 的 "157.1，"），不在这里清洗
const COPIED_FIELDS = [
  'repo',
  'internalName',
  'name',
  'author',
  'version',
  'minGameVersion',
  'lastUpdated',
  'stars',
  'hasIcon',
  'hasScripts',
  'hasJava',
  'iconHash',
];

export async function fetchModsJson(client) {
  const response = await client.get(MODS_URL);
  if (response.status !== 200) {
    throw new Error(`拉取官方 mods.json 失败：HTTP ${response.status}`);
  }
  let raw;
  try {
    raw = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`官方 mods.json 不是合法 JSON：${error.message}`);
  }
  return normalizeMods(raw);
}

// 图标地址语义对齐启动器：只有明确 hasIcon === false 才没有图标；
// true 或官方列表缺字段（null）时也给地址，由客户端自己决定是否试一次
export function modIconUrl(repo, hasIcon) {
  if (hasIcon === false) {
    return null;
  }
  return `${MOD_ICON_BASE}/${assertRepo(repo).replace('/', '_')}`;
}

export function normalizeMods(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('官方 mods.json 结构异常：顶层不是数组');
  }
  const mods = [];
  const seen = new Set();
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`官方 mods.json 第 ${index} 项不是对象`);
    }
    try {
      assertRepo(item.repo);
    } catch (error) {
      throw new Error(`官方 mods.json 第 ${index} 项：${error.message}`);
    }
    const key = item.repo.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`官方 mods.json 存在重复 repo：${item.repo}`);
    }
    seen.add(key);

    const mod = {};
    for (const field of COPIED_FIELDS) {
      mod[field] = item[field] ?? null;
    }
    // hasIcon 缺字段时保持 null（决定 iconUrl 是否给出），hasScripts/hasJava 缺省为 false
    for (const field of ['hasScripts', 'hasJava']) {
      if (mod[field] === null) {
        mod[field] = false;
      }
    }
    mods.push(mod);
  }
  return mods;
}
