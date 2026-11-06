import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlacklistState,
  decodeBase64String,
  isBlacklisted,
  normalizeBlacklistState,
  parseModUpdaterSource,
} from '../src/blacklist.js';

const SOURCE = `
public class ModUpdater {
    private static final Seq<String> nameBlacklist = Seq.with(
        "theee145", "o7", "pixaxeofpixie", "iron-miner", "easyplaysu",
        "guiymour", "mishakorzik", "n3m1x10", "evilman12317", "guiymou", "thesaus"
    );
    private static final ObjectSet<String> blacklist = ObjectSet.with(
        "snow-of-spirit-fox-mori/old-mod",
        "Anuken/ExampleMod",
        "RebornTrack970/Multiplayernt"
    );
    private static final Pattern globalBlacklist = Pattern.compile(
        Base64Coder.decodeString("Z2F5fHJhY2lzdHx1dWlk")
    );
}`;

test('decodeBase64String：Anuken globalBlacklist 解码为 gay|racist|uuid', () => {
  assert.equal(decodeBase64String('Z2F5fHJhY2lzdHx1dWlk'), 'gay|racist|uuid');
});

test('parseModUpdaterSource：抽取 nameBlacklist / blacklist / globalBlacklist', () => {
  const parsed = parseModUpdaterSource(SOURCE);
  assert.ok(parsed);
  assert.deepEqual(parsed.nameBlacklist, [
    'theee145',
    'o7',
    'pixaxeofpixie',
    'iron-miner',
    'easyplaysu',
    'guiymour',
    'mishakorzik',
    'n3m1x10',
    'evilman12317',
    'guiymou',
    'thesaus',
  ]);
  assert.equal(parsed.blacklist.length, 3);
  assert.ok(parsed.blacklist.includes('anuken/examplemod'));
  assert.deepEqual(parsed.globalBlacklist, { source: 'gay|racist|uuid', flags: 'i' });
});

test('parseModUpdaterSource：源格式变化（缺字段 / 空 Base64）返回 null', () => {
  assert.equal(parseModUpdaterSource(''), null);
  assert.equal(parseModUpdaterSource('nameBlacklist = Seq.with("a");'), null);
  assert.equal(
    parseModUpdaterSource(
      'nameBlacklist = Seq.with("a"); blacklist = ObjectSet.with("b/c"); globalBlacklist = Base64Coder.decodeString("");',
    ),
    null,
  );
});

test('blacklist 应用：前缀 / 精确 / 名称与描述正则', () => {
  const blacklist = parseModUpdaterSource(SOURCE);
  // nameBlacklist 是 full_name 前缀匹配
  assert.equal(isBlacklisted({ repo: 'theee145/anything' }, blacklist), true);
  assert.equal(isBlacklisted({ repo: 'Theee145/Anything' }, blacklist), true);
  assert.equal(isBlacklisted({ repo: 'other/theee145' }, blacklist), false);
  // blacklist 精确匹配 repo，忽略大小写
  assert.equal(isBlacklisted({ repo: 'ANUKEN/examplemod' }, blacklist), true);
  assert.equal(isBlacklisted({ repo: 'anuken/examplemod-extra' }, blacklist), false);
  // globalBlacklist 作用于名称和描述
  assert.equal(isBlacklisted({ repo: 'a/b', name: 'UUID changer' }, blacklist), true);
  assert.equal(isBlacklisted({ repo: 'a/b', description: 'a racist mod' }, blacklist), true);
  assert.equal(isBlacklisted({ repo: 'a/b', name: 'normal', description: 'ok' }, blacklist), false);
});

test('blacklist state 形状与清洗', () => {
  const parsed = parseModUpdaterSource(SOURCE);
  const state = buildBlacklistState({
    parsed,
    hash: 'abc',
    fetchedAt: '2026-11-06T00:00:00.000Z',
  });
  assert.equal(state.formatVersion, 1);
  assert.equal(state.sourceHash, 'abc');
  const normalized = normalizeBlacklistState(state);
  assert.ok(normalized);
  assert.equal(normalized.blacklist.length, 3);
  assert.equal(normalizeBlacklistState(null), null);
  assert.equal(normalizeBlacklistState({ formatVersion: 1, globalBlacklist: { source: '(' } }), null);
});
