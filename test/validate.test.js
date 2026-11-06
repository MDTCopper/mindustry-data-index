import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDir, validateReleaseFileData, validateIndexData, isValidReleasesPath } from '../src/validate.js';
import { VERSIONS_API } from '../src/versions.js';
import { buildSummary, summaryCsv } from '../src/summary.js';
import {
  buildGateFile,
  mergeGateRules,
} from '../src/mod-gate.js';

const GENERATED_AT = '2026-11-06T03:00:00.000Z';

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
          releasesPath: releasesRelPath(repo),
          releaseCount: 1,
          tagCount: 1,
          removedCount: 0,
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
          latestCompatible: null,
          compatRanges: 0,
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
      compat: [],
    },
  };
}

function summaryRow(entry, releaseFile) {
  const first = releaseFile.releases.find((release) => release.hasRelease !== false) ?? null;
  return {
    repo: entry.repo,
    name: entry.name,
    author: entry.author,
    stars: entry.stars,
    releaseCount: entry.releaseCount,
    tagCount: entry.tagCount,
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
    releasesPath: entry.releasesPath,
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
  const relPath = releasesRelPath(releaseFile.repo);
  await mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
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
  assert.ok(result.errors.some((message) => message.includes('iconHash 应为非空字符串或 null')));
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

function withTagOnly(fixture = validFixture()) {
  fixture.releaseFile.releases.push(tagOnlyEntry(fixture.releaseFile.repo));
  fixture.index.mods[0].tagCount = 2;
  return fixture;
}

test('tag-only 条目（hasRelease=false）校验通过', async (t) => {
  const dir = await makeFixtureDir(withTagOnly());
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('tag-only 条目字段不合法会被发现', async (t) => {
  const fixture = withTagOnly();
  const tagOnly = fixture.releaseFile.releases[1];
  tagOnly.prerelease = false;
  tagOnly.publishedAt = '2026-10-01T12:00:00Z';
  tagOnly.assets = [{ name: 'x.jar', size: 1, downloadCount: 0, downloadUrl: 'https://x' }];
  tagOnly.downloadUrl = 'https://github.com/owner/demo/releases/download/v0.9/x.jar';
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('prerelease 在 hasRelease=false')));
  assert.ok(result.errors.some((message) => message.includes('publishedAt 在 hasRelease=false')));
  assert.ok(result.errors.some((message) => message.includes('assets 在 hasRelease=false')));
  assert.ok(result.errors.some((message) => message.includes('downloadUrl 在 hasRelease=false')));
});

test('tagCount / releaseCount 与文件条数不一致会被发现', async (t) => {
  const fixture = withTagOnly();
  fixture.index.mods[0].tagCount = 3;
  fixture.index.mods[0].releaseCount = 2;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('tagCount（3）')));
  assert.ok(result.errors.some((message) => message.includes('hasRelease=true 条数')));
});

// ---------- 社区模组（community/） ----------

function communityFixture({ repo = 'communitymods/demo' } = {}) {
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
    downloadUrl: `https://github.com/${repo}/archive/refs/tags/v1.0.zip`,
    sourceArchiveUrl: `https://github.com/${repo}/archive/refs/tags/v1.0.zip`,
    assets: [],
  };
  const entry = {
    repo,
    source: 'topic',
    internalName: null,
    name: 'Demo',
    author: 'author',
    version: '1.0',
    minGameVersion: '146',
    description: 'a community mod',
    lastUpdated: '2026-11-01T00:00:00Z',
    stars: 2,
    hasIcon: false,
    hasScripts: false,
    hasJava: false,
    iconUrl: null,
    iconHash: null,
    releasesPath: `community/releases/${repo}.json`,
    releaseCount: 1,
    tagCount: 1,
    removedCount: 0,
    totalDownloads: 0,
    allAssetsDownloads: 0,
    latestDownloads: 0,
    latestSizeBytes: null,
    totalSizeBytes: null,
    latestRelease: {
      tag: 'v1.0',
      name: '1.0',
      prerelease: false,
      publishedAt: '2026-10-01T12:00:00Z',
      downloads: 0,
      sizeBytes: null,
    },
    latestCompatible: null,
    compatRanges: 0,
    releaseDataUpdatedAt: GENERATED_AT,
  };
  return {
    index: {
      formatVersion: 1,
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
      formatVersion: 1,
      repo,
      generatedAt: GENERATED_AT,
      releases: [release],
      compat: [],
    },
    entry,
    release,
  };
}

async function addCommunityFixture(dir, fixture = communityFixture()) {
  const communityDir = path.join(dir, 'community');
  await mkdir(path.join(communityDir, 'releases', 'communitymods'), { recursive: true });
  await writeFile(
    path.join(communityDir, 'index.json'),
    JSON.stringify(fixture.index, null, 2),
  );
  const filePath = path.join(communityDir, 'releases', `${fixture.releaseFile.repo}.json`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(fixture.releaseFile, null, 2));
  const row = {
    repo: fixture.entry.repo,
    name: fixture.entry.name,
    author: fixture.entry.author,
    stars: fixture.entry.stars,
    releaseCount: fixture.entry.releaseCount,
    tagCount: fixture.entry.tagCount,
    totalDownloads: fixture.entry.totalDownloads,
    allAssetsDownloads: fixture.entry.allAssetsDownloads,
    latestDownloads: fixture.entry.latestDownloads,
    latestSizeBytes: fixture.entry.latestSizeBytes,
    totalSizeBytes: fixture.entry.totalSizeBytes,
    latestTag: fixture.entry.latestRelease.tag,
    latestPrerelease: fixture.entry.latestRelease.prerelease,
    latestModVersion: fixture.release.modVersion,
    latestMinGameVersion: fixture.release.minGameVersion,
    iconUrl: null,
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

test('compat：引用不存在的 tag / 已删除条目 / 区间重叠会被发现', () => {
  const base = (compat) => ({
    ...validFixture().releaseFile,
    compat,
  });
  let errors = [];
  validateReleaseFileData(
    base([
      { tag: 'v9', modVersion: '9', minGameVersion: '146', maxGameVersion: null, hasRelease: true },
    ]),
    { errors },
  );
  assert.ok(errors.some((message) => message.includes('tag 不存在于 releases')));

  const removedFile = validFixture().releaseFile;
  removedFile.releases[0].removed = true;
  removedFile.releases[0].removedAt = GENERATED_AT;
  errors = [];
  validateReleaseFileData(
    {
      ...removedFile,
      compat: [
        { tag: 'v1.0', modVersion: '1.0', minGameVersion: '146', maxGameVersion: null, hasRelease: true },
      ],
    },
    { errors },
  );
  assert.ok(errors.some((message) => message.includes('已删除留档')));

  const overlapping = [
    { tag: 'v1.0', modVersion: '1.0', minGameVersion: '146', maxGameVersion: 160, hasRelease: true },
    { tag: 'v1.0', modVersion: '1.0', minGameVersion: '154', maxGameVersion: null, hasRelease: true },
  ];
  errors = [];
  validateReleaseFileData(base(overlapping), { errors });
  assert.ok(errors.some((message) => message.includes('重叠')));
});

test('commitSha / archiveByCommitUrl / removedAt 校验', () => {
  const file = validFixture().releaseFile;
  file.releases[0].commitSha = SHA;
  file.releases[0].archiveByCommitUrl = `https://github.com/owner/demo/archive/${SHA}.zip`;
  let errors = [];
  validateReleaseFileData(file, { errors });
  assert.deepEqual(errors, []);

  file.releases[0].archiveByCommitUrl = 'https://github.com/owner/demo/archive/wrong.zip';
  errors = [];
  validateReleaseFileData(file, { errors });
  assert.ok(errors.some((message) => message.includes('archiveByCommitUrl')));

  const removed = validFixture().releaseFile;
  removed.releases[0].removed = true;
  errors = [];
  validateReleaseFileData(removed, { errors });
  assert.ok(errors.some((message) => message.includes('removedAt')));
});

test('index removedCount / compatRanges / latestCompatible 字段校验', () => {
  const fixture = validFixture();
  let errors = [];
  validateIndexData(fixture.index, { errors });
  assert.deepEqual(errors, []);

  fixture.index.mods[0].removedCount = 5;
  fixture.index.mods[0].compatRanges = -1;
  fixture.index.mods[0].latestCompatible = 42;
  errors = [];
  validateIndexData(fixture.index, { errors });
  assert.ok(errors.some((message) => message.includes('removedCount 不能大于')));
  assert.ok(errors.some((message) => message.includes('compatRanges')));
  assert.ok(errors.some((message) => message.includes('latestCompatible')));
});

test('validateDir：compat 与 index 的 compatRanges / removedCount 一致性', async (t) => {
  const fixture = validFixture();
  fixture.releaseFile.compat = [
    { tag: 'v1.0', modVersion: '1.0', minGameVersion: '146', maxGameVersion: null, hasRelease: true },
  ];
  fixture.index.mods[0].compatRanges = 1;
  // 没有游戏版本数据时 latestCompatible 应为 null
  fixture.index.mods[0].latestCompatible = null;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
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
