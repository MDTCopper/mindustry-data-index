import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  assertRepo,
  releasesFileStem,
  releasesRelPath,
  releasesLegacyRelPath,
  resolveReleaseFile,
  resolveReleaseFileForDelete,
} from '../src/paths.js';

test('releases 新路径：releases/<owner>/<repo>.json，保留大小写', () => {
  assert.equal(releasesRelPath('owner/repo'), 'releases/owner/repo.json');
  assert.equal(releasesRelPath('Anuken/Mindustry'), 'releases/Anuken/Mindustry.json');
  assert.equal(
    releasesRelPath('Anuken/Example-Mod_2'),
    'releases/Anuken/Example-Mod_2.json',
  );
  // repo 名以点结尾也原样保留
  assert.equal(
    releasesRelPath('maksimk792/some-music.'),
    'releases/maksimk792/some-music..json',
  );
});

test('legacy flat 路径函数只用于迁移读取', () => {
  assert.equal(releasesFileStem('Anuken/ExampleMod'), 'Anuken_ExampleMod');
  assert.equal(releasesLegacyRelPath('owner/repo'), 'releases/owner_repo.json');
  assert.equal(
    releasesLegacyRelPath('Anuken/ExampleMod'),
    'releases/Anuken_ExampleMod.json',
  );
});

test('repo 校验拒绝非法形态', () => {
  assert.equal(assertRepo('owner/repo'), 'owner/repo');
  for (const bad of ['', 'owner', 'a/b/c', 'owner/..', '../etc/passwd', 'owner/repo/../x', null, 42]) {
    assert.throws(() => assertRepo(bad), /非法 repo/);
  }
});

test('resolveReleaseFile：只接受 releases/<owner>/<repo>.json 三段', () => {
  const out = path.resolve('D:/data/mods-index');
  assert.equal(
    resolveReleaseFile(out, 'releases/owner/repo.json'),
    path.resolve(out, 'releases/owner/repo.json'),
  );

  for (const bad of [
    'releases/owner_repo.json', // 旧 flat 路径
    'releases/owner/repo/nested.json',
    'releases/owner/../repo.json',
    'releases/owner/.json',
    'releases//repo.json',
    'releases/owner/',
    'releases/owner/repo.txt',
    'index.json',
    '../index.json',
    'releases/owner/..',
  ]) {
    assert.throws(() => resolveReleaseFile(out, bad), /非法 releases 路径|越界/);
  }
});

test('resolveReleaseFileForDelete：删除时兼容旧 flat 与新三段，仍拒绝越界', () => {
  const out = path.resolve('D:/data/mods-index');
  assert.equal(
    resolveReleaseFileForDelete(out, 'releases/owner/repo.json'),
    path.resolve(out, 'releases/owner/repo.json'),
  );
  assert.equal(
    resolveReleaseFileForDelete(out, 'releases/owner_repo.json'),
    path.resolve(out, 'releases/owner_repo.json'),
  );

  for (const bad of [
    'releases/../index.json',
    'releases/owner/../repo.json',
    'index.json',
    'releases/owner/repo.txt',
  ]) {
    assert.throws(() => resolveReleaseFileForDelete(out, bad), /非法 releases 路径|越界/);
  }
});
