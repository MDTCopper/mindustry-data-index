import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMUNITY_DIR,
  buildCommunityIndexEntry,
  buildCommunityMod,
  checkEligibility,
  detectCommunityIcon,
  normalizeCommunityCandidates,
  prefilterCandidate,
  probeAndFilterCandidates,
} from '../src/community.js';
import { parseModMetadataDocument } from '../src/mod-meta.js';
import { parseModUpdaterSource } from '../src/blacklist.js';

const BLACKLIST = parseModUpdaterSource(`
nameBlacklist = Seq.with("theee145");
blacklist = ObjectSet.with("Anuken/ExampleMod");
globalBlacklist = Base64Coder.decodeString("Z2F5fHJhY2lzdHx1dWlk");
`);

function candidate(fullName, overrides = {}) {
  return {
    repo: fullName,
    archived: false,
    template: false,
    fork: false,
    pushedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    stars: 3,
    description: 'A Mindustry mod',
    defaultBranch: 'main',
    ...overrides,
  };
}

function metadata(overrides = {}) {
  return {
    name: 'Demo Mod',
    author: 'author',
    description: 'adds blocks',
    modVersion: '1.0',
    minGameVersion: '146',
    hideBrowser: false,
    hasScripts: false,
    hasJava: false,
    ...overrides,
  };
}

test('parseModMetadataDocument：解析名称/作者/描述/hideBrowser/scripts/main', () => {
  const parsed = parseModMetadataDocument(`{
    name: "Demo"
    author: "someone"
    description: "hello"
    version: 1.2
    minGameVersion: 146
    main: "mindustry.Demo"
    hideBrowser: true
  }`);
  assert.equal(parsed.name, 'Demo');
  assert.equal(parsed.author, 'someone');
  assert.equal(parsed.description, 'hello');
  assert.equal(parsed.modVersion, '1.2');
  assert.equal(parsed.minGameVersion, '146');
  assert.equal(parsed.hasJava, true);
  assert.equal(parsed.hasScripts, false);
  assert.equal(parsed.hideBrowser, true);

  const scripted = parseModMetadataDocument('{ name: "S", scripts: ["a.js"] }');
  assert.equal(scripted.hasScripts, true);
  assert.equal(scripted.hasJava, false);
  assert.equal(parseModMetadataDocument('not an object'), null);
});

test('prefilterCandidate：官方已有 / archived / template / 黑名单', () => {
  const stats = { official: 0, archived: 0, template: 0, blacklisted: 0 };
  const officialRepos = new Set(['official/mod']);
  assert.equal(
    prefilterCandidate(candidate('Official/Mod'), { officialRepos, blacklist: BLACKLIST, stats }),
    null,
  );
  assert.equal(
    prefilterCandidate(candidate('x/archived', { archived: true }), {
      officialRepos,
      blacklist: BLACKLIST,
      stats,
    }),
    null,
  );
  assert.equal(
    prefilterCandidate(candidate('theee145/mod'), { officialRepos, blacklist: BLACKLIST, stats }),
    null,
  );
  assert.equal(
    prefilterCandidate(candidate('x/racist-mod'), { officialRepos, blacklist: BLACKLIST, stats }),
    null,
  );
  assert.ok(prefilterCandidate(candidate('x/good'), { officialRepos, blacklist: BLACKLIST, stats }));
  assert.deepEqual(stats, { official: 1, archived: 1, template: 0, blacklisted: 2 });
});

test('checkEligibility：minGameVersion<136 / hideBrowser / 无元数据 / 黑名单名称', () => {
  const stats = { noMetadata: 0, lowVersion: 0, hidden: 0, blacklisted: 0 };
  assert.equal(checkEligibility(candidate('x/a'), null, BLACKLIST, stats), null);
  assert.equal(checkEligibility(candidate('x/a'), metadata({ minGameVersion: 130 }), BLACKLIST, stats), null);
  assert.equal(checkEligibility(candidate('x/a'), metadata({ hideBrowser: true }), BLACKLIST, stats), null);
  assert.equal(
    checkEligibility(candidate('x/a'), metadata({ name: 'uuid changer' }), BLACKLIST, stats),
    null,
  );
  const ok = checkEligibility(candidate('x/a'), metadata({ minGameVersion: 136.5 }), BLACKLIST, stats);
  assert.ok(ok);
  assert.equal(ok.minGameVersion, 136.5);
  assert.deepEqual(stats, { noMetadata: 1, lowVersion: 1, hidden: 1, blacklisted: 1 });
});

test('buildCommunityMod：source=topic 与字段映射', () => {
  const mod = buildCommunityMod({
    candidate: candidate('Owner/Repo', { stars: 9 }),
    metadata: metadata({ name: 'Cool', author: 'me', description: 'desc' }),
    iconUrl: 'https://raw.githubusercontent.com/Owner/Repo/main/icon.png',
  });
  assert.equal(mod.repo, 'Owner/Repo');
  assert.equal(mod.source, 'topic');
  assert.equal(mod.internalName, null);
  assert.equal(mod.name, 'Cool');
  assert.equal(mod.author, 'me');
  assert.equal(mod.description, 'desc');
  assert.equal(mod.stars, 9);
  assert.equal(mod.hasIcon, true);
  assert.equal(mod.lastUpdated, '2026-01-02T00:00:00Z');
});

test('buildCommunityIndexEntry：releasesPath 带 community/ 前缀、统计口径复用', () => {
  const mod = buildCommunityMod({
    candidate: candidate('Owner/Repo'),
    metadata: metadata(),
    iconUrl: null,
  });
  const file = {
    formatVersion: 1,
    repo: 'Owner/Repo',
    generatedAt: '2026-11-06T03:00:00.000Z',
    releases: [
      {
        tag: 'v1',
        name: '1',
        hasRelease: true,
        prerelease: false,
        publishedAt: '2026-10-01T00:00:00Z',
        assets: [],
      },
      { tag: 'v0.9', name: 'v0.9', hasRelease: false, prerelease: null, publishedAt: null, assets: [] },
    ],
  };
  const entry = buildCommunityIndexEntry(mod, file, {
    relPath: 'releases/Owner/Repo.json',
    stats: { totalDownloads: 0, allAssetsDownloads: 0, latestDownloads: 0, latestSizeBytes: null, totalSizeBytes: null },
  });
  assert.equal(entry.source, 'topic');
  assert.equal(entry.releasesPath, `${COMMUNITY_DIR}/releases/Owner/Repo.json`);
  assert.equal(entry.releaseCount, 1);
  assert.equal(entry.tagCount, 2);
  assert.equal(entry.latestRelease.tag, 'v1');
});

test('detectCommunityIcon：root icon.png 404 后试 assets/icon.png', async () => {
  const calls = [];
  const client = {
    async get(url) {
      calls.push(url);
      if (url.includes('/icon.png') && !url.includes('assets/')) {
        return { status: 404, text: '' };
      }
      return { status: 200, text: 'png' };
    },
  };
  const result = await detectCommunityIcon(client, { repo: 'Owner/Repo', ref: 'main' });
  assert.equal(result.iconPath, 'assets/icon.png');
  assert.ok(result.iconUrl.endsWith('/assets/icon.png'));
  assert.equal(calls.length, 2);
});

test('probeAndFilterCandidates：串起预处理、元数据、图标与收录', async () => {
  const calls = [];
  const client = {
    async get(url) {
      calls.push(url);
      if (url.includes('/repos/official/mod/')) {
        return { status: 404, text: '' };
      }
      if (url.includes('/mod.json')) {
        return {
          status: 200,
          text: JSON.stringify({ name: 'Good', author: 'a', description: 'd', version: '1', minGameVersion: 146 }),
        };
      }
      return { status: 404, text: '' };
    },
  };
  const result = await probeAndFilterCandidates({
    candidates: [candidate('official/mod'), candidate('x/good'), candidate('theee145/bad')],
    rawClient: client,
    apiClient: null,
    officialRepos: new Set(['official/mod']),
    blacklist: BLACKLIST,
    maxCandidates: 5,
  });
  assert.equal(result.stats.official, 1);
  assert.equal(result.stats.blacklisted, 1);
  assert.equal(result.eligible.length, 1);
  assert.equal(result.eligible[0].candidate.repo, 'x/good');
});

test('normalizeCommunityCandidates：去重并拒绝非法 repo', () => {
  const normalized = normalizeCommunityCandidates([
    candidate('Owner/Repo'),
    candidate('owner/repo'),
    candidate('bad'),
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].repo, 'Owner/Repo');
});
