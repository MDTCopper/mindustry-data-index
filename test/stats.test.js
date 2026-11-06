import test from 'node:test';
import assert from 'node:assert/strict';
import { preferredAsset, computeModStats } from '../src/stats.js';

function release(assets, extra = {}) {
  return { tag: 'v1', assets, ...extra };
}

test('preferredAsset：hasJava 取最大 .jar，否则取最大 .zip', () => {
  const assets = [
    { name: 'a.jar', size: 10, downloadCount: 1 },
    { name: 'b.jar', size: 99, downloadCount: 2 },
    { name: 'c.zip', size: 50, downloadCount: 3 },
  ];
  assert.equal(preferredAsset(assets, true).name, 'b.jar');
  assert.equal(preferredAsset(assets, false).name, 'c.zip');
  assert.equal(preferredAsset([], true), null);
  assert.equal(preferredAsset([{ name: 'x.zip', size: 1 }], true), null);
});

test('computeModStats：累计/全资产/最新下载量与体积', () => {
  const releases = [
    release([
      { name: 'mod.jar', size: 100, downloadCount: 10 },
      { name: 'extra.zip', size: 5, downloadCount: 2 },
    ]),
    release([
      { name: 'mod.jar', size: 50, downloadCount: 4 },
    ]),
  ];
  assert.deepEqual(computeModStats(releases, true), {
    totalDownloads: 14,
    allAssetsDownloads: 16,
    latestDownloads: 10,
    latestSizeBytes: 100,
    totalSizeBytes: 150,
  });
});

test('computeModStats：0 release / 无资产 / 无首选资产分别为 0 与 null', () => {
  assert.deepEqual(computeModStats([], false), {
    totalDownloads: 0,
    allAssetsDownloads: 0,
    latestDownloads: 0,
    latestSizeBytes: null,
    totalSizeBytes: null,
  });
  // 有 release 但没有任何资产
  assert.deepEqual(computeModStats([release([])], true), {
    totalDownloads: 0,
    allAssetsDownloads: 0,
    latestDownloads: 0,
    latestSizeBytes: null,
    totalSizeBytes: null,
  });
  // 非 Java 模组只有 jar：全资产下载量照算，但首选资产为 0/null
  assert.deepEqual(
    computeModStats([release([{ name: 'mod.jar', size: 10, downloadCount: 7 }])], false),
    {
      totalDownloads: 0,
      allAssetsDownloads: 7,
      latestDownloads: 0,
      latestSizeBytes: null,
      totalSizeBytes: null,
    },
  );
});

test('computeModStats：最新一条无首选资产时 latest 为 0/null，但历史仍累计', () => {
  const releases = [
    release([]),
    release([{ name: 'mod.jar', size: 50, downloadCount: 4 }]),
  ];
  assert.deepEqual(computeModStats(releases, true), {
    totalDownloads: 4,
    allAssetsDownloads: 4,
    latestDownloads: 0,
    latestSizeBytes: null,
    totalSizeBytes: 50,
  });
});

test('computeModStats：tag-only 条目不影响统计与 latest（按有 Release 的条目算）', () => {
  const entries = [
    { tag: 'v2.0', hasRelease: true, assets: [{ name: 'mod.jar', size: 50, downloadCount: 4 }] },
    { tag: 'v1.9', hasRelease: false, assets: [] },
    { tag: 'v1.8', hasRelease: false, assets: [] },
  ];
  assert.deepEqual(computeModStats(entries, true), {
    totalDownloads: 4,
    allAssetsDownloads: 4,
    latestDownloads: 4,
    latestSizeBytes: 50,
    totalSizeBytes: 50,
  });
  // 只有 tag-only 时统计为 0/null
  assert.deepEqual(
    computeModStats(
      [
        { tag: 'v1', hasRelease: false, assets: [] },
        { tag: 'v2', hasRelease: false, assets: [] },
      ],
      true,
    ),
    {
      totalDownloads: 0,
      allAssetsDownloads: 0,
      latestDownloads: 0,
      latestSizeBytes: null,
      totalSizeBytes: null,
    },
  );
});
