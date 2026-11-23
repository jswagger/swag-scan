import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// SS-104, access-control and error-handling rules. Each rule has a true-positive case and a harmless case, run on a real file on disk.

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
  const directory = mkdtempSync(join(tmpdir(), 'access-error-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'));
  return scan([added(path, lines)]);
}

const ids = (report) => report.candidates.map((candidate) => candidate.ruleId);
const flagged = (context, rule, name, lines) => ids(scanFile(context, name, lines)).includes(rule);

test('ACC-601 flags new routes with no auth marker (Express and Nest) and ignores the safe forms', (context) => {
  const risky = [["app.get('/reports', (req, res) => {});"], ["router.post('/reports', async (req, res) => {});"]];
  for (const lines of risky) assert.equal(flagged(context, 'ACC-601', "src/routes.ts", lines), true, lines.join(' '));
  const harmless = [["app.get('/reports', requireAuth, (req, res) => {});"], ["app.get('/health', (req, res) => {});"], ["router.use(authMiddleware);", "router.get('/reports', (req, res) => {});"]];
  for (const lines of harmless) assert.equal(flagged(context, 'ACC-601', "src/routes.ts", lines), false, lines.join(' '));
});

test('ACC-601 flags a Nest handler with no guard and ignores the safe forms', (context) => {
  const risky = [["@Controller('reports')", "export class ReportsController {", "  @Get()", "  list() {}", "}"]];
  for (const lines of risky) assert.equal(flagged(context, 'ACC-601', "src/reports.controller.ts", lines), true, lines.join(' '));
  const harmless = [["@UseGuards(AuthGuard)", "@Controller('reports')", "export class ReportsController {", "  @Get()", "  list() {}", "}"], ["@Controller('reports')", "export class ReportsController {", "  @UseGuards(AuthGuard)", "  @Get()", "  list() {}", "}"]];
  for (const lines of harmless) assert.equal(flagged(context, 'ACC-601', "src/reports.controller.ts", lines), false, lines.join(' '));
});

test('ACC-601 flags a FastAPI, Flask or Django REST view with no auth and ignores the safe forms', (context) => {
  const risky = [["@app.get('/items')", "async def items():", "    return []"], ["@app.route('/admin')", "def admin():", "    pass"], ["class V(APIView):", "    def get(self, request):", "        pass"]];
  for (const lines of risky) assert.equal(flagged(context, 'ACC-601', "api.py", lines), true, lines.join(' '));
  const harmless = [["@app.get('/me')", "async def me(user=Depends(get_user)):", "    return user"], ["@app.route('/x')", "@login_required", "def x():", "    pass"], ["class W(APIView):", "    permission_classes = [IsAuthenticated]", "    def get(self, request):", "        pass"], ["@app.get('/health')", "async def health():", "    return 'ok'"]];
  for (const lines of harmless) assert.equal(flagged(context, 'ACC-601', "api.py", lines), false, lines.join(' '));
});

test('ERR-601 flags errors that are thrown away (TypeScript) and ignores the safe forms', (context) => {
  const risky = [["p.catch(() => {});"], ["try {", "  x();", "} catch (e) {", "  console.log(e);", "}"], ["try {", "  z();", "} catch {", "  // ignore", "}"]];
  for (const lines of risky) assert.equal(flagged(context, 'ERR-601', "src/a.ts", lines), true, lines.join(' '));
  const harmless = [["try {", "  y();", "} catch (e) {", "  handle(e);", "}"], ["p.catch((e) => report(e));"], ["try {", "  y();", "} catch (e) {", "  console.error(e);", "  throw e;", "}"]];
  for (const lines of harmless) assert.equal(flagged(context, 'ERR-601', "src/a.ts", lines), false, lines.join(' '));
});

test('ERR-601 flags errors that are thrown away (Python) and ignores the safe forms', (context) => {
  const risky = [["try:", "    x()", "except:", "    return None"], ["try:", "    y()", "except Exception:", "    continue"]];
  for (const lines of risky) assert.equal(flagged(context, 'ERR-601', "a.py", lines), true, lines.join(' '));
  const harmless = [["try:", "    w()", "except Exception as e:", "    logger.exception(e)", "    raise"], ["try:", "    z()", "except ValueError:", "    return None"], ["try:", "    z()", "except:", "    raise"]];
  for (const lines of harmless) assert.equal(flagged(context, 'ERR-601', "a.py", lines), false, lines.join(' '));
});

test('ERR-602 flags auth handlers that fail open and ignores the safe forms', (context) => {
  const risky = [["export async function auth(req, res, next) {", "  try {", "    verify(req);", "    next();", "  } catch (e) {", "    next();", "  }", "}"]];
  for (const lines of risky) assert.equal(flagged(context, 'ERR-602', "mw/auth.ts", lines), true, lines.join(' '));
  const harmless = [["export async function auth(req, res, next) {", "  try {", "    verify(req);", "    next();", "  } catch (e) {", "    next(e);", "  }", "}"], ["export async function auth(req, res, next) {", "  try {", "    verify(req);", "    next();", "  } catch (e) {", "    res.status(401).end();", "  }", "}"]];
  for (const lines of harmless) assert.equal(flagged(context, 'ERR-602', "mw/auth.ts", lines), false, lines.join(' '));
});

test('ERR-602 flags a Python auth handler that fails open and ignores the safe forms', (context) => {
  const risky = [["async def dispatch(request, call_next):", "    try:", "        check(request)", "    except Exception:", "        return await call_next(request)"]];
  for (const lines of risky) assert.equal(flagged(context, 'ERR-602', "auth.py", lines), true, lines.join(' '));
  const harmless = [["async def dispatch(request, call_next):", "    try:", "        check(request)", "    except Exception:", "        raise HTTPException(status_code=401)"]];
  for (const lines of harmless) assert.equal(flagged(context, 'ERR-602', "auth.py", lines), false, lines.join(' '));
});

