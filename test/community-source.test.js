import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_PER_PAGE,
  buildSearchWindows,
  discoverCommunityRepos,
  fetchSearchPage,
  normalizeSearchItems,
  searchApiUrl,
  topicQueryForWindow,
} from '../src/community-source.js';

function searchItem(fullName, overrides = {}) {
  return {
    full_name: fullName,
    archived: false,
    is_template: false,
    fork: false,
    pushed_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    stargazers_count: 1,
    description: 'desc',
    default_branch: 'main',
    ...overrides,
  };
}

function fakeSearchClient(handler) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      return handler(url);
    },
  };
}

test('topic 查询与搜索 API 地址', () => {
  assert.equal(
    topicQueryForWindow('2022-05-01', '2022-11-01'),
    'mindustry-mod in:topics archived:false template:false pushed:2022-05-01..2022-11-01',
  );
  const url = searchApiUrl({ query: 'mindustry-mod in:topics', page: 2 });
  assert.ok(url.startsWith('https://api.github.com/search/repositories?'));
  assert.ok(url.includes('per_page=100'));
  assert.ok(url.includes('page=2'));
  assert.ok(url.includes('sort=updated'));
});

test('buildSearchWindows：从 2022-05 按半年切到 now，窗口连续', () => {
  const windows = buildSearchWindows({ now: new Date('2024-06-15T00:00:00Z') });
  assert.ok(windows.length >= 4);
  assert.equal(windows[0].since, '2022-05-01');
  assert.equal(windows[0].until, '2022-11-01');
  for (let index = 1; index < windows.length; index += 1) {
    assert.equal(windows[index].since, windows[index - 1].until);
  }
  assert.equal(windows.at(-1).until, '2024-06-15');
});

test('normalizeSearchItems：过滤非法项、映射字段', () => {
  assert.deepEqual(
    normalizeSearchItems([
      searchItem('Owner/Repo', { archived: true, is_template: true, stargazers_count: 9 }),
      { full_name: 'bad' },
      null,
    ]),
    [
      {
        repo: 'Owner/Repo',
        archived: true,
        template: true,
        fork: false,
        pushedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        stars: 9,
        description: 'desc',
        defaultBranch: 'main',
      },
    ],
  );
});

test('fetchSearchPage：解析 total_count / items / incomplete', async () => {
  const client = fakeSearchClient(() => ({
    status: 200,
    text: JSON.stringify({
      total_count: 3,
      incomplete_results: true,
      items: [searchItem('a/b')],
    }),
  }));
  const result = await fetchSearchPage(client, { query: 'q' });
  assert.equal(result.totalCount, 3);
  assert.equal(result.incomplete, true);
  assert.equal(result.items.length, 1);
});

test('discoverCommunityRepos：多窗口分页取全并按 full_name 小写去重', async () => {
  const pages = {
    '2022-05-01..2022-11-01:1': [searchItem('a/one'), searchItem('b/two')],
    '2022-11-01..2023-05-01:1': [searchItem('A/One'), searchItem('c/three')],
  };
  const client = fakeSearchClient((url) => {
    const query = decodeURIComponent(new URL(url).searchParams.get('q'));
    const window = query.match(/pushed:(\S+)/)[1];
    const page = new URL(url).searchParams.get('page');
    const items = pages[`${window}:${page}`] ?? [];
    return { status: 200, text: JSON.stringify({ total_count: items.length, items }) };
  });
  const windows = buildSearchWindows({ now: new Date('2023-05-02T00:00:00Z') }).slice(0, 2);
  const result = await discoverCommunityRepos(client, { windows });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.stats.requests, 2);
  assert.ok(result.candidates.some((repo) => repo.repo === 'a/one'));
  assert.ok(result.candidates.some((repo) => repo.repo === 'c/three'));
});

test('discoverCommunityRepos：total_count > 1000 时二分时间窗', async () => {
  const queries = [];
  const client = fakeSearchClient((url) => {
    const query = decodeURIComponent(new URL(url).searchParams.get('q'));
    queries.push(query);
    if (query.endsWith('2022-05-01..2022-11-01')) {
      return { status: 200, text: JSON.stringify({ total_count: 1200, items: [] }) };
    }
    return {
      status: 200,
      text: JSON.stringify({ total_count: 1, items: [searchItem('x/y')] }),
    };
  });
  const result = await discoverCommunityRepos(client, {
    windows: [
      { since: '2022-05-01', until: '2022-11-01', query: topicQueryForWindow('2022-05-01', '2022-11-01') },
    ],
  });
  assert.equal(result.candidates.length >= 1, true);
  assert.ok(queries.some((query) => query.includes('2022-08-01') || query.includes('2022-07')));
});

test('discoverCommunityRepos：maxCandidates 限制探测规模（本地验证）', async () => {
  const client = fakeSearchClient(() => ({
    status: 200,
    text: JSON.stringify({
      total_count: 500,
      items: Array.from({ length: 100 }, (_, index) => searchItem(`owner/repo-${index}`)),
    }),
  }));
  const result = await discoverCommunityRepos(client, {
    windows: [{ since: '2022-05-01', until: '2022-11-01', query: 'q pushed:2022-05-01..2022-11-01' }],
    maxCandidates: 10,
  });
  assert.equal(result.candidates.length, 10);
  assert.equal(result.stats.requests, 1);
});

test('SEARCH_PER_PAGE 固定 100', () => {
  assert.equal(SEARCH_PER_PAGE, 100);
});
