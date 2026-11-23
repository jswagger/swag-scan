import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// SS-104 probe fixture. One realistic snippet per area, scanned together as a single change, with the rule IDs it must
// produce and the ones it must not. This guards the whole rule set against a later change that quietly breaks a rule
// or makes a safe snippet noisy.

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scannerPath = fileURLToPath(new URL('../scripts/scan-patterns.mjs', import.meta.url));

const probes = [
  { name: 'src/server.ts', expect: ['TS-601', 'TS-602', 'TS-603', 'TS-606', 'TS-607', 'TS-610', 'ACC-601'], reject: ['TS-604', 'TS-608'], lines: [
    "import https from 'node:https';",
    'const agent = new https.Agent({ rejectUnauthorized: false });',
    "el.innerHTML = '<p>' + req.query.q;",
    "const run = new Function('a', req.body.code);",
    "fs.readFile(path.join(base, req.params.name), cb);",
    "const page = await fetch(req.query.url);",
    "const user = await User.findOne(req.body);",
    "app.get('/reports', (req, res) => res.json([]));",
    "const digest = crypto.createHash('sha256').update(data);",
  ] },
  { name: 'app/views.py', expect: ['PY-601', 'PY-602', 'PY-608', 'PY-610', 'ERR-601'], reject: ['PY-604', 'PY-609'], lines: [
    'import subprocess, yaml, requests',
    "subprocess.run(f'ls {name}', shell=True)",
    "cur.execute(f\"SELECT * FROM t WHERE a = {a}\")",
    'config = yaml.load(stream)',
    'requests.get(url, verify=False)',
    'try:',
    '    risky()',
    'except:',
    '    return None',
    "digest = hashlib.sha256(data)",
  ] },
  { name: 'Controllers/ReportsController.cs', expect: ['CS-601', 'CS-610'], reject: ['CS-604'], lines: [
    '[ApiController]',
    'public class ReportsController : ControllerBase',
    '{',
    '    [HttpGet("reports")]',
    '    public IActionResult Get(string name)',
    '    {',
    '        var rows = _db.Reports.FromSqlRaw($"SELECT * FROM Reports WHERE Name = \'{name}\'");',
    '        return Ok(rows);',
    '    }',
    '}',
  ] },
  { name: '.github/workflows/ci.yml', expect: ['SUP-601', 'SUP-602', 'SUP-603', 'SUP-604'], reject: [], lines: [
    'on: pull_request_target',
    'permissions: write-all',
    'jobs:',
    '  build:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}',
    '      - run: echo "${{ github.event.pull_request.title }}"',
  ] },
  { name: 'safe/.github/workflows/ci.yml', expect: [], reject: ['SUP-601', 'SUP-602', 'SUP-603', 'SUP-604'], lines: [
    'on: pull_request',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  build:',
    '    steps:',
    '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567',
    '      - run: echo "$TITLE"',
    '        env:',
    '          TITLE: ${{ github.event.pull_request.title }}',
  ] },
  { name: 'package.json', expect: ['SUP-605', 'SUP-606'], reject: [], lines: [
    '{', '  "scripts": {', '    "postinstall": "node setup.js"', '  },', '  "dependencies": {', '    "left-pad": "^1.3.0"', '  }', '}',
  ] },
  { name: 'config/.mcp.json', expect: ['SEC-603'], reject: [], lines: [
    '{', '  "env": {', '    "SERVICE_TOKEN": "literal-value-123456"', '  }', '}',
  ] },
  { name: 'config/.env', expect: ['SEC-602'], reject: [], lines: ['SERVICE_API_KEY=literal-value-123456', 'LOG_LEVEL=info'] },
];

test('SS-104 probe snippets produce the expected hits and misses', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ss104-probes-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = probes.map((probe) => {
    const path = join(directory, probe.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, probe.lines.join('\n'));
    return { path, changes: probe.lines.map((text, index) => ({ side: 'added', line: index + 1, text })) };
  });
  const result = spawnSync(process.execPath, [scannerPath], { cwd: workspaceRoot, encoding: 'utf8', input: JSON.stringify({ files }) });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  probes.forEach((probe, index) => {
    const hits = new Set(report.candidates.filter((candidate) => candidate.path === files[index].path).map((candidate) => candidate.ruleId));
    for (const rule of probe.expect) assert.equal(hits.has(rule), true, `${probe.name} should produce ${rule}; got ${[...hits].join(', ') || 'nothing'}`);
    for (const rule of probe.reject) assert.equal(hits.has(rule), false, `${probe.name} should not produce ${rule}`);
  });
});
