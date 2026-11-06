import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiReleasesUrl,
  sourceArchiveUrl,
  rawFileUrl,
  rawFileUrlVariants,
  pickDownloadUrl,
  normalizeRelease,
  normalizeReleases,
  hasNextPage,
  fetchReleases,
  mergeReleaseMetadata,
  buildReleasesFile,
} from '../src/releases.js';

function apiRelease(overrides = {}) {
  return {
    tag_name: 'v1.2.3',
    name: '1.2.3',
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T12:00:00Z',
    html_url: 'https://github.com/owner/repo/releases/tag/v1.2.3',
    assets: [],
    ...overrides,
  };
}

function fakeClient(pages, { etag = 'W/"first"' } = {}) {
  const calls = [];
  return {
    calls,
    async get(url, options = {}) {
      calls.push({ url, etag: options.etag ?? null });
      const page = Number(new URL(url).searchParams.get('page'));
      const pageData = pages[page - 1];
      if (typeof pageData === 'function') {
        return pageData({ url, options });
      }
      const headers = new Headers(pageData.headers ?? {});
      return {
        status: 200,
        headers,
        text: JSON.stringify(pageData.items),
        etag: page === 1 ? etag : null,
      };
    },
  };
}

test('API / 归档 / raw 地址生成', () => {
  assert.equal(
    apiReleasesUrl('owner/repo', 2),
    'https://api.github.com/repos/owner/repo/releases?per_page=100&page=2',
  );
  assert.equal(
    sourceArchiveUrl('owner/repo', 'v1.0 beta'),
    'https://github.com/owner/repo/archive/refs/tags/v1.0%20beta.zip',
  );
  assert.equal(
    sourceArchiveUrl('owner/repo', 'release/1.0'),
    'https://github.com/owner/repo/archive/refs/tags/release%2F1.0.zip',
  );
  assert.equal(
    rawFileUrl('owner/repo', 'v1.0 beta', 'mod.hjson'),
    'https://raw.githubusercontent.com/owner/repo/v1.0%20beta/mod.hjson',
  );
  // 优先整个 tag 走 encodeURIComponent（含 / 与 CJK）；特殊 tag 另给原样与 refs/tags 回退
  assert.equal(
    rawFileUrl('owner/repo', 'release/1.0', 'assets/mod.json'),
    'https://raw.githubusercontent.com/owner/repo/release%2F1.0/assets/mod.json',
  );
  assert.deepEqual(rawFileUrlVariants('owner/repo', 'v1.2.3', 'mod.hjson'), [
    'https://raw.githubusercontent.com/owner/repo/v1.2.3/mod.hjson',
  ]);
  assert.deepEqual(rawFileUrlVariants('owner/repo', 'release/1.0', 'mod.hjson'), [
    'https://raw.githubusercontent.com/owner/repo/release%2F1.0/mod.hjson',
    'https://raw.githubusercontent.com/owner/repo/release/1.0/mod.hjson',
    'https://raw.githubusercontent.com/owner/repo/refs/tags/release%2F1.0/mod.hjson',
  ]);
  assert.deepEqual(
    rawFileUrlVariants('owner/repo', 'v1.0 beta', 'mod.hjson'),
    [
      'https://raw.githubusercontent.com/owner/repo/v1.0%20beta/mod.hjson',
      'https://raw.githubusercontent.com/owner/repo/v1.0 beta/mod.hjson',
    ],
  );
  assert.deepEqual(rawFileUrlVariants('owner/repo', 'v1.0+', 'mod.hjson'), [
    'https://raw.githubusercontent.com/owner/repo/v1.0%2B/mod.hjson',
    'https://raw.githubusercontent.com/owner/repo/v1.0+/mod.hjson',
    'https://raw.githubusercontent.com/owner/repo/refs/tags/v1.0%2B/mod.hjson',
  ]);
});

test('CJK tag 的 raw / 源码归档地址全部走 URL 编码', () => {
  assert.equal(
    rawFileUrl('owner/repo', 'v1.0中文', 'mod.hjson'),
    'https://raw.githubusercontent.com/owner/repo/v1.0%E4%B8%AD%E6%96%87/mod.hjson',
  );
  assert.deepEqual(rawFileUrlVariants('owner/repo', 'v1.0中文', 'mod.hjson'), [
    'https://raw.githubusercontent.com/owner/repo/v1.0%E4%B8%AD%E6%96%87/mod.hjson',
    'https://raw.githubusercontent.com/owner/repo/v1.0中文/mod.hjson',
    'https://raw.githubusercontent.com/owner/repo/refs/tags/v1.0%E4%B8%AD%E6%96%87/mod.hjson',
  ]);
  assert.equal(
    sourceArchiveUrl('owner/repo', 'v1.0中文'),
    'https://github.com/owner/repo/archive/refs/tags/v1.0%E4%B8%AD%E6%96%87.zip',
  );
});

test('含 / 的 tag：源码归档用 %2F，raw 首选 %2F 形态', () => {
  assert.equal(
    sourceArchiveUrl('owner/repo', 'release/1.0'),
    'https://github.com/owner/repo/archive/refs/tags/release%2F1.0.zip',
  );
  assert.equal(
    rawFileUrl('owner/repo', 'release/1.0', 'mod.hjson'),
    'https://raw.githubusercontent.com/owner/repo/release%2F1.0/mod.hjson',
  );
  // 兜底变体包含原样 tag 与 refs/tags 形态
  const variants = rawFileUrlVariants('owner/repo', 'release/1.0', 'mod.hjson');
  assert.ok(
    variants.includes('https://raw.githubusercontent.com/owner/repo/release/1.0/mod.hjson'),
  );
  assert.ok(
    variants.includes(
      'https://raw.githubusercontent.com/owner/repo/refs/tags/release%2F1.0/mod.hjson',
    ),
  );
});

test('release 规范化：trim 名称、空名回退 tag、draft 跳过、prerelease 保留、assets 映射', () => {
  const release = normalizeRelease(apiRelease({ name: '  1.2.3  ' }), {
    repo: 'owner/repo',
    hasJava: true,
  });
  assert.equal(release.name, '1.2.3');
  assert.equal(release.tag, 'v1.2.3');
  assert.equal(release.prerelease, false);
  assert.equal(release.downloadUrl, sourceArchiveUrl('owner/repo', 'v1.2.3'));

  const fallback = normalizeRelease(apiRelease({ name: '   ' }), {
    repo: 'owner/repo',
    hasJava: false,
  });
  assert.equal(fallback.name, 'v1.2.3');

  assert.equal(
    normalizeRelease(apiRelease({ name: null }), { repo: 'owner/repo', hasJava: false }).name,
    'v1.2.3',
  );
  assert.equal(
    normalizeRelease(apiRelease({ draft: true }), { repo: 'owner/repo', hasJava: false }),
    null,
  );
  assert.equal(
    normalizeRelease(apiRelease({ tag_name: '' }), { repo: 'owner/repo', hasJava: false }),
    null,
  );

  const assets = [
    { name: 'mod.jar', size: 10, download_count: 2, browser_download_url: 'https://a/mod.jar' },
    { name: 'mod.zip', size: 20, download_count: 0, browser_download_url: 'https://a/mod.zip' },
  ];
  const withAssets = normalizeRelease(
    apiRelease({ prerelease: true, name: '  Beta  ', assets }),
    { repo: 'owner/repo', hasJava: true },
  );
  assert.equal(withAssets.prerelease, true);
  assert.equal(withAssets.name, 'Beta');
  assert.deepEqual(withAssets.assets, [
    { name: 'mod.jar', size: 10, downloadCount: 2, downloadUrl: 'https://a/mod.jar' },
    { name: 'mod.zip', size: 20, downloadCount: 0, downloadUrl: 'https://a/mod.zip' },
  ]);
  assert.equal(withAssets.downloadUrl, 'https://a/mod.jar');
});

test('downloadUrl：Java 优先 jar、非 Java 优先 zip、多个取最大、没有则回落源码', () => {
  const assets = [
    { name: 'small.jar', size: 10, downloadCount: 0, downloadUrl: 'https://a/small.jar' },
    { name: 'big.jar', size: 99, downloadCount: 0, downloadUrl: 'https://a/big.jar' },
    { name: 'mod.zip', size: 50, downloadCount: 0, downloadUrl: 'https://a/mod.zip' },
  ];
  const archive = 'https://github.com/owner/repo/archive/refs/tags/v1.zip';
  assert.equal(pickDownloadUrl(assets, { hasJava: true, archiveUrl: archive }), 'https://a/big.jar');
  assert.equal(pickDownloadUrl(assets, { hasJava: false, archiveUrl: archive }), 'https://a/mod.zip');
  assert.equal(
    pickDownloadUrl([assets[0]], { hasJava: true, archiveUrl: archive }),
    'https://a/small.jar',
  );
  // 非 Java 只有 jar 资产也回落源码；不跨后缀猜
  assert.equal(
    pickDownloadUrl([assets[0]], { hasJava: false, archiveUrl: archive }),
    archive,
  );
  assert.equal(pickDownloadUrl([], { hasJava: true, archiveUrl: archive }), archive);
});

test('normalizeReleases 保持 API 顺序并跳过 draft', () => {
  const releases = normalizeReleases(
    [
      apiRelease({ tag_name: 'v2' }),
      apiRelease({ tag_name: 'draft', draft: true }),
      apiRelease({ tag_name: 'v1' }),
    ],
    { repo: 'owner/repo', hasJava: false },
  );
  assert.deepEqual(
    releases.map((release) => release.tag),
    ['v2', 'v1'],
  );
});

test('hasNextPage 解析 Link 头', () => {
  assert.equal(hasNextPage(null), null);
  assert.equal(
    hasNextPage('<https://api.github.com/repos/o/r/releases?page=2>; rel="next"'),
    true,
  );
  assert.equal(
    hasNextPage('<https://api.github.com/repos/o/r/releases?page=1>; rel="prev"'),
    false,
  );
});

test('fetchReleases 分页取全并在第一页带 ETag', async () => {
  const items = Array.from({ length: 100 }, (_, index) => apiRelease({ tag_name: `v${index}` }));
  const client = fakeClient(
    [
      {
        items,
        headers: {
          link: '<https://api.github.com/repos/o/r/releases?page=2>; rel="next"',
        },
      },
      { items: [apiRelease({ tag_name: 'last' })] },
    ],
    { etag: 'W/"page1"' },
  );
  const result = await fetchReleases(client, 'owner/repo', { etag: 'W/"old"' });
  assert.equal(result.notModified, false);
  assert.equal(result.raws.length, 101);
  assert.equal(result.etag, 'W/"page1"');
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].etag, 'W/"old"');
  assert.equal(client.calls[1].etag, null);
});

test('fetchReleases 空列表与不足一页即结束', async () => {
  const client = fakeClient([{ items: [] }]);
  const result = await fetchReleases(client, 'owner/repo');
  assert.equal(result.notModified, false);
  assert.deepEqual(result.raws, []);
  assert.equal(client.calls.length, 1);
});

test('fetchReleases 304 直接复用，不再翻页', async () => {
  const client = fakeClient([
    () => ({ status: 304, headers: new Headers(), text: null, etag: 'W/"x"' }),
  ]);
  const result = await fetchReleases(client, 'owner/repo', { etag: 'W/"x"' });
  assert.deepEqual(result, { notModified: true });
  assert.equal(client.calls.length, 1);
});

test('fetchReleases 404 抛出带 status 的错误', async () => {
  const client = fakeClient([() => ({ status: 404, headers: new Headers(), text: '{}' })]);
  await assert.rejects(fetchReleases(client, 'owner/repo'), (error) => error.status === 404);
});

test('mergeReleaseMetadata：旧 ok 复用、新 tag 与未成功旧 tag 才抓取', async () => {
  const previousReleases = [
    {
      tag: 'v3',
      metadataStatus: 'unparsed',
      modVersion: null,
      minGameVersion: null,
      metadataPath: null,
    },
    {
      tag: 'v2',
      metadataStatus: 'ok',
      modVersion: '2.0',
      minGameVersion: '146',
      metadataPath: 'mod.hjson',
    },
  ];
  const releases = normalizeReleases(
    [apiRelease({ tag_name: 'v1' }), apiRelease({ tag_name: 'v2' }), apiRelease({ tag_name: 'v3' })],
    { repo: 'owner/demo', hasJava: true },
  );
  const fetchedTags = [];
  const result = await mergeReleaseMetadata({
    previousReleases,
    releases,
    fetchMetadata: async (tag) => {
      fetchedTags.push(tag);
      return {
        modVersion: `mod-${tag}`,
        minGameVersion: '160',
        metadataPath: 'mod.json',
        metadataStatus: 'ok',
      };
    },
  });

  assert.deepEqual(fetchedTags, ['v1', 'v3']);
  assert.equal(result.metaFetched, 2);
  assert.equal(result.metaReused, 1);
  assert.deepEqual(
    result.releases.map((release) => release.tag),
    ['v1', 'v2', 'v3'],
  );
  assert.equal(result.releases[1].modVersion, '2.0');
  assert.equal(result.releases[1].metadataPath, 'mod.hjson');
  assert.equal(result.releases[0].modVersion, 'mod-v1');
  assert.equal(result.releases[2].minGameVersion, '160');
});

test('mergeReleaseMetadata：抓取抛错记为 unparsed 供下次重试', async () => {
  const releases = normalizeReleases([apiRelease({ tag_name: 'v1' })], {
    repo: 'owner/demo',
    hasJava: false,
  });
  const result = await mergeReleaseMetadata({
    previousReleases: [],
    releases,
    fetchMetadata: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(result.releases[0].metadataStatus, 'unparsed');
  assert.equal(result.releases[0].modVersion, null);
  assert.equal(result.releases[0].metadataPath, null);
});

test('buildReleasesFile 写入 source 与 generatedAt', () => {
  const file = buildReleasesFile({
    repo: 'owner/repo',
    releases: [],
    etag: 'W/"e"',
    fetchedAt: '2026-11-06T03:00:00.000Z',
  });
  assert.equal(file.formatVersion, 1);
  assert.equal(file.repo, 'owner/repo');
  assert.deepEqual(file.source, {
    releasesEtag: 'W/"e"',
    releasesFetchedAt: '2026-11-06T03:00:00.000Z',
  });
  assert.equal(file.generatedAt, '2026-11-06T03:00:00.000Z');
  assert.deepEqual(file.releases, []);
});
