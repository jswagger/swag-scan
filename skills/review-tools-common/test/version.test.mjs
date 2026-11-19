import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = (path) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

test('the plugin has a semantic version, below 1.0 while in beta', () => {
  const { version } = JSON.parse(readFileSync(root('.claude-plugin/plugin.json'), 'utf8'));
  assert.match(version, SEMVER);
  assert.equal(version.split('.')[0], '0', 'move to 1.0.0 only on purpose: update this test when that happens');
});

test('the newest CHANGELOG entry is the plugin version', () => {
  const { version } = JSON.parse(readFileSync(root('.claude-plugin/plugin.json'), 'utf8'));
  const newest = /^## (\d+\.\d+\.\d+)\b/m.exec(readFileSync(root('CHANGELOG.md'), 'utf8'))?.[1];
  assert.equal(newest, version, 'bump plugin.json and add a CHANGELOG entry together');
});
