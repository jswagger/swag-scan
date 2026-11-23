import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// SS-104, Python rules. Each rule has a true-positive case and a harmless case. Most run on a real file on disk,
// because the rules that look at neighbouring lines (attributes, catch bodies, CORS) need the whole file.

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scannerPath = fileURLToPath(new URL('../scripts/scan-patterns.mjs', import.meta.url));

function scan(files) {
  const result = spawnSync(process.execPath, [scannerPath], { cwd: workspaceRoot, encoding: 'utf8', input: JSON.stringify({ files }) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const added = (path, lines) => ({ path, changes: lines.map((text, index) => ({ side: 'added', line: index + 1, text })) });
const ids = (report) => report.candidates.map((candidate) => candidate.ruleId);

/** Writes the lines to a real file and scans it as if every line were added. */
function scanFile(context, name, lines) {
  const directory = mkdtempSync(join(tmpdir(), 'py-rules-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  writeFileSync(path, lines.join('\n'));
  return scan([added(path, lines)]);
}

const flagged = (context, rule, lines, name = 'Sample.py') => ids(scanFile(context, name, lines)).includes(rule);

test('PY-601 flags code and command execution with dynamic values and ignores the safe forms', (context) => {
  const risky = [["eval(request.args['x'])"], ["subprocess.run(f'ls {name}', shell=True)"], ["os.system('ls ' + name)"], ["subprocess.run(", "    f'ls {name}',", "    shell=True)"]];
  for (const lines of risky) assert.equal(flagged(context, 'PY-601', lines), true, lines.join(' '));
  const harmless = [["eval('1 + 1')"], ["subprocess.run(['ls', name])"], ["subprocess.run('ls -l', shell=True)"], ["os.system('clear')"]];
  for (const lines of harmless) assert.equal(flagged(context, 'PY-601', lines), false, lines.join(' '));
});

test('PY-602 flags SQL built with formatting and ignores the safe forms', (context) => {
  const risky = [["cur.execute(f\"SELECT * FROM t WHERE a = {a}\")"], ["cur.execute(\"SELECT * FROM t WHERE a = '%s'\" % a)"], ["cur.execute(\"DELETE FROM t WHERE a = \" + a)"], ["cur.execute(", "    f\"SELECT * FROM t WHERE a = {a}\")"], ["cur.execute(\"SELECT * FROM t WHERE a = {}\".format(a))"]];
  for (const lines of risky) assert.equal(flagged(context, 'PY-602', lines), true, lines.join(' '));
  const harmless = [["cur.execute(\"SELECT * FROM t WHERE a = %s\", (a,))"], ["cur.execute(\"SELECT 1\")"], ["cur.execute(query, params)"]];
  for (const lines of harmless) assert.equal(flagged(context, 'PY-602', lines), false, lines.join(' '));
});

test('PY-603 flags template injection and ignores the safe forms', (context) => {
  const risky = [["return render_template_string(request.args['t'])"], ["return render_template_string(f'<p>{name}</p>')"], ["env = Environment(autoescape=False)"], ["html = mark_safe(comment.body)"]];
  for (const lines of risky) assert.equal(flagged(context, 'PY-603', lines), true, lines.join(' '));
  const harmless = [["return render_template_string('<p>{{ name }}</p>', name=name)"], ["html = mark_safe('<br>')"], ["env = Environment(autoescape=True)"]];
  for (const lines of harmless) assert.equal(flagged(context, 'PY-603', lines), false, lines.join(' '));
});

test('PY-604 flags debug mode and ignores the safe forms', (context) => {
  const risky = [["app.run(debug=True)"], ["DEBUG = True"]];
  for (const lines of risky) assert.equal(flagged(context, 'PY-604', lines), true, lines.join(' '));
  const harmless = [["app.run(debug=False)"], ["app.run()"]];
  for (const lines of harmless) assert.equal(flagged(context, 'PY-604', lines), false, lines.join(' '));
});

test('PY-605 flags paths and URLs from request input and ignores the safe forms', (context) => {
  const risky = [["open(os.path.join(base, request.args['f']))"], ["return send_file(request.args['f'])"], ["requests.get(request.args['u'])"]];
  for (const lines of risky) assert.equal(flagged(context, 'PY-605', lines), true, lines.join(' '));
  const harmless = [["open(os.path.join(base, 'a.txt'))"], ["return send_from_directory(base, secure_filename(request.args['f']))"], ["requests.get('https://api.example.com/x')"]];
  for (const lines of harmless) assert.equal(flagged(context, 'PY-605', lines), false, lines.join(' '));
});

test('PY-606 flags weak authorization and ignores the safe forms', (context) => {
  const risky = [["assert user.is_admin"], ["claims = jwt.decode(token, options={'verify_signature': False})"], ["@csrf_exempt"], ["CORS(app, allow_origins=['*'])", "CORS(app, allow_credentials=True)"]];
  for (const lines of risky) assert.equal(flagged(context, 'PY-606', lines), true, lines.join(' '));
  const harmless = [["if not user.is_admin:", "    raise PermissionError()"], ["claims = jwt.decode(token, key, algorithms=['HS256'])"], ["CORS(app, allow_origins=['*'])"]];
  for (const lines of harmless) assert.equal(flagged(context, 'PY-606', lines), false, lines.join(' '));
});

test('PY-607 flags mass assignment and ignores the safe forms', (context) => {
  const risky = [["user = User(**request.json)"], ["fields = '__all__'"]];
  for (const lines of risky) assert.equal(flagged(context, 'PY-607', lines), true, lines.join(' '));
  const harmless = [["user = User(name=data['name'])"], ["fields = ['name', 'email']"]];
  for (const lines of harmless) assert.equal(flagged(context, 'PY-607', lines), false, lines.join(' '));
});

test('PY-608 flags unsafe deserialization and ignores the safe forms', (context) => {
  const risky = [["data = yaml.load(f)"], ["obj = pickle.loads(blob)"], ["data = yaml.load(f, Loader=yaml.FullLoader)"]];
  for (const lines of risky) assert.equal(flagged(context, 'PY-608', lines), true, lines.join(' '));
  const harmless = [["data = yaml.safe_load(f)"], ["data = yaml.load(f, Loader=yaml.SafeLoader)"], ["obj = json.loads(blob)"]];
  for (const lines of harmless) assert.equal(flagged(context, 'PY-608', lines), false, lines.join(' '));
});

test('PY-609 flags weak crypto and randomness and ignores the safe forms', (context) => {
  const risky = [["digest = hashlib.md5(password.encode())"], ["token = random.choice(chars)"], ["cipher = AES.new(key, AES.MODE_ECB)"]];
  for (const lines of risky) assert.equal(flagged(context, 'PY-609', lines), true, lines.join(' '));
  const harmless = [["digest = hashlib.sha256(data)"], ["token = secrets.token_hex(16)"], ["jitter = random.random()"]];
  for (const lines of harmless) assert.equal(flagged(context, 'PY-609', lines), false, lines.join(' '));
});

test('PY-610 flags TLS verification off and ignores the safe forms', (context) => {
  const risky = [["requests.get(url, verify=False)"], ["ctx = ssl._create_unverified_context()"], ["ctx.verify_mode = ssl.CERT_NONE"]];
  for (const lines of risky) assert.equal(flagged(context, 'PY-610', lines), true, lines.join(' '));
  const harmless = [["requests.get(url, verify=True)"], ["requests.get(url)"]];
  for (const lines of harmless) assert.equal(flagged(context, 'PY-610', lines), false, lines.join(' '));
});

test('PY-601 to PY-612 also cover asyncio shells, Django extra/RawSQL, ALLOWED_HOSTS, XXE, mktemp, zip slip and torch.load', (context) => {
  const cases = [
    ['PY-601', ["proc = await asyncio.create_subprocess_shell(f'ls {name}')"], ["proc = await asyncio.create_subprocess_exec('ls', name)"]],
    ['PY-602', ["qs = Report.objects.extra(where=['name = %s' % name])"], ["qs = Report.objects.extra(where=['active = 1'])"]],
    ['PY-602', ["total = RawSQL(f'SELECT {col} FROM t', [])"], ["total = RawSQL('SELECT 1', [])"]],
    ['PY-604', ["ALLOWED_HOSTS = ['*']"], ["ALLOWED_HOSTS = ['app.example.com']"]],
    ['PY-612', ["parser = etree.XMLParser(resolve_entities=True)"], ["parser = etree.XMLParser(resolve_entities=False)"]],
    ['PY-609', ["path = tempfile.mktemp()"], ["fd, path = tempfile.mkstemp()"]],
    ['PY-607', ["with zipfile.ZipFile(upload) as archive:", "    archive.extractall(target)"], ["with zipfile.ZipFile(upload) as archive:", "    for member in archive.namelist():", "        assert os.path.commonpath([target, os.path.join(target, member)]) == target", "    archive.extractall(target)"]],
    ['PY-608', ["model = torch.load(path)"], ["model = torch.load(path, weights_only=True)"]],
    ['PY-608', ["state = marshal.loads(blob)", "db = shelve.open(path)", "obj = jsonpickle.decode(text)"], ["state = json.loads(blob)"]],
  ];
  for (const [rule, risky, harmless] of cases) {
    assert.equal(flagged(context, rule, risky), true, `${rule}: ${risky.join(' ')}`);
    assert.equal(flagged(context, rule, harmless), false, `${rule}: ${harmless.join(' ')}`);
  }
});
