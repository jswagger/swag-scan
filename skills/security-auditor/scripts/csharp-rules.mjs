// C# rules for the Security Auditor (SS-104). They run on changed C# files and on changed `.config` files (web.config).
//
// The shared statement splitter does not break up C# class bodies (a whole class lands in one statement), so these
// rules work on the changed line plus a small window of the lines around it. They need the real file for anything
// that looks at neighbouring lines. When the file cannot be read, only rules that fit on the changed lines run.
//
// Every rule is a lead for the model pass, not a verdict. Context-dependent rules carry `confidence: 'lower'`.

const CLIP = 240;
const clip = (text) => text.replace(/\s+/g, ' ').trim().slice(0, CLIP);

/** A line without its trailing `// comment`. A `//` inside a string such as "http://x" has no space before it, so it stays. */
const code = (line) => (line ?? '').replace(/(^|\s)\/\/.*$/, '$1').trimEnd();
const isCommentLine = (line) => /^\s*(?:\/\/|\/\*|\*)/.test(line ?? '');

const STRING_START = /^(\$@|@\$|\$|@)?"/;

/** Reads a C# string literal that starts at `index`. Returns where it ends and whether it has `{placeholders}`. */
function readString(text, index) {
  if (/\w/.test(text[index - 1] ?? '')) return undefined;
  const start = STRING_START.exec(text.slice(index, index + 3));
  if (!start) return undefined;
  const prefix = start[1] ?? '';
  let position = index + start[0].length;
  if (!prefix && text.startsWith('""', position)) { // raw string literal: """ ... """
    const close = text.indexOf('"""', position + 2);
    return { end: close === -1 ? text.length : close + 3, interpolated: false };
  }
  const verbatim = prefix.includes('@');
  while (position < text.length) {
    if (verbatim && text.startsWith('""', position)) position += 2;
    else if (!verbatim && text[position] === '\\') position += 2;
    else if (text[position] === '"') break;
    else position += 1;
  }
  const body = text.slice(index + start[0].length, position);
  return { end: position + 1, interpolated: prefix.includes('$') && /(?<!\{)\{[^{}]+\}/.test(body) };
}

/** The first argument of a call, with every string replaced by a marker: "S" plain, $"I" with placeholders. */
function firstArgument(text, openIndex) {
  let depth = 0;
  let masked = '';
  let index = openIndex;
  while (index < text.length) {
    const string = readString(text, index);
    if (string) {
      masked += string.interpolated ? '$"I"' : '"S"';
      index = string.end;
      continue;
    }
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (char === ',' && depth === 0) break;
    masked += char;
    index += 1;
  }
  return masked.trim();
}

/** The text of the statement around line `index` (0-based): back to the previous `;`, `{`, `}` and forward to the next. */
function localStatement(lines, index) {
  let start = index;
  while (start > 0 && index - start < 10 && lines[start - 1].trim()
    && !/[;{}]$/.test(code(lines[start - 1])) && !/^\s*\[[^\]]*\]\s*$/.test(lines[start - 1])) start -= 1;
  let end = index;
  while (end < lines.length - 1 && end - index < 10 && !/[;{]$/.test(code(lines[end]))) end += 1;
  return {
    first: start + 1,
    text: lines.slice(start, end + 1).map(code).join(' ').replace(/\s+/g, ' ').trim(),
  };
}

const windowText = (lines, from, to) => lines.slice(Math.max(0, from), to + 1).map(code).join('\n');

/** The text between the braces of the block that opens on or just after line `index`, or undefined if it is not found. */
function blockBody(lines, index) {
  let depth = 0;
  let opened = false;
  const body = [];
  for (let at = index; at < Math.min(lines.length, index + 30); at += 1) {
    const text = code(lines[at]).replace(/@?"(?:\\.|""|[^"\\])*"|'(?:\\.|[^'\\])'/g, '""');
    if (!opened && at > index + 1) return undefined;
    for (const char of text) {
      if (char === '{') {
        depth += 1;
        if (depth === 1) { opened = true; continue; }
      } else if (char === '}') {
        depth -= 1;
        if (opened && depth === 0) return body.join('');
      }
      if (opened && depth >= 1) body.push(char);
    }
    if (opened) body.push('\n');
  }
  return undefined;
}

// ---- Rule patterns -------------------------------------------------------------------------------------------------

const EF_RAW_SQL = /\b(?:FromSqlRaw|ExecuteSqlRaw(?:Async)?|SqlQueryRaw)\s*\(/;
const HTML_RAW = /\bHtml\s*\.\s*Raw\s*\(/;
const XXE = /\bDtdProcessing\s*=\s*DtdProcessing\s*\.\s*Parse\b|\bXmlResolver\s*=\s*new\s+XmlUrlResolver\b/;
const WEAK_HASH = /\b(?:MD5|SHA1)\s*\.\s*(?:Create|HashData)\s*\(|\b(?:MD5|SHA1)(?:CryptoServiceProvider|Managed|Cng)\b|\bnew\s+(?:MD5|SHA1)\w*\s*\(|\bHashAlgorithm\s*\.\s*Create\s*\(\s*"(?:MD5|SHA-?1)"|\bHashAlgorithmName\s*\.\s*(?:MD5|SHA1)\b/;
const WEAK_CIPHER = /\b(?:DES|RC2|TripleDES)\s*\.\s*Create\s*\(|\b(?:DES|RC2|TripleDES)CryptoServiceProvider\b/;
const JWT_VALIDATION_OFF = /\b(?:ValidateIssuer|ValidateAudience|ValidateLifetime|ValidateIssuerSigningKey|RequireHttpsMetadata|RequireSignedTokens)\s*=\s*false\b/;
const CORS_ANY_ORIGIN = /\bAllowAnyOrigin\s*\(|\bSetIsOriginAllowed\s*\(\s*\w+\s*=>\s*true\s*\)/;
const CORS_CREDENTIALS = /\bAllowCredentials\s*\(/;
const IGNORE_ANTIFORGERY = /\[\s*IgnoreAntiforgeryToken\b/;
const PATH_COMBINE = /\bPath\s*\.\s*(?:Combine|Join)\s*\(/;
const REQUEST_INPUT = /\bRequest\s*\.|\bHttpContext\b|\bRouteData\b|\.FileName\b|\b(?:request|req|input|model|dto|body|query|form)\s*\./i;
const MACHINE_KEY = /<machineKey\b[^>]*\b(?:validationKey|decryptionKey)\s*=\s*"(?!AutoGenerate)[^"]{8,}"/i;
const VIEWSTATE_MAC_OFF = /\benableViewStateMac\s*=\s*"false"/i;
const HTTP_ACTION = /^\s*\[\s*Http(?:Get|Post|Put|Delete|Patch)\b/;
const MINIMAL_API = /\.\s*Map(?:Get|Post|Put|Delete|Patch)\s*\(/;
const AUTH_MARKER = /\[\s*(?:Authorize|AllowAnonymous)\b/;
const MINIMAL_AUTH_MARKER = /\.\s*(?:RequireAuthorization|AllowAnonymous)\s*\(|\[\s*(?:Authorize|AllowAnonymous)\b/;
const CLASS_DECLARATION = /\b(?:class|record)\s+\w+/;
const AUTH_BASE_CLASS = /:\s*[\w.<>]*(?:Authorized|Authenticated|Secure)\w*/;
const AUTH_CODE = /\b(?:AuthenticationHandler|IAuthorizationHandler|AuthorizationHandler|IAsyncAuthorizationFilter|IAuthorizationFilter|IMiddleware|ActionFilterAttribute|AuthorizeAttribute)\b|\bInvokeAsync\s*\(\s*HttpContext/;
const AUTH_PATH = /(?:auth\w*|middleware|handler|filter)/i;
const FAIL_OPEN_BODY = /(?:\bawait\s+)?\b_?next\s*\(|\bAuthenticateResult\s*\.\s*Success\b|\.\s*Succeed\s*\(|\breturn\s+true\b/;
const CONSOLE_ONLY = /^\s*(?:Console\s*\.\s*(?:Write|WriteLine|Error\s*\.\s*WriteLine)|Debug\s*\.\s*Write(?:Line)?|Trace\s*\.\s*Write(?:Line)?)\s*\([^;]*\)\s*;\s*$/;
const LINQ_ID_FILTER = /\b([A-Za-z_]\w*(?:Ids|Guids|ids|guids))\s*\.\s*Contains\s*\(\s*\w+\s*\.\s*\w*(?:Guid|Id|ID)\s*\)/;

const escapeWord = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createCSharpRules(scan = {}) {
  const tenantPredicates = (Array.isArray(scan.dataAccess?.tenantPredicates) ? scan.dataAccess.tenantPredicates : [])
    .filter((name) => typeof name === 'string' && name.trim());
  const tenantPattern = tenantPredicates.length
    ? new RegExp(`\\b(?:${tenantPredicates.map(escapeWord).join('|')})\\b`, 'i')
    : undefined;

  /**
   * Runs the C# rules on one file. `sourceLines` is the file as read from disk, or undefined when it cannot be read;
   * rules that need the lines around a change are skipped then, so a missing file never causes a guess.
   */
  function analyze({ file, language, sourceLines }) {
    const isConfig = /\.config$/i.test(file.path);
    if (language !== 'csharp' && !isConfig) return [];

    const hasSource = Array.isArray(sourceLines);
    const lines = hasSource ? sourceLines : [];
    if (!hasSource) {
      for (const change of file.changes ?? []) if (change.side === 'added') lines[change.line - 1] = change.text;
      for (let index = 0; index < lines.length; index += 1) lines[index] ??= '';
    }

    const found = [];
    const reported = new Set();
    const report = (ruleId, change, description, extra = {}, key = `${ruleId}:${change.line}`) => {
      if (reported.has(key)) return;
      reported.add(key);
      found.push({ ruleId, line: change.line, description, evidence: extra.evidence ?? clip(change.text), ...extra.fields });
    };
    const lower = { fields: { confidence: 'lower' } };
    const suspicious = { fields: { severity: 'suspicious', confidence: 'lower' } };

    for (const change of file.changes ?? []) {
      if (change.side !== 'added' || isCommentLine(change.text)) continue;
      const index = change.line - 1;
      const line = code(change.text);

      if (isConfig) {
        const joined = windowText(lines, index - 2, index + 3).replace(/\s+/g, ' ');
        if (/machineKey|validationKey|decryptionKey/i.test(line) && MACHINE_KEY.test(joined)) {
          report('CS-609', change, 'A fixed machineKey in configuration lets anyone who has the key forge ViewState and authentication tickets; remove it from source, use AutoGenerate or a secret store, and rotate the key', { evidence: '[machine key value omitted]' });
        }
        if (VIEWSTATE_MAC_OFF.test(line)) {
          report('CS-609', change, 'enableViewStateMac="false" turns off ViewState tamper protection (the weakness behind ViewState forgery attacks); remove it');
        }
        continue;
      }

      const statement = localStatement(lines, index);
      const statementKey = (ruleId) => `${ruleId}:s${statement.first}`;

      // CS-601: EF Core raw SQL built from a string.
      const efCall = EF_RAW_SQL.exec(statement.text);
      if (efCall) {
        const argument = firstArgument(statement.text, efCall.index + efCall[0].length);
        const dynamic = argument.includes('$"I"') || /\+/.test(argument) || /\bstring\s*\.\s*(?:Format|Concat)\b/.test(argument);
        if (dynamic) {
          report('CS-601', change, 'Raw SQL for Entity Framework is built from a string with interpolation or concatenation; use FromSqlInterpolated, ExecuteSqlInterpolated, or pass values as parameters', {}, statementKey('CS-601'));
        }
      }

      // CS-602: Html.Raw with anything but a plain literal.
      const raw = HTML_RAW.exec(statement.text);
      if (raw && firstArgument(statement.text, raw.index + raw[0].length) !== '"S"') {
        report('CS-602', change, 'Html.Raw writes its argument without HTML encoding; confirm it never holds user, model or database text', lower, statementKey('CS-602'));
      }

      // CS-603: XML parser that reads DTDs or external entities.
      if (XXE.test(line)) {
        report('CS-603', change, 'XML parser allows DTD processing or an external resolver, which enables XML external entity (XXE) attacks; prohibit DTDs and set XmlResolver to null');
      }

      // CS-604: weak hashes (lower confidence: a checksum is fine) and weak ciphers.
      if (WEAK_CIPHER.test(line)) {
        report('CS-604', change, 'DES, RC2 and TripleDES are broken or obsolete; use AES-GCM');
      } else if (WEAK_HASH.test(line)) {
        report('CS-604', change, 'MD5 and SHA-1 are broken for passwords, signatures and integrity checks; use SHA-256 or better, and a password hasher for passwords (fine for a non-security checksum)', lower);
      }

      // CS-605: token validation switched off.
      if (JWT_VALIDATION_OFF.test(line)) {
        report('CS-605', change, 'Token validation setting is false (issuer, audience, lifetime, signing key, signature or HTTPS metadata); forged or expired tokens may be accepted');
      }

      // CS-606: any origin together with credentials.
      if (hasSource && (CORS_ANY_ORIGIN.test(line) || CORS_CREDENTIALS.test(line))) {
        const around = lines.slice(Math.max(0, index - 8), index + 9);
        const anchor = around.findIndex((text) => CORS_ANY_ORIGIN.test(code(text)));
        if (anchor !== -1 && around.some((text) => CORS_CREDENTIALS.test(code(text)))) {
          const anchorLine = Math.max(0, index - 8) + anchor + 1;
          report('CS-606', change, 'CORS policy allows any origin and also allows credentials, so any website can make authenticated requests as the user; list the trusted origins instead', {}, `CS-606:${anchorLine}`);
        }
      }

      // CS-607: anti-forgery validation turned off on an action.
      if (IGNORE_ANTIFORGERY.test(line)) {
        report('CS-607', change, '[IgnoreAntiforgeryToken] turns off CSRF validation for this action; fine for a token-authenticated API, risky for cookie sessions', lower);
      }

      // CS-608: file path built from request input.
      const pathCall = PATH_COMBINE.exec(statement.text);
      if (pathCall && REQUEST_INPUT.test(firstArgumentsText(statement.text, pathCall.index + pathCall[0].length))) {
        report('CS-608', change, 'Path.Combine or Path.Join uses a value that looks like request input; an absolute path or ".." can escape the intended folder, so resolve the full path and check it stays inside', lower, statementKey('CS-608'));
      }

      if (hasSource) {
        // CS-610: a new HTTP endpoint with no authorization marker nearby.
        if (HTTP_ACTION.test(change.text) && !hasAuthorizationMarker(lines, index)) {
          report('CS-610', change, 'New HTTP action with no [Authorize] or [AllowAnonymous] on the action or class; confirm a base controller, filter or global fallback policy protects it', suspicious);
        } else if (MINIMAL_API.test(line)) {
          const nearby = windowText(lines, index - 1, index + 10);
          if (!MINIMAL_AUTH_MARKER.test(nearby)) {
            report('CS-610', change, 'New minimal API endpoint with no RequireAuthorization or AllowAnonymous nearby; confirm the group or a fallback policy protects it', suspicious);
          }
        }

        // CRIT-301 (C#): an empty catch, or one that only writes to the console, over several lines.
        if (/\bcatch\b/.test(line) && !/\bcatch\b[^{]*\{\s*\}/.test(line)) {
          const body = blockBody(lines, index);
          const statements = body?.split('\n').map((text) => text.trim()).filter((text) => text && !isCommentLine(text));
          if (statements && statements.length === 0) {
            report('CRIT-301', change, 'Empty catch block swallows the exception; handle it, log it with context, or let it propagate');
          } else if (statements && statements.length === 1 && CONSOLE_ONLY.test(statements[0])) {
            report('CRIT-301', change, 'The catch block only writes to the console; the failure is not handled, logged properly or rethrown');
          }

          // ARCH-404 (C#): an authentication or authorization handler that carries on after an error.
          const authFile = AUTH_PATH.test(file.path) || AUTH_CODE.test(sourceLines.join('\n'));
          if (authFile && body && FAIL_OPEN_BODY.test(body)) {
            report('ARCH-404', change, 'A catch block in an authentication or authorization handler continues the request or reports success; an error here should deny access (fail closed)', suspicious);
          }
        }

        // DATA-502 (C#): a LINQ filter by a caller-supplied id list with no user or tenant predicate.
        const idFilter = LINQ_ID_FILTER.exec(statement.text);
        if (idFilter) {
          const scoped = windowText(lines, statement.first - 1, index + 4);
          if (!(tenantPattern && tenantPattern.test(scoped))) {
            report('DATA-502', change, `Query filters by caller-supplied ${idFilter[1]}.Contains(...) with no tenant or user predicate (${tenantPredicates.join(', ') || 'none configured'}); confirm the caller may read every id (IDOR lead, see ARCH-402)`, suspicious, statementKey('DATA-502'));
          }
        }
      }
    }
    return found;
  }

  return { analyze };
}

/** All the text inside the call's parentheses, with strings masked, for rules that look at every argument. */
function firstArgumentsText(text, openIndex) {
  let depth = 0;
  let masked = '';
  let index = openIndex;
  while (index < text.length) {
    const string = readString(text, index);
    if (string) {
      masked += '"S"';
      index = string.end;
      continue;
    }
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    masked += char;
    index += 1;
  }
  return masked;
}

/** The attribute lines of one action: the run of attributes (and comments) directly above and below its [Http...] line. */
function actionAttributes(lines, index) {
  let from = index;
  while (from > 0 && /^\s*(?:\[|\/\/)/.test(lines[from - 1])) from -= 1;
  let to = index;
  while (to < lines.length - 1 && to - index < 8 && /^\s*(?:\[|\/\/|$)/.test(lines[to + 1])) to += 1;
  return windowText(lines, from, to);
}

/** True when the action, or the class it sits in, carries [Authorize] or [AllowAnonymous], or the class has an authorized base. */
function hasAuthorizationMarker(lines, index) {
  if (AUTH_MARKER.test(actionAttributes(lines, index))) return true;
  for (let at = index; at >= 0; at -= 1) {
    if (!CLASS_DECLARATION.test(code(lines[at]))) continue;
    if (AUTH_BASE_CLASS.test(code(lines[at]))) return true;
    return AUTH_MARKER.test(windowText(lines, at - 6, at));
  }
  return false;
}
