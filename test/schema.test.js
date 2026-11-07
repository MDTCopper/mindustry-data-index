import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = path.join(repoRoot, 'schema');

const EXPECTED_REQUIRED = {
  'index.json': ['formatVersion', 'generatedAt', 'source', 'mods', 'skipped'],
  'index-full.json': ['formatVersion', 'generatedAt', 'source', 'mods', 'skipped'],
  'releases.json': ['formatVersion', 'repo', 'generatedAt', 'modType', 'versions'],
  'community-index.json': ['formatVersion', 'generatedAt', 'source', 'mods', 'skipped'],
  'community-index-full.json': ['formatVersion', 'generatedAt', 'source', 'mods', 'skipped'],
  'community-releases.json': ['formatVersion', 'repo', 'generatedAt', 'modType', 'versions'],
  'summary.json': ['formatVersion', 'generatedAt', 'totals', 'mods'],
  'community-summary.json': ['formatVersion', 'generatedAt', 'totals', 'mods'],
  'versions.json': ['update_time', 'source', 'releases', 'latest_be'],
  'mod-gate.json': ['formatVersion', 'generatedAt', 'gate', 'source', 'rules', 'versions'],
  'java-gate.json': ['formatVersion', 'generatedAt', 'gate', 'source', 'rules', 'versions'],
  'refresh-state.json': ['formatVersion', 'updatedAt', 'mods'],
  'community-refresh-state.json': ['formatVersion', 'updatedAt', 'mods'],
  'blacklist-state.json': ['formatVersion', 'fetchedAt', 'sourceUrl', 'sourceHash', 'nameBlacklist', 'blacklist', 'globalBlacklist'],
  'status.json': ['formatVersion', 'generatedAt', 'datasets', 'api', 'validate'],
  'heat-history.json': ['formatVersion', 'generatedAt', 'mods'],
  'heat-commit-state.json': ['formatVersion', 'fetchedAt', 'complete', 'stats'],
  'repo-created.json': ['formatVersion', 'updatedAt', 'repos'],
  'repo-stats.json': ['formatVersion', 'updatedAt', 'repos'],
};

test('schema/: 全部是合法 JSON 且使用 draft 2020-12', () => {
  const files = readdirSync(schemaDir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 19);
  for (const name of files) {
    const schema = JSON.parse(readFileSync(path.join(schemaDir, name), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
    assert.equal(typeof schema.title, 'string', name);
  }
});

test('schema/: 关键数据文件 required 字段齐全，formatVersion 与当前实现一致', () => {
  for (const [name, required] of Object.entries(EXPECTED_REQUIRED)) {
    const schema = JSON.parse(readFileSync(path.join(schemaDir, name), 'utf8'));
    for (const field of required) {
      assert.ok(schema.required.includes(field), `${name} 缺少 required ${field}`);
    }
  }
  const releases = JSON.parse(readFileSync(path.join(schemaDir, 'releases.json'), 'utf8'));
  assert.equal(releases.properties.formatVersion.const, 3);
  assert.ok(releases.required.includes('versions'));
  assert.ok(releases.required.includes('modType'));

  const index = JSON.parse(readFileSync(path.join(schemaDir, 'index.json'), 'utf8'));
  const modRequired = index.properties.mods.items.required;
  for (const field of ['namePlain', 'authorPlain', 'descriptionPlain', 'modType', 'gameVersionRanges', 'releaseUpdatedAt', 'commitUpdatedAt', 'score']) {
    assert.ok(modRequired.includes(field), `index 条目缺少 ${field}`);
  }
  for (const field of ['hasJava', 'hasScripts', 'removedCount', 'compatRanges', 'latestCompatible', 'iosCompatible', 'legacyCompatible']) {
    assert.ok(!modRequired.includes(field), `index 条目不应再有 ${field}`);
  }

  const community = JSON.parse(readFileSync(path.join(schemaDir, 'community-index.json'), 'utf8'));
  assert.ok(community.properties.mods.items.required.includes('modType'));
  assert.ok(community.properties.mods.items.required.includes('descriptionPlain'));
  assert.ok(community.properties.mods.items.required.includes('score'));

  const summary = JSON.parse(readFileSync(path.join(schemaDir, 'summary.json'), 'utf8'));
  for (const field of ['rank', 'recommendVisible']) {
    assert.ok(summary.properties.mods.items.required.includes(field), `summary 条目缺少 ${field}`);
  }
  assert.ok(!('maintenanceStatus' in summary.properties.mods.items.properties));
  const heatFields = index.properties.mods.items.properties.score.required;
  assert.deepEqual(
    [...heatFields].sort(),
    ['downloadsScore', 'penaltyScore', 'newModMultiplier', 'recommendVisible', 'starsScore', 'updateScore'].sort(),
  );

  const changes = JSON.parse(readFileSync(path.join(schemaDir, 'changes.json'), 'utf8'));
  assert.equal(changes.type, 'array');
  assert.equal(changes.maxItems, 500);
  assert.deepEqual(
    changes.items.properties.action.enum,
    ['mod-added', 'mod-updated', 'release-added', 'tag-removed', 'release-removed'],
  );
});
