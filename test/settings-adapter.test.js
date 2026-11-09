import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSettingTable,
  diffSettingTables,
  evalConstantNumber,
  extractSettingTable,
} from '../src/settings-adapter.js';

test('evalConstantNumber：支持整数常量表达式，拒绝任意代码', () => {
  assert.equal(evalConstantNumber('5 * 120'), 600);
  assert.equal(evalConstantNumber('(10 + 5) * 2'), 30);
  assert.equal(evalConstantNumber('process.exit()'), null);
  assert.equal(evalConstantNumber('1.5'), null);
});

test('extractSettingTable：只解析 addSettings 内、忽略注释，带名称/描述译文', () => {
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
  const bundleEn = `setting.alwaysmusic.name = Play Music
setting.alwaysmusic.description = Keep music playing.
setting.uiscale.name = UI Scale
setting.hints.name = Hints`;
  const bundleZh = `setting.alwaysmusic.name = 始终播放音乐
setting.alwaysmusic.description = 启用后，游戏内音乐将持续循环播放。
setting.uiscale.name = 界面缩放比例
setting.hints.name = 提示`;
  const specs = extractSettingTable(java, { bundleEn, bundleZh });
  assert.deepEqual(
    specs.map((spec) => spec.key),
    ['alwaysmusic', 'uiscale', 'hints'],
  );
  assert.deepEqual(specs[0].name, { en: 'Play Music', zh_CN: '始终播放音乐' });
  assert.deepEqual(specs[0].description, {
    en: 'Keep music playing.',
    zh_CN: '启用后，游戏内音乐将持续循环播放。',
  });
  assert.equal(specs[1].type, 'int');
  assert.deepEqual(
    { min: specs[1].min, max: specs[1].max, step: specs[1].step, unit: specs[1].unit },
    { min: 25, max: 300, step: 5, unit: '%' },
  );
});

test('diffSettingTables：输出新增/修改/删除', () => {
  const previous = buildSettingTable({
    version: 'v160.7',
    build: 160,
    now: '2026-11-01T00:00:00Z',
    specs: [
      { key: 'a', type: 'bool', name: { en: 'A' }, description: {}, categories: ['game'] },
      { key: 'b', type: 'bool', name: { en: 'B' }, description: {}, categories: ['game'] },
    ],
  });
  const next = buildSettingTable({
    version: 'v161',
    build: 161,
    now: '2026-11-09T00:00:00Z',
    specs: [
      { key: 'a', type: 'int', name: { en: 'A' }, description: {}, categories: ['game'] },
      { key: 'c', type: 'bool', name: { en: 'C' }, description: {}, categories: ['game'] },
    ],
  });
  const diff = diffSettingTables(previous, next, {
    fromVersion: 'v160.7',
    toVersion: 'v161',
    build: 161,
    now: '2026-11-09T00:00:00Z',
  });
  assert.deepEqual(diff.add.map((spec) => spec.key), ['c']);
  assert.deepEqual(diff.changed.map((spec) => spec.key), ['a']);
  assert.deepEqual(diff.remove, ['b']);
});
