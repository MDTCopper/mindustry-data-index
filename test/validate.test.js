import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDir, isValidReleasesPath } from '../src/validate.js';
import { VERSIONS_API } from '../src/versions.js';
import { buildSummary, summaryCsv } from '../src/summary.js';
import {
  GATE_BASELINE_URL,
  GATE_REPO,
  mergeGateRules,
} from '../src/mod-gate.js';

const GENERATED_AT = '2026-11-06T03:00:00.000Z';

function validFixture(repo = 'owner/demo') {
  const stem = repo.replace('/', '_');
  const release = {
    tag: 'v1.0',
    name: '1.0',
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
      formatVersion: 1,
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
          author: 'author',
          version: '1.0',
          minGameVersion: '146',
          lastUpdated: '2026-10-01T00:00:00Z',
          stars: 3,
          hasIcon: true,
          hasScripts: false,
          hasJava: true,
          iconUrl: `https://raw.githubusercontent.com/Anuken/MindustryMods/master/icons/${stem}`,
          iconHash: null,
          releasesPath: `releases/${stem}.json`,
          releaseCount: 1,
          totalDownloads: 4,
          allAssetsDownloads: 4,
          latestDownloads: 4,
          latestSizeBytes: 123,
          totalSizeBytes: 123,
          latestRelease: {
            tag: 'v1.0',
            name: '1.0',
            prerelease: false,
            publishedAt: '2026-10-01T12:00:00Z',
            downloads: 4,
            sizeBytes: 123,
          },
          releaseDataUpdatedAt: GENERATED_AT,
        },
      ],
      skipped: [],
    },
    releaseFile: {
      formatVersion: 1,
      repo,
      generatedAt: GENERATED_AT,
      releases: [release],
    },
  };
}

function summaryRow(entry, releaseFile) {
  const first = releaseFile.releases[0] ?? null;
  return {
    repo: entry.repo,
    name: entry.name,
    author: entry.author,
    stars: entry.stars,
    releaseCount: entry.releaseCount,
    totalDownloads: entry.totalDownloads,
    allAssetsDownloads: entry.allAssetsDownloads,
    latestDownloads: entry.latestDownloads,
    latestSizeBytes: entry.latestSizeBytes,
    totalSizeBytes: entry.totalSizeBytes,
    latestTag: first?.tag ?? null,
    latestPrerelease: first ? first.prerelease : null,
    latestModVersion: first?.modVersion ?? null,
    latestMinGameVersion: first?.minGameVersion ?? null,
    iconUrl: entry.iconUrl,
  };
}

async function writeSummaryFiles(dir, index, releaseFile) {
  const rows = index.mods.map((entry) => summaryRow(entry, releaseFile));
  const summary = buildSummary({ rows, generatedAt: GENERATED_AT });
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(dir, 'summary.csv'), summaryCsv(summary.mods));
}

async function makeFixtureDir({ index, releaseFile } = validFixture()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mods-index-validate-'));
  await mkdir(path.join(dir, 'releases'), { recursive: true });
  await writeFile(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
  const relPath = `releases/${releaseFile.repo.replace('/', '_')}.json`;
  await writeFile(path.join(dir, relPath), JSON.stringify(releaseFile, null, 2));
  await writeSummaryFiles(dir, index, releaseFile);
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
  delete fixture.index.mods[0].internalName;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('internalName')));
});

test('重复 tag 能被发现', async (t) => {
  const fixture = validFixture();
  fixture.releaseFile.releases.push({ ...fixture.releaseFile.releases[0] });
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
  await unlink(path.join(dir, 'releases', 'owner_demo.json'));
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
  await writeFile(path.join(dir, 'releases', 'extra_extra.json'), '{}');
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
  const versions = [
    { tag: 'v97', version: 97, mod: 97, java: 97, source: 'baseline' },
    { tag: 'v147', version: 147, mod: 136, java: 147, source: 'game-source' },
    { tag: 'v154.2', version: 154.2, mod: 136, java: 154, source: 'game-source' },
  ];
  return {
    formatVersion: 1,
    generatedAt: GENERATED_AT,
    source: {
      repo: GATE_REPO,
      baseline: GATE_BASELINE_URL,
      constants: ['minModGameVersion', 'minJavaModGameVersion'],
      resolvedPaths: ['core/src/mindustry/Vars.java'],
    },
    rules: mergeGateRules(versions),
    versions,
  };
}

async function makeMindustryDir({ versions = versionsFixture(), gate = gateFixture() } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-data-validate-'));
  await mkdir(path.join(dir, 'mindustry'), { recursive: true });
  await writeFile(path.join(dir, 'mindustry', 'versions.json'), JSON.stringify(versions, null, 2));
  await writeFile(path.join(dir, 'mindustry', 'mod-gate.json'), JSON.stringify(gate, null, 2));
  return dir;
}

test('合法的 versions.json / mod-gate.json 通过校验', async (t) => {
  const dir = await makeMindustryDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.versionsCount, 2);
  assert.equal(result.latestBe, '28065');
  assert.equal(result.gateVersionCount, 3);
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

test('mod-gate 规则不连续 / 未合并 / 与 versions 不一致会被发现', async (t) => {
  const gate = gateFixture();
  gate.rules = [
    { min: 97, max: 147, mod: 97, java: 97, source: 'baseline' },
    { min: 148, max: null, mod: 136, java: 147, source: 'game-source' },
  ];
  const dir = await makeMindustryDir({ gate });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('不连续')));
  assert.ok(result.errors.some((message) => message.includes('合并结果不一致')));
});

test('mod-gate 版本未升序 / 最后规则 max 不为 null 会被发现', async (t) => {
  const gate = gateFixture();
  gate.versions = [...gate.versions].reverse();
  gate.rules[gate.rules.length - 1] = {
    ...gate.rules[gate.rules.length - 1],
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
  assert.ok(result.errors.some((message) => message.includes('iconHash 应为非空字符串或 null')));
});

// ---------- releasesPath 路径段校验（repo 名以点结尾） ----------

test('isValidReleasesPath：只按路径段判断，文件名中间的 .. 合法', () => {
  assert.equal(isValidReleasesPath('releases/foo_bar..json'), true);
  assert.equal(isValidReleasesPath('releases/maksimk792_some-music..json'), true);
  assert.equal(isValidReleasesPath('releases/owner_repo.json'), true);

  assert.equal(isValidReleasesPath('releases/../x.json'), false);
  assert.equal(isValidReleasesPath('releases/a/b.json'), false);
  assert.equal(isValidReleasesPath('releases//x.json'), false);
  assert.equal(isValidReleasesPath('index.json'), false);
  assert.equal(isValidReleasesPath('releases/foo.txt'), false);
  assert.equal(isValidReleasesPath('releases/..'), false);
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

test('releasesPath 含路径穿越 / 多层目录会被判非法', async (t) => {
  const traversal = validFixture();
  traversal.index.mods[0].releasesPath = 'releases/../x.json';
  const dir = await makeFixtureDir(traversal);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('releasesPath 非法')));

  const nested = validFixture();
  nested.index.mods[0].releasesPath = 'releases/a/b.json';
  const nestedDir = await makeFixtureDir(nested);
  t.after(() => rm(nestedDir, { recursive: true, force: true }));
  const nestedResult = await validateDir(nestedDir);
  assert.ok(nestedResult.errors.some((message) => message.includes('releasesPath 非法')));
});

// ---------- 下载量/体积统计与总表 ----------

test('index 统计字段与 per-mod 数据重算不一致会被发现', async (t) => {
  const fixture = validFixture();
  fixture.index.mods[0].totalDownloads = 999;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(
    result.errors.some((message) => message.includes('totalDownloads 与 per-mod 数据重算不一致')),
  );
});

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
