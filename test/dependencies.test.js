import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDependencyIndex } from '../src/dependencies.js';

test('buildDependencyIndex：internalName 节点、反向依赖与缺失依赖', () => {
  const official = {
    mods: [
      { internalName: 'base-mod', repo: 'a/base', name: 'Base', version: '1.0' },
      {
        internalName: 'addon-mod',
        repo: 'a/addon',
        name: 'Addon',
        version: '1.0',
        dependencies: ['base-mod', 'missing-mod'],
      },
    ],
  };
  const community = {
    mods: [
      {
        internalName: 'community-addon',
        repo: 'b/community',
        version: '2.0',
        dependencies: ['Base-Mod'],
      },
    ],
  };
  const index = buildDependencyIndex({
    official,
    community,
    now: '2026-11-11T00:00:00Z',
  });
  assert.deepEqual(index.mods['addon-mod'].dependencies, ['base-mod', 'missing-mod']);
  assert.deepEqual(index.reverse['base-mod'], ['addon-mod', 'community-addon']);
  assert.deepEqual(index.missing, [
    {
      id: 'addon-mod',
      repo: 'a/addon',
      source: 'official',
      dependency: 'missing-mod',
    },
  ]);
});
