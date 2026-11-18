// 下载量与体积统计：首选资产口径与 downloadUrl 一致
// hasJava 取体积最大的 .jar，否则取体积最大的 .zip；没有对应资产视为「无可用资产」

function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function toSize(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

export function preferredAsset(assets, hasJava) {
  const extension = hasJava ? '.jar' : '.zip';
  let best = null;
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (!asset) {
      continue;
    }
    // 正常资产用 name 后缀判断；v3 缓存回填的合成资产 name 可能不带后缀，再按 downloadUrl 判断
    const name = typeof asset.name === 'string' ? asset.name.toLowerCase() : '';
    const url = typeof asset.downloadUrl === 'string' ? asset.downloadUrl.toLowerCase() : '';
    const matches =
      name.endsWith(extension) ||
      url.split('?')[0].endsWith(extension) ||
      url.endsWith(extension);
    if (!matches) {
      continue;
    }
    if (best === null || toCount(asset.size) > toCount(best.size)) {
      best = asset;
    }
  }
  return best;
}

export function computeModStats(releases, hasJava) {
  // tag-only 条目没有 release 资产，统计只按有 Release 的条目算（hasRelease 缺省视作 release）
  const list = (Array.isArray(releases) ? releases : []).filter(
    (release) => release?.hasRelease !== false,
  );
  let totalDownloads = 0;
  let allAssetsDownloads = 0;
  let latestDownloads = 0;
  let latestSizeBytes = null;
  let totalSizeBytes = null;

  for (const [index, release] of list.entries()) {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    for (const asset of assets) {
      allAssetsDownloads += toCount(asset?.downloadCount);
    }
    const preferred = preferredAsset(assets, hasJava);
    if (!preferred) {
      continue;
    }
    totalDownloads += toCount(preferred.downloadCount);
    totalSizeBytes = (totalSizeBytes ?? 0) + (toSize(preferred.size) ?? 0);
    if (index === 0) {
      latestDownloads = toCount(preferred.downloadCount);
      latestSizeBytes = toSize(preferred.size);
    }
  }

  return {
    totalDownloads,
    allAssetsDownloads,
    latestDownloads,
    latestSizeBytes,
    totalSizeBytes,
  };
}

// tag 平均下载量：只统计真正有首选资源的 Release，tag-only / source / 无资源条目不计入分母。
// 用于限制「更新很频繁、但每个 tag 下载量很低」的模组。
export function tagDownloadStats(releases, hasJava) {
  let sum = 0;
  let count = 0;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release?.hasRelease === false) continue;
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const preferred = preferredAsset(assets, hasJava);
    if (!preferred) continue;
    sum += toCount(preferred.downloadCount);
    count += 1;
  }
  return {
    tagDownloadAvg: count > 0 ? sum / count : null,
    tagDownloadCount: count,
    tagDownloadTotal: sum,
  };
}
