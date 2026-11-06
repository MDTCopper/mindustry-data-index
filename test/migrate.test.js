import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runMods } from '../src/main.js';
import { MODS_URL } from '../src/mods-source.js';
import {
  CURRENT_FORMAT_VERSION,
  migrateDataDir,
  migrateReleaseFileData,
  needsMigration,
} from '../src/migrate.js';

const GENERATED_AT = '2026-11-06T03:00:00.000Z';
const FETCHED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function officialMod(repo) {
  return {
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
    iconHash: null,
  };
}

function legacyReleaseFile(repo) {
  return {
    formatVersion: 2,
    repo,
    generatedAt: GENERATED_AT,
    source: { releasesEtag: 'W/"legacy"', releasesFetchedAt: FETCHED_AT },
    releases: [
      {
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
      },
    ],
    compat: [],
    meta: null,
  };
}

function fakeClients() {
  const apiCalls = [];
  const rawCalls = [];
  return {
    apiCalls,
    rawCalls,
    apiClient: {
      async get(url) {
        apiCalls.push(url);
        if (url.includes('/tags?')) {
          return {
            status: 200,
            text: JSON.stringify([{ name: 'v1.0' }, { name: 'v0.9' }]),
          };
        }
        throw new Error('迁移不应触发 release 抓取');
      },
    },
    rawClient: {
      async get(url) {
        rawCalls.push(url);
        if (url === MODS_URL) {
          return {
            status: 200,
            text: JSON.stringify([officialMod('owner/demo')]),
          };
        }
        // mod.hjson 不存在时 fetchModMetadata 会按 404 记 missing
        return { status: 404, text: '' };
      },
    },
  };
}

async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

test('旧 flat 文件迁移：读旧当缓存 → 写新路径 → 删旧文件，且不触发抓取', async (t) => {
  const repo = 'owner/demo';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // runMods 自带进度日志；测试里静音，避免污染 test runner 的 TAP 输出
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = originalLog;
    console.error = originalError;
  });
  await mkdir(path.join(dir, 'releases'), { recursive: true });
  await writeFile(
    path.join(dir, 'releases', 'owner_demo.json'),
    JSON.stringify(legacyReleaseFile(repo), null, 2),
  );

  const options = parseArgs(['--out', dir, '--repos', repo]);
  const clients = fakeClients();
  const result = await runMods(options, {
    apiClient: clients.apiClient,
    rawClient: clients.rawClient,
    outDir: dir,
    log: () => {},
  });

  assert.equal(result.code, 0);
  // 只应请求 tags（releases 页不重抓）
  assert.equal(clients.apiCalls.length, 1, '只应抓一次 tags');
  assert.ok(clients.apiCalls[0].includes('/tags?'));
  // 旧 flat 删除、新路径生成
  await assert.rejects(stat(path.join(dir, 'releases', 'owner_demo.json')), /ENOENT/);
  const newFile = JSON.parse(
    await readFile(path.join(dir, 'releases', 'owner', 'demo.json'), 'utf8'),
  );
  assert.equal(newFile.repo, repo);
  assert.equal('source' in newFile, false);
  // 原有 Release 条目保留并标 hasRelease=true；缺失的 git tag 补成 tag-only 条目
  assert.equal(newFile.releases.length, 2);
  assert.equal(newFile.releases[0].tag, 'v1.0');
  assert.equal(newFile.releases[0].hasRelease, true);
  assert.equal(newFile.releases[1].tag, 'v0.9');
  assert.equal(newFile.releases[1].hasRelease, false);
  assert.equal(newFile.releases[1].prerelease, null);
  assert.equal(newFile.releases[1].publishedAt, null);
  assert.deepEqual(newFile.releases[1].assets, []);
  assert.equal(
    newFile.releases[1].downloadUrl,
    'https://github.com/owner/demo/archive/refs/tags/v0.9.zip',
  );

  // index：releasesPath 新格式、releaseDataUpdatedAt 与文件一致、tagCount/releaseCount
  const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.mods[0].releasesPath, 'releases/owner/demo.json');
  assert.equal(index.mods[0].releaseDataUpdatedAt, newFile.generatedAt);
  assert.equal(index.mods[0].tagCount, 2);
  assert.equal(index.mods[0].releaseCount, 1);

  // state：以 repo 为键，第 1 页 ETag/时间从旧 source 迁移，tagsFetchedAt 已记录
  const state = JSON.parse(
    await readFile(path.join(dir, 'state', 'refresh.json'), 'utf8'),
  );
  const entry = state.mods[repo];
  assert.equal(entry.page1Etag, 'W/"legacy"');
  assert.equal(entry.page1FetchedAt, FETCHED_AT);
  assert.equal(typeof entry.tagsFetchedAt, 'string');

  // summary 带释放路径与 tagCount 列
  const summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8'));
  assert.equal(summary.mods[0].releasesPath, 'releases/owner/demo.json');
  assert.equal(summary.mods[0].tagCount, 2);
  const csv = await readFile(path.join(dir, 'summary.csv'), 'utf8');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.split('\r\n')[0].endsWith(',releasesPath'));

  // 第二次运行：一切不变（文件哈希验证）
  const hashes = {
    index: await hashFile(path.join(dir, 'index.json')),
    summary: await hashFile(path.join(dir, 'summary.json')),
    csv: await hashFile(path.join(dir, 'summary.csv')),
    state: await hashFile(path.join(dir, 'state', 'refresh.json')),
    release: await hashFile(path.join(dir, 'releases', 'owner', 'demo.json')),
  };
  const second = await runMods(options, {
    apiClient: clients.apiClient,
    rawClient: clients.rawClient,
    outDir: dir,
    log: () => {},
  });
  assert.equal(second.code, 0);
  assert.equal(second.changed, 0);
  assert.equal(second.indexChanged, false);
  assert.equal(second.summaryChanged, false);
  assert.equal(second.stateChanged, false);
  assert.equal(clients.apiCalls.length, 1, '第二次运行不再抓 tags/releases');
  assert.equal(await hashFile(path.join(dir, 'index.json')), hashes.index);
  assert.equal(await hashFile(path.join(dir, 'summary.json')), hashes.summary);
  assert.equal(await hashFile(path.join(dir, 'summary.csv')), hashes.csv);
  assert.equal(await hashFile(path.join(dir, 'state', 'refresh.json')), hashes.state);
  assert.equal(
    await hashFile(path.join(dir, 'releases', 'owner', 'demo.json')),
    hashes.release,
  );
});

test('处理旧 per-mod 文件（formatVersion 1）时本地迁移到 2，且不额外发 API', async (t) => {
  const repo = 'owner/demo';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-schema-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'releases', 'owner'), { recursive: true });
  await mkdir(path.join(dir, 'mindustry'), { recursive: true });
  await writeFile(
    path.join(dir, 'releases', 'owner', 'demo.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        repo,
        generatedAt: GENERATED_AT,
        releases: [
          {
            tag: 'v1.0',
            name: '1.0',
            prerelease: false,
            publishedAt: '2026-10-01T12:00:00Z',
            htmlUrl: `https://github.com/${repo}/releases/tag/v1.0`,
            modVersion: '1.0',
            minGameVersion: '146',
            metadataPath: 'mod.hjson',
            metadataStatus: 'ok',
            downloadUrl: `https://github.com/${repo}/downloads/v1.0.jar`,
            sourceArchiveUrl: `https://github.com/${repo}/archive/refs/tags/v1.0.zip`,
            assets: [],
            hasRelease: true,
          },
        ],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(dir, 'mindustry', 'versions.json'),
    JSON.stringify({ releases: [{ tag_name: 'v160.7' }] }),
  );
  const clients = fakeClients();
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = originalLog;
    console.error = originalError;
  });
  const result = await runMods(parseArgs(['--out', dir, '--repos', repo]), {
    apiClient: clients.apiClient,
    rawClient: clients.rawClient,
    outDir: dir,
    log: () => {},
  });
  assert.equal(result.code, 0);
  assert.equal(clients.apiCalls.length, 0, `迁移不应发 API 请求：${JSON.stringify(clients.apiCalls)}`);
  const file = JSON.parse(
    await readFile(path.join(dir, 'releases', 'owner', 'demo.json'), 'utf8'),
  );
  assert.equal(file.formatVersion, CURRENT_FORMAT_VERSION);
  assert.ok(Array.isArray(file.compat));
  assert.equal('meta' in file, true);
  assert.equal(file.meta, null);
  assert.equal(file.releases[0].commitSha, null);
  assert.equal(file.releases[0].archiveByCommitUrl, null);
  const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.mods[0].removedCount, 0);
  assert.equal(index.mods[0].compatRanges, file.compat.length);
});

test('migrateDataDir：官方+社区旧文件一次性迁移，第二次 0 文件变化', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-migrate-dir-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const officialRepo = 'owner/demo';
  const communityRepo = 'community/demo';
  const oldRelease = (repo) => ({
    formatVersion: 1,
    repo,
    generatedAt: GENERATED_AT,
    releases: [
      {
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
        downloadUrl: `https://github.com/${repo}/downloads/v1.0.jar`,
        sourceArchiveUrl: `https://github.com/${repo}/archive/refs/tags/v1.0.zip`,
        assets: [],
      },
    ],
  });
  await mkdir(path.join(dir, 'releases', 'owner'), { recursive: true });
  await mkdir(path.join(dir, 'community', 'releases', 'community'), { recursive: true });
  await mkdir(path.join(dir, 'mindustry'), { recursive: true });
  await writeFile(path.join(dir, 'releases', 'owner', 'demo.json'), JSON.stringify(oldRelease(officialRepo)));
  await writeFile(
    path.join(dir, 'community', 'releases', 'community', 'demo.json'),
    JSON.stringify(oldRelease(communityRepo)),
  );
  const indexEntry = (repo, pathValue, extra = {}) => ({
    repo,
    internalName: 'demo',
    name: 'Demo',
    author: 'author',
    version: '1.0',
    minGameVersion: '146',
    lastUpdated: '2026-10-01T00:00:00Z',
    stars: 1,
    hasIcon: false,
    hasScripts: false,
    hasJava: false,
    iconUrl: null,
    iconHash: null,
    releasesPath: pathValue,
    releaseCount: 1,
    tagCount: 1,
    totalDownloads: 0,
    allAssetsDownloads: 0,
    latestDownloads: 0,
    latestSizeBytes: null,
    totalSizeBytes: null,
    latestRelease: { tag: 'v1.0', name: '1.0', prerelease: false, publishedAt: '2026-10-01T12:00:00Z', downloads: 0, sizeBytes: null },
    releaseDataUpdatedAt: GENERATED_AT,
    ...extra,
  });
  await writeFile(
    path.join(dir, 'index.json'),
    JSON.stringify({
      formatVersion: 1,
      generatedAt: GENERATED_AT,
      source: { modsUrl: 'https://example.com/mods.json', modCount: 1 },
      mods: [indexEntry(officialRepo, 'releases/owner/demo.json')],
      skipped: [],
    }),
  );
  await writeFile(
    path.join(dir, 'community', 'index.json'),
    JSON.stringify({
      formatVersion: 1,
      generatedAt: GENERATED_AT,
      source: { source: 'topic', query: 'mindustry-mod in:topics', officialCount: 1 },
      mods: [
        indexEntry(communityRepo, 'community/releases/community/demo.json', {
          source: 'topic',
          description: 'desc',
        }),
      ],
      skipped: [],
    }),
  );
  await writeFile(
    path.join(dir, 'mindustry', 'versions.json'),
    JSON.stringify({
      update_time: GENERATED_AT,
      source: 'test',
      releases: [{ name: 'v160.7', tag_name: 'v160.7', published_at: GENERATED_AT, body: '', reactions: { total_count: 0 }, assets: [] }],
      latest_be: null,
    }),
  );

  const first = await migrateDataDir({ outDir: dir, now: GENERATED_AT });
  assert.equal(first.officialFiles, 1);
  assert.equal(first.communityFiles, 1);
  for (const file of [
    path.join(dir, 'releases', 'owner', 'demo.json'),
    path.join(dir, 'community', 'releases', 'community', 'demo.json'),
  ]) {
    const data = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(data.formatVersion, CURRENT_FORMAT_VERSION);
    assert.ok(Array.isArray(data.compat));
    assert.equal('meta' in data, true);
  }
  const officialIndex = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(officialIndex.mods[0].removedCount, 0);
  const communityIndex = JSON.parse(
    await readFile(path.join(dir, 'community', 'index.json'), 'utf8'),
  );
  assert.equal(communityIndex.mods[0].removedCount, 0);

  // 第二次：所有 per-mod 文件都不再重写
  const second = await migrateDataDir({ outDir: dir, now: GENERATED_AT });
  assert.equal(second.officialFiles, 0);
  assert.equal(second.communityFiles, 0);
});

test('needsMigration：formatVersion / compat / meta 缺失都视为需要迁移', () => {
  assert.equal(needsMigration(null), true);
  assert.equal(needsMigration({ formatVersion: 1 }), true);
  assert.equal(needsMigration({ formatVersion: 2, compat: [] }), true);
  assert.equal(needsMigration({ formatVersion: 2, compat: [], meta: null }), false);
  assert.equal(migrateReleaseFileData({ repo: 'a/b', previous: { formatVersion: 1, releases: [] }, compatData: null, now: GENERATED_AT, hasJava: false }).formatVersion, CURRENT_FORMAT_VERSION);
});
