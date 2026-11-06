import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUMMARY_COLUMNS,
  buildSummary,
  csvEscape,
  parseCsv,
  summaryBodyChanged,
  summaryCsv,
} from '../src/summary.js';

function row(overrides = {}) {
  return {
    repo: 'owner/demo',
    name: 'Demo',
    namePlain: 'Demo',
    author: 'author',
    stars: 1,
    releaseCount: 2,
    tagCount: 5,
    totalDownloads: 10,
    allAssetsDownloads: 12,
    latestDownloads: 6,
    latestSizeBytes: 100,
    totalSizeBytes: 200,
    latestTag: 'v1',
    latestPrerelease: false,
    latestModVersion: '1.0',
    latestMinGameVersion: '146',
    iconUrl: 'https://example.com/icon',
    releasesPath: 'releases/owner/demo.json',
    ...overrides,
  };
}

test('buildSummary：按 totalDownloads 降序、stars 降序、repo 升序，并给出合计', () => {
  const summary = buildSummary({
    rows: [
      row({ repo: 'b/b', totalDownloads: 10, stars: 1 }),
      row({ repo: 'a/a', totalDownloads: 10, stars: 5 }),
      row({ repo: 'c/c', totalDownloads: 99, stars: 0 }),
    ],
    generatedAt: '2026-11-06T03:00:00.000Z',
  });
  assert.deepEqual(
    summary.mods.map((item) => item.repo),
    ['c/c', 'a/a', 'b/b'],
  );
  assert.deepEqual(summary.totals, {
    mods: 3,
    releases: 6,
    downloads: 119,
    sizeBytes: 600,
  });
  assert.equal(summary.formatVersion, 1);
});

test('buildSummary：null 体积不计入合计；空列表合计为 0', () => {
  const summary = buildSummary({
    rows: [
      row({ totalSizeBytes: null }),
      row({ repo: 'owner/two', totalSizeBytes: 50 }),
    ],
    generatedAt: '2026-11-06T03:00:00.000Z',
  });
  assert.equal(summary.totals.sizeBytes, 50);
  assert.deepEqual(buildSummary({ rows: [], generatedAt: '2026-11-06T03:00:00.000Z' }), {
    formatVersion: 1,
    generatedAt: '2026-11-06T03:00:00.000Z',
    totals: { mods: 0, releases: 0, downloads: 0, sizeBytes: 0 },
    mods: [],
  });
});

test('summaryBodyChanged：只忽略 generatedAt', () => {
  const base = buildSummary({ rows: [row()], generatedAt: '2026-11-06T03:00:00.000Z' });
  const same = { ...base, generatedAt: '2026-11-07T03:00:00.000Z' };
  assert.equal(summaryBodyChanged(base, same), false);
  assert.equal(summaryBodyChanged(null, base), true);
  assert.equal(
    summaryBodyChanged(base, {
      ...base,
      totals: { ...base.totals, downloads: 99 },
    }),
    true,
  );
  assert.equal(summaryBodyChanged(base, { ...base, mods: [row({ stars: 2 })] }), true);
});

test('csvEscape：逗号、引号、换行按 CSV 规则转义；null 为空', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
  assert.equal(csvEscape(42), '42');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('a\nb'), '"a\nb"');
  assert.equal(csvEscape('a\r\nb'), '"a\r\nb"');
});

test('summaryCsv：BOM + 表头 + 与 json 同列，可按 CSV 解析回来', () => {
  const rows = [row({ repo: 'owner/weird,name', name: '带"引号"' })];
  const csv = summaryCsv(rows);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.endsWith('\r\n'));
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed[0], SUMMARY_COLUMNS);
  // tagCount 紧跟 releaseCount；namePlain 紧跟 name；releasesPath 放最后一列
  assert.equal(parsed[0].indexOf('tagCount'), parsed[0].indexOf('releaseCount') + 1);
  assert.equal(parsed[0].indexOf('namePlain'), parsed[0].indexOf('name') + 1);
  assert.equal(parsed[0][parsed[0].length - 1], 'releasesPath');
  const expectedCells = SUMMARY_COLUMNS.map((column) => {
    const value = rows[0][column];
    return value === null || value === undefined ? '' : String(value);
  });
  assert.deepEqual(parsed[1], expectedCells);
  assert.equal(parsed.length, 2);
});

test('parseCsv：支持字段内换行与 "" 转义', () => {
  const rows = parseCsv('\uFEFFa,b\r\n"x\r\ny","he said ""hi"""\r\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x\r\ny', 'he said "hi"'],
  ]);
});
