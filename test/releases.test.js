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
  sortReleases,
  mergeReleasesByTag,
  buildTagOnlyRelease,
  isReleaseEntry,
  fetchAllReleasePages,
  fetchReleasePages,
  mergeReleaseMetadata,
  mergeWithShaAndRemovals,
  archiveByCommitUrl,
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

function pageResponse(items, { etag = null } = {}) {
  return {
    status: 200,
    headers: new Headers(etag ? { etag } : {}),
    text: JSON.stringify(items),
    etag,
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
  assert.deepEqual(rawFileUrlVariants('owner/repo', 'v1.0 beta', 'mod.hjson'), [
    'https://raw.githubusercontent.com/owner/repo/v1.0%20beta/mod.hjson',
    'https://raw.githubusercontent.com/owner/repo/v1.0 beta/mod.hjson',
  ]);
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
  assert.equal(
    sourceArchiveUrl('owner/repo', 'v1.0中文'),
    'https://github.com/owner/repo/archive/refs/tags/v1.0%E4%B8%AD%E6%96%87.zip',
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

test('sortReleases：publishedAt 降序、同时间按 tag 升序、缺失时间排最后', () => {
  const releases = [
    { tag: 'b', publishedAt: '2026-10-01T00:00:00Z' },
    { tag: 'a', publishedAt: '2026-10-01T00:00:00Z' },
    { tag: 'new', publishedAt: '2026-11-01T00:00:00Z' },
    { tag: 'none', publishedAt: null },
  ];
  assert.deepEqual(
    sortReleases(releases).map((release) => release.tag),
    ['new', 'a', 'b', 'none'],
  );
});

test('mergeReleasesByTag：抓到的页覆盖同 tag（下载量更新），旧条目保留', () => {
  const previous = [
    { tag: 'v3', publishedAt: '2026-10-03T00:00:00Z', assets: [{ downloadCount: 1 }] },
    { tag: 'v2', publishedAt: '2026-10-02T00:00:00Z', assets: [{ downloadCount: 2 }] },
    { tag: 'v1', publishedAt: '2026-10-01T00:00:00Z', assets: [{ downloadCount: 3 }] },
  ];
  const fetched = [
    { tag: 'v4', publishedAt: '2026-10-04T00:00:00Z', assets: [{ downloadCount: 4 }] },
    { tag: 'v3', publishedAt: '2026-10-03T00:00:00Z', assets: [{ downloadCount: 99 }] },
  ];
  const merged = mergeReleasesByTag(previous, fetched);
  assert.deepEqual(
    merged.map((release) => release.tag),
    ['v4', 'v3', 'v2', 'v1'],
  );
  assert.equal(merged.find((release) => release.tag === 'v3').assets[0].downloadCount, 99);
  // 旧条目对象原样保留（元数据不会被重抓）
  assert.equal(
    merged.find((release) => release.tag === 'v1'),
    previous.find((release) => release.tag === 'v1'),
  );
});

test('fetchAllReleasePages：从第 1 页抓到不足一页', async () => {
  const client = fakeClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 1) {
      return pageResponse(
        Array.from({ length: 100 }, (_, index) => apiRelease({ tag_name: `v${index}` })),
        { etag: 'W/"p1"' },
      );
    }
    return pageResponse([apiRelease({ tag_name: 'last' })], { etag: null });
  });
  const pages = await fetchAllReleasePages(client, 'owner/repo');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].items.length, 100);
  assert.equal(pages[0].etag, 'W/"p1"');
  assert.equal(pages[1].items.length, 1);
  assert.equal(client.calls.length, 2);
});

test('fetchReleasePages：只抓指定页并只为第 1 页带旧 ETag；304 标记', async () => {
  const client = fakeClient((url, options) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 1) {
      return {
        status: 304,
        headers: new Headers({ etag: options.etag }),
        text: null,
        etag: options.etag,
      };
    }
    return pageResponse([apiRelease({ tag_name: `p${page}` })], { etag: 'W/"p2"' });
  });
  const pages = await fetchReleasePages(client, 'owner/repo', {
    pages: [1, 2],
    etags: { 1: 'W/"old"' },
  });
  assert.equal(pages.length, 2);
  assert.equal(pages[0].notModified, true);
  assert.equal(client.calls[0].etag, 'W/"old"');
  assert.equal(client.calls[1].etag, null);
  assert.equal(pages[1].notModified, false);
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
  const v2 = result.releases.find((release) => release.tag === 'v2');
  assert.equal(v2.modVersion, '2.0');
  assert.equal(v2.metadataPath, 'mod.hjson');
});

test('buildReleasesFile：formatVersion / repo / generatedAt / releases / compat', () => {
  const file = buildReleasesFile({
    repo: 'owner/repo',
    releases: [],
    generatedAt: '2026-11-06T03:00:00.000Z',
  });
  assert.deepEqual(file, {
    formatVersion: 2,
    repo: 'owner/repo',
    generatedAt: '2026-11-06T03:00:00.000Z',
    releases: [],
    compat: [],
    meta: null,
  });
  assert.deepEqual(
    buildReleasesFile({
      repo: 'owner/repo',
      releases: [],
      compat: [{ tag: 'v1' }],
      generatedAt: '2026-11-06T03:00:00.000Z',
    }).compat,
    [{ tag: 'v1' }],
  );
});

test('normalizeRelease：有 Release 的条目 hasRelease=true', () => {
  const release = normalizeRelease(apiRelease(), { repo: 'owner/repo', hasJava: false });
  assert.equal(release.hasRelease, true);
});

test('isReleaseEntry：缺字段视作 release，只有 false 才是 tag-only', () => {
  assert.equal(isReleaseEntry({ tag: 'v1' }), true);
  assert.equal(isReleaseEntry({ tag: 'v1', hasRelease: true }), true);
  assert.equal(isReleaseEntry({ tag: 'v1', hasRelease: false }), false);
  assert.equal(isReleaseEntry(null), false);
});

test('buildTagOnlyRelease：tag-only 字段齐全、下载回落源码归档', () => {
  const entry = buildTagOnlyRelease({ repo: 'oscillatorium/alef-null', tag: 'v1.04' });
  assert.deepEqual(entry, {
    tag: 'v1.04',
    name: 'v1.04',
    hasRelease: false,
    prerelease: null,
    publishedAt: null,
    htmlUrl: 'https://github.com/oscillatorium/alef-null/tree/v1.04',
    modVersion: null,
    minGameVersion: null,
    metadataPath: null,
    metadataStatus: null,
    downloadUrl:
      'https://github.com/oscillatorium/alef-null/archive/refs/tags/v1.04.zip',
    sourceArchiveUrl:
      'https://github.com/oscillatorium/alef-null/archive/refs/tags/v1.04.zip',
    assets: [],
  });
  assert.equal(
    buildTagOnlyRelease({ repo: 'owner/repo', tag: 'v1.0 beta' }).sourceArchiveUrl,
    'https://github.com/owner/repo/archive/refs/tags/v1.0%20beta.zip',
  );
});

test('sortReleases：Release 条目在前（publishedAt 降序），tag-only 在后（tag 自然降序）', () => {
  const entries = [
    { tag: 'v0.9', hasRelease: false },
    { tag: 'v1.10', publishedAt: '2026-10-10T00:00:00Z', hasRelease: true },
    { tag: 'v1.2', publishedAt: '2026-10-02T00:00:00Z', hasRelease: true },
    { tag: 'v1.9', hasRelease: false },
    { tag: 'v0.11', hasRelease: false },
  ];
  assert.deepEqual(
    sortReleases(entries).map((entry) => entry.tag),
    ['v1.10', 'v1.2', 'v1.9', 'v0.11', 'v0.9'],
  );
  // 缺 hasRelease 的旧条目视作 release
  assert.deepEqual(
    sortReleases([
      { tag: 'v1', hasRelease: false },
      { tag: 'v2', publishedAt: '2026-10-01T00:00:00Z' },
    ]).map((entry) => entry.tag),
    ['v2', 'v1'],
  );
});

test('mergeReleasesByTag：后补建 Release 的 tag 覆盖旧 tag-only 条目', () => {
  const previous = [
    { tag: 'v2', hasRelease: false, prerelease: null, publishedAt: null, assets: [] },
    { tag: 'v1', hasRelease: false, prerelease: null, publishedAt: null, assets: [] },
  ];
  const fetched = [
    { tag: 'v2', hasRelease: true, prerelease: false, publishedAt: '2026-10-02T00:00:00Z', assets: [] },
  ];
  const merged = mergeReleasesByTag(previous, fetched);
  assert.deepEqual(merged.map((entry) => entry.tag), ['v2', 'v1']);
  assert.equal(merged[0].hasRelease, true);
  assert.equal(merged[0].publishedAt, '2026-10-02T00:00:00Z');
  assert.equal(merged[1].hasRelease, false);
});

// ---------- commit sha / 删除留档 ----------

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REMOVED_AT = '2026-11-06T03:00:00.000Z';

test('archiveByCommitUrl：repo + sha 生成 GitHub 源码归档地址，sha 为空返回 null', () => {
  assert.equal(
    archiveByCommitUrl('Owner/Repo', SHA_A),
    `https://github.com/Owner/Repo/archive/${SHA_A}.zip`,
  );
  assert.equal(archiveByCommitUrl('Owner/Repo', null), null);
  assert.equal(archiveByCommitUrl('Owner/Repo', ''), null);
});

test('mergeWithShaAndRemovals：给 release 与 tag-only 条目补 commitSha / archiveByCommitUrl', () => {
  const entries = [
    { tag: 'v2', hasRelease: true, publishedAt: '2026-10-02T00:00:00Z', assets: [] },
    { tag: 'v1', hasRelease: false, prerelease: null, publishedAt: null, assets: [] },
  ];
  const previous = [
    { tag: 'v2', hasRelease: true, commitSha: SHA_A, publishedAt: '2026-10-02T00:00:00Z', assets: [] },
    { tag: 'v1', hasRelease: false, commitSha: SHA_B, prerelease: null, publishedAt: null, assets: [] },
  ];
  const merged = mergeWithShaAndRemovals({
    repo: 'Owner/Repo',
    entries,
    previousEntries: previous,
    partialTagEntries: [{ name: 'v2', commitSha: SHA_B }],
    removedAt: REMOVED_AT,
  });
  const byTag = new Map(merged.map((entry) => [entry.tag, entry]));
  // 本轮抓到的 tag sha 覆盖旧缓存
  assert.equal(byTag.get('v2').commitSha, SHA_B);
  assert.equal(byTag.get('v2').archiveByCommitUrl, `https://github.com/Owner/Repo/archive/${SHA_B}.zip`);
  // 没在本轮抓到的沿用旧 sha
  assert.equal(byTag.get('v1').commitSha, SHA_B);
  assert.equal(
    byTag.get('v1').archiveByCommitUrl,
    `https://github.com/Owner/Repo/archive/${SHA_B}.zip`,
  );
  assert.equal(byTag.get('v2').removed, undefined);
});

test('mergeWithShaAndRemovals：全量 tags 刷新时缺失 tag 保留并标 removed:true + removedAt', () => {
  const previous = [
    { tag: 'v2', hasRelease: true, commitSha: SHA_A, publishedAt: '2026-10-02T00:00:00Z', assets: [] },
    { tag: 'v1', hasRelease: false, commitSha: SHA_B, prerelease: null, publishedAt: null, assets: [] },
  ];
  const entries = [
    { tag: 'v2', hasRelease: true, publishedAt: '2026-10-02T00:00:00Z', assets: [] },
  ];
  const merged = mergeWithShaAndRemovals({
    repo: 'Owner/Repo',
    entries,
    previousEntries: previous,
    fullTagEntries: [{ name: 'v2', commitSha: SHA_A }],
    fullReleaseTags: new Set(['v2']),
    removedAt: REMOVED_AT,
  });
  const removed = merged.find((entry) => entry.tag === 'v1');
  assert.ok(removed);
  assert.equal(removed.removed, true);
  assert.equal(removed.removedAt, REMOVED_AT);
  // 保留原有下载兜底字段
  assert.equal(removed.commitSha, SHA_B);
  assert.equal(removed.archiveByCommitUrl, `https://github.com/Owner/Repo/archive/${SHA_B}.zip`);
  assert.equal(merged.find((entry) => entry.tag === 'v2').removed, undefined);
});

test('mergeWithShaAndRemovals：全量 releases 刷新时缺失 release 保留并标 removed', () => {
  const previous = [
    { tag: 'v3', hasRelease: true, commitSha: SHA_A, publishedAt: '2026-10-03T00:00:00Z', assets: [] },
    { tag: 'v2', hasRelease: true, commitSha: SHA_B, publishedAt: '2026-10-02T00:00:00Z', assets: [] },
  ];
  const merged = mergeWithShaAndRemovals({
    repo: 'Owner/Repo',
    entries: [{ tag: 'v3', hasRelease: true, publishedAt: '2026-10-03T00:00:00Z', assets: [] }],
    previousEntries: previous,
    fullReleaseTags: new Set(['v3']),
    removedAt: REMOVED_AT,
  });
  const removed = merged.find((entry) => entry.tag === 'v2');
  assert.equal(removed.removed, true);
  assert.equal(removed.removedAt, REMOVED_AT);
  assert.equal(merged.find((entry) => entry.tag === 'v3').removed, undefined);
});

test('mergeWithShaAndRemovals：只刷部分页时不把远处缺失条目误标 removed', () => {
  const previous = [
    { tag: 'v1', hasRelease: true, commitSha: SHA_A, publishedAt: '2026-10-01T00:00:00Z', assets: [] },
  ];
  const merged = mergeWithShaAndRemovals({
    repo: 'Owner/Repo',
    entries: [{ ...previous[0] }],
    previousEntries: previous,
    partialTagEntries: [{ name: 'v2', commitSha: SHA_B }],
    removedAt: REMOVED_AT,
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tag, 'v1');
  assert.equal(merged[0].removed, undefined);
});

test('mergeWithShaAndRemovals：上游重新出现的 tag 会清掉 removed 标记', () => {
  const previous = [
    {
      tag: 'v1',
      hasRelease: false,
      commitSha: SHA_A,
      removed: true,
      removedAt: REMOVED_AT,
      prerelease: null,
      publishedAt: null,
      assets: [],
    },
  ];
  const merged = mergeWithShaAndRemovals({
    repo: 'Owner/Repo',
    entries: [{ ...previous[0] }],
    previousEntries: previous,
    partialTagEntries: [{ name: 'v1', commitSha: SHA_B }],
    removedAt: REMOVED_AT,
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].removed, undefined);
  assert.equal(merged[0].removedAt, undefined);
  assert.equal(merged[0].commitSha, SHA_B);
});
