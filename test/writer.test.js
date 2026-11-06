import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  deleteReleaseFile,
  indexBodyChanged,
  listReleaseFiles,
  releaseFileBodyChanged,
} from '../src/writer.js';

function indexFile(overrides = {}) {
  return {
    formatVersion: 1,
    generatedAt: '2026-11-06T03:00:00.000Z',
    source: { modsUrl: 'https://example.com/mods.json', modCount: 1 },
    mods: [{ repo: 'owner/demo' }],
    skipped: [],
    ...overrides,
  };
}

test('indexBodyChanged：只有 generatedAt 变化不算内容变化', () => {
  const previous = indexFile();
  const next = indexFile({ generatedAt: '2026-11-07T03:00:00.000Z' });
  assert.equal(indexBodyChanged(previous, next), false);
});

test('indexBodyChanged：mods / source / skipped / formatVersion 变化都算变化', () => {
  const previous = indexFile();
  assert.equal(
    indexBodyChanged(previous, indexFile({ mods: [{ repo: 'owner/other' }] })),
    true,
  );
  assert.equal(
    indexBodyChanged(previous, indexFile({ source: { modsUrl: 'https://x', modCount: 2 } })),
    true,
  );
  assert.equal(
    indexBodyChanged(previous, indexFile({ skipped: [{ repo: 'owner/demo', reason: 'network' }] })),
    true,
  );
  assert.equal(indexBodyChanged(previous, indexFile({ formatVersion: 2 })), true);
  assert.equal(indexBodyChanged(null, previous), true);
});

test('releaseFileBodyChanged：忽略 generatedAt / 旧 source，只有 releases 变化才重写', () => {
  const previous = {
    formatVersion: 1,
    repo: 'owner/demo',
    generatedAt: '2026-11-06T03:00:00.000Z',
    source: { releasesEtag: 'W/"a"', releasesFetchedAt: '2026-11-06T03:00:00.000Z' },
    releases: [{ tag: 'v1' }],
  };
  const next = {
    formatVersion: 1,
    repo: 'owner/demo',
    generatedAt: '2026-11-07T03:00:00.000Z',
    releases: [{ tag: 'v1' }],
  };
  assert.equal(releaseFileBodyChanged(previous, next), false);
  assert.equal(
    releaseFileBodyChanged(previous, { ...next, releases: [{ tag: 'v2' }] }),
    true,
  );
  assert.equal(releaseFileBodyChanged(null, previous), true);
});

test('listReleaseFiles：递归枚举 releases/**/*.json（含旧 flat），返回 posix 路径', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-writer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'releases', 'Anuken', 'nested'), { recursive: true });
  await writeFile(path.join(dir, 'releases', 'Anuken', 'ExampleMod.json'), '{}');
  await writeFile(path.join(dir, 'releases', 'Anuken', 'example-mod.json'), '{}');
  await writeFile(path.join(dir, 'releases', 'Anuken', 'nested', 'x.json'), '{}');
  await writeFile(path.join(dir, 'releases', 'owner_repo.json'), '{}');
  await writeFile(path.join(dir, 'releases', 'ignored.txt'), 'x');

  const files = await listReleaseFiles(dir);
  assert.deepEqual(files, [
    'releases/Anuken/ExampleMod.json',
    'releases/Anuken/example-mod.json',
    'releases/Anuken/nested/x.json',
    'releases/owner_repo.json',
  ]);
  assert.deepEqual(await listReleaseFiles(path.join(dir, 'missing')), []);
});

test('deleteReleaseFile：新路径与旧 flat 都能删，越界仍拒绝', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mindustry-writer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'releases', 'owner'), { recursive: true });
  await writeFile(path.join(dir, 'releases', 'owner', 'repo.json'), '{}');
  await writeFile(path.join(dir, 'releases', 'owner_repo.json'), '{}');

  assert.equal(await deleteReleaseFile(dir, 'releases/owner/repo.json'), true);
  assert.equal(await deleteReleaseFile(dir, 'releases/owner_repo.json'), true);
  assert.equal(await deleteReleaseFile(dir, 'releases/owner/repo.json'), false);
  await assert.rejects(
    deleteReleaseFile(dir, 'releases/../index.json'),
    /非法 releases 路径|越界/,
  );
});
