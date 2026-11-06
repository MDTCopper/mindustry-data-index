import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, run } from '../src/main.js';

test('parseArgs：--datasets 默认只跑 mods', () => {
  const options = parseArgs([]);
  assert.deepEqual(options.datasets, ['mods']);
  assert.equal(options.versionsPages, null);
  assert.equal(options.versionsFile, null);
});

test('parseArgs：子集参数只用于 mods / versions-pages 只用于 versions', () => {
  assert.deepEqual(parseArgs(['--repos', 'a/b', '--out', 'tmp/x']).repos, ['a/b']);
  assert.throws(() => parseArgs(['--datasets', 'versions', '--repos', 'a/b']), /只用于 mods/);
  assert.throws(
    () => parseArgs(['--datasets', 'mods', '--versions-pages', '1']),
    /只用于 versions/,
  );
  assert.throws(
    () => parseArgs(['--datasets', 'mods', '--versions-file', 'x.json']),
    /只用于 gate/,
  );
});

test('子集模式不允许 --out 指向当前目录（防止裁剪正式 index.json）', async () => {
  const code = await run(['--repos', 'owner/demo']);
  assert.equal(code, 2);
});

test('子集模式指向临时目录时参数校验通过', () => {
  const options = parseArgs(['--repos', 'owner/demo', '--out', 'tmp/live']);
  assert.deepEqual(options.repos, ['owner/demo']);
  assert.equal(options.out, 'tmp/live');
});
