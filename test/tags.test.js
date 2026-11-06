import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAGS_PER_PAGE,
  apiTagsUrl,
  fetchAllTags,
  fetchTagsPage,
  normalizeTags,
} from '../src/tags.js';

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      return handler(url);
    },
  };
}

test('apiTagsUrl：分页参数与 repo 校验', () => {
  assert.equal(
    apiTagsUrl('oscillatorium/alef-null'),
    'https://api.github.com/repos/oscillatorium/alef-null/tags?per_page=100&page=1',
  );
  assert.equal(
    apiTagsUrl('owner/repo', 3),
    'https://api.github.com/repos/owner/repo/tags?per_page=100&page=3',
  );
  assert.throws(() => apiTagsUrl('owner'), /非法 repo/);
});

test('normalizeTags：只留合法 name、去重、保持顺序', () => {
  assert.deepEqual(
    normalizeTags([
      { name: 'v1.04' },
      { name: 'v1.03' },
      { name: 'v1.04' },
      { name: '' },
      { name: 42 },
      null,
      { commit: { sha: 'x' } },
    ]),
    ['v1.04', 'v1.03'],
  );
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags([]), []);
});

test('fetchAllTags：从第 1 页抓到不足一页，合并去重', async () => {
  const client = fakeClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 1) {
      return {
        status: 200,
        text: JSON.stringify(
          Array.from({ length: TAGS_PER_PAGE }, (_, index) => ({
            name: `v${TAGS_PER_PAGE - index}`,
          })),
        ),
      };
    }
    return { status: 200, text: JSON.stringify([{ name: 'v0.1' }]) };
  });
  const result = await fetchAllTags(client, 'owner/repo');
  assert.equal(result.pageCount, 2);
  assert.equal(result.tags.length, TAGS_PER_PAGE + 1);
  assert.equal(result.tags[0], `v${TAGS_PER_PAGE}`);
  assert.equal(result.tags.at(-1), 'v0.1');
  assert.equal(client.calls.length, 2);
});

test('fetchAllTags：恰好整页时继续抓下一页，直到空页', async () => {
  const fullPage = Array.from({ length: TAGS_PER_PAGE }, (_, index) => ({
    name: `v${index}`,
  }));
  const client = fakeClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return { status: 200, text: JSON.stringify(page === 1 ? fullPage : []) };
  });
  const result = await fetchAllTags(client, 'owner/repo');
  assert.equal(result.pageCount, 2);
  assert.equal(result.tags.length, TAGS_PER_PAGE);
  assert.equal(client.calls.length, 2);
});

test('fetchTagsPage：解析单个页面', async () => {
  const client = fakeClient(() => ({
    status: 200,
    text: JSON.stringify([{ name: 'a' }, { name: 'b' }]),
  }));
  assert.deepEqual(await fetchTagsPage(client, 'owner/repo', 2), ['a', 'b']);
  assert.ok(client.calls[0].endsWith('page=2'));
});
