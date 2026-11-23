import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// SS-104, C# rules. Each rule has a true-positive case and a harmless case. Most run on a real file on disk,
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
  const directory = mkdtempSync(join(tmpdir(), 'csharp-rules-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  writeFileSync(path, lines.join('\n'));
  return scan([added(path, lines)]);
}

const flagged = (context, rule, lines, name = 'Sample.cs') => ids(scanFile(context, name, lines)).includes(rule);

test('CS-601 flags EF raw SQL built with interpolation, concatenation or string.Format, even across lines', (context) => {
  const risky = [
    ['var rows = _db.Reports.FromSqlRaw($"SELECT * FROM Reports WHERE Name = \'{name}\'");'],
    ['await _db.Database.ExecuteSqlRawAsync("DELETE FROM Reports WHERE Id = " + id);'],
    ['var rows = _db.Reports.FromSqlRaw(string.Format("SELECT * FROM Reports WHERE Name = \'{0}\'", name));'],
    ['var rows = _db.Reports', '    .FromSqlRaw(', '        $"SELECT * FROM Reports WHERE Name = \'{name}\'")', '    .ToList();'],
  ];
  for (const lines of risky) assert.equal(flagged(context, 'CS-601', lines), true, lines.join(' '));

  const harmless = [
    ['var rows = _db.Reports.FromSqlRaw("SELECT * FROM Reports WHERE Name = {0}", name);'],
    ['var rows = _db.Reports.FromSqlInterpolated($"SELECT * FROM Reports WHERE Name = {name}");'],
    ['var rows = _db.Reports.FromSqlRaw(sql);'],
    ['var rows = _db.Reports.FromSqlRaw($"SELECT 1");'],
    ['await _db.Database.ExecuteSqlRawAsync("DELETE FROM Reports WHERE Id = @p0", new SqlParameter("@p0", id + 1));'],
  ];
  for (const lines of harmless) assert.equal(flagged(context, 'CS-601', lines), false, lines.join(' '));
});

test('CS-602 flags Html.Raw unless the argument is a plain literal', (context) => {
  assert.equal(flagged(context, 'CS-602', ['@Html.Raw(Model.Description)'], 'View.cshtml'), true);
  assert.equal(flagged(context, 'CS-602', ['var html = Html.Raw($"<b>{name}</b>");']), true);
  assert.equal(flagged(context, 'CS-602', ['@Html.Raw("<br />")'], 'View.cshtml'), false);
  assert.equal(flagged(context, 'CS-602', ['@Html.Encode(Model.Description)'], 'View.cshtml'), false);
  const found = ids(scanFile(context, 'View.cshtml', ['@Html.Raw(Model.Description)']));
  assert.equal(found.includes('CS-602'), true);
});

test('CS-603 flags XML parsers that read DTDs or use a real resolver', (context) => {
  assert.equal(flagged(context, 'CS-603', ['settings.DtdProcessing = DtdProcessing.Parse;']), true);
  assert.equal(flagged(context, 'CS-603', ['doc.XmlResolver = new XmlUrlResolver();']), true);
  assert.equal(flagged(context, 'CS-603', ['settings.DtdProcessing = DtdProcessing.Prohibit;']), false);
  assert.equal(flagged(context, 'CS-603', ['doc.XmlResolver = null;']), false);
});

test('CS-604 flags weak hashes (lower confidence) and weak ciphers', (context) => {
  const md5 = scanFile(context, 'Hash.cs', ['using var md5 = MD5.Create();']);
  const found = md5.candidates.find((candidate) => candidate.ruleId === 'CS-604');
  assert.ok(found);
  assert.equal(found.confidence, 'lower');

  const des = scanFile(context, 'Cipher.cs', ['var cipher = TripleDES.Create();']).candidates.find((candidate) => candidate.ruleId === 'CS-604');
  assert.ok(des);
  assert.equal(des.confidence, undefined);

  for (const line of ['var h = SHA1.HashData(bytes);', 'var h = new SHA1CryptoServiceProvider();', 'HashAlgorithmName.MD5']) {
    assert.equal(flagged(context, 'CS-604', [line]), true, line);
  }
  for (const line of ['using var sha = SHA256.Create();', 'using var aes = Aes.Create();', 'var h = SHA512.HashData(bytes);']) {
    assert.equal(flagged(context, 'CS-604', [line]), false, line);
  }
});

test('CRIT-108, CRIT-109 and CRIT-111 cover the wider set of unsafe formatters, type handling and certificate bypasses', (context) => {
  for (const line of ['var f = new NetDataContractSerializer();', 'var f = new LosFormatter();', 'var f = new SoapFormatter();', 'var f = new BinaryFormatter();']) {
    assert.equal(flagged(context, 'CRIT-108', [line]), true, line);
  }
  for (const line of ['s.TypeNameHandling = TypeNameHandling.Auto;', 's.TypeNameHandling = TypeNameHandling.Objects;', 's.TypeNameHandling = TypeNameHandling.Arrays;', 's.TypeNameHandling = TypeNameHandling.All;']) {
    assert.equal(flagged(context, 'CRIT-109', [line]), true, line);
  }
  assert.equal(flagged(context, 'CRIT-109', ['s.TypeNameHandling = TypeNameHandling.None;']), false);
  for (const line of [
    'handler.ServerCertificateCustomValidationCallback = (m, c, ch, e) => true;',
    'handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;',
    'ServicePointManager.ServerCertificateValidationCallback += (_, _, _, _) => true;',
  ]) {
    assert.equal(flagged(context, 'CRIT-111', [line]), true, line);
  }
  assert.equal(flagged(context, 'CRIT-111', ['var handler = new HttpClientHandler();']), false);
  assert.equal(flagged(context, 'CRIT-108', ['var f = new JsonSerializer();']), false);
});

test('CS-605 flags token validation switched off', (context) => {
  for (const setting of ['ValidateIssuer', 'ValidateAudience', 'ValidateLifetime', 'ValidateIssuerSigningKey', 'RequireHttpsMetadata', 'RequireSignedTokens']) {
    assert.equal(flagged(context, 'CS-605', [`options.TokenValidationParameters.${setting} = false,`]), true, setting);
    assert.equal(flagged(context, 'CS-605', [`${setting} = true,`]), false, `${setting} = true`);
  }
});

test('CS-606 flags any origin together with credentials, but not either alone', (context) => {
  const both = [
    'builder.Services.AddCors(o => o.AddPolicy("p", b => b',
    '    .AllowAnyOrigin()',
    '    .AllowAnyHeader()',
    '    .AllowCredentials()));',
  ];
  assert.equal(flagged(context, 'CS-606', both), true);
  assert.equal(flagged(context, 'CS-606', ['b.SetIsOriginAllowed(_ => true).AllowCredentials();']), true);
  assert.equal(flagged(context, 'CS-606', ['b.AllowAnyOrigin().AllowAnyHeader();']), false);
  assert.equal(flagged(context, 'CS-606', ['b.WithOrigins("https://app.example.com").AllowCredentials();']), false);
  assert.equal(ids(scanFile(context, 'Cors.cs', both)).filter((id) => id === 'CS-606').length, 1, 'one lead per policy');
});

test('CS-607 flags IgnoreAntiforgeryToken at lower confidence', (context) => {
  const found = scanFile(context, 'Ctl.cs', ['[IgnoreAntiforgeryToken]', 'public IActionResult Save() => Ok();']).candidates.find((candidate) => candidate.ruleId === 'CS-607');
  assert.ok(found);
  assert.equal(found.confidence, 'lower');
  assert.equal(flagged(context, 'CS-607', ['[ValidateAntiForgeryToken]']), false);
});

test('CS-608 flags Path.Combine with request input but not with fixed folders', (context) => {
  for (const line of [
    'var path = Path.Combine(_env.WebRootPath, request.FileName);',
    'var path = Path.Combine(root, Request.Query["file"]);',
    'var path = Path.Join(root, upload.FileName);',
  ]) assert.equal(flagged(context, 'CS-608', [line]), true, line);
  for (const line of [
    'var path = Path.Combine(_env.WebRootPath, "uploads", "logo.png");',
    'var path = Path.Combine(root, formattedName);',
    'var path = Path.Combine(root, safeName);',
  ]) assert.equal(flagged(context, 'CS-608', [line]), false, line);
});

test('CS-609 flags a fixed machineKey and disabled ViewState MAC in web.config, without printing the key', (context) => {
  const key = '<machineKey validationKey="A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F6" decryptionKey="0123456789ABCDEF0123456789ABCDEF" />';
  const report = scanFile(context, 'web.config', ['<system.web>', `  ${key}`, '</system.web>']);
  const found = report.candidates.find((candidate) => candidate.ruleId === 'CS-609');
  assert.ok(found);
  assert.equal(JSON.stringify(report).includes('A1B2C3D4E5F6'), false, 'the key value must not appear in the output');

  assert.equal(flagged(context, 'CS-609', ['<pages enableViewStateMac="false" />'], 'web.config'), true);
  assert.equal(flagged(context, 'CS-609', ['<machineKey validationKey="AutoGenerate,IsolateApps" decryptionKey="AutoGenerate,IsolateApps" />'], 'web.config'), false);
  assert.equal(flagged(context, 'CS-609', ['<pages enableViewStateMac="true" />'], 'web.config'), false);
  assert.equal(report.coverage.unchecked.length, 0, 'web.config is data, not an unchecked language');
});

test('CS-610 flags a new HTTP action with no authorization marker, and respects action, class and base-class markers', (context) => {
  const open = [
    '[ApiController]',
    'public class ReportsController : ControllerBase',
    '{',
    '    [HttpPost("reports")]',
    '    public IActionResult Create() => Ok();',
    '}',
  ];
  const report = scanFile(context, 'Open.cs', open);
  const found = report.candidates.find((candidate) => candidate.ruleId === 'CS-610');
  assert.ok(found);
  assert.equal(found.confidence, 'lower');
  assert.equal(found.severity, 'suspicious');

  const onAction = ['[ApiController]', 'public class A : ControllerBase', '{', '    [Authorize]', '    [HttpPost("a")]', '    public IActionResult Create() => Ok();', '}'];
  const onClass = ['[Authorize]', '[ApiController]', 'public class A : ControllerBase', '{', '    [HttpPost("a")]', '    public IActionResult Create() => Ok();', '}'];
  const anonymous = ['[ApiController]', 'public class A : ControllerBase', '{', '    [AllowAnonymous]', '    [HttpGet("a")]', '    public IActionResult Get() => Ok();', '}'];
  const baseClass = ['public class A : AuthorizedController', '{', '    [HttpGet("a")]', '    public IActionResult Get() => Ok();', '}'];
  for (const lines of [onAction, onClass, anonymous, baseClass]) assert.equal(flagged(context, 'CS-610', lines), false, lines.join('\n'));

  // The [Authorize] on the action above must not hide the open action below it.
  const neighbours = ['[ApiController]', 'public class A : ControllerBase', '{', '    [Authorize]', '    [HttpGet("a")]', '    public IActionResult Get() => Ok();', '', '    [HttpPost("b")]', '    public IActionResult Post() => Ok();', '}'];
  const flaggedLines = scanFile(context, 'Two.cs', neighbours).candidates.filter((candidate) => candidate.ruleId === 'CS-610').map((candidate) => candidate.line);
  assert.deepEqual(flaggedLines, [8]);
});

test('CS-610 covers minimal API endpoints', (context) => {
  assert.equal(flagged(context, 'CS-610', ['app.MapPost("/reports", (Report r) => Results.Ok(r));']), true);
  assert.equal(flagged(context, 'CS-610', ['app.MapPost("/reports", (Report r) => Results.Ok(r)).RequireAuthorization();']), false);
  assert.equal(flagged(context, 'CS-610', ['app.MapGet("/health", () => "ok").AllowAnonymous();']), false);
  assert.equal(flagged(context, 'CS-610', ['app.MapPost("/reports", [Authorize] (Report r) => Results.Ok(r));']), false);
});

test('CRIT-301 flags a multi-line empty catch and one that only writes to the console, not one that handles the error', (context) => {
  assert.equal(flagged(context, 'CRIT-301', ['try { Run(); }', 'catch (Exception)', '{', '}']), true);
  assert.equal(flagged(context, 'CRIT-301', ['try { Run(); }', 'catch (Exception ex)', '{', '    // ignore', '}']), true);
  assert.equal(flagged(context, 'CRIT-301', ['try { Run(); }', 'catch (Exception ex)', '{', '    Console.WriteLine(ex);', '}']), true);

  assert.equal(flagged(context, 'CRIT-301', ['try { Run(); }', 'catch (Exception ex)', '{', '    _logger.LogError(ex, "failed");', '    throw;', '}']), false);
  assert.equal(flagged(context, 'CRIT-301', ['try { Run(); }', 'catch (Exception ex)', '{', '    Console.WriteLine(ex);', '    return Problem();', '}']), false);
});

test('ARCH-404 flags an auth handler that carries on after an error, not one that denies', (context) => {
  const failOpen = [
    'public class TokenMiddleware',
    '{',
    '    public async Task InvokeAsync(HttpContext context)',
    '    {',
    '        try { Validate(context); }',
    '        catch (Exception)',
    '        {',
    '            await _next(context);',
    '            return;',
    '        }',
    '        await _next(context);',
    '    }',
    '}',
  ];
  assert.equal(flagged(context, 'ARCH-404', failOpen, 'TokenMiddleware.cs'), true);

  const failClosed = failOpen.map((line) => (line === '            await _next(context);' ? '            context.Response.StatusCode = 401;' : line));
  assert.equal(flagged(context, 'ARCH-404', failClosed, 'TokenMiddleware.cs'), false);

  const notAuth = ['public class Worker', '{', '    void Run()', '    {', '        try { Step(); }', '        catch (Exception)', '        {', '            return true;', '        }', '    }', '}'];
  assert.equal(flagged(context, 'ARCH-404', notAuth, 'Worker.cs'), false, 'a catch outside an auth handler is not a fail-open lead');
});

test('DATA-502 flags a LINQ filter by a caller-supplied id list with no user or tenant predicate', (context) => {
  const open = ['var rows = await _db.Reports.Where(r => guids.Contains(r.ReportGuid)).ToListAsync();'];
  const found = scanFile(context, 'Q.cs', open).candidates.find((candidate) => candidate.ruleId === 'DATA-502');
  assert.ok(found);
  assert.equal(found.confidence, 'lower');

  const scoped = ['var rows = await _db.Reports.Where(r => r.UserId == userId && guids.Contains(r.ReportGuid)).ToListAsync();'];
  assert.equal(flagged(context, 'DATA-502', scoped), false);
  const scopedBelow = ['var rows = await _db.Reports', '    .Where(r => guids.Contains(r.ReportGuid))', '    .Where(r => r.TenantId == tenant)', '    .ToListAsync();'];
  assert.equal(flagged(context, 'DATA-502', scopedBelow), false);
  assert.equal(flagged(context, 'DATA-502', ['var rows = _db.Reports.Where(r => r.Status == status);']), false);
});

test('a C# class body is not reported as one multi-line SQL statement (the stray CRIT-101 on line 2)', (context) => {
  const lines = [
    'namespace A {',
    '  public class Reports {',
    '    public void Get(Guid id) {',
    '      var rows = _db.Reports.Where(r => r.Id == id);',
    '      var label = $"Report {id}";',
    '      var note = "SELECT x FROM y WHERE z";',
    '    }',
    '  }',
    '}',
  ];
  assert.equal(flagged(context, 'CRIT-101', lines), false);
});

test('probe controller: every planted issue gets a lead (SS-104 C# comment, 0 leads on a risky endpoint)', (context) => {
  const lines = [
    'using Microsoft.AspNetCore.Mvc;',
    'namespace A {',
    '  [ApiController]',
    '  public class ReportsController : ControllerBase {',
    '    [HttpPost("reports/by-guids")]',
    '    public async Task<IActionResult> Get([FromBody] List<Guid> guids) {',
    '      var rows = await _db.Reports.Where(r => guids.Contains(r.ReportGuid)).ToListAsync();',
    '      var raw = _db.Reports.FromSqlRaw($"SELECT * FROM Reports WHERE Name = \'{guids[0]}\'");',
    '      var md5 = System.Security.Cryptography.MD5.Create();',
    '      try { Do(); } catch (Exception) { }',
    '      return Ok(rows);',
    '    }',
    '  }',
    '}',
  ];
  const found = ids(scanFile(context, 'ReportsController.cs', lines));
  for (const rule of ['CS-610', 'DATA-502', 'CS-601', 'CS-604', 'CRIT-301']) assert.equal(found.includes(rule), true, `${rule} should be reported`);
  assert.equal(found.includes('CRIT-101'), false, 'no stray class-body lead');
});

test('coverage says how many rules found something, so 0 leads is not read as clean', (context) => {
  const quiet = scanFile(context, 'Quiet.cs', ['public class Quiet { public int One() => 1; }']);
  const csharp = quiet.coverage.ruleFamilies.find((entry) => entry.language === 'csharp');
  assert.equal(csharp.rules.matched, 0);
  assert.equal(csharp.rules.ran >= 20, true);
  assert.equal(csharp.rules.matchedNothing, csharp.rules.ran);
  assert.match(quiet.coverage.ruleFamiliesLine, /C# \(1 file\): 15 of 15 families, 0 of \d+ rules found something/);

  const noisy = scanFile(context, 'Noisy.cs', ['var md5 = MD5.Create();', 'var f = new BinaryFormatter();']);
  const counts = noisy.coverage.ruleFamilies.find((entry) => entry.language === 'csharp').rules;
  assert.equal(counts.matched, 2);
});
