import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runMods, sortModsForRefresh } from '../src/main.js';
import { RateLimitError } from '../src/github.js';
import { MODS_URL } from '../src/mods-source.js';

function officialMod(repo) {
  return {
    repo,
    internalName: repo.split('/')[1],
    name: repo,
    author: 'author',
    version: '1.0',
    minGameVersion: '146',
    lastUpdated: '2026-10-01T00:00:00Z',
    stars: 1,
    hasIcon: true,
    hasScripts: false,
    hasJava: false,
    iconHash: null,
  };
}

function makeRawClient(mods) {
  return {
    async get(url) {
      if (url === MODS_URL) {
        return { status: 200, text: JSON.stringify(mods) };
      }
      return { status: 404, text: '' };
    },
  };
}

function makeApiClient(getImpl, { remaining = null } = {}) {
  return {
    stats: { remaining },
    hasLowQuota(threshold = 5) {
      return this.stats.remaining !== null && this.stats.remaining <= threshold;
    },
    async get(url) {
      return getImpl(url);
    },
  };
}

async function run(dir, apiClient, mods, repos = ['a/one', 'b/two'], rawClient = makeRawClient(mods)) {
  const options = parseArgs(['--out', dir, '--repos', repos.join(',')]);
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try {
    return await runMods(options, {
      apiClient,
      rawClient,
      outDir: dir,
      log: () => {},
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

test('sortModsForRefresh：最近没刷新过的排前面', () => {
  const ordered = sortModsForRefresh(
    [{ repo: 'a/one' }, { repo: 'b/two' }, { repo: 'c/three' }],
    {
      mods: {
        'a/one': { page1FetchedAt: '2026-11-06T10:00:00.000Z' },
        'c/three': { page1FetchedAt: '2026-11-01T10:00:00.000Z' },
      },
    },
  );
  assert.deepEqual(
    ordered.map((mod) => mod.repo),
    ['b/two', 'c/three', 'a/one'],
  );
});

test('API 配额不足：中止本次、保留已抓结果、exit 0，下次从未刷新的模组续跑', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mods = [officialMod('a/one'), officialMod('b/two')];

  // 第一轮：a/one 正常（空 release/tag），b/two 触发 RateLimitError
  const apiCalls = [];
  const apiClient = makeApiClient((url) => {
    apiCalls.push(url);
    if (url.includes('/repos/a/one/')) {
      return { status: 200, text: '[]' };
    }
    throw new RateLimitError('配额不足');
  });
  const first = await run(dir, apiClient, mods);
  assert.equal(first.code, 0);
  assert.equal(first.unprocessed, 1);
  assert.ok(apiCalls.some((url) => url.includes('/repos/a/one/releases')));
  // b/two 只会发出触发限流的那一次请求，之后中止、不再请求
  assert.ok(
    apiCalls.filter((url) => url.includes('/repos/b/two/')).length <= 2,
  );
  // a/one 已抓并写盘；b/two 未处理
  const files = await readdir(path.join(dir, 'releases', 'a')).catch(() => []);
  assert.deepEqual(files, []);
  await assert.rejects(readdir(path.join(dir, 'releases', 'b')), /ENOENT/);

  const state = JSON.parse(
    await readFile(path.join(dir, 'state', 'refresh.json'), 'utf8'),
  );
  assert.ok(state.mods['a/one']);
  assert.equal(state.mods['b/two'], undefined);

  // 第二轮：b/two 排在最前、正常抓取
  const order = [];
  const secondApi = makeApiClient((url) => {
    order.push(url);
    return { status: 200, text: '[]' };
  });
  const second = await run(dir, secondApi, mods);
  assert.equal(second.code, 0);
  assert.equal(second.unprocessed, 0);
  assert.ok(order.some((url) => url.includes('/repos/b/two/releases')));
  const bFiles = await readdir(path.join(dir, 'releases', 'b')).catch(() => []);
  assert.deepEqual(bFiles, []);
});

test('运行前剩余配额已不足：不发请求、全部计为未处理、exit 0', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mods = [officialMod('a/one'), officialMod('b/two')];
  const apiCalls = [];
  const apiClient = makeApiClient((url) => {
    apiCalls.push(url);
    return { status: 200, text: '[]' };
  }, { remaining: 3 });
  const result = await run(dir, apiClient, mods);
  assert.equal(result.code, 0);
  assert.equal(result.unprocessed, 2);
  assert.equal(apiCalls.length, 0);
  await assert.rejects(readdir(path.join(dir, 'releases')), /ENOENT/);
});

test('index 为 v3：不再带 removedCount/iosCompatible/legacyCompatible，纯文本字段保留', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-newfields-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mods = [officialMod('a/one')];
  // 缓存一条带 minGameVersion 的版本，确保 v3 过滤/丢弃规则下仍保留该 mod
  await seedMod(dir, [releaseFixture('v1', SHA_V1)], {
    page1Etag: null,
    page1FetchedAt: '2026-11-06T00:00:00.000Z',
    page2FetchedAt: '2026-11-06T00:00:00.000Z',
    fullFetchedAt: '2020-01-01T00:00:00.000Z',
    tagsFetchedAt: '2026-11-06T00:00:00.000Z',
  });
  const result = await run(dir, tagAwareApi({ tags: [['v1', SHA_V1]] }), mods, ['a/one']);
  assert.equal(result.code, 0);
  const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.formatVersion, 3);
  assert.equal('removedCount' in index.mods[0], false);
  assert.equal('iosCompatible' in index.mods[0], false);
  assert.equal('legacyCompatible' in index.mods[0], false);
  assert.equal(index.mods[0].modType, 'json');
  assert.equal(typeof index.mods[0].gameVersionRanges, 'object');
  assert.equal(typeof index.mods[0].namePlain, 'string');
  assert.equal(typeof index.mods[0].authorPlain, 'string');
  assert.equal(typeof index.mods[0].descriptionPlain, 'string');
});

test('C8：最新 tag 元数据写入 per-mod meta，并校正 index 的 hasJava/hasScripts', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-meta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mod = { ...officialMod('a/one'), hasJava: false, hasScripts: false };
  const mods = [mod];
  const rawClient = {
    async get(url) {
      if (url === MODS_URL) {
        return { status: 200, text: JSON.stringify([{ ...mod, description: '[red]desc[]' }]) };
      }
      if (url.endsWith('/mod.hjson') || url.endsWith('/mod.json')) {
        return {
          status: 200,
          text: '{ name: "Demo", main: "a.b", minGameVersion: "146", dependencies: { mindustry: "146" }, description: "[red]desc[]" }',
        };
      }
      return { status: 404, text: '' };
    },
  };
  const result = await run(
    dir,
    tagAwareApi({
      tags: [['v1', SHA_V1]],
      releases: [
        {
          tag_name: 'v1',
          name: '1',
          published_at: '2026-10-01T00:00:00Z',
          prerelease: false,
          draft: false,
          assets: [
            {
              name: 'demo.jar',
              size: 123,
              download_count: 0,
              browser_download_url: 'https://github.com/a/one/releases/download/v1/demo.jar',
            },
          ],
        },
      ],
    }),
    mods,
    ['a/one'],
    rawClient,
  );
  assert.equal(result.code, 0);
  const file = JSON.parse(
    await readFile(path.join(dir, 'releases', 'a', 'one.json'), 'utf8'),
  );
  assert.deepEqual(file.meta, {
    name: 'Demo',
    author: null,
    description: '[red]desc[]',
    version: null,
    minGameVersion: '146',
    dependencies: { mindustry: '146' },
    hidden: false,
    legacyCompatible: false,
    main: 'a.b',
    java: false,
    hasScripts: false,
    hasJava: true,
  });
  const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.mods[0].modType, 'java');
  assert.equal(index.mods[0].descriptionPlain, 'desc');
});

// ---------- A1：commit sha / 删除留档 ----------

const SHA_V1 = '1'.repeat(40);
const SHA_V2 = '2'.repeat(40);

function releaseFixture(tag, sha = null) {
  return {
    tag,
    name: tag,
    hasRelease: true,
    prerelease: false,
    publishedAt: '2026-10-01T00:00:00Z',
    htmlUrl: `https://github.com/a/one/releases/tag/${tag}`,
    modVersion: tag.replace(/^v/, ''),
    minGameVersion: '146',
    metadataPath: 'mod.hjson',
    metadataStatus: 'ok',
    downloadUrl: `https://github.com/a/one/releases/download/${tag}/mod.jar`,
    sourceArchiveUrl: `https://github.com/a/one/archive/refs/tags/${tag}.zip`,
    assets: [],
    ...(sha ? { commitSha: sha, archiveByCommitUrl: `https://github.com/a/one/archive/${sha}.zip` } : {}),
  };
}

async function seedMod(dir, releases, stateEntry) {
  await mkdir(path.join(dir, 'releases', 'a'), { recursive: true });
  await writeFile(
    path.join(dir, 'releases', 'a', 'one.json'),
    JSON.stringify(
      { formatVersion: 2, repo: 'a/one', generatedAt: '2026-10-02T00:00:00.000Z', releases, compat: [], meta: null },
      null,
      2,
    ),
  );
  await mkdir(path.join(dir, 'state'), { recursive: true });
  await writeFile(
    path.join(dir, 'state', 'refresh.json'),
    JSON.stringify(
      { formatVersion: 1, updatedAt: '2026-10-02T00:00:00.000Z', mods: { 'a/one': stateEntry } },
      null,
      2,
    ),
  );
}

function tagItems(entries) {
  return entries.map(([name, sha]) => ({ name, commit: { sha } }));
}

function tagAwareApi({ releases = [], tags = [] }) {
  return makeApiClient((url) => {
    if (url.includes('/releases?')) {
      return { status: 200, text: JSON.stringify(releases) };
    }
    if (url.includes('/tags?')) {
      return { status: 200, text: JSON.stringify(tagItems(tags)) };
    }
    return { status: 200, text: '[]' };
  });
}

test('全量刷新：上游删除的 tag 保留在文件里并标 removed，index 记录 removedCount', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-removed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mods = [officialMod('a/one')];
  // 缓存里 v1/v2 都有 commit sha；本轮上游只剩 v2
  await seedMod(
    dir,
    [releaseFixture('v2', SHA_V2), releaseFixture('v1', SHA_V1)],
    {
      page1Etag: null,
      page1FetchedAt: '2026-11-06T00:00:00.000Z',
      page2FetchedAt: '2026-11-06T00:00:00.000Z',
      fullFetchedAt: '2020-01-01T00:00:00.000Z',
      tagsFetchedAt: '2026-11-06T00:00:00.000Z',
    },
  );
  const result = await run(dir, tagAwareApi({ tags: [['v2', SHA_V2]] }), mods, ['a/one']);
  assert.equal(result.code, 0);

  const file = JSON.parse(
    await readFile(path.join(dir, 'releases', 'a', 'one.json'), 'utf8'),
  );
  const byTag = new Map(file.versions.map((entry) => [entry.tag, entry]));
  assert.equal(file.versions.length, 2);
  assert.equal(byTag.get('v2').removed, undefined);
  assert.equal(byTag.get('v1').removed, true);
  assert.ok(byTag.get('v1').removedAt);
  assert.equal(byTag.get('v2').kind, 'tag');

  const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.mods[0].tagCount, 2);
  assert.equal(index.mods[0].releaseCount, 0);
  assert.equal('removedCount' in index.mods[0], false);
});

test('只刷部分页：不上游缺失判定为删除，远处缓存条目保持不变', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-partial-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mods = [officialMod('a/one')];
  const nowIso = new Date().toISOString();
  await seedMod(dir, [releaseFixture('v1', SHA_V1)], {
    page1Etag: null,
    page1FetchedAt: '2020-01-01T00:00:00.000Z',
    page2FetchedAt: nowIso,
    fullFetchedAt: nowIso,
    tagsFetchedAt: nowIso,
  });
  // 第 1 页 tags 只看到 v2；v1 没看到但这是部分刷新，不能标记删除
  const result = await run(dir, tagAwareApi({ tags: [['v2', SHA_V2]] }), mods, ['a/one']);
  assert.equal(result.code, 0);

  const file = JSON.parse(
    await readFile(path.join(dir, 'releases', 'a', 'one.json'), 'utf8'),
  );
  const byTag = new Map(file.versions.map((entry) => [entry.tag, entry]));
  assert.equal(byTag.get('v1').removed, undefined);
  assert.equal(byTag.get('v1').kind, 'tag');
});
