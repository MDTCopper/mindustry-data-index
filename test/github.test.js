import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpClient,
  HttpError,
  RateLimitError,
  parseRetryAfter,
  computeBackoffMs,
  createPool,
} from '../src/github.js';

function respond(status, body = '', headers = {}) {
  return {
    status,
    headers: new Headers(headers),
    text: async () => body,
  };
}

// 记录每次请求的 fetch 替身：按调用次序返回准备好的响应
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) {
      throw new Error('没有更多预设响应');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { impl, calls };
}

test('parseRetryAfter 支持秒数与 HTTP 日期', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('not-a-date'), null);
  const now = Date.parse('2026-11-06T03:00:00Z');
  assert.equal(parseRetryAfter('Fri, 06 Nov 2026 03:00:10 GMT', now), 10_000);
});

test('computeBackoffMs 指数退避', () => {
  assert.equal(computeBackoffMs(0), 1000);
  assert.equal(computeBackoffMs(1), 2000);
  assert.equal(computeBackoffMs(2), 4000);
  assert.equal(computeBackoffMs(0, 10), 10);
});

test('createPool 限制同时进行的任务数', async () => {
  const pool = createPool(2);
  let active = 0;
  let peak = 0;
  const task = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  };
  await Promise.all(Array.from({ length: 5 }, () => pool.run(task)));
  assert.equal(peak, 2);
  assert.equal(pool.active, 0);
  assert.equal(pool.pending, 0);
});

test('HttpClient：5xx 重试后成功', async () => {
  const sleeps = [];
  const { impl, calls } = fakeFetch([
    respond(500),
    respond(502),
    respond(200, '{"ok":true}'),
  ]);
  const client = new HttpClient({
    fetchImpl: impl,
    sleep: async (ms) => sleeps.push(ms),
    retryBaseMs: 10,
    maxRetries: 3,
  });
  const result = await client.get('https://api.github.com/rate_limit');
  assert.equal(result.status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(client.stats.retries, 2);
});

test('HttpClient：404 原样返回交给调用方', async () => {
  const { impl } = fakeFetch([respond(404, '{}')]);
  const client = new HttpClient({ fetchImpl: impl });
  const result = await client.get('https://raw.githubusercontent.com/o/r/main/mod.hjson');
  assert.equal(result.status, 404);
});

test('HttpClient：403 带 retry-after 先等待再重试', async () => {
  const sleeps = [];
  const { impl, calls } = fakeFetch([
    respond(403, '', { 'retry-after': '2' }),
    respond(200, 'ok'),
  ]);
  const client = new HttpClient({
    fetchImpl: impl,
    sleep: async (ms) => sleeps.push(ms),
  });
  const result = await client.get('https://api.github.com/repos/o/r/releases');
  assert.equal(result.status, 200);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(calls.length, 2);
  assert.equal(client.stats.rateLimitWaits, 1);
});

test('HttpClient：304 不算失败，带 If-None-Match', async () => {
  const { impl, calls } = fakeFetch([respond(304, '', { etag: 'W/"x"' })]);
  const client = new HttpClient({ fetchImpl: impl, token: 'secret' });
  const result = await client.get('https://api.github.com/repos/o/r/releases', {
    etag: 'W/"x"',
  });
  assert.equal(result.status, 304);
  assert.equal(client.stats.notModified, 1);
  assert.equal(calls[0].options.headers['If-None-Match'], 'W/"x"');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
});

test('HttpClient：token 只发给 api.github.com', async () => {
  const { impl, calls } = fakeFetch([
    respond(200, 'ok'),
    respond(200, 'ok'),
  ]);
  const client = new HttpClient({ fetchImpl: impl, token: 'secret' });
  await client.get('https://api.github.com/repos/o/r/releases');
  await client.get('https://raw.githubusercontent.com/o/r/main/mod.hjson');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.match(calls[0].options.headers['User-Agent'], /mindustry-mods-index/);
});

test('HttpClient：网络错误重试耗尽后抛 HttpError', async () => {
  const { impl } = fakeFetch([new Error('ECONNRESET'), new Error('ECONNRESET')]);
  const client = new HttpClient({
    fetchImpl: impl,
    sleep: async () => {},
    maxRetries: 1,
  });
  await assert.rejects(
    client.get('https://api.github.com/repos/o/r/releases'),
    (error) => error instanceof HttpError && error.status === 0,
  );
});

test('HttpClient：配额等待超过上限抛 RateLimitError', async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const { impl } = fakeFetch([
    respond(403, '', {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(reset),
    }),
  ]);
  const client = new HttpClient({
    fetchImpl: impl,
    sleep: async () => {},
    maxRateLimitWaitMs: 1000,
  });
  await assert.rejects(
    client.get('https://api.github.com/repos/o/r/releases'),
    (error) => error instanceof RateLimitError,
  );
});
