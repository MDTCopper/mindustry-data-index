import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contentCountsFromTree,
  languageStatsFromBundles,
  statsBodyChanged,
} from '../src/extra-stats.js';

test('languageStatsFromBundles：以 en 为基准算 key 数与翻译率，超过基准封顶 1', () => {
  const stats = languageStatsFromBundles([
    { language: 'en', keys: new Set(['a', 'b', 'c', 'd']) },
    { language: 'zh_CN', keys: new Set(['a', 'b']) },
    { language: 'ru', keys: new Set(['a', 'b', 'c', 'd', 'e']) },
  ]);
  assert.equal(stats.base, 'en');
  assert.equal(stats.totalKeys, 4);
  assert.deepEqual(stats.languages, [
    { language: 'en', keys: 4, rate: 1 },
    { language: 'ru', keys: 5, rate: 1 },
    { language: 'zh_CN', keys: 2, rate: 0.5 },
  ]);
});

test('contentCountsFromTree：只数 content/<kind>/*.json', () => {
  const counts = contentCountsFromTree([
    'content/blocks/a.json',
    'src/content/blocks/b.json',
    'content/items/c.json',
    'content/blocks/readme.md',
    'content/units/d.json',
  ]);
  assert.equal(counts.blocks, 2);
  assert.equal(counts.items, 1);
  assert.equal(counts.units, 1);
  assert.equal(counts.liquids, 0);
});

test('statsBodyChanged：generatedAt 变化不算内容变化', () => {
  assert.equal(
    statsBodyChanged({ formatVersion: 1, generatedAt: 'a', repo: 'r' }, {
      formatVersion: 1,
      generatedAt: 'b',
      repo: 'r',
    }),
    false,
  );
  assert.equal(
    statsBodyChanged({ formatVersion: 1, generatedAt: 'a', repo: 'r' }, {
      formatVersion: 1,
      generatedAt: 'b',
      repo: 'x',
    }),
    true,
  );
});
