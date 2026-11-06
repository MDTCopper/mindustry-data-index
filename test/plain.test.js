import test from 'node:test';
import assert from 'node:assert/strict';
import { plainFields, stripMindustryColors } from '../src/plain.js';

test('stripMindustryColors：命名颜色 / #hex / [] 被移除，普通方括号英文保留', () => {
  assert.equal(stripMindustryColors('[red]Danger[/red]'), 'Danger[/red]');
  assert.equal(stripMindustryColors('[#00ff00]Green[]'), 'Green');
  assert.equal(stripMindustryColors('[orange]A [#ff00aa]B [white]C[]'), 'A B C');
  assert.equal(stripMindustryColors('[Mod] New content'), '[Mod] New content');
  assert.equal(stripMindustryColors('Calls [this] function'), 'Calls [this] function');
});

test('stripMindustryColors：换行/多余空白压缩，非字符串返回空串', () => {
  assert.equal(stripMindustryColors('  line1\n\nline2\t  line3  '), 'line1 line2 line3');
  assert.equal(stripMindustryColors(null), '');
  assert.equal(stripMindustryColors(42), '');
});

test('stripMindustryColors：中文与颜色标记混合', () => {
  assert.equal(
    stripMindustryColors('[green]机械[/green] 与 [#00ff00]电力[] 模组'),
    '机械[/green] 与 电力 模组',
  );
});

test('plainFields：生成 namePlain / authorPlain / descriptionPlain', () => {
  assert.deepEqual(
    plainFields({
      name: '[red]Demo[]',
      author: '[#00ff00]Alice',
      description: 'a\nmod',
    }),
    { namePlain: 'Demo', authorPlain: 'Alice', descriptionPlain: 'a mod' },
  );
  assert.deepEqual(plainFields({}), {
    namePlain: '',
    authorPlain: '',
    descriptionPlain: '',
  });
});
