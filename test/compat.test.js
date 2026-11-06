import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompat,
  gameVersionsFromFile,
  gateValueForVersion,
  latestCompatibleTag,
  parseGameVersion,
} from '../src/compat.js';

const GAME_VERSIONS = [
  { tag: 'v136', version: 136 },
  { tag: 'v146', version: 146 },
  { tag: 'v147', version: 147 },
  { tag: 'v154.2', version: 154.2 },
  { tag: 'v159.7', version: 159.7 },
  { tag: 'v160.7', version: 160.7 },
];

const MOD_GATE = {
  versions: GAME_VERSIONS.map((game) => ({
    tag: game.tag,
    version: game.version,
    value: game.version < 147 ? 97 : game.version < 154.2 ? 136 : 136,
    source: 'baseline',
  })),
  rules: [{ min: 97, max: null, value: 136, source: 'mixed' }],
};

const JAVA_GATE = {
  versions: GAME_VERSIONS.map((game) => ({
    tag: game.tag,
    version: game.version,
    value: game.version < 136 ? 97 : game.version < 147 ? 136 : game.version < 154.2 ? 136 : 154,
    source: 'game-source',
  })),
  rules: [{ min: 97, max: null, value: 154, source: 'game-source' }],
};

function release(tag, minGameVersion, publishedAt, extra = {}) {
  return {
    tag,
    name: tag,
    hasRelease: true,
    prerelease: false,
    publishedAt,
    minGameVersion,
    modVersion: tag.replace(/^v/, ''),
    assets: [],
    ...extra,
  };
}

test('gameVersionsFromFile / gateValueForVersion / parseGameVersion', () => {
  const versions = gameVersionsFromFile({
    releases: [{ tag_name: 'v160.7' }, { tag_name: 'v136' }, { tag_name: 'v154.2' }],
  });
  assert.deepEqual(
    versions.map((item) => item.version),
    [136, 154.2, 160.7],
  );
  assert.equal(gateValueForVersion(MOD_GATE, 136), 97);
  assert.equal(gateValueForVersion(JAVA_GATE, 154.2), 154);
  // versions 里没有时回落 rules
  assert.equal(gateValueForVersion({ rules: [{ min: 97, max: null, value: 136 }] }, 160), 136);
  assert.equal(parseGameVersion('157.1，'), 157.1);
  assert.equal(parseGameVersion(null), null);
});

test('buildCompat：按 publishedAt 新旧 + 门禁上界生成不重叠区间', () => {
  const entries = [
    release('v2.0.0', '154.2', '2026-10-01T00:00:00Z'),
    release('v1.0.0', '146', '2026-01-01T00:00:00Z'),
  ];
  const compat = buildCompat({ entries, gameVersions: GAME_VERSIONS, gateFile: MOD_GATE });
  assert.deepEqual(compat, [
    { tag: 'v1.0.0', modVersion: '1.0.0', minGameVersion: '146', maxGameVersion: 154.2, hasRelease: true },
    { tag: 'v2.0.0', modVersion: '2.0.0', minGameVersion: '154.2', maxGameVersion: null, hasRelease: true },
  ]);
});

test('buildCompat：java 门禁在 154.2 跳变时旧版本区间上界被门禁截断', () => {
  const entries = [release('v1.0.0', '136', '2026-01-01T00:00:00Z')];
  const compat = buildCompat({ entries, gameVersions: GAME_VERSIONS, gateFile: JAVA_GATE });
  // java gate 在 154.2 变为 154 > 136，所以 136 版本只能覆盖到 154.2
  assert.deepEqual(compat, [
    { tag: 'v1.0.0', modVersion: '1.0.0', minGameVersion: '136', maxGameVersion: 154.2, hasRelease: true },
  ]);
});

test('buildCompat：tag-only 只填补 release 未覆盖区间，且推荐优先 hasRelease', () => {
  const entries = [
    release('v2.0.0', '154.2', '2026-10-01T00:00:00Z'),
    {
      tag: 'v0.9.0',
      name: 'v0.9.0',
      hasRelease: false,
      prerelease: null,
      publishedAt: null,
      minGameVersion: '136',
      modVersion: '0.9.0',
      assets: [],
    },
  ];
  const compat = buildCompat({ entries, gameVersions: GAME_VERSIONS, gateFile: MOD_GATE });
  assert.deepEqual(compat, [
    { tag: 'v0.9.0', modVersion: '0.9.0', minGameVersion: '136', maxGameVersion: 154.2, hasRelease: false },
    { tag: 'v2.0.0', modVersion: '2.0.0', minGameVersion: '154.2', maxGameVersion: null, hasRelease: true },
  ]);
});

test('buildCompat：没有 minGameVersion / 空 release / removed 条目 → 空或跳过', () => {
  assert.deepEqual(buildCompat({ entries: [], gameVersions: GAME_VERSIONS }), []);
  assert.deepEqual(
    buildCompat({
      entries: [release('v1', null, '2026-01-01T00:00:00Z')],
      gameVersions: GAME_VERSIONS,
    }),
    [],
  );
  assert.deepEqual(
    buildCompat({
      entries: [release('v1', '146', '2026-01-01T00:00:00Z', { removed: true })],
      gameVersions: GAME_VERSIONS,
    }),
    [],
  );
});

test('latestCompatibleTag：取最新游戏版本下的推荐 tag', () => {
  const compat = [
    { tag: 'a', minGameVersion: '136', maxGameVersion: 154.2 },
    { tag: 'b', minGameVersion: '154.2', maxGameVersion: null },
  ];
  assert.equal(latestCompatibleTag(compat, GAME_VERSIONS), 'b');
  assert.equal(latestCompatibleTag([], GAME_VERSIONS), null);
  assert.equal(latestCompatibleTag([compat[0]], GAME_VERSIONS), null);
});
