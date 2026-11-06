import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateMetadataPaths,
  parseModMetadata,
  repairQuotedNewlines,
  fetchModMetadata,
} from '../src/mod-meta.js';

// 按 URL 尾部匹配候选路径；长路径优先，避免 assets/mod.hjson 被 mod.hjson 抢先匹配
function fakeRawClient(routes) {
  const calls = [];
  const paths = [
    'assets/mod.hjson',
    'assets/mod.json',
    'mod.hjson',
    'mod.json',
  ];
  return {
    calls,
    async get(url) {
      calls.push(url);
      const matched = paths.find((candidate) => url.endsWith(`/${candidate}`));
      if (!matched) {
        return { status: 404, text: '' };
      }
      const route = routes[matched];
      if (route === undefined) {
        return { status: 404, text: '' };
      }
      if (route instanceof Error) {
        throw route;
      }
      if (typeof route === 'string') {
        return { status: 200, text: route };
      }
      return { status: route.status ?? 200, text: route.text ?? '' };
    },
  };
}

test('候选路径顺序：hasJava 时 hjson 优先，否则 json 优先', () => {
  assert.deepEqual(candidateMetadataPaths(true), [
    'mod.hjson',
    'mod.json',
    'assets/mod.hjson',
    'assets/mod.json',
  ]);
  assert.deepEqual(candidateMetadataPaths(false), [
    'mod.json',
    'mod.hjson',
    'assets/mod.json',
    'assets/mod.hjson',
  ]);
});

test('解析带注释与无引号 key 的 HJSON', () => {
  const metadata = parseModMetadata(`{
    // 模组说明
    name: Example
    version: "1.2.3"
    minGameVersion: 146
  }`);
  assert.deepEqual(metadata, { modVersion: '1.2.3', minGameVersion: '146' });
});

test('minGameVersion 数字转字符串、脏值原样保留、缺失为 null', () => {
  assert.deepEqual(parseModMetadata('{ minGameVersion: 146 }'), {
    modVersion: null,
    minGameVersion: '146',
  });
  assert.deepEqual(parseModMetadata('{ minGameVersion: "157.1，" }'), {
    modVersion: null,
    minGameVersion: '157.1，',
  });
  assert.deepEqual(parseModMetadata('{ version: "2.0" }'), {
    modVersion: '2.0',
    minGameVersion: null,
  });
});

test('非法内容与根不是对象都解析失败', () => {
  assert.throws(() => parseModMetadata('{ version: '), /./);
  assert.throws(() => parseModMetadata('not: [valid'), /不是对象/);
});

test('字符串内裸换行：严格 HJSON 失败，宽松修复后仍能解析出版本字段', async () => {
  const { parse: parseHjson } = await import('hjson');
  const text = `name: example
description: "第一行
第二行"
version: "1.2.3"
minGameVersion: 146
`;
  assert.throws(() => parseHjson(text), /Bad string containing newline/);
  assert.deepEqual(parseModMetadata(text), {
    modVersion: '1.2.3',
    minGameVersion: '146',
  });
});

test('宽松修复只动普通引号字符串里的换行', () => {
  const multiline = "description: '''行1\n行2'''\nversion: 1\n";
  assert.equal(repairQuotedNewlines(multiline), multiline);

  const comment = '# 注释里的 "引号\nversion: 1\n';
  assert.equal(repairQuotedNewlines(comment), comment);

  const escaped = 'description: "a\\"b"\nversion: 1\n';
  assert.equal(repairQuotedNewlines(escaped), escaped);
});

test('严格解析与宽松修复都失败时用正则兜底捞 version / minGameVersion', () => {
  assert.deepEqual(parseModMetadata('{{{\nversion: "1.2.3"\nminGameVersion: 146\n}'), {
    modVersion: '1.2.3',
    minGameVersion: '146',
  });
  assert.deepEqual(parseModMetadata('{{{\nversion: 2.0\n'), {
    modVersion: '2.0',
    minGameVersion: null,
  });
  assert.deepEqual(parseModMetadata('{{{\nminGameVersion: "157.1，"\n'), {
    modVersion: null,
    minGameVersion: '157.1，',
  });
});

test('fetchModMetadata：hasJava 命中 assets/mod.json', async () => {
  const client = fakeRawClient({
    'assets/mod.json': JSON.stringify({ version: '3.0', minGameVersion: 160 }),
  });
  const result = await fetchModMetadata(client, {
    repo: 'owner/repo',
    tag: 'v1 beta',
    hasJava: true,
  });
  assert.equal(result.metadataStatus, 'ok');
  assert.equal(result.metadataPath, 'assets/mod.json');
  assert.equal(result.modVersion, '3.0');
  assert.equal(result.minGameVersion, '160');
  // tag 带空格时先试编码形态、再试原样形态：4 个候选路径里前 3 个各 2 次，第 4 个第 1 次命中
  assert.equal(client.calls.length, 7);
  assert.match(client.calls[0], /v1%20beta\/mod\.hjson$/);
  assert.match(client.calls[1], /v1 beta\/mod\.hjson$/);
});

test('fetchModMetadata：非 Java 直接命中 mod.json 并立即停止', async () => {
  const client = fakeRawClient({
    'mod.json': JSON.stringify({ version: '1.0', minGameVersion: '146' }),
  });
  const result = await fetchModMetadata(client, {
    repo: 'owner/repo',
    tag: 'v1',
    hasJava: false,
  });
  assert.equal(result.metadataStatus, 'ok');
  assert.equal(result.metadataPath, 'mod.json');
  assert.equal(client.calls.length, 1);
});

test('fetchModMetadata：全部 404 记 missing', async () => {
  const client = fakeRawClient({});
  const result = await fetchModMetadata(client, {
    repo: 'owner/repo',
    tag: 'v1',
    hasJava: true,
  });
  assert.deepEqual(result, {
    metadataPath: null,
    metadataStatus: 'missing',
    modVersion: null,
    minGameVersion: null,
  });
  assert.equal(client.calls.length, 4);
});

test('fetchModMetadata：命中的文件解析失败记 unparsed 并保留命中路径', async () => {
  const client = fakeRawClient({ 'mod.hjson': '{ version: ' });
  const result = await fetchModMetadata(client, {
    repo: 'owner/repo',
    tag: 'v1',
    hasJava: true,
  });
  assert.equal(result.metadataStatus, 'unparsed');
  assert.equal(result.metadataPath, 'mod.hjson');
  assert.equal(result.modVersion, null);
});

test('fetchModMetadata：请求层失败记 unparsed', async () => {
  const client = fakeRawClient({ 'mod.hjson': new Error('ECONNRESET') });
  const result = await fetchModMetadata(client, {
    repo: 'owner/repo',
    tag: 'v1',
    hasJava: true,
  });
  assert.equal(result.metadataStatus, 'unparsed');
  assert.equal(result.metadataPath, null);
});
