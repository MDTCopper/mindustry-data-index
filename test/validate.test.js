import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDir, validateReleaseFileData, validateIndexData, validateStatusData, validateChangesData, isValidReleasesPath } from '../src/validate.js';
import { HEAT_SUMMARY_COLUMNS, heatSummaryRow, buildSnapshot } from '../src/heat.js';
import { VERSIONS_API } from '../src/versions.js';
import { buildSummary, summaryCsv, csvEscape } from '../src/summary.js';
import {
  buildGateFile,
  mergeGateRules,
} from '../src/mod-gate.js';

const GENERATED_AT = '2026-11-06T03:00:00.000Z';

function defaultHeat(rank = 1, score = 0.5 / rank) {
  return {
    score,
    rank,
    downloadsScore: 0.5,
    starsScore: 0.6,
    updateScore: 0.4,
    recommendVisible: score >= 0,
  };
}

function ensureHeat(index, startRank = 0) {
  for (const [position, mod] of (index?.mods ?? []).entries()) {
    if (!mod.heat) {
      mod.heat = defaultHeat(startRank + position + 1);
    }
  }
  return index;
}

function releasesRelPath(repo) {
  const [owner, name] = repo.split('/');
  return `releases/${owner}/${name}.json`;
}

function validFixture(repo = 'owner/demo') {
  const stem = repo.replace('/', '_');
  const release = {
    tag: 'v1.0',
    name: '1.0',
    hasRelease: true,
    prerelease: false,
    publishedAt: '2026-10-01T12:00:00Z',
    htmlUrl: `https://github.com/${repo}/releases/tag/v1.0`,
    modVersion: '1.0',
    minGameVersion: '146',
    metadataPath: 'mod.hjson',
    metadataStatus: 'ok',
    downloadUrl: `https://github.com/${repo}/releases/download/v1.0/demo.jar`,
    sourceArchiveUrl: `https://github.com/${repo}/archive/refs/tags/v1.0.zip`,
    assets: [
      {
        name: 'demo.jar',
        size: 123,
        downloadCount: 4,
        downloadUrl: `https://github.com/${repo}/releases/download/v1.0/demo.jar`,
      },
    ],
  };
  return {
    index: {
      formatVersion: 3,
      generatedAt: GENERATED_AT,
      source: {
        modsUrl: 'https://raw.githubusercontent.com/Anuken/MindustryMods/master/mods.json',
        modCount: 1,
      },
      mods: [
        {
          repo,
          internalName: 'demo',
          name: 'Demo',
          namePlain: 'Demo',
          author: 'author',
          authorPlain: 'author',
          descriptionPlain: '',
          version: '1.0',
          minGameVersion: '146',
          modType: 'java',
          gameVersionRanges: [{ from: '146', to: '146' }],
          stars: 3,
          hasIcon: true,
          iconUrl: `https://raw.githubusercontent.com/Anuken/MindustryMods/master/icons/${stem}`,
          iconHash: null,
          releasesPath: releasesRelPath(repo),
          releaseCount: 1,
          releaseUpdatedAt: '2026-10-01T12:00:00Z',
          commitUpdatedAt: null,
          totalDownloads: 4,
          allAssetsDownloads: 4,
          releaseDataUpdatedAt: GENERATED_AT,
        },
      ],
      skipped: [],
    },
    releaseFile: {
      formatVersion: 3,
      repo,
      generatedAt: GENERATED_AT,
      modType: 'java',
      versions: [
        {
          tag: 'v1.0',
          kind: 'release',
          modVersion: '1.0',
          minGameVersion: '146',
          gameVersionRanges: [{ from: '146', to: '146' }],
          releasedAt: '2026-10-01T12:00:00Z',
          downloadUrl: `https://github.com/${repo}/releases/download/v1.0/demo.jar`,
          sizeBytes: 123,
          downloadCount: 4,
        },
      ],
    },
  };
}

function summaryRow(entry) {
  return {
    repo: entry.repo,
    name: entry.name,
    namePlain: entry.namePlain ?? '',
    author: entry.author,
    stars: entry.stars,
    modType: entry.modType,
    releaseCount: entry.releaseCount,
    ...(entry.modType === 'java' ? {} : { tagCount: entry.tagCount }),
    totalDownloads: entry.totalDownloads,
    allAssetsDownloads: entry.allAssetsDownloads,
    minGameVersion: entry.minGameVersion,
    gameVersionRanges: JSON.stringify(entry.gameVersionRanges ?? []),
    releaseUpdatedAt: entry.releaseUpdatedAt ?? null,
    commitUpdatedAt: entry.commitUpdatedAt ?? null,
    iconUrl: entry.iconUrl,
    ...(entry.heat
      ? {
          heatScore: entry.heat.score,
          heatRank: entry.heat.rank,
          recommendVisible: entry.heat.recommendVisible,
        }
      : {}),
    releasesPath: entry.releasesPath,
  };
}

async function writeSummaryFiles(dir, index) {
  ensureHeat(index);
  const rows = index.mods.map((entry) => summaryRow(entry));
  const summary = buildSummary({ rows, generatedAt: GENERATED_AT });
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(dir, 'summary.csv'), summaryCsv(summary.mods));
}

async function makeFixtureDir({ index, releaseFile } = validFixture()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mods-index-validate-'));
  ensureHeat(index);
  const fullIndex = JSON.parse(JSON.stringify(index));
  const visibleIndex = {
    ...fullIndex,
    source: fullIndex.source
      ? { ...fullIndex.source, modCount: fullIndex.mods.filter((mod) => mod.heat?.recommendVisible === true).length }
      : fullIndex.source,
    mods: fullIndex.mods.filter((mod) => mod.heat?.recommendVisible === true),
  };
  await mkdir(path.join(dir, 'releases'), { recursive: true });
  await writeFile(path.join(dir, 'index-full.json'), JSON.stringify(fullIndex, null, 2));
  await writeFile(path.join(dir, 'index.json'), JSON.stringify(visibleIndex, null, 2));
  const relPath = releasesRelPath(releaseFile.repo);
  await mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
  await writeFile(path.join(dir, relPath), JSON.stringify(releaseFile, null, 2));
  await writeSummaryFiles(dir, fullIndex, releaseFile);
  await writeFile(
    path.join(dir, 'status.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        generatedAt: GENERATED_AT,
        datasets: {
          official: { updatedAt: GENERATED_AT, modCount: 1, releaseCount: 1, skipped: [] },
          community: null,
          versions: null,
          gate: null,
        },
        api: { requests: 1, remaining: 100, resetAt: null },
        validate: { errors: 0, warnings: 0, presentFiles: ['index.json'] },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(dir, 'changes.json'),
    JSON.stringify(
      [
        {
          at: GENERATED_AT,
          dataset: 'official',
          repo: 'owner/demo',
          action: 'mod-added',
          namePlain: 'Demo',
        },
      ],
      null,
      2,
    ),
  );
  return dir;
}

test('合法产物校验通过', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.modCount, 1);
  assert.equal(result.releaseFileCount, 1);
});

test('缺少 index.json 报错', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mods-index-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('找不到')));
});

test('缺字段能被发现', async (t) => {
  const fixture = validFixture();
  delete fixture.index.mods[0].name;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('.name')));
});

test('重复 tag 能被发现', async (t) => {
  const fixture = validFixture();
  fixture.releaseFile.versions.push({ ...fixture.releaseFile.versions[0] });
  fixture.index.mods[0].releaseCount = 2;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('tag 重复')));
});

test('releasesPath 指向的文件不存在能被发现', async (t) => {
  const fixture = validFixture();
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await unlink(path.join(dir, 'releases', 'owner', 'demo.json'));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('文件不存在')));
});

test('releaseCount 与文件条数不一致能被发现', async (t) => {
  const fixture = validFixture();
  fixture.index.mods[0].releaseCount = 2;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('releaseCount')));
});

test('未被 index 引用的 releases 文件只算警告', async (t) => {
  const fixture = validFixture();
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'releases', 'extra'), { recursive: true });
  await writeFile(path.join(dir, 'releases', 'extra', 'extra.json'), '{}');
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => message.includes('没有被 index 引用')));
});

// ---------- mindustry 数据集 ----------

function trimmedRelease(tag, totalCount = 10) {
  return {
    name: `v8 Build ${tag.slice(1)}`,
    tag_name: tag,
    published_at: '2026-10-01T12:00:00Z',
    body: '',
    reactions: { total_count: totalCount },
    assets: [
      {
        name: 'Mindustry.jar',
        size: 100,
        download_count: 5,
        browser_download_url: `https://github.com/Anuken/Mindustry/releases/download/${tag}/Mindustry.jar`,
      },
    ],
  };
}

function versionsFixture() {
  return {
    update_time: GENERATED_AT,
    source: VERSIONS_API,
    releases: [trimmedRelease('v159.7', 100), trimmedRelease('v159.6', 80)],
    latest_be: {
      name: 'Build 28065',
      tag_name: '28065',
      published_at: '2026-10-01T12:00:00Z',
      body: '',
      assets: [],
    },
    etags: { releases: 'W/"a"', latestBe: 'W/"b"' },
  };
}

function gateFixture() {
  const combined = [
    { tag: 'v97', version: 97, mod: 97, java: 97, source: 'baseline' },
    { tag: 'v147', version: 147, mod: 136, java: 147, source: 'game-source' },
    { tag: 'v154.2', version: 154.2, mod: 136, java: 154, source: 'game-source' },
  ];
  const build = (type) => {
    const versions = combined.map((item) => ({
      tag: item.tag,
      version: item.version,
      value: item[type],
      source: item.source,
    }));
    return buildGateFile({
      type,
      versions,
      rules: mergeGateRules(versions),
      resolvedPaths: ['core/src/mindustry/Vars.java'],
      generatedAt: GENERATED_AT,
    });
  };
  return { mod: build('mod'), java: build('java') };
}

async function makeMindustryDir({ versions = versionsFixture(), gate = gateFixture() } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-data-validate-'));
  await mkdir(path.join(dir, 'mindustry'), { recursive: true });
  await writeFile(path.join(dir, 'mindustry', 'versions.json'), JSON.stringify(versions, null, 2));
  await writeFile(
    path.join(dir, 'mindustry', 'mod-gate.json'),
    JSON.stringify(gate.mod, null, 2),
  );
  await writeFile(
    path.join(dir, 'mindustry', 'java-gate.json'),
    JSON.stringify(gate.java, null, 2),
  );
  return dir;
}

test('合法的 versions.json / mod-gate.json / java-gate.json 通过校验', async (t) => {
  const dir = await makeMindustryDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.versionsCount, 2);
  assert.equal(result.latestBe, '28065');
  assert.equal(result.gates.mod.versionCount, 3);
  assert.equal(result.gates.java.versionCount, 3);
  assert.ok(result.warnings.some((message) => message.includes('找不到 index.json')));
});

test('latest_be 带 reactions 会被发现', async (t) => {
  const versions = versionsFixture();
  versions.latest_be.reactions = { total_count: 1 };
  const dir = await makeMindustryDir({ versions });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('不应带 reactions')));
});

test('versions 缺 reactions / body 非空 / 重复 tag 会被发现', async (t) => {
  const versions = versionsFixture();
  delete versions.releases[0].reactions;
  versions.releases[1].body = '有更新日志';
  versions.releases.push(trimmedRelease('v159.7'));
  const dir = await makeMindustryDir({ versions });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('reactions.total_count')));
  assert.ok(result.errors.some((message) => message.includes('body 应为空串')));
  assert.ok(result.errors.some((message) => message.includes('tag_name 重复')));
});

test('gate 规则不连续 / 未合并 / 与 versions 不一致会被发现', async (t) => {
  const gate = gateFixture();
  gate.mod.rules = [
    { min: 97, max: 147, value: 97, source: 'baseline' },
    { min: 148, max: null, value: 136, source: 'game-source' },
  ];
  const dir = await makeMindustryDir({ gate });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('不连续')));
  assert.ok(result.errors.some((message) => message.includes('合并结果不一致')));
});

test('gate 版本未升序 / 最后规则 max 不为 null 会被发现', async (t) => {
  const gate = gateFixture();
  gate.mod.versions = [...gate.mod.versions].reverse();
  gate.mod.rules[gate.mod.rules.length - 1] = {
    ...gate.mod.rules[gate.mod.rules.length - 1],
    max: 999,
  };
  const dir = await makeMindustryDir({ gate });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('严格升序')));
  assert.ok(result.errors.some((message) => message.includes('最后一条规则的 max 应为 null')));
});

test('heartbeat.json 形状不合法会被发现', async (t) => {
  const dir = await makeMindustryDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'mindustry', 'heartbeat.json'), '{"lastCheck": 42}');
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('heartbeat.lastCheck')));
});

test('目录里一个数据文件都没有时报错', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-data-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('找不到任何数据文件')));
});

test('iconUrl 与 repo/hasIcon 不一致会被发现', async (t) => {
  const fixture = validFixture();
  fixture.index.mods[0].iconUrl =
    'https://raw.githubusercontent.com/Anuken/MindustryMods/master/icons/other_repo';
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('iconUrl 与 repo/hasIcon 不一致')));
});

test('hasIcon=false 却给 iconUrl、iconHash 类型不对会被发现', async (t) => {
  const fixture = validFixture();
  fixture.index.mods[0].hasIcon = false;
  // hasIcon=false 时 iconUrl 应为 null；iconHash 必须是字符串
  fixture.index.mods[0].iconUrl =
    'https://raw.githubusercontent.com/Anuken/MindustryMods/master/icons/owner_demo';
  fixture.index.mods[0].iconHash = 123;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('iconUrl 与 repo/hasIcon 不一致')));
  assert.ok(result.errors.some((message) => message.includes('iconHash 应为字符串或 null')));
});

// ---------- releasesPath 路径段校验（新 owner/repo 结构） ----------

test('isValidReleasesPath：新路径三段合法，旧 flat / 穿越 / 多层目录非法', () => {
  assert.equal(isValidReleasesPath('releases/owner/repo.json'), true);
  assert.equal(isValidReleasesPath('releases/Anuken/Example-Mod_2.json'), true);
  assert.equal(isValidReleasesPath('releases/maksimk792/some-music..json'), true);

  assert.equal(isValidReleasesPath('releases/owner_repo.json'), false); // 旧 flat
  assert.equal(isValidReleasesPath('releases/../x.json'), false);
  assert.equal(isValidReleasesPath('releases/a/b/c.json'), false);
  assert.equal(isValidReleasesPath('releases//repo.json'), false);
  assert.equal(isValidReleasesPath('releases/owner/.json'), false);
  assert.equal(isValidReleasesPath('index.json'), false);
  assert.equal(isValidReleasesPath('releases/owner/repo.txt'), false);
  assert.equal(isValidReleasesPath(null), false);
});

test('repo 名以点结尾（文件名含 ..）时正常校验、不再误报未引用', async (t) => {
  const fixture = validFixture('maksimk792/some-music.');
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.modCount, 1);
  assert.equal(result.releaseFileCount, 1);
});

test('releasesPath 含路径穿越 / 更深目录会被判非法', async (t) => {
  const traversal = validFixture();
  traversal.index.mods[0].releasesPath = 'releases/../x.json';
  const dir = await makeFixtureDir(traversal);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('releasesPath 非法')));

  const nested = validFixture();
  nested.index.mods[0].releasesPath = 'releases/a/b/c.json';
  const nestedDir = await makeFixtureDir(nested);
  t.after(() => rm(nestedDir, { recursive: true, force: true }));
  const nestedResult = await validateDir(nestedDir);
  assert.ok(nestedResult.errors.some((message) => message.includes('releasesPath 非法')));
});

test('旧 flat 文件仍存在时给迁移未完成 warning', async (t) => {
  const fixture = validFixture();
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, 'releases', 'owner_demo.json'),
    JSON.stringify(fixture.releaseFile, null, 2),
  );
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => message.includes('旧 flat 路径')));
});

// ---------- 下载量/体积统计与总表 ----------

test('缺 summary.json 只给警告（旧数据兼容）', async (t) => {
  const fixture = validFixture();
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await unlink(path.join(dir, 'summary.json'));
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => message.includes('缺少 summary.json')));
});

test('summary totals / 行内容与 index 不一致会被发现', async (t) => {
  const fixture = validFixture();
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary = JSON.parse(
    await readFile(path.join(dir, 'summary.json'), 'utf8'),
  );
  summary.totals.downloads = 999;
  summary.mods[0].releaseCount = 5;
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('summary.totals.downloads')));
  assert.ok(result.errors.some((message) => message.includes('releaseCount 与 index 不一致')));
});

test('summary.csv 行数与内容不一致会被发现', async (t) => {
  const fixture = validFixture();
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, 'summary.csv'),
    '\uFEFF' + 'repo,name\r\n' + 'only,two\r\n',
  );
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('summary.csv 表头')));
});

test('state/refresh.json 形状不合法会被发现', async (t) => {
  const fixture = validFixture();
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'state'), { recursive: true });
  await writeFile(
    path.join(dir, 'state', 'refresh.json'),
    JSON.stringify({
      formatVersion: 1,
      updatedAt: GENERATED_AT,
      mods: { 'owner/demo': { page1Etag: 5, page1FetchedAt: 'x', pages: { 1: 'x' } } },
    }),
  );
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('page1Etag')));
  assert.ok(result.errors.some((message) => message.includes('pages')));
});

// ---------- tag-only（无 GitHub Release 的 git tag） ----------

function tagOnlyEntry(repo, tag = 'v0.9') {
  const archive = `https://github.com/${repo}/archive/refs/tags/${tag}.zip`;
  return {
    tag,
    name: tag,
    hasRelease: false,
    prerelease: null,
    publishedAt: null,
    htmlUrl: `https://github.com/${repo}/tree/${tag}`,
    modVersion: null,
    minGameVersion: null,
    metadataPath: null,
    metadataStatus: 'missing',
    downloadUrl: archive,
    sourceArchiveUrl: archive,
    assets: [],
  };
}

function communityFixture({ repo = 'communitymods/demo' } = {}) {
  const entry = {
    repo,
    source: 'topic',
    name: 'Demo',
    namePlain: 'Demo',
    author: 'author',
    authorPlain: 'author',
    version: '1.0',
    minGameVersion: '146',
    modType: 'json',
    gameVersionRanges: [{ from: '146', to: '146' }],
    description: 'a community mod',
    descriptionPlain: 'a community mod',
    stars: 2,
    hasIcon: false,
    iconUrl: null,
    iconHash: null,
    releasesPath: `community/releases/${repo}.json`,
    releaseCount: 0,
    tagCount: 1,
    releaseUpdatedAt: '2026-10-01T12:00:00Z',
    commitUpdatedAt: null,
    totalDownloads: 0,
    allAssetsDownloads: 0,
    releaseDataUpdatedAt: GENERATED_AT,
  };
  return {
    index: {
      formatVersion: 3,
      generatedAt: GENERATED_AT,
      source: {
        source: 'topic',
        query: 'mindustry-mod in:topics archived:false template:false',
        officialCount: 1,
      },
      mods: [entry],
      skipped: [],
    },
    releaseFile: {
      formatVersion: 3,
      repo,
      generatedAt: GENERATED_AT,
      modType: 'json',
      versions: [
        {
          tag: 'v1.0',
          kind: 'tag',
          modVersion: '1.0',
          minGameVersion: '146',
          gameVersionRanges: [{ from: '146', to: '146' }],
          releasedAt: '2026-10-01T12:00:00Z',
          downloadUrl: `https://github.com/${repo}/archive/refs/tags/v1.0.zip`,
        },
      ],
    },
    entry,
  };
}

async function addCommunityFixture(dir, fixture = communityFixture()) {
  const communityDir = path.join(dir, 'community');
  let officialCount = 0;
  try {
    const officialIndex = JSON.parse(
      await readFile(path.join(dir, 'index-full.json'), 'utf8'),
    );
    officialCount = Array.isArray(officialIndex.mods) ? officialIndex.mods.length : 0;
  } catch {}
  ensureHeat(fixture.index, officialCount);
  const communityFull = JSON.parse(JSON.stringify(fixture.index));
  const communityVisible = {
    ...communityFull,
    source: communityFull.source
      ? {
          ...communityFull.source,
          modCount: communityFull.mods.filter((mod) => mod.heat?.recommendVisible === true).length,
        }
      : communityFull.source,
    mods: communityFull.mods.filter((mod) => mod.heat?.recommendVisible === true),
  };
  await mkdir(path.join(communityDir, 'releases', 'communitymods'), { recursive: true });
  await writeFile(
    path.join(communityDir, 'index-full.json'),
    JSON.stringify(communityFull, null, 2),
  );
  await writeFile(
    path.join(communityDir, 'index.json'),
    JSON.stringify(communityVisible, null, 2),
  );
  const filePath = path.join(communityDir, 'releases', `${fixture.releaseFile.repo}.json`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(fixture.releaseFile, null, 2));
  const row = {
    repo: fixture.entry.repo,
    name: fixture.entry.name,
    namePlain: fixture.entry.namePlain ?? '',
    author: fixture.entry.author,
    stars: fixture.entry.stars,
    modType: fixture.entry.modType,
    releaseCount: fixture.entry.releaseCount,
    tagCount: fixture.entry.tagCount,
    totalDownloads: fixture.entry.totalDownloads,
    allAssetsDownloads: fixture.entry.allAssetsDownloads,
    minGameVersion: fixture.entry.minGameVersion,
    gameVersionRanges: JSON.stringify(fixture.entry.gameVersionRanges ?? []),
    releaseUpdatedAt: fixture.entry.releaseUpdatedAt,
    commitUpdatedAt: fixture.entry.commitUpdatedAt,
    iconUrl: null,
    heatScore: fixture.index.mods[0].heat.score,
    heatRank: fixture.index.mods[0].heat.rank,
    recommendVisible: fixture.index.mods[0].heat.recommendVisible,
    releasesPath: fixture.entry.releasesPath,
  };
  const summary = buildSummary({ rows: [row], generatedAt: GENERATED_AT });
  await writeFile(
    path.join(communityDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  await writeFile(path.join(communityDir, 'summary.csv'), summaryCsv(summary.mods));
  await mkdir(path.join(dir, 'state'), { recursive: true });
  await writeFile(
    path.join(dir, 'state', 'community-refresh.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        updatedAt: GENERATED_AT,
        mods: {
          [fixture.entry.repo]: {
            page1Etag: null,
            page1FetchedAt: GENERATED_AT,
            page2FetchedAt: GENERATED_AT,
            fullFetchedAt: GENERATED_AT,
            tagsFetchedAt: GENERATED_AT,
          },
        },
      },
      null,
      2,
    ),
  );
}

test('合法 community 数据（index/releases/summary/state）校验通过', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await addCommunityFixture(dir);
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.communityModCount, 1);
  assert.equal(result.communityReleaseFileCount, 1);
  assert.equal(result.communitySummaryRowCount, 1);
});

test('community 与官方 repo 重复会被发现', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 用官方 fixture 的 repo（owner/demo）构造社区条目
  const fixture = communityFixture({ repo: 'owner/demo' });
  fixture.index.source.officialCount = 1;
  fixture.entry.repo = 'owner/demo';
  await addCommunityFixture(dir, fixture);
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('与官方列表重复')));
});

test('community 条目 source 不是 topic 会被发现', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = communityFixture();
  fixture.index.mods[0].source = 'official';
  await addCommunityFixture(dir, fixture);
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('source 应为 "topic"')));
});

// ---------- A1/A2：commitSha / removed / compat ----------

const SHA = 'a'.repeat(40);

test('release 文件 compat 合法时通过', () => {
  const fixture = validFixture();
  fixture.releaseFile.compat = [
    {
      tag: 'v1.0',
      modVersion: '1.0',
      minGameVersion: '146',
      maxGameVersion: null,
      hasRelease: true,
    },
  ];
  const errors = [];
  validateReleaseFileData(fixture.releaseFile, { errors });
  assert.deepEqual(errors, []);
});

test('validateDir：compatRanges 与文件不一致会被发现', async (t) => {
  const fixture = validFixture();
  fixture.releaseFile.compat = [
    { tag: 'v1.0', modVersion: '1.0', minGameVersion: '146', maxGameVersion: null, hasRelease: true },
  ];
  fixture.index.mods[0].compatRanges = 2;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('compatRanges')));
});

// ---------- status.json / changes.json ----------

test('validateStatusData：合法结构通过，缺字段/类型错误被发现', () => {
  const status = {
    formatVersion: 1,
    generatedAt: GENERATED_AT,
    datasets: {
      official: { updatedAt: GENERATED_AT, modCount: 1, releaseCount: 2, skipped: [] },
      community: null,
      versions: null,
      gate: null,
    },
    api: { requests: 3, remaining: 5, resetAt: null },
    validate: { errors: 0, warnings: 0, presentFiles: ['index.json'] },
  };
  let errors = [];
  validateStatusData(status, { errors });
  assert.deepEqual(errors, []);

  status.api.requests = -1;
  status.datasets.official.releaseCount = 'x';
  delete status.validate.presentFiles;
  errors = [];
  validateStatusData(status, { errors });
  assert.ok(errors.some((message) => message.includes('api.requests')));
  assert.ok(errors.some((message) => message.includes('releaseCount')));
  assert.ok(errors.some((message) => message.includes('presentFiles')));
});

test('validateChangesData：合法变更通过，非法 action/dataset/时间被发现', () => {
  const valid = [
    { at: GENERATED_AT, dataset: 'official', repo: 'owner/demo', action: 'release-added', tag: 'v1' },
    { at: GENERATED_AT, dataset: 'community', repo: 'owner/demo', action: 'mod-added', namePlain: 'Demo' },
  ];
  let errors = [];
  assert.equal(validateChangesData(valid, { errors }).count, 2);
  assert.deepEqual(errors, []);

  const invalid = [
    { at: 'not-a-date', dataset: 'other', repo: 'bad', action: 'unknown' },
  ];
  errors = [];
  validateChangesData(invalid, { errors });
  assert.ok(errors.some((message) => message.includes('.at')));
  assert.ok(errors.some((message) => message.includes('.dataset')));
  assert.ok(errors.some((message) => message.includes('.repo')));
  assert.ok(errors.some((message) => message.includes('.action')));
});

// ---------- heat（已合并进 index / summary） ----------

async function addHeatHistory(dir, { daily = 1 } = {}) {
  const heatDir = path.join(dir, 'heat');
  await mkdir(path.join(heatDir, 'history', 'daily'), { recursive: true });
  await mkdir(path.join(heatDir, 'history', 'weekly'), { recursive: true });
  await mkdir(path.join(heatDir, 'history', 'monthly'), { recursive: true });
  const snapshot = buildSnapshot([], GENERATED_AT);
  for (let day = 1; day <= daily; day += 1) {
    await writeFile(
      path.join(heatDir, 'history', 'daily', `2026-10-${String(day).padStart(2, '0')}.json`),
      JSON.stringify(snapshot),
    );
  }
  await writeFile(
    path.join(heatDir, 'history', 'weekly', '2026-W45.json'),
    JSON.stringify(snapshot),
  );
  await writeFile(
    path.join(heatDir, 'history', 'monthly', '2026-11.json'),
    JSON.stringify(snapshot),
  );
}

test('validateDir：index.heat 与历史快照合法时通过', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await addHeatHistory(dir);
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.heatModCount, 1);
  assert.deepEqual(result.heatHistoryCounts, { daily: 1, weekly: 1, monthly: 1 });
});

test('validateDir：缺少 index.heat 字段会被发现', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexPath = path.join(dir, 'index.json');
  const fullPath = path.join(dir, 'index-full.json');
  for (const filePath of [indexPath, fullPath]) {
    const index = JSON.parse(await readFile(filePath, 'utf8'));
    delete index.mods[0].heat;
    await writeFile(filePath, JSON.stringify(index, null, 2));
  }
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('.heat 缺失')));
});

test('validateDir：全局 heat.rank 重复或与分数排序不一致会被发现', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await addCommunityFixture(dir);
  const writeCommunity = async (updater) => {
    for (const file of ['index.json', 'index-full.json']) {
      const filePath = path.join(dir, 'community', file);
      const data = JSON.parse(await readFile(filePath, 'utf8'));
      updater(data.mods[0]);
      await writeFile(filePath, JSON.stringify(data, null, 2));
    }
  };
  // 社区全量/默认条目 rank=1，与官方 rank=1 重复
  await writeCommunity((mod) => {
    mod.heat.rank = 1;
  });
  const duplicate = await validateDir(dir);
  assert.ok(duplicate.errors.some((message) => message.includes('全局 heat.rank 重复')));
  // 修正为 rank=2 但分数更高 → 排序不一致
  await writeCommunity((mod) => {
    mod.heat.rank = 2;
    mod.heat.score = 0.9;
  });
  const summaryPath = path.join(dir, 'community', 'summary.json');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  summary.mods[0].heatScore = 0.9;
  summary.mods[0].heatRank = 2;
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  const wrongOrder = await validateDir(dir);
  assert.ok(wrongOrder.errors.some((message) => message.includes('heat.rank 与分数排序不一致')));
});

test('validateDir：默认列表不等于全量按 recommendVisible 过滤会被发现', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexPath = path.join(dir, 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.mods = [];
  index.source.modCount = 0;
  await writeFile(indexPath, JSON.stringify(index, null, 2));
  const result = await validateDir(dir);
  assert.ok(
    result.errors.some((message) => message.includes('默认列表必须等于全量列表按 recommendVisible 过滤')),
  );
});

test('validateDir：heat 出现第 7 个字段会被发现', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of ['index.json', 'index-full.json']) {
    const filePath = path.join(dir, file);
    const index = JSON.parse(await readFile(filePath, 'utf8'));
    index.mods[0].heat.maintenance = { status: 'active' };
    await writeFile(filePath, JSON.stringify(index, null, 2));
  }
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('含多余字段 maintenance')));
});

test('validateDir：summary 热度列与 index.heat 不一致会被发现', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summaryPath = path.join(dir, 'summary.json');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  summary.mods[0].heatScore = 0.123;
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('heatScore 与 index.heat')));
});

test('validateDir：旧 heat/index.json 只给废弃 warning', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'heat'), { recursive: true });
  await writeFile(path.join(dir, 'heat', 'index.json'), '{}');
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => message.includes('旧 heat/index.json 已废弃')));
});

test('validateDir：heat 历史快照超量会被发现', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await addHeatHistory(dir, { daily: 8 });
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('超过保留数量')));
});
