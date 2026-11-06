// status.json：每次运行后的健康状态（运行日志性质，无数据变化也更新）

export const STATUS_REL_PATH = 'status.json';
export const DATASET_KEYS = ['official', 'community', 'versions', 'gate'];

function datasetEntry(value) {
  return {
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : null,
    modCount: Number.isInteger(value?.modCount) ? value.modCount : null,
    releaseCount: Number.isInteger(value?.releaseCount) ? value.releaseCount : null,
    skipped: Array.isArray(value?.skipped)
      ? value.skipped
          .filter((item) => item && typeof item.repo === 'string')
          .map((item) => ({
            repo: item.repo,
            reason: typeof item.reason === 'string' ? item.reason : 'unknown',
          }))
      : [],
  };
}

export function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const datasets = {};
  for (const key of DATASET_KEYS) {
    datasets[key] = raw.datasets?.[key] ? datasetEntry(raw.datasets[key]) : null;
  }
  const api = raw.api && typeof raw.api === 'object' ? raw.api : null;
  const validate = raw.validate && typeof raw.validate === 'object' ? raw.validate : null;
  return {
    formatVersion: 1,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
    datasets,
    api: api
      ? {
          requests: Number.isInteger(api.requests) ? api.requests : 0,
          remaining:
            api.remaining === null || Number.isInteger(api.remaining) ? (api.remaining ?? null) : null,
          resetAt: typeof api.resetAt === 'string' ? api.resetAt : null,
        }
      : null,
    validate: validate
      ? {
          errors: Number.isInteger(validate.errors) ? validate.errors : 0,
          warnings: Number.isInteger(validate.warnings) ? validate.warnings : 0,
          presentFiles: Array.isArray(validate.presentFiles)
            ? validate.presentFiles.filter((item) => typeof item === 'string')
            : [],
        }
      : null,
  };
}

// datasets 只覆盖本次运行的数据集；其它数据集沿用上一份 status（update-mindustry 与 update-mods 分开跑）
export function buildStatus({ generatedAt, previous = null, datasets = {}, api = null, validate = null }) {
  const base = normalizeStatus(previous);
  const mergedDatasets = {};
  for (const key of DATASET_KEYS) {
    const nextValue = datasets[key];
    mergedDatasets[key] = nextValue
      ? datasetEntry(nextValue)
      : (base?.datasets?.[key] ?? null);
  }
  return {
    formatVersion: 1,
    generatedAt,
    datasets: mergedDatasets,
    api: api
      ? {
          requests: Number.isInteger(api.requests) ? api.requests : 0,
          remaining: api.remaining ?? null,
          resetAt: api.resetAt ?? null,
        }
      : (base?.api ?? null),
    validate: validate
      ? {
          errors: Number.isInteger(validate.errors) ? validate.errors : 0,
          warnings: Number.isInteger(validate.warnings) ? validate.warnings : 0,
          presentFiles: Array.isArray(validate.presentFiles) ? [...validate.presentFiles] : [],
        }
      : (base?.validate ?? null),
  };
}

export function apiStatus(client) {
  const stats = client?.stats ?? {};
  return {
    requests: Number.isInteger(stats.requests) ? stats.requests : 0,
    remaining: Number.isInteger(stats.remaining) ? stats.remaining : null,
    resetAt: Number.isInteger(stats.resetAt) ? new Date(stats.resetAt).toISOString() : null,
  };
}
