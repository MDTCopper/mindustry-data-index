import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOD_ICON_BASE,
  modIconUrl,
  normalizeMods,
} from '../src/mods-source.js';

function rawMod(overrides = {}) {
  return {
    repo: 'owner/demo',
    internalName: 'demo',
    name: 'Demo',
    author: 'author',
    version: '1.0',
    minGameVersion: '146',
    lastUpdated: '2026-10-01T00:00:00Z',
    stars: 1,
    hasIcon: true,
    hasScripts: false,
    hasJava: true,
    iconHash: 'A'.repeat(64),
    ...overrides,
  };
}

test('modIconUrl：hasIcon true / false / 缺字段三种情况', () => {
  assert.equal(
    modIconUrl('owner/demo', true),
    `${MOD_ICON_BASE}/owner_demo`,
  );
  assert.equal(modIconUrl('owner/demo', false), null);
  // 官方列表缺字段（null）时也给出地址，由客户端自己决定是否试一次
  assert.equal(modIconUrl('owner/demo', null), `${MOD_ICON_BASE}/owner_demo`);
  assert.equal(modIconUrl('owner/demo', undefined), `${MOD_ICON_BASE}/owner_demo`);
});

test('modIconUrl：repo 含大写、-、_ 时只把 / 换成 _', () => {
  assert.equal(
    modIconUrl('Anuken/Example-Mod_2', true),
    `${MOD_ICON_BASE}/Anuken_Example-Mod_2`,
  );
});

test('normalizeMods：iconHash 原样保留、缺字段为 null、hasIcon 缺字段保持 null', () => {
  const mods = normalizeMods([
    rawMod(),
    rawMod({ repo: 'owner/noicon', hasIcon: false, iconHash: undefined }),
  ]);
  assert.equal(mods[0].iconHash, 'A'.repeat(64));
  assert.equal(mods[1].iconHash, null);
  assert.equal(mods[1].hasIcon, false);
  assert.equal(mods[1].hasScripts, false);
  assert.equal(mods[1].hasJava, true);

  const missing = normalizeMods([rawMod({ hasIcon: undefined })]);
  assert.equal(missing[0].hasIcon, null);
});
