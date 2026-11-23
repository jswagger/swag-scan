import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// SS-104, TypeScript and JavaScript rules. Each rule has a true-positive case and a harmless case. Most run on a real file on disk,
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
  const directory = mkdtempSync(join(tmpdir(), 'ts-rules-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  writeFileSync(path, lines.join('\n'));
  return scan([added(path, lines)]);
}

const flagged = (context, rule, lines, name = 'Sample.ts') => ids(scanFile(context, name, lines)).includes(rule);

test('TS-601 flags TLS verification turned off and ignores the safe forms', (context) => {
  const risky = [["https.request({ rejectUnauthorized: false });"], ["process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';"]];
  for (const lines of risky) assert.equal(flagged(context, 'TS-601', lines), true, lines.join(' '));
  const harmless = [["https.request({ rejectUnauthorized: true });"], ["// rejectUnauthorized: false"]];
  for (const lines of harmless) assert.equal(flagged(context, 'TS-601', lines), false, lines.join(' '));
});

test('TS-602 flags HTML sinks fed non-literal values and ignores the safe forms', (context) => {
  const risky = [["el.innerHTML = `<b>${name}</b>`;"], ["el.innerHTML = '<p>' + req.query.q;"], ["el.insertAdjacentHTML('beforeend', html);"], ["document.write(location.hash);"], ["<div dangerouslySetInnerHTML={{ __html: html }} />"], ["<div dangerouslySetInnerHTML={{", "  __html: comment.body }} />"]];
  for (const lines of risky) assert.equal(flagged(context, 'TS-602', lines), true, lines.join(' '));
  const harmless = [["el.innerHTML = '<b>static</b>';"], ["el.textContent = name;"], ["el.innerHTML = DOMPurify.sanitize(html);"], ["document.write('<hr>');"]];
  for (const lines of harmless) assert.equal(flagged(context, 'TS-602', lines), false, lines.join(' '));
});

test('TS-603 flags new Function and string timers and ignores the safe forms', (context) => {
  const risky = [["const f = new Function('a', body);"], ["setTimeout('go()', 5);"], ["setInterval(\"tick(\" + n + \")\", 5);"]];
  for (const lines of risky) assert.equal(flagged(context, 'TS-603', lines), true, lines.join(' '));
  const harmless = [["const f = new Function('a', 'return a');"], ["setTimeout(() => go(), 5);"], ["setTimeout(go, 5);"]];
  for (const lines of harmless) assert.equal(flagged(context, 'TS-603', lines), false, lines.join(' '));
});

test('TS-604 flags JWT checks that are off and ignores the safe forms', (context) => {
  const risky = [["jwt.verify(token, key, { ignoreExpiration: true });"], ["jwt.verify(token, key, { algorithms: ['HS256', 'none'] });"], ["const claims = jwt.decode(token);", "if (claims.role === 'admin') grant();"]];
  for (const lines of risky) assert.equal(flagged(context, 'TS-604', lines), true, lines.join(' '));
  const harmless = [["jwt.verify(token, key, { algorithms: ['HS256'] });"], ["const claims = jwt.decode(token);", "console.log(claims.iat);"]];
  for (const lines of harmless) assert.equal(flagged(context, 'TS-604', lines), false, lines.join(' '));
});

test('TS-605 flags cookie and CORS settings and ignores the safe forms', (context) => {
  const risky = [["res.cookie('sid', value, { httpOnly: false });"], ["app.use(cors({", "  origin: '*',", "  credentials: true,", "}));"]];
  for (const lines of risky) assert.equal(flagged(context, 'TS-605', lines), true, lines.join(' '));
  const harmless = [["res.cookie('sid', value, { httpOnly: true, secure: true });"], ["app.use(cors({ origin: '*' }));"], ["app.use(cors({ origin: 'https://app.example.com', credentials: true }));"]];
  for (const lines of harmless) assert.equal(flagged(context, 'TS-605', lines), false, lines.join(' '));
});

test('TS-606 flags file paths from request input and ignores the safe forms', (context) => {
  const risky = [["fs.readFile(path.join(base, req.params.name), cb);"], ["res.sendFile(req.query.file);"], ["await fs.promises.unlink(req.body.path);"]];
  for (const lines of risky) assert.equal(flagged(context, 'TS-606', lines), true, lines.join(' '));
  const harmless = [["fs.readFile(path.join(base, 'report.txt'), cb);"], ["res.sendFile(path.basename(req.query.file), { root: base });"]];
  for (const lines of harmless) assert.equal(flagged(context, 'TS-606', lines), false, lines.join(' '));
});

test('TS-607 flags server fetches of request-supplied URLs and ignores the safe forms', (context) => {
  const risky = [["const r = await fetch(req.query.url);"], ["await axios.get(req.body.target);"], ["const r = await fetch(", "  req.query.url,", "  { method: 'GET' });"]];
  for (const lines of risky) assert.equal(flagged(context, 'TS-607', lines), true, lines.join(' '));
  const harmless = [["const r = await fetch('https://api.example.com/items');"], ["const r = await fetch(`https://api.example.com/items/${id}`);"], ["const r = await fetch(url);"]];
  for (const lines of harmless) assert.equal(flagged(context, 'TS-607', lines), false, lines.join(' '));
});

test('TS-608 flags weak crypto and ignores the safe forms', (context) => {
  const risky = [["const c = crypto.createCipher('aes192', password);"], ["const h = crypto.createHash('md5').update(data);"], ["const h = crypto.createHash('sha1');"]];
  for (const lines of risky) assert.equal(flagged(context, 'TS-608', lines), true, lines.join(' '));
  const harmless = [["const c = crypto.createCipheriv('aes-256-gcm', key, iv);"], ["const h = crypto.createHash('sha256').update(data);"]];
  for (const lines of harmless) assert.equal(flagged(context, 'TS-608', lines), false, lines.join(' '));
});

test('TS-609 flags prototype pollution and mass assignment and ignores the safe forms', (context) => {
  const risky = [["target.__proto__ = payload;"], ["_.merge(settings, req.body);"], ["Object.assign(user, req.body);"]];
  for (const lines of risky) assert.equal(flagged(context, 'TS-609', lines), true, lines.join(' '));
  const harmless = [["const copy = Object.assign({}, defaults);"], ["_.merge(settings, defaults);"], ["const proto = Object.getPrototypeOf(x);"]];
  for (const lines of harmless) assert.equal(flagged(context, 'TS-609', lines), false, lines.join(' '));
});

test('TS-610 flags NoSQL injection and ignores the safe forms', (context) => {
  const risky = [["const rows = await db.collection('u').find({ $where: 'this.a == ' + a });"], ["const user = await User.findOne(req.body);"], ["const user = await User.findOne({ name: req.body.name, pass: req.body.pass });"]];
  for (const lines of risky) assert.equal(flagged(context, 'TS-610', lines), true, lines.join(' '));
  const harmless = [["const user = await User.findOne({ name: String(req.body.name) });"], ["const user = await User.findOne({ id });"]];
  for (const lines of harmless) assert.equal(flagged(context, 'TS-610', lines), false, lines.join(' '));
});

