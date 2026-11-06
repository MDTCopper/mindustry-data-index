import test from 'node:test';
import assert from 'node:assert/strict';
import {
  versionsApiUrl,
  latestBeApiUrl,
  trimRelease,
  trimLatestBe,
  buildVersionsFile,
  versionsBodyChanged,
  fetchAllVersions,
  fetchVersionsIncremental,
  fetchLatestBe,
} from '../src/versions.js';

function rawRelease(index, overrides = {}) {
  return {
    name: `v8 Build 15${index}`,
    tag_name: `v15${index}`,
    published_at: '2026-10-01T12:00:00Z',
    body: '更新说明不应该被保留',
    reactions: { total_count: 10 + index },
    assets: [
      {
        name: 'Mindustry.jar',
        size: 100 + index,
        download_count: 5,
        browser_download_url: `https://github.com/Anuken/Mindustry/releases/download/v15${index}/Mindustry.jar`,
      },
    ],
    ...overrides,
  };
}

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    async get(url, options = {}) {
      calls.push({ url, etag: options.etag ?? null });
      return handler(url, options);
    },
  };
}

function pageResponse(items, { etag = null, headers = {} } = {}) {
  return {
    status: 200,
    headers: new Headers({ ...(etag ? { etag } : {}), ...headers }),
    text: JSON.stringify(items),
    etag,
  };
}

test('versions API 地址', () => {
  assert.equal(
    versionsApiUrl(2),
    'https://api.github.com/repos/Anuken/Mindustry/releases?per_page=100&page=2',
  );
  assert.equal(
    latestBeApiUrl(),
    'https://api.github.com/repos/Anuken/MindustryBuilds/releases?per_page=1',
  );
});

test('trimRelease：body 空串、reactions 只留 total_count、assets 四个字段、name 原样', () => {
  const trimmed = trimRelease(
    rawRelease(1, { name: 'v8 Build 160.7 ', reactions: { total_count: 100 } }),
  );
  assert.equal(trimmed.name, 'v8 Build 160.7 ');
  assert.equal(trimmed.body, '');
  assert.deepEqual(trimmed.reactions, { total_count: 100 });
  assert.deepEqual(trimmed.assets, [
    {
      name: 'Mindustry.jar',
      size: 101,
      download_count: 5,
      browser_download_url:
        'https://github.com/Anuken/Mindustry/releases/download/v151/Mindustry.jar',
    },
  ]);
  assert.deepEqual(Object.keys(trimmed), [
    'name',
    'tag_name',
    'published_at',
    'body',
    'reactions',
    'assets',
  ]);
});

test('trimLatestBe：没有 reactions 键；null 输入返回 null', () => {
  const trimmed = trimLatestBe(rawRelease(2));
  assert.equal(trimmed.name, 'v8 Build 152');
  assert.equal(trimmed.body, '');
  assert.equal(Object.prototype.hasOwnProperty.call(trimmed, 'reactions'), false);
  assert.equal(trimLatestBe(null), null);
});

test('buildVersionsFile 形状与 etags', () => {
  const file = buildVersionsFile({
    releases: [trimRelease(rawRelease(1))],
    latestBe: trimLatestBe(rawRelease(2)),
    etags: { releases: 'W/"a"', latestBe: 'W/"b"' },
    updateTime: '2026-11-06T03:00:00Z',
  });
  assert.equal(file.update_time, '2026-11-06T03:00:00Z');
  assert.equal(file.source, 'https://api.github.com/repos/Anuken/Mindustry/releases');
  assert.equal(file.releases.length, 1);
  assert.equal(file.latest_be.tag_name, 'v152');
  assert.deepEqual(file.etags, { releases: 'W/"a"', latestBe: 'W/"b"' });
});

test('versionsBodyChanged 忽略 update_time / etags，只认 releases 与 latest_be', () => {
  const base = buildVersionsFile({
    releases: [trimRelease(rawRelease(1))],
    latestBe: trimLatestBe(rawRelease(2)),
    etags: { releases: 'W/"a"', latestBe: 'W/"b"' },
    updateTime: '2026-11-06T03:00:00Z',
  });
  assert.equal(versionsBodyChanged(null, base), true);

  const edited = buildVersionsFile({
    releases: base.releases,
    latestBe: base.latest_be,
    etags: { releases: 'W/"c"', latestBe: 'W/"d"' },
    updateTime: '2026-11-06T04:00:00Z',
  });
  assert.equal(versionsBodyChanged(base, edited), false);

  const newRelease = buildVersionsFile({
    releases: [trimRelease(rawRelease(3)), ...base.releases],
    latestBe: base.latest_be,
    etags: base.etags,
    updateTime: base.update_time,
  });
  assert.equal(versionsBodyChanged(base, newRelease), true);

  const newBe = buildVersionsFile({
    releases: base.releases,
    latestBe: trimLatestBe(rawRelease(4)),
    etags: base.etags,
    updateTime: base.update_time,
  });
  assert.equal(versionsBodyChanged(base, newBe), true);
});

test('fetchAllVersions 分页取全，第一页带 ETag', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => rawRelease(index));
  const client = fakeClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 1) {
      return pageResponse(firstPage, { etag: 'W/"p1"' });
    }
    return pageResponse([rawRelease(100)]);
  });
  const result = await fetchAllVersions(client, { etag: 'W/"old"' });
  assert.equal(result.notModified, false);
  assert.equal(result.raws.length, 101);
  assert.equal(result.etag, 'W/"p1"');
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].etag, 'W/"old"');
  assert.equal(client.calls[1].etag, null);
});

test('fetchAllVersions 304 直接复用，不再翻页', async () => {
  const client = fakeClient(() => ({ status: 304, headers: new Headers(), text: null, etag: null }));
  const result = await fetchAllVersions(client, { etag: 'W/"x"' });
  assert.deepEqual(result, { notModified: true });
  assert.equal(client.calls.length, 1);
});

test('fetchAllVersions 遵守 --versions-pages 上限', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => rawRelease(index));
  const client = fakeClient(() => pageResponse(firstPage, { etag: 'W/"p1"' }));
  const result = await fetchAllVersions(client, { maxPages: 1 });
  assert.equal(result.raws.length, 100);
  assert.equal(client.calls.length, 1);
});

test('fetchLatestBe 取 per_page=1 的第一条；304 复用', async () => {
  const client = fakeClient(() => pageResponse([rawRelease(7)], { etag: 'W/"be"' }));
  const result = await fetchLatestBe(client, {});
  assert.equal(result.notModified, false);
  assert.equal(result.release.tag_name, 'v157');
  assert.equal(result.etag, 'W/"be"');
  assert.equal(
    client.calls[0].url,
    'https://api.github.com/repos/Anuken/MindustryBuilds/releases?per_page=1',
  );

  const notModifiedClient = fakeClient(() => ({
    status: 304,
    headers: new Headers(),
    text: null,
    etag: null,
  }));
  assert.deepEqual(await fetchLatestBe(notModifiedClient, { etag: 'W/"be"' }), {
    notModified: true,
  });
});

// ---------- 30 分钟任务的轻量增量 ----------

function localReleases(count, start = 0) {
  return Array.from({ length: count }, (_, index) => trimRelease(rawRelease(start + index)));
}

test('fetchVersionsIncremental：304 时直接复用，仅 1 次 API', async () => {
  const client = fakeClient(() => ({
    status: 304,
    headers: new Headers(),
    text: null,
    etag: null,
  }));
  const result = await fetchVersionsIncremental(client, {
    etag: 'W/"x"',
    localReleases: localReleases(5),
  });
  assert.deepEqual(result, { notModified: true });
  assert.equal(client.calls.length, 1);
});

test('fetchVersionsIncremental：第一页全是已知 release 时只抓第一页并合并', async () => {
  const local = localReleases(150);
  // 第一页取本地前 100 条（模拟没有新版本），只有 reaction 数不同
  const page1 = Array.from({ length: 100 }, (_, index) =>
    rawRelease(99 - index, { reactions: { total_count: 999 } }),
  );
  const client = fakeClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return pageResponse(page === 1 ? page1 : [], { etag: 'W/"p1"' });
  });
  const result = await fetchVersionsIncremental(client, {
    etag: 'W/"old"',
    localReleases: local,
  });
  assert.equal(result.notModified, false);
  assert.equal(result.rebuilt, false);
  assert.equal(result.fetchedPages, 1);
  assert.equal(client.calls.length, 1);
  assert.equal(result.releases.length, 150);
  assert.equal(result.releases[0].reactions.total_count, 999);
  // 本地旧的前 100 条被第一页覆盖，其余 50 条保留在末尾
  assert.equal(result.releases[100].tag_name, local[100].tag_name);
});

test('fetchVersionsIncremental：第一页出现未知 release 时翻页重建', async () => {
  const local = localReleases(150);
  const page1 = [rawRelease(900, { tag_name: 'v1900' }), ...Array.from({ length: 99 }, (_, index) => rawRelease(index))];
  const page2 = Array.from({ length: 50 }, (_, index) => rawRelease(100 + index));
  const client = fakeClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 1) {
      return pageResponse(page1, { etag: 'W/"p1"' });
    }
    return pageResponse(page2, { etag: null });
  });
  const result = await fetchVersionsIncremental(client, {
    etag: 'W/"old"',
    localReleases: local,
  });
  assert.equal(result.rebuilt, true);
  assert.equal(result.fetchedPages, 2);
  assert.equal(client.calls.length, 2);
  assert.equal(result.releases.length, 150);
});

test('fetchVersionsIncremental：没有本地列表时全量翻页', async () => {
  const page1 = Array.from({ length: 100 }, (_, index) => rawRelease(index));
  const page2 = Array.from({ length: 5 }, (_, index) => rawRelease(100 + index));
  const client = fakeClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return pageResponse(page === 1 ? page1 : page2, {
      etag: page === 1 ? 'W/"p1"' : null,
    });
  });
  const result = await fetchVersionsIncremental(client, {});
  assert.equal(result.rebuilt, true);
  assert.equal(result.fetchedPages, 2);
  assert.equal(result.releases.length, 105);
});
