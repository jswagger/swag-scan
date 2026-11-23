import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// SS-104, secret rules. Each rule has a true-positive case and a harmless case, run on a real file on disk.

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scannerPath = fileURLToPath(new URL('../scripts/scan-patterns.mjs', import.meta.url));

function scan(files) {
  const result = spawnSync(process.execPath, [scannerPath], { cwd: workspaceRoot, encoding: 'utf8', input: JSON.stringify({ files }) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const added = (path, lines) => ({ path, changes: lines.map((text, index) => ({ side: 'added', line: index + 1, text })) });

/** Writes the lines to a real file (folders included) and scans it as if every line were added. */
function scanFile(context, name, lines) {
  const directory = mkdtempSync(join(tmpdir(), 'secret-rules-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'));
  return scan([added(path, lines)]);
}

const ids = (report) => report.candidates.map((candidate) => candidate.ruleId);
const flagged = (context, rule, name, lines) => ids(scanFile(context, name, lines)).includes(rule);

// Fake credentials are built at run time so this file never contains a string that looks like a real key.
const fake = {
  anthropic: `sk-ant-${'api03-'}${'abcdefghijklmnopqrstuvwx'}`,
  github: `ghp_${'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'}`,
  aws: `AKIA${'IOSFODNN7ABCDEFG'}`,
  slack: `xoxb-${'1234567890-abcdefghij'}`,
  stripe: `sk_live_${'abcdefghijklmnopqrstuvwx'}`,
  huggingface: `hf_${'abcdefghijklmnopqrstuvwxyzABCDEFGH'}`,
  openai: `sk-${'proj-abcdefghijklmnopqrstuvwxyz123456'}`,
};

test('SEC-601 flags well-known provider keys, in any file, and never prints the value', (context) => {
  for (const [provider, key] of Object.entries(fake)) {
    const report = scanFile(context, 'src/config.ts', [`const value = '${key}';`]);
    const hit = report.candidates.find((candidate) => candidate.ruleId === 'SEC-601');
    assert.ok(hit, provider);
    assert.equal(JSON.stringify(report).includes(key), false, `${provider} key leaked into the report`);
  }
  assert.equal(flagged(context, 'SEC-601', 'notes/setup.cfg', [`token = ${fake.github}`]), true);
});

test('SEC-601 ignores placeholders and short look-alikes', (context) => {
  for (const line of ["const a = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';", "const b = 'sk-your-key-here';", "const c = 'AKIA_EXAMPLE';", "const d = 'hf_token';", "const e = 'sk-short';"]) {
    assert.equal(flagged(context, 'SEC-601', 'src/config.ts', [line]), false, line);
  }
});

test('SEC-602 flags literal secrets in .env files but not templates or references', (context) => {
  const report = scanFile(context, 'app/.env', ['OPENAI_API_KEY=abcdefgh12345678', 'DEBUG=true']);
  const hit = report.candidates.find((candidate) => candidate.ruleId === 'SEC-602');
  assert.ok(hit);
  assert.equal(JSON.stringify(report).includes('abcdefgh12345678'.slice(0, 8)), false);
  assert.equal(flagged(context, 'SEC-602', 'app/.env', ['DB_PASSWORD=${DB_PASS}']), false);
  assert.equal(flagged(context, 'SEC-602', 'app/.env', ['DEBUG=true']), false);
  assert.equal(flagged(context, 'SEC-602', 'app/.env.example', ['API_KEY=abcdefgh12345678']), false);
  assert.equal(flagged(context, 'SEC-602', 'app/.env', ['API_KEY=']), false);
});

test('SEC-603 flags literal credentials in MCP configuration but not references', (context) => {
  const risky = [['{', '  "env": {', '    "GITHUB_TOKEN": "abc123secretvalue"', '  }', '}'], ['{', '  "headers": { "Authorization": "Bearer abcdefghijklmnop1234" }', '}']];
  for (const lines of risky) assert.equal(flagged(context, 'SEC-603', '.mcp.json', lines), true, lines.join(' '));
  const report = scanFile(context, '.mcp.json', ['{', '  "env": {', '    "GITHUB_TOKEN": "abc123secretvalue"', '  }', '}']);
  assert.equal(JSON.stringify(report).includes('abc123secretvalue'), false);
  const harmless = [['{', '  "env": {', '    "GITHUB_TOKEN": "${GITHUB_TOKEN}"', '  }', '}'], ['{', '  "command": "npx",', '  "args": ["-y", "server"]', '}']];
  for (const lines of harmless) assert.equal(flagged(context, 'SEC-603', '.mcp.json', lines), false, lines.join(' '));
});

