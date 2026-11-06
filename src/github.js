// GitHub / raw 的 HTTP 层：token、超时、重试、限流等待、ETag、并发池

export const API_HOST = 'api.github.com';
const DEFAULT_USER_AGENT = 'mindustry-mods-index';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RATE_WAIT_MS = 15 * 60 * 1000;

export class HttpError extends Error {
  constructor(message, { status = 0, url = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

function header(headers, name) {
  const value = headers?.get?.(name);
  return value === null || value === undefined ? null : String(value);
}

function numberHeader(headers, name) {
  const value = header(headers, name);
  if (value === null || !/^\d+$/.test(value.trim())) {
    return null;
  }
  return Number(value);
}

// retry-after 支持秒数与 HTTP 日期两种写法
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  if (/^\d+$/.test(text)) {
    return Number(text) * 1000;
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

// attempt 从 0 开始：1s、2s、4s
export function computeBackoffMs(attempt, baseMs = 1000) {
  return baseMs * 2 ** Math.max(0, attempt);
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

// 并发池：限制同时进行的任务数，超出的排队
export function createPool(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`并发数必须为正整数：${concurrency}`);
  }
  let active = 0;
  const queue = [];

  function pump() {
    while (active < concurrency && queue.length > 0) {
      const task = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return {
    get concurrency() {
      return concurrency;
    },
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        pump();
      });
    },
  };
}

export class HttpClient {
  constructor({
    token = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseMs = 1000,
    maxRateLimitWaitMs = DEFAULT_MAX_RATE_WAIT_MS,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    logger = null,
    userAgent = DEFAULT_USER_AGENT,
  } = {}) {
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryBaseMs = retryBaseMs;
    this.maxRateLimitWaitMs = maxRateLimitWaitMs;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.logger = logger;
    this.userAgent = userAgent;
    this.gateUntil = 0;
    this.stats = {
      requests: 0,
      retries: 0,
      notModified: 0,
      rateLimitWaits: 0,
      rateLimitWaitMs: 0,
    };
  }

  log(message) {
    this.logger?.(message);
  }

  // 剩余配额 ≤5 时先等到重置，避免请求半路被拒
  captureRateLimit(headers) {
    const remaining = numberHeader(headers, 'x-ratelimit-remaining');
    const reset = numberHeader(headers, 'x-ratelimit-reset');
    if (remaining === null || reset === null) {
      return;
    }
    if (remaining <= 5) {
      const until = reset * 1000 + 1000;
      if (until > this.gateUntil) {
        this.gateUntil = until;
      }
    }
  }

  rateLimitDelayMs(headers) {
    const retryAfter = parseRetryAfter(header(headers, 'retry-after'));
    if (retryAfter !== null) {
      return retryAfter;
    }
    const remaining = numberHeader(headers, 'x-ratelimit-remaining');
    const reset = numberHeader(headers, 'x-ratelimit-reset');
    if (remaining === 0 && reset !== null) {
      return Math.max(0, reset * 1000 - Date.now() + 1000);
    }
    return null;
  }

  async waitForGate() {
    const wait = this.gateUntil - Date.now();
    this.gateUntil = 0;
    if (wait <= 0) {
      return;
    }
    if (wait > this.maxRateLimitWaitMs) {
      throw new RateLimitError(
        `GitHub 配额耗尽，重置还要 ${Math.ceil(wait / 1000)} 秒，超过等待上限`,
      );
    }
    this.stats.rateLimitWaits += 1;
    this.stats.rateLimitWaitMs += wait;
    this.log(`等待 GitHub 配额重置 ${Math.ceil(wait / 1000)} 秒`);
    await this.sleep(wait);
  }

  async waitBeforeRetry(attempt, headers = null) {
    const rateDelay = headers ? this.rateLimitDelayMs(headers) : null;
    if (rateDelay !== null) {
      if (rateDelay > this.maxRateLimitWaitMs) {
        throw new RateLimitError(
          `GitHub 限流等待 ${Math.ceil(rateDelay / 1000)} 秒，超过等待上限`,
        );
      }
      this.stats.rateLimitWaits += 1;
      this.stats.rateLimitWaitMs += rateDelay;
      this.log(`按 GitHub 限流提示等待 ${Math.ceil(rateDelay / 1000)} 秒`);
      await this.sleep(rateDelay);
      return;
    }
    if (attempt >= this.maxRetries) {
      return;
    }
    const delay = computeBackoffMs(attempt, this.retryBaseMs);
    this.stats.retries += 1;
    this.log(`请求失败，${delay}ms 后重试`);
    await this.sleep(delay);
  }

  async get(url, { etag = null, accept = null } = {}) {
    const headers = { 'User-Agent': this.userAgent };
    const isApi = new URL(url).hostname === API_HOST;
    if (isApi) {
      headers.Accept = 'application/vnd.github+json';
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }
    }
    if (accept) {
      headers.Accept = accept;
    }
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    let attempt = 0;
    for (;;) {
      await this.waitForGate();
      this.stats.requests += 1;

      let response;
      try {
        response = await this.fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt >= this.maxRetries) {
          throw new HttpError(
            `请求失败：${url}（${error?.message ?? error}）`,
            { url },
          );
        }
        await this.waitBeforeRetry(attempt);
        attempt += 1;
        continue;
      }

      const status = response.status;
      const responseHeaders = response.headers;
      this.captureRateLimit(responseHeaders);
      const responseEtag = header(responseHeaders, 'etag');

      if (status === 304) {
        this.stats.notModified += 1;
        return { status, headers: responseHeaders, text: null, etag: responseEtag };
      }
      if (status === 200) {
        return {
          status,
          headers: responseHeaders,
          text: await response.text(),
          etag: responseEtag,
        };
      }
      if (status === 403 || status === 429) {
        const delay = this.rateLimitDelayMs(responseHeaders);
        if (delay !== null) {
          await this.waitBeforeRetry(attempt, responseHeaders);
          attempt += 1;
          continue;
        }
        throw new HttpError(`GitHub 拒绝请求（${status}）：${url}`, { status, url });
      }
      if (status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new HttpError(`GitHub 返回 ${status}：${url}`, { status, url });
        }
        await this.waitBeforeRetry(attempt);
        attempt += 1;
        continue;
      }
      if (status === 404 || status === 451) {
        return {
          status,
          headers: responseHeaders,
          text: await response.text(),
          etag: responseEtag,
        };
      }
      throw new HttpError(`GitHub 返回 ${status}：${url}`, { status, url });
    }
  }
}
