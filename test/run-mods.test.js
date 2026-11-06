import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

async function run(dir, apiClient, mods) {
  const options = parseArgs(['--out', dir, '--repos', 'a/one,b/two']);
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try {
    return await runMods(options, {
      apiClient,
      rawClient: makeRawClient(mods),
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
  assert.equal(
    apiCalls.filter((url) => url.includes('/repos/b/two/')).length,
    1,
  );
  // a/one 已抓并写盘；b/two 未处理
  const files = await readdir(path.join(dir, 'releases', 'a'));
  assert.deepEqual(files, ['one.json']);
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
  assert.ok(order[0].includes('/repos/b/two/'));
  const bFiles = await readdir(path.join(dir, 'releases', 'b'));
  assert.deepEqual(bFiles, ['two.json']);
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
