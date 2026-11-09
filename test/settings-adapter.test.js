import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdapterFile,
  evalConstantNumber,
  extractSettingSpecs,
} from '../src/settings-adapter.js';

test('evalConstantNumber：支持整数常量表达式，拒绝任意代码', () => {
  assert.equal(evalConstantNumber('5 * 120'), 600);
  assert.equal(evalConstantNumber('(10 + 5) * 2'), 30);
  assert.equal(evalConstantNumber('process.exit()'), null);
  assert.equal(evalConstantNumber('1.5'), null);
});

test('extractSettingSpecs：只解析 addSettings 内、忽略注释，中文标题来自 bundle', () => {
  const java = `
class SettingsMenuDialog {
  void addSettings(){
    sound.checkPref("alwaysmusic", false);
    graphics.sliderPref("uiscale", 100, 25, 300, 5, s -> s + "%");
    // game.checkPref("commented", false);
    /* game.checkPref("blockcommented", false); */
    game.checkPref("hints", true);
  }
  void other(){
    game.checkPref("outside", false);
  }
}`;
  const bundle = `setting.alwaysmusic.name = 始终播放音乐
setting.uiscale.name = 界面缩放比例
setting.hints.name = 提示`;
  const specs = extractSettingSpecs(java, bundle);
  assert.deepEqual(
    specs.map((spec) => spec.key),
    ['alwaysmusic', 'uiscale', 'hints'],
  );
  assert.equal(specs[1].title, '界面缩放比例');
  assert.equal(specs[1].type, 'int');
  assert.deepEqual(
    { min: specs[1].min, max: specs[1].max, step: specs[1].step, unit: specs[1].unit },
    { min: 25, max: 300, step: 5, unit: '%' },
  );
  assert.equal(specs[0].type, 'bool');
  assert.deepEqual(specs[0].categories, ['sound']);
});

test('buildAdapterFile：base 之后按版本生成 add/remove 差量', () => {
  const base = [{ key: 'a', title: 'A', type: 'bool', categories: ['game'] }];
  const next = [
    { key: 'a', title: 'A', type: 'bool', categories: ['game'] },
    { key: 'b', title: 'B', type: 'bool', categories: ['game'] },
  ];
  const after = [{ key: 'b', title: 'B', type: 'bool', categories: ['game'] }];
  const file = buildAdapterFile({
    versions: [],
    extractedByBuild: new Map([
      [136, base],
      [140, next],
      [150, after],
    ]),
    now: '2026-11-09T00:00:00Z',
  });
  assert.equal(file.base_build, 136);
  assert.equal(file.changes.length, 2);
  assert.deepEqual(file.changes[0].add.map((spec) => spec.key), ['b']);
  assert.deepEqual(file.changes[1].remove, ['a']);
});
