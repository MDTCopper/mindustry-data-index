import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  pagesForFile,
  readReleasePages,
  writeReleasePages,
} from '../src/writer.js';

function version(index) {
  const tag = `v1.0.${index}`;
  return {
    tag,
    kind: 'release',
    modVersion: `1.0.${index}`,
    minGameVersion: '146',
    gameVersionRanges: [{ from: '146', to: '160.7' }],
    releasedAt: `2026-10-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    downloadUrl: `https://example.com/${tag}.jar`,
  };
}

function fileWith(count) {
  return {
    formatVersion: 3,
    repo: 'owner/demo',
    generatedAt: '2026-11-07T00:00:00.000Z',
    modType: 'java',
    versions: Array.from({ length: count }, (_, index) => version(index)),
  };
}

test('分页：<=200 个版本仍写单文件，pages 只有一个 path', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-pages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pages = await writeReleasePages(dir, 'owner/demo', fileWith(3));
  assert.equal(pages.length, 1);
  assert.equal(pages[0].path, 'releases/owner/demo.json');
  const single = JSON.parse(await readFile(path.join(dir, 'releases/owner/demo.json'), 'utf8'));
  assert.equal(single.versions.length, 3);
  const read = await readReleasePages(dir, 'owner/demo');
  assert.equal(read.versions.length, 3);
});

test('分页：450 个版本拆 3 页，每页 200/200/50，并删除旧单文件', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-pages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 先写一个旧单文件，验证迁移时会删除
  await writeReleasePages(dir, 'owner/demo', fileWith(1));
  const pages = await writeReleasePages(dir, 'owner/demo', fileWith(450));
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((page) => page.count), [200, 200, 50]);
  assert.equal(pages[0].path, 'releases/owner/demo/page-1.json');
  for (const page of pages) {
    const body = JSON.parse(await readFile(path.join(dir, page.path), 'utf8'));
    assert.equal(body.count, page.count);
    assert.equal(body.versions.length, page.count);
    assert.ok(Array.isArray(body.gameVersionRanges));
    if (page.page === 1) {
      assert.equal(body.pages.length, 3);
    }
  }
  await assert.rejects(stat(path.join(dir, 'releases/owner/demo.json')), /ENOENT/);
  const read = await readReleasePages(dir, 'owner/demo');
  assert.equal(read.versions.length, 450);
  assert.equal(read.pages.length, 3);
});

test('分页：超过 1000 个版本截断到 1000（5 页）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-pages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pages = await writeReleasePages(dir, 'owner/demo', fileWith(1234));
  assert.equal(pages.length, 5);
  assert.deepEqual(pages.map((page) => page.count), [200, 200, 200, 200, 200]);
});

test('pagesForFile：单页用单文件路径，多页用 page-N 路径', () => {
  assert.equal(pagesForFile('owner/demo', fileWith(10))[0].path, 'releases/owner/demo.json');
  const pages = pagesForFile('owner/demo', fileWith(201));
  assert.equal(pages.length, 2);
  assert.equal(pages[1].path, 'releases/owner/demo/page-2.json');
});
