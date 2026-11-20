import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { logicalStatements, looksLikeSql } from '../scripts/statements.mjs';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scannerPath = fileURLToPath(new URL('../scripts/scan-patterns.mjs', import.meta.url));

function scan(files) {
  const result = spawnSync(process.execPath, [scannerPath], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    input: JSON.stringify({ files }),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const added = (path, lines) => ({ path, changes: lines.map((text, index) => ({ side: 'added', line: index + 1, text })) });
const ruleIds = (report) => report.candidates.map((candidate) => candidate.ruleId);

function scanSource(context, name, lines) {
  const directory = mkdtempSync(join(tmpdir(), 'security-auditor-fixes-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  writeFileSync(path, lines.join('\n'));
  return scan([added(path, lines)]);
}

// Audit probe snippets (SS-102 audit) for bug 1: CRIT-105 flagged any `.exec(` call.
test('CRIT-105 ignores .exec( method calls but still flags eval, bare exec and child_process exec', () => {
  const harmless = ['const m = /(\\d+)/.exec(s);', 'cursor.exec(sql)', 'const hit = pattern.exec(line);', 'def exec(self, sql):', 'function exec(sql) {'];
  for (const text of harmless) {
    const js = scan([added('src/a.js', [text])]);
    const py = scan([added('src/a.py', [text])]);
    assert.equal(ruleIds(js).includes('CRIT-105'), false, `${text} should not be flagged in JavaScript`);
    assert.equal(ruleIds(py).includes('CRIT-105'), false, `${text} should not be flagged in Python`);
  }

  const risky = ['eval(userInput)', 'const out = exec(`ls ${dir}`)', 'child_process.exec(cmd, cb)', 'childProcess.execSync(cmd)', 'cp.exec(cmd)', 'window.eval(code)', 'exec(code)'];
  for (const text of risky) {
    assert.equal(ruleIds(scan([added('src/a.js', [text])])).includes('CRIT-105'), true, `${text} should be flagged`);
  }
});

// Bug 2: CRIT-104 stopped at the first `)`.
test('CRIT-104 catches shell=True after nested parentheses, on one line and across lines', (context) => {
  const nested = scan([added('src/run.py', ['subprocess.run(shlex.split(cmd), shell=True)'])]);
  assert.equal(ruleIds(nested).includes('CRIT-104'), true);

  const harmless = scan([added('src/run.py', ['subprocess.run(shlex.split(cmd), shell=False)', 'subprocess.run(["ls", "-l"], check=True)'])]);
  assert.equal(ruleIds(harmless).includes('CRIT-104'), false);

  const multiline = scanSource(context, 'multi.py', [
    'subprocess.run(',
    '    build_command(cmd),',
    '    shell=True,',
    ')',
  ]);
  const hits = multiline.candidates.filter((candidate) => candidate.ruleId === 'CRIT-104');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

// Bug 3: CRIT-201 only matched exact key names.
test('CRIT-201 catches prefixed and suffixed key names and keeps the value redacted', () => {
  const secrets = [
    "SECRET_KEY = 'django-insecure-abc123'",
    'API_SECRET = "s3cr3t-value"',
    'DB_PASSWORD = "hunter2"',
    'client_secret = "oauth-secret"',
    'const dbPassword = "hunter2";',
    'secretKey: "abc123",',
    '"AWS_SECRET_ACCESS_KEY": "abcd1234",',
    'public const string ConnectionPassword = "pw";',
    'self.admin_password = "pw"',
  ];
  for (const text of secrets) {
    const report = scan([added('src/settings.py', [text])]);
    const hit = report.candidates.find((candidate) => candidate.ruleId === 'CRIT-201');
    assert.ok(hit, `${text} should be flagged`);
    assert.equal(hit.evidence, '[possible secret value omitted]');
    assert.equal(JSON.stringify(report).includes('hunter2'), false, 'the secret value must not appear in the report');
  }

  const harmless = [
    'const tokenizer = "regex";',
    'password_field = "password"',
    'PASSWORD_MIN_LENGTH = "8"',
    'token_type = "bearer"',
    'const label = "Password";',
    'if (token == "abc") {',
    'secret = os.environ["SECRET"]',
  ];
  for (const text of harmless) {
    assert.equal(ruleIds(scan([added('src/settings.py', [text])])).includes('CRIT-201'), false, `${text} should not be flagged`);
  }
});

// Bug 4: .mjs/.cjs/.mts/.cts/.cshtml/.razor had no language, so language-gated rules skipped them.
test('module and Razor extensions get a language, so language-gated rules run', () => {
  for (const path of ['src/a.mjs', 'src/a.cjs', 'src/a.mts', 'src/a.cts']) {
    const report = scan([added(path, ['eval(code)'])]);
    assert.equal(ruleIds(report).includes('CRIT-105'), true, `${path} should run the eval rule`);
    assert.equal(report.coverage.detectedLanguages.length, 1, `${path} should be a detected language`);
  }
  assert.deepEqual(scan([added('src/a.mts', ['x'])]).coverage.detectedLanguages, ['typescript']);
  assert.deepEqual(scan([added('src/a.cjs', ['x'])]).coverage.detectedLanguages, ['javascript']);

  for (const path of ['Views/Admin.cshtml', 'Pages/Admin.razor']) {
    const report = scan([added(path, ['[AllowAnonymous]'])]);
    assert.equal(ruleIds(report).includes('CRIT-110'), true, `${path} should run the C# rules`);
    assert.deepEqual(report.coverage.detectedLanguages, ['csharp']);
  }
});

test('CRIT-202 no longer fires on the bare word id and treats new Random( as predictable', () => {
  const harmless = [
    'const id = Math.random();',
    'user_id = random.choice(ids)',
    'const rowId = Math.floor(Math.random() * 10);',
  ];
  for (const text of harmless) {
    assert.equal(ruleIds(scan([added('src/a.js', [text])])).includes('CRIT-202'), false, `${text} should not be flagged`);
  }

  const risky = [
    ['src/a.js', 'const sessionToken = Math.random().toString(36);'],
    ['src/a.py', 'session = uuid.uuid1()'],
    ['src/a.py', 'token = random.choice(alphabet)'],
    ['src/Auth.cs', 'var token = new Random().Next();'],
    ['src/Auth.cs', 'var resetCode = new Random(seed).Next();'],
  ];
  for (const [path, text] of risky) {
    assert.equal(ruleIds(scan([added(path, [text])])).includes('CRIT-202'), true, `${text} should be flagged`);
  }
});

test('multi-line SQL built from pieces is found, and fixed or bound SQL is not', (context) => {
  const python = scanSource(context, 'report.py', [
    'sql = ("SELECT id, name FROM users WHERE id IN "',
    '       + id_list)',
    'safe = ("SELECT id FROM users "',
    '        "WHERE id = %s")',
    'cursor.execute(safe, (user_id,))',
    'message = ("Select a file from the list "',
    '           + name)',
  ]);
  const pythonHits = python.candidates.filter((candidate) => candidate.ruleId === 'CRIT-101');
  assert.deepEqual(pythonHits.map((hit) => hit.line), [1]);
  assert.equal(pythonHits[0].confidence, 'lower');

  const typescript = scanSource(context, 'query.ts', [
    'const q = "SELECT * FROM orders " +',
    '  "WHERE customer = \'" + customer + "\'";',
    'const fixed = "SELECT * FROM orders " +',
    '  "WHERE customer = $1";',
    'const t = `SELECT * FROM orders',
    '  WHERE total > ${min}`;',
  ]);
  const tsHits = typescript.candidates.filter((candidate) => candidate.ruleId === 'CRIT-101').map((hit) => hit.line);
  assert.deepEqual(tsHits, [2, 6]);

  const csharp = scanSource(context, 'Repo.cs', [
    'var sql = "SELECT * FROM Orders "',
    '    + "WHERE Customer = " + customer;',
  ]);
  assert.equal(csharp.candidates.some((candidate) => candidate.ruleId === 'CRIT-101'), true);
});

test('TypeScript and JavaScript files now get surrounding source lines, so a split statement is one lead', (context) => {
  const report = scanSource(context, 'split.js', [
    'const sql = ("SELECT a FROM t WHERE id IN "',
    '  + ids)',
    'cursor.exec(sql)',
  ]);
  assert.equal(report.candidates.filter((candidate) => candidate.ruleId === 'CRIT-101').length, 1);
  assert.equal(report.candidates.some((candidate) => candidate.ruleId === 'CRIT-105'), false);
});

test('coverage states which rule families ran for each detected language', () => {
  const report = scan([
    added('src/a.ts', ['const x = 1;']),
    added('src/b.py', ['x = 1']),
    added('deploy/main.tf', ['encrypted = false']),
  ]);
  const byLanguage = Object.fromEntries(report.coverage.ruleFamilies.map((entry) => [entry.language, entry]));

  assert.equal(byLanguage.typescript.files, 1);
  assert.equal(byLanguage.typescript.notCovered.includes('Unsafe deserialization'), true);
  assert.equal(byLanguage.typescript.notCovered.includes('TLS verification'), true);
  assert.deepEqual(byLanguage.python.notCovered, []);
  assert.equal(byLanguage.other.files, 1);
  assert.match(report.coverage.ruleFamiliesLine, /TypeScript \(1 file\): 9 of 11 families, no rules for Unsafe deserialization or TLS verification/);
  assert.match(report.coverage.ruleFamiliesLine, /No candidates does not mean safe\./);

  const families = byLanguage.python.ran.map((item) => item.family);
  assert.equal(families.includes('Secrets'), true);
  assert.deepEqual(byLanguage.python.ran.find((item) => item.family === 'Code and command execution').rules, ['CRIT-104', 'CRIT-105']);
});

test('coverage reports scan.readOnlyPaths, empty by default', () => {
  const report = scan([added('src/analyze/run.py', ['x = 1'])]);
  assert.deepEqual(report.coverage.readOnlyPaths.configured, []);
  assert.deepEqual(report.coverage.readOnlyPaths.matchedFiles, []);
  assert.match(report.coverage.readOnlyPaths.note, /empty/);
  assert.equal(report.coverage.readOnlyPaths.warning, undefined);
});

test('statement joiner splits statements, joins adjacent literals and drops comments', () => {
  const python = logicalStatements([
    'query = ("SELECT a FROM t "  # SELECT b FROM u',
    '         "WHERE x = " + value)',
    'other = 1',
  ], 'python');
  assert.equal(python.length, 2);
  assert.equal(python[0].firstLine, 1);
  assert.equal(python[0].lastLine, 2);
  assert.equal(python[0].sql, 'SELECT a FROM t WHERE x = ');
  assert.equal(python[0].dynamic, true);
  assert.equal(python[1].dynamic, false);

  const javascript = logicalStatements([
    'const a = "x" + "y";',
    'const b = `n ${n}`;',
    '/* "SELECT c FROM d" + e */ const c = 1;',
  ], 'javascript');
  assert.equal(javascript[0].sql, 'xy');
  assert.equal(javascript[0].dynamic, false);
  assert.equal(javascript[1].dynamic, true);
  assert.equal(javascript[2].sql, '');

  const csharp = logicalStatements(['var q = $@"SELECT * FROM T', 'WHERE a = {a}";'], 'csharp');
  assert.equal(csharp.length, 1);
  assert.equal(csharp[0].dynamic, true);
});

test('looksLikeSql separates SQL from prose', () => {
  assert.equal(looksLikeSql('SELECT id FROM users WHERE id = '), true);
  assert.equal(looksLikeSql('select id from users where id = '), true);
  assert.equal(looksLikeSql('INSERT INTO audit (a) VALUES '), true);
  assert.equal(looksLikeSql('Select a file from the list'), false);
  assert.equal(looksLikeSql('Please update the settings'), false);
});
