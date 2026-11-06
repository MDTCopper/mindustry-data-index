import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_BASELINE_URL,
  GATE_CANDIDATE_PATHS,
  GATE_REPO,
  GATE_SOURCE_CONSTANT_SINCE,
  baselineLookup,
  buildGateFile,
  findGateSourcePaths,
  gateBodyChanged,
  gateStartVersion,
  mergeGateRules,
  normalizeBaselineRules,
  parseBaselineText,
  parseGateConstants,
  rawSourceUrl,
  regularVersions,
  resolveVersionGate,
  splitLegacyGateFile,
  treeApiUrl,
} from '../src/mod-gate.js';

const MMGVM_TEXT = `// Min game version modified
update_time: 2026-09-11
rules: [
    { min: 97, max: 105, mod: 97, java: 97 }
    { min: 105, max: 136, mod: 105, java: 105 }
    { min: 136, max: 147, mod: 136, java: 136 }
    { min: 147, max: 154.2, mod: 136, java: 147 }
    { min: 154.2, mod: 136, java: 154 }
]`;

const JAVA_CONSTANTS = `
public class Vars {
  public static final int minModGameVersion = 136;
  public static final int minJavaModGameVersion = 147;
}`;

function fakeRawClient(routes) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      const matched = Object.keys(routes).find((suffix) => url.endsWith(`/${suffix}`));
      if (!matched) {
        return { status: 404, text: '' };
      }
      const route = routes[matched];
      if (route instanceof Error) {
        throw route;
      }
      if (route === 404) {
        return { status: 404, text: '' };
      }
      return { status: 200, text: route };
    },
  };
}

test('raw / tree 地址生成', () => {
  assert.equal(
    rawSourceUrl('v147', 'core/src/mindustry/Vars.java'),
    'https://raw.githubusercontent.com/Anuken/Mindustry/v147/core/src/mindustry/Vars.java',
  );
  assert.equal(
    treeApiUrl('v147'),
    'https://api.github.com/repos/Anuken/Mindustry/git/trees/v147?recursive=1',
  );
});

test('源码常量起始版本是 147（实测 v146 及更早没有）', () => {
  assert.equal(GATE_SOURCE_CONSTANT_SINCE, 147);
});

test('parseGateConstants：两个常量必须同时存在', () => {
  assert.deepEqual(parseGateConstants(JAVA_CONSTANTS), { mod: 136, java: 147 });
  assert.deepEqual(
    parseGateConstants(
      'public static final int minModGameVersion = 136;\npublic static final int minJavaModGameVersion = 154;',
    ),
    { mod: 136, java: 154 },
  );
  assert.equal(parseGateConstants('public static final int minModGameVersion = 136;'), null);
  assert.equal(parseGateConstants('class Vars {}'), null);
});

test('regularVersions：只留 v<数字>[.<数字>]，升序去重', () => {
  const versions = regularVersions([
    { tag_name: 'v154.2' },
    { tag_name: '28065' },
    { tag_name: 'v147' },
    { tag_name: 'v8 Build 160.7' },
    { tag_name: 'v97' },
    { tag_name: 'v154.2' },
    { tag_name: 'nightly' },
  ]);
  assert.deepEqual(versions, [
    { tag: 'v97', version: 97 },
    { tag: 'v147', version: 147 },
    { tag: 'v154.2', version: 154.2 },
  ]);
});

test('基线规则解析与查询边界', () => {
  const rules = parseBaselineText(MMGVM_TEXT);
  assert.deepEqual(rules, [
    { min: 97, max: 105, mod: 97, java: 97 },
    { min: 105, max: 136, mod: 105, java: 105 },
    { min: 136, max: 147, mod: 136, java: 136 },
    { min: 147, max: 154.2, mod: 136, java: 147 },
    { min: 154.2, max: null, mod: 136, java: 154 },
  ]);
  assert.equal(baselineLookup(rules, 96), null);
  assert.deepEqual(baselineLookup(rules, 97), { mod: 97, java: 97 });
  assert.deepEqual(baselineLookup(rules, 104.9), { mod: 97, java: 97 });
  assert.deepEqual(baselineLookup(rules, 105), { mod: 105, java: 105 });
  assert.deepEqual(baselineLookup(rules, 147), { mod: 136, java: 147 });
  assert.deepEqual(baselineLookup(rules, 154.2), { mod: 136, java: 154 });
  assert.deepEqual(baselineLookup(rules, 999), { mod: 136, java: 154 });
});

test('normalizeBaselineRules 拒绝非法规则', () => {
  assert.equal(normalizeBaselineRules([]), null);
  assert.equal(normalizeBaselineRules([{ min: 100, max: 90, mod: 1, java: 1 }]), null);
  assert.equal(normalizeBaselineRules([{ min: 'x', mod: 1, java: 1 }]), null);
  assert.deepEqual(
    normalizeBaselineRules([{ min: 97, mod: 97, java: 97 }]),
    [{ min: 97, max: null, mod: 97, java: 97 }],
  );
});

test('mergeGateRules：连续相同值合并，从 97 开始，最后 max=null', () => {
  const versions = [
    { tag: 'v97', version: 97, value: 97, source: 'baseline' },
    { tag: 'v104', version: 104, value: 97, source: 'baseline' },
    { tag: 'v105', version: 105, value: 105, source: 'baseline' },
    { tag: 'v136', version: 136, value: 136, source: 'baseline' },
    { tag: 'v147', version: 147, value: 136, source: 'game-source' },
    { tag: 'v154', version: 154, value: 136, source: 'game-source' },
    { tag: 'v154.2', version: 154.2, value: 154, source: 'game-source' },
  ];
  assert.deepEqual(mergeGateRules(versions), [
    { min: 97, max: 105, value: 97, source: 'baseline' },
    { min: 105, max: 136, value: 105, source: 'baseline' },
    { min: 136, max: 154.2, value: 136, source: 'mixed' },
    { min: 154.2, max: null, value: 154, source: 'game-source' },
  ]);
});

test('mergeGateRules：混合来源标 mixed，单条规则 max 为 null', () => {
  assert.deepEqual(
    mergeGateRules([
      { version: 97, value: 97, source: 'baseline' },
      { version: 98, value: 97, source: 'game-source' },
    ]),
    [{ min: 97, max: null, value: 97, source: 'mixed' }],
  );
});

test('resolveVersionGate：候选路径顺序命中并返回路径', async () => {
  const client = fakeRawClient({
    'core/src/mindustry/Vars.java': JAVA_CONSTANTS,
  });
  const result = await resolveVersionGate({ tag: 'v147', rawClient: client });
  assert.deepEqual(result, {
    found: true,
    path: 'core/src/mindustry/Vars.java',
    mod: 136,
    java: 147,
  });
  assert.equal(client.calls.length, 1);
});

test('resolveVersionGate：全部 404 且不允许 tree 时不发 API', async () => {
  const client = fakeRawClient({});
  const result = await resolveVersionGate({ tag: 'v105', rawClient: client });
  assert.deepEqual(result, { found: false });
  assert.equal(client.calls.length, GATE_CANDIDATE_PATHS.length);
});

test('resolveVersionGate：候选 404 且允许 tree 时用 tree API 找移动后的文件', async () => {
  const rawClient = fakeRawClient({
    'core/src/mindustry/util/Vars.java': JAVA_CONSTANTS,
  });
  const apiCalls = [];
  const apiClient = {
    async get(url) {
      apiCalls.push(url);
      return {
        status: 200,
        text: JSON.stringify({
          tree: [
            { path: 'core/src/mindustry/Version.java' },
            { path: 'core/src/mindustry/util/Vars.java' },
          ],
        }),
      };
    },
  };
  const result = await resolveVersionGate({
    tag: 'v999',
    rawClient,
    apiClient,
    allowTree: true,
  });
  assert.equal(result.found, true);
  assert.equal(result.path, 'core/src/mindustry/util/Vars.java');
  assert.equal(apiCalls.length, 1);
});

test('findGateSourcePaths 只挑 core 下的 Vars/Version.java 并优先 mindustry 目录', async () => {
  const apiClient = {
    async get() {
      return {
        status: 200,
        text: JSON.stringify({
          tree: [
            { path: 'core/src/mindustry/Version.java' },
            { path: 'core/src/mindustry/util/Vars.java' },
            { path: 'android/src/main/Vars.java' },
            { path: 'core/src/mindustry/Other.java' },
          ],
        }),
      };
    },
  };
  const paths = await findGateSourcePaths(apiClient, 'v147');
  assert.deepEqual(paths, [
    'core/src/mindustry/Version.java',
    'core/src/mindustry/util/Vars.java',
  ]);
});

test('buildGateFile：mod/java 两份各自只含自己的常量与 value', () => {
  const modVersions = [
    { tag: 'v97', version: 97, value: 97, source: 'baseline' },
    { tag: 'v147', version: 147, value: 136, source: 'game-source' },
  ];
  const modFile = buildGateFile({
    type: 'mod',
    versions: modVersions,
    rules: mergeGateRules(modVersions),
    resolvedPaths: ['core/src/mindustry/Vars.java'],
    generatedAt: '2026-11-06T03:00:00.000Z',
  });
  assert.equal(modFile.formatVersion, 1);
  assert.equal(modFile.gate, 'mod');
  assert.equal(modFile.source.repo, GATE_REPO);
  assert.equal(modFile.source.baseline, GATE_BASELINE_URL);
  assert.deepEqual(modFile.source.constants, ['minModGameVersion']);
  assert.deepEqual(modFile.source.resolvedPaths, ['core/src/mindustry/Vars.java']);
  assert.equal(modFile.rules[0].min, gateStartVersion());
  assert.deepEqual(modFile.versions, modVersions);

  const javaFile = buildGateFile({
    type: 'java',
    versions: [
      { tag: 'v97', version: 97, value: 97, source: 'baseline' },
      { tag: 'v147', version: 147, value: 147, source: 'game-source' },
    ],
    rules: mergeGateRules([
      { tag: 'v97', version: 97, value: 97, source: 'baseline' },
      { tag: 'v147', version: 147, value: 147, source: 'game-source' },
    ]),
    resolvedPaths: [],
    generatedAt: '2026-11-06T03:00:00.000Z',
  });
  assert.equal(javaFile.gate, 'java');
  assert.deepEqual(javaFile.source.constants, ['minJavaModGameVersion']);

  const sameBody = { ...modFile, generatedAt: '2026-11-06T04:00:00.000Z' };
  assert.equal(gateBodyChanged(modFile, sameBody), false);
  assert.equal(
    gateBodyChanged(modFile, { ...modFile, rules: [{ ...modFile.rules[0], value: 98 }] }),
    true,
  );
  // gate 字段不同（mod vs java）也算变化
  assert.equal(gateBodyChanged(modFile, javaFile), true);
});

test('splitLegacyGateFile：旧合并文件拆成 mod/java 两份缓存', () => {
  const legacy = {
    formatVersion: 1,
    generatedAt: '2026-11-06T03:00:00.000Z',
    source: {
      repo: GATE_REPO,
      baseline: GATE_BASELINE_URL,
      constants: ['minModGameVersion', 'minJavaModGameVersion'],
      resolvedPaths: ['core/src/mindustry/Vars.java'],
    },
    rules: [{ min: 97, max: null, mod: 136, java: 154, source: 'game-source' }],
    versions: [
      { tag: 'v97', version: 97, mod: 136, java: 154, source: 'game-source' },
    ],
  };
  const split = splitLegacyGateFile(legacy);
  assert.equal(split.mod.gate, 'mod');
  assert.deepEqual(split.mod.source.constants, ['minModGameVersion']);
  assert.deepEqual(split.mod.versions, [
    { tag: 'v97', version: 97, value: 136, source: 'game-source' },
  ]);
  assert.deepEqual(split.mod.rules, [
    { min: 97, max: null, value: 136, source: 'game-source' },
  ]);
  assert.deepEqual(split.java.versions, [
    { tag: 'v97', version: 97, value: 154, source: 'game-source' },
  ]);
  assert.equal(splitLegacyGateFile({ formatVersion: 1, gate: 'mod' }), null);
  assert.equal(splitLegacyGateFile(null), null);
});
