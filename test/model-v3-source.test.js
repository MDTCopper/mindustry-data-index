import test from 'node:test';
import assert from 'node:assert/strict';
import {
  releasesFromVersions,
} from '../src/model-v3.js';
import { buildReleasesFile } from '../src/releases.js';

test('source 版本：非 Java 无 tag 时保留 kind/下载地址，往返重建不被改成 tag', () => {
  const file = buildReleasesFile({
    repo: 'owner/demo',
    releases: [
      {
        tag: 'main',
        source: true,
        minGameVersion: '146',
        downloadUrl: 'https://github.com/owner/demo/archive/refs/heads/main.zip',
        committedAt: '2026-11-01T00:00:00Z',
        assets: [],
      },
    ],
    meta: null,
    modType: 'json',
    gameVersions: ['146', '160'],
    gateFile: null,
    generatedAt: '2026-11-09T00:00:00Z',
  });
  assert.equal(file.versions.length, 1);
  const version = file.versions[0];
  assert.equal(version.kind, 'source');
  assert.equal(
    version.downloadUrl,
    'https://github.com/owner/demo/archive/refs/heads/main.zip',
  );

  const internal = releasesFromVersions(file);
  assert.equal(internal[0].source, true);

  const rebuilt = buildReleasesFile({
    repo: 'owner/demo',
    releases: internal,
    meta: null,
    modType: 'json',
    gameVersions: ['146', '160'],
    gateFile: null,
    generatedAt: '2026-11-09T01:00:00Z',
  });
  assert.equal(rebuilt.versions[0].kind, 'source');
  assert.equal(
    rebuilt.versions[0].downloadUrl,
    'https://github.com/owner/demo/archive/refs/heads/main.zip',
  );
});
