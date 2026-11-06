import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDir } from '../src/validate.js';

const GENERATED_AT = '2026-11-06T03:00:00.000Z';

function validFixture() {
  const repo = 'owner/demo';
  const release = {
    tag: 'v1.0',
    name: '1.0',
    prerelease: false,
    publishedAt: '2026-10-01T12:00:00Z',
    htmlUrl: `https://github.com/${repo}/releases/tag/v1.0`,
    modVersion: '1.0',
    minGameVersion: '146',
    metadataPath: 'mod.hjson',
    metadataStatus: 'ok',
    downloadUrl: `https://github.com/${repo}/releases/download/v1.0/demo.jar`,
    sourceArchiveUrl: `https://github.com/${repo}/archive/refs/tags/v1.0.zip`,
    assets: [
      {
        name: 'demo.jar',
        size: 123,
        downloadCount: 4,
        downloadUrl: `https://github.com/${repo}/releases/download/v1.0/demo.jar`,
      },
    ],
  };
  return {
    index: {
      formatVersion: 1,
      generatedAt: GENERATED_AT,
      source: {
        modsUrl: 'https://raw.githubusercontent.com/Anuken/MindustryMods/master/mods.json',
        modCount: 1,
      },
      mods: [
        {
          repo,
          internalName: 'demo',
          name: 'Demo',
          author: 'author',
          version: '1.0',
          minGameVersion: '146',
          lastUpdated: '2026-10-01T00:00:00Z',
          stars: 3,
          hasIcon: true,
          hasScripts: false,
          hasJava: true,
          releasesPath: 'releases/owner_demo.json',
          releaseCount: 1,
          latestRelease: {
            tag: 'v1.0',
            name: '1.0',
            prerelease: false,
            publishedAt: '2026-10-01T12:00:00Z',
          },
          releaseDataUpdatedAt: GENERATED_AT,
        },
      ],
      skipped: [],
    },
    releaseFile: {
      formatVersion: 1,
      repo,
      generatedAt: GENERATED_AT,
      source: {
        releasesEtag: 'W/"e"',
        releasesFetchedAt: GENERATED_AT,
      },
      releases: [release],
    },
  };
}

async function makeFixtureDir({ index, releaseFile } = validFixture()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mods-index-validate-'));
  await mkdir(path.join(dir, 'releases'), { recursive: true });
  await writeFile(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
  await writeFile(
    path.join(dir, 'releases', 'owner_demo.json'),
    JSON.stringify(releaseFile, null, 2),
  );
  return dir;
}

test('合法产物校验通过', async (t) => {
  const dir = await makeFixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.modCount, 1);
  assert.equal(result.releaseFileCount, 1);
});

test('缺少 index.json 报错', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mods-index-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('找不到 index.json')));
});

test('缺字段能被发现', async (t) => {
  const fixture = validFixture();
  delete fixture.index.mods[0].internalName;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('internalName')));
});

test('重复 tag 能被发现', async (t) => {
  const fixture = validFixture();
  fixture.releaseFile.releases.push({ ...fixture.releaseFile.releases[0] });
  fixture.index.mods[0].releaseCount = 2;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('tag 重复')));
});

test('releasesPath 指向的文件不存在能被发现', async (t) => {
  const fixture = validFixture();
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await unlink(path.join(dir, 'releases', 'owner_demo.json'));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('文件不存在')));
});

test('releaseCount 与文件条数不一致能被发现', async (t) => {
  const fixture = validFixture();
  fixture.index.mods[0].releaseCount = 2;
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await validateDir(dir);
  assert.ok(result.errors.some((message) => message.includes('releaseCount')));
});

test('未被 index 引用的 releases 文件只算警告', async (t) => {
  const fixture = validFixture();
  const dir = await makeFixtureDir(fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'releases', 'extra_extra.json'), '{}');
  const result = await validateDir(dir);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => message.includes('没有被 index 引用')));
});
