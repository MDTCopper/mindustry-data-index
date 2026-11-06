import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runMods } from '../src/main.js';
import { MODS_URL } from '../src/mods-source.js';

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
    formatVersion: 1,
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
        throw new Error('迁移不应触发 API 抓取');
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
        throw new Error(`迁移不应请求 ${url}`);
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
  assert.equal(clients.apiCalls.length, 0, '迁移不应消耗 API');
  // 旧 flat 删除、新路径生成
  await assert.rejects(stat(path.join(dir, 'releases', 'owner_demo.json')), /ENOENT/);
  const newFile = JSON.parse(
    await readFile(path.join(dir, 'releases', 'owner', 'demo.json'), 'utf8'),
  );
  assert.equal(newFile.repo, repo);
  // 迁移不改变数据与 generatedAt，且不再写 source
  assert.equal(newFile.generatedAt, GENERATED_AT);
  assert.deepEqual(newFile.releases, legacyReleaseFile(repo).releases);
  assert.equal('source' in newFile, false);

  // index：releasesPath 新格式、releaseDataUpdatedAt 与文件一致
  const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.mods[0].releasesPath, 'releases/owner/demo.json');
  assert.equal(index.mods[0].releaseDataUpdatedAt, GENERATED_AT);

  // state：以 repo 为键，第 1 页 ETag/时间从旧 source 迁移
  const state = JSON.parse(
    await readFile(path.join(dir, 'state', 'refresh.json'), 'utf8'),
  );
  const entry = state.mods[repo];
  assert.equal(entry.page1Etag, 'W/"legacy"');
  assert.equal(entry.page1FetchedAt, FETCHED_AT);

  // summary 带释放路径列
  const summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8'));
  assert.equal(summary.mods[0].releasesPath, 'releases/owner/demo.json');
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
  assert.equal(await hashFile(path.join(dir, 'index.json')), hashes.index);
  assert.equal(await hashFile(path.join(dir, 'summary.json')), hashes.summary);
  assert.equal(await hashFile(path.join(dir, 'summary.csv')), hashes.csv);
  assert.equal(await hashFile(path.join(dir, 'state', 'refresh.json')), hashes.state);
  assert.equal(
    await hashFile(path.join(dir, 'releases', 'owner', 'demo.json')),
    hashes.release,
  );
});
