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
    if (!asset || typeof asset.name !== 'string') {
      continue;
    }
    if (!asset.name.toLowerCase().endsWith(extension)) {
      continue;
    }
    if (best === null || toCount(asset.size) > toCount(best.size)) {
      best = asset;
    }
  }
  return best;
}

export function computeModStats(releases, hasJava) {
  const list = Array.isArray(releases) ? releases : [];
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
