import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatus, normalizeStatus, apiStatus } from '../src/status.js';

const AT = '2026-11-06T03:00:00.000Z';

test('buildStatus：合并本次运行的数据集，其余沿用上一份 status', () => {
  const previous = buildStatus({
    generatedAt: AT,
    datasets: {
      official: { updatedAt: AT, modCount: 10, releaseCount: 20, skipped: [{ repo: 'a/b', reason: 'http-500' }] },
      community: { updatedAt: AT, modCount: 3, releaseCount: 4, skipped: [] },
    },
    api: { requests: 1, remaining: 99, resetAt: null },
    validate: { errors: 0, warnings: 0, presentFiles: ['index.json'] },
  });
  const next = buildStatus({
    generatedAt: '2026-11-06T04:00:00.000Z',
    previous,
    datasets: {
      versions: { updatedAt: '2026-11-06T04:00:00.000Z', modCount: null, releaseCount: 205, skipped: [] },
    },
    api: { requests: 7, remaining: null, resetAt: '2026-11-06T05:00:00.000Z' },
    validate: { errors: 1, warnings: 2, presentFiles: ['index.json', 'status.json'] },
  });
  assert.equal(next.datasets.official.modCount, 10);
  assert.equal(next.datasets.community.modCount, 3);
  assert.equal(next.datasets.versions.releaseCount, 205);
  assert.equal(next.datasets.gate, null);
  assert.equal(next.api.requests, 7);
  assert.equal(next.validate.errors, 1);
});

test('normalizeStatus：清洗未知字段并保留四个数据集槽位', () => {
  const status = normalizeStatus({
    formatVersion: 1,
    generatedAt: AT,
    datasets: { official: { updatedAt: AT, modCount: 1, releaseCount: 2, skipped: [] } },
    api: { requests: 3, remaining: 5, resetAt: null },
    validate: { errors: 0, warnings: 0, presentFiles: ['index.json'] },
  });
  assert.deepEqual(Object.keys(status.datasets), ['official', 'community', 'versions', 'gate']);
  assert.equal(status.datasets.community, null);
  assert.equal(normalizeStatus(null), null);
});

test('apiStatus：从 HttpClient.stats 生成可写入 status 的摘要', () => {
  const stats = { requests: 12, remaining: 4800, resetAt: Date.parse('2026-11-06T05:00:00Z') };
  assert.deepEqual(apiStatus({ stats }), {
    requests: 12,
    remaining: 4800,
    resetAt: '2026-11-06T05:00:00.000Z',
  });
  assert.deepEqual(apiStatus({}), { requests: 0, remaining: null, resetAt: null });
});
