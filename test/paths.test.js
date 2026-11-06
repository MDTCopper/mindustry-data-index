import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  assertRepo,
  releasesFileStem,
  releasesRelPath,
  resolveReleaseFile,
} from '../src/paths.js';

test('releases 文件名：/ 换成 _ 且保留大小写', () => {
  assert.equal(releasesFileStem('Anuken/ExampleMod'), 'Anuken_ExampleMod');
  assert.equal(releasesRelPath('owner/repo'), 'releases/owner_repo.json');
  assert.equal(releasesRelPath('Anuken/Mindustry'), 'releases/Anuken_Mindustry.json');
});

test('repo 校验拒绝非法形态', () => {
  assert.equal(assertRepo('owner/repo'), 'owner/repo');
  for (const bad of ['', 'owner', 'a/b/c', 'owner/..', '../etc/passwd', 'owner/repo/../x', null, 42]) {
    assert.throws(() => assertRepo(bad), /非法 repo/);
  }
});

test('resolves releases 路径并拒绝越界', () => {
  const out = path.resolve('D:/data/mods-index');
  const file = resolveReleaseFile(out, 'releases/owner_repo.json');
  assert.equal(file, path.resolve(out, 'releases/owner_repo.json'));

  for (const bad of [
    'releases/../index.json',
    'releases/sub/owner_repo.json',
    'index.json',
    'releases/owner_repo.txt',
    '../index.json',
  ]) {
    assert.throws(() => resolveReleaseFile(out, bad), /非法 releases 路径|越界/);
  }
});
