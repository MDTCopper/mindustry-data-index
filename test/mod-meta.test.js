import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateMetadataPaths,
  extractModMetadataFields,
  fetchModMetadata,
  fetchModMetadataDocument,
  metaFromDocument,
  parseModMetadata,
  parseModMetadataDocument,
  repairQuotedNewlines,
} from '../src/mod-meta.js';
import { parseJval } from '../src/jval.js';
import { computeGameVersionRanges, modTypeOf, parseMinVersion } from '../src/model-v3.js';

const repo = 'owner/demo';

test('候选路径：游戏 metaFiles 顺序，只查 root（不读 assets）', () => {
  const expected = [
    'copper.mod.json',
    'copper.mod.hjson',
    'mod.json',
    'mod.hjson',
    'plugin.json',
    'plugin.hjson',
  ];
  assert.deepEqual(candidateMetadataPaths(true), expected);
  assert.deepEqual(candidateMetadataPaths(false), expected);
});

test('Jval：mod.json 带注释/无引号 key/尾逗号/无逗号', () => {
  const parsed = parseJval(`{
    // line comment
    name: Demo Mod
    author: "A"
    # hash comment
    version: 1.0
    minGameVersion: 146
    list: [1 2 3,]
    obj: { a: 1, b: "two" }
  }`);
  assert.equal(parsed.name, 'Demo Mod');
  assert.equal(parsed.author, 'A');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.minGameVersion, 146);
  assert.deepEqual(parsed.list, [1, 2, 3]);
  assert.deepEqual(parsed.obj, { a: 1, b: 'two' });
});

test('Jval：根大括号可省、单引号、无引号字符串、逗号可选', () => {
  const parsed = parseJval(`name: 'Demo'
author: someone
version: 1.1.7
minGameVersion: 146`);
  assert.equal(parsed.name, 'Demo');
  assert.equal(parsed.author, 'someone');
  assert.equal(parsed.version, '1.1.7');
});

test('Jval：引号字符串内允许裸换行、支持转义', () => {
  const parsed = parseJval(`{ name: "line1\nline2", description: "a\\tb" }`);
  assert.equal(parsed.name, 'line1\nline2');
  assert.equal(parsed.description, 'a\tb');
});

test('Jval：重复 key 后值生效；数字规则', () => {
  const parsed = parseJval(`name: first
name: second
n: 141.1
bad: 01
good: 0`);
  assert.equal(parsed.name, 'second');
  assert.equal(parsed.n, 141.1);
  assert.equal(parsed.bad, '01');
  assert.equal(parsed.good, 0);
});

test('Jval：BOM 不剥离 → 第一个 key 带 BOM，name 缺失', () => {
  const parsed = parseJval(`\uFEFFname: Demo\nminGameVersion: 146`);
  assert.equal(parsed.name, undefined);
  assert.equal(parsed['\uFEFFname'], 'Demo');
  assert.equal(parseModMetadataDocument(`\uFEFFname: Demo\nminGameVersion: 146`), null);
});

test('parseModMetadataDocument：核心字段、null 缺省、main 空串不算 Java', () => {
  const doc = parseModMetadataDocument(`{
    name: Demo,
    author: A,
    description: desc,
    version: 141.1,
    minGameVersion: "157.1，",
    main: "",
    java: false,
    hideBrowser: true,
    dependencies: { mindustry: "146" }
  }`);
  assert.equal(doc.name, 'Demo');
  assert.equal(doc.author, 'A');
  assert.equal(doc.description, 'desc');
  assert.equal(doc.modVersion, '141.1');
  assert.equal(doc.minGameVersion, '157.1，');
  assert.equal(doc.main, null);
  assert.equal(doc.hideBrowser, true);
  assert.deepEqual(doc.dependencies, { mindustry: '146' });
  assert.equal(doc.hasJava, false);
});

test('parseModMetadataDocument：数组 minGameVersion 视为缺省；缺 name 返回 null', () => {
  const doc = parseModMetadataDocument(`{ name: Demo, minGameVersion: [146, 154] }`);
  assert.equal(doc.minGameVersion, null);
  assert.equal(parseModMetadataDocument(`{ minGameVersion: 146 }`), null);
});

test('parseModMetadata：version/minGameVersion；非法内容抛错；正则兜底仍保留', () => {
  assert.deepEqual(parseModMetadata(`{ version: 1.0, minGameVersion: 146 }`), {
    modVersion: '1',
    minGameVersion: '146',
  });
  assert.throws(() => parseModMetadata('{{'));
  const fallback = extractModMetadataFields('version: 3.2,\nminGameVersion: 146,');
  assert.deepEqual(fallback, { modVersion: '3.2', minGameVersion: '146' });
  assert.equal(repairQuotedNewlines('a: "x'), 'a: "x');
});

test('metaFromDocument：宽松绑定，Java/脚本语义', () => {
  const doc = parseModMetadataDocument(`{
    name: Demo, main: a.b, java: true, dependencies: { mindustry: "146" }
  }`);
  const meta = metaFromDocument(doc);
  assert.equal(meta.java, true);
  assert.equal(meta.hasJava, true);
  assert.equal(meta.main, 'a.b');
  assert.equal(metaFromDocument(null), null);
});

test('modTypeOf：java=meta.java/main，js=root scripts，json=其余', () => {
  assert.equal(modTypeOf({ meta: { java: true } }), 'java');
  assert.equal(modTypeOf({ meta: { main: 'a.b' } }), 'java');
  assert.equal(modTypeOf({ meta: { hasScripts: true } }), 'js');
  assert.equal(modTypeOf({ meta: {}, releases: [{ assets: [{ name: 'x.jar' }] }] }), 'java');
  assert.equal(modTypeOf({ meta: {}, releases: [] }), 'json');
});

test('parseMinVersion / gameVersionRanges：isAtLeast 语义、门禁 major、空 range 丢弃', () => {
  assert.deepEqual(parseMinVersion('146'), { major: 146, minor: 0 });
  assert.deepEqual(parseMinVersion('146.5'), { major: 146, minor: 5 });
  assert.deepEqual(parseMinVersion('157.1，'), { major: 157, minor: 1 });
  assert.equal(parseMinVersion([146, 154]), null);
  assert.equal(parseMinVersion(''), null);
  const versions = [
    { tag: 'v145', version: 145 },
    { tag: 'v146', version: 146 },
    { tag: 'v146.5', version: 146.5 },
    { tag: 'v147', version: 147 },
  ];
  assert.deepEqual(
    computeGameVersionRanges({
      minGameVersion: '146',
      gameVersions: versions,
      gateFile: { versions: [{ version: 147, value: 147 }] },
    }),
    [{ from: '146', to: '146.5' }],
  );
  assert.deepEqual(
    computeGameVersionRanges({
      minGameVersion: '999',
      gameVersions: versions,
      gateFile: null,
    }),
    [],
  );
});

function clientWith(files) {
  return {
    async get(url) {
      const entry = files.find(([suffix]) => url.endsWith(suffix));
      return entry ? entry[1] : { status: 404, text: '' };
    },
  };
}

test('fetchModMetadata：先 mod.json，找不到再 mod.hjson/plugin', async () => {
  const calls = [];
  const client = {
    async get(url) {
      calls.push(url);
      if (url.endsWith('/mod.json')) return { status: 404, text: '' };
      if (url.endsWith('/mod.hjson')) {
        return { status: 200, text: '{ name: Demo, minGameVersion: 146 }' };
      }
      return { status: 404, text: '' };
    },
  };
  const result = await fetchModMetadata(client, { repo, tag: 'v1', hasJava: true });
  assert.equal(result.metadataStatus, 'ok');
  assert.equal(result.metadataPath, 'mod.hjson');
  assert.ok(calls[0].endsWith('/copper.mod.json'));
});

test('fetchModMetadataDocument：copper.mod.json 标记 copper 并视为 Java', async () => {
  const client = {
    async get(url) {
      if (url.endsWith('/copper.mod.json')) {
        return { status: 200, text: '{ name: CopperMod, main: a.b, minGameVersion: 146 }' };
      }
      return { status: 404, text: '' };
    },
  };
  const result = await fetchModMetadataDocument(client, {
    repo,
    tag: 'v1',
    hasJava: false,
  });
  assert.equal(result.found, true);
  assert.equal(result.meta.copper, true);
  assert.equal(result.meta.hasJava, true);
  assert.equal(result.meta.main, 'a.b');
});

test('fetchModMetadata：不读 assets/mod.json（游戏装不上）', async () => {
  const client = {
    async get(url) {
      if (url.includes('/assets/')) return { status: 200, text: '{ name: Assets }' };
      return { status: 404, text: '' };
    },
  };
  const result = await fetchModMetadata(client, { repo, tag: 'v1', hasJava: false });
  assert.equal(result.metadataStatus, 'missing');
});

test('fetchModMetadata：解析失败记 unparsed；缺 name 视为不可用', async () => {
  const client = {
    async get(url) {
      if (url.endsWith('/mod.json')) return { status: 200, text: '{{ broken' };
      return { status: 404, text: '' };
    },
  };
  const result = await fetchModMetadata(client, { repo, tag: 'v1', hasJava: false });
  assert.equal(result.metadataStatus, 'unparsed');
  const noName = await fetchModMetadata(
    clientWith([['/mod.json', { status: 200, text: '{ minGameVersion: 146 }' }]]),
    { repo, tag: 'v1', hasJava: false },
  );
  assert.equal(noName.metadataStatus, 'unparsed');
});
