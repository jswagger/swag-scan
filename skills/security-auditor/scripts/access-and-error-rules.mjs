// Access-control and error-handling rules for TypeScript, JavaScript and Python (SS-104; C# has CS-610, CRIT-301 and
// ARCH-404). All of them read the surrounding lines, so they run only when the real file can be read, and every one is
// a lower-confidence lead for the model pass: 0 hits on a new endpoint does not make it safe.
//
//   ACC-601  a new HTTP route with no authentication marker nearby (Express, Fastify, NestJS, FastAPI, Flask, Django REST)
//   ERR-601  an error that is caught and thrown away (.catch(() => {}), a catch that only logs, bare except)
//   ERR-602  an authentication or authorization handler that lets the request through when it fails

import { LOWER, createReporter, isCommentLine, linesFor, stripLineComment, windowText } from './rule-helpers.mjs';

const AUTH_WORDS = /\b(?:auth\w*|jwt\w*|passport|guard\w*|protect\w*|session\w*|login\w*|require[A-Z]\w*|requires?_\w+|verify\w*|isAdmin|is_admin|permission\w*|roles?\w*|acl|can[A-Z]\w*|bearer|apikey|api_key|secured|csrf\w*|Depends|Security|login_required|permission_required|user_passes_test|IsAuthenticated|IsAdminUser|Public)\b/i;
const PUBLIC_PATH = /['"`]\/?(?:health|healthz|ready|readyz|live|livez|ping|status|metrics|version|favicon\.ico|login|logout|signin|sign-in|signup|sign-up|register|auth|oauth|callback|public|robots\.txt|webhooks?|docs|openapi\.json)\b[^'"`]*['"`]/i;
const EXPRESS_ROUTE = /\b(app|router|server|api|fastify|\w+Router)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`][^'"`]*['"`])/;
const NEST_ROUTE = /^\s*@(Get|Post|Put|Patch|Delete|All)\s*\(/;
const FASTAPI_ROUTE = /^\s*@(\w+)\s*\.\s*(get|post|put|patch|delete)\s*\(/;
const FLASK_ROUTE = /^\s*@(\w+)\s*\.\s*route\s*\(/;
const DRF_VIEW = /^\s*class\s+\w+\s*\([^)]*\b(?:APIView|ViewSet|ModelViewSet|GenericAPIView|ReadOnlyModelViewSet|GenericViewSet|ListAPIView|CreateAPIView|RetrieveAPIView|UpdateAPIView|DestroyAPIView|ListCreateAPIView)\b[^)]*\)\s*:/;
const API_VIEW_DECORATOR = /^\s*@api_view\s*\(/;

const AUTH_PATH = /(?:^|[\\/_.-])(?:auth|authn|authz|authoriz\w*|authenticat\w*|guard|guards|middleware|interceptor|policy|permission\w*|security|login|session|jwt|token)(?:[\\/_.-]|$)/i;
const AUTH_CODE = /\b(?:authenticat\w*|authoriz\w*|verifyToken|verify_token|checkAuth|check_auth|requireAuth|require_auth|isAuthenticated|jwt\.verify|has_permission|canActivate|validateToken|validate_token|get_current_user|authorize)\b/i;
const ALLOWS = /\bnext\s*\(\s*\)|\breturn\s+(?:true|next\s*\(\s*\))\b|\breturn\s+await\s+call_next\b|\bawait\s+call_next\b|\bcallback\s*\(\s*(?:null|undefined)\s*,\s*true\b|\bresolve\s*\(\s*true\s*\)|\bdone\s*\(\s*\)|\breturn\s+True\b|\bpass\b\s*$/;
const DENIES = /\bnext\s*\(\s*\w+|\bthrow\b|\braise\b|\b(?:status|sendStatus)\s*\(\s*40[13]|\b401\b|\b403\b|\breturn\s+(?:false|False)\b|\bUnauthorized\b|\bForbidden\b|\bHTTPException\b|\bPermissionDenied\b|\bdeny\b|\breject\b/i;

/** The text of the `{ ... }` block that opens at `lines[at]`, as an array of its lines (without the braces). */
function braceBlock(lines, at, maxLines = 30) {
  const text = lines.slice(at, at + maxLines).join('\n');
  const open = text.indexOf('{');
  if (open === -1) return undefined;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, index), endLine: at + text.slice(0, index).split('\n').length - 1 };
    }
  }
  return undefined;
}

/** The indented lines that follow `lines[at]` in Python, up to the next line at the same or lower indentation. */
function indentedBlock(lines, at) {
  const indent = /^\s*/.exec(lines[at])[0].length;
  const body = [];
  for (let next = at + 1; next < lines.length; next += 1) {
    if (!lines[next].trim()) continue;
    if (/^\s*/.exec(lines[next])[0].length <= indent) break;
    body.push(lines[next]);
  }
  return body;
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|#).*$/gm, '').trim();

export function createAccessAndErrorRules() {
  function analyze({ file, language, sourceLines }) {
    if (!['typescript', 'javascript', 'python'].includes(language)) return [];
    const { lines, hasSource } = linesFor(file, sourceLines);
    if (!hasSource) return [];
    const { found, report } = createReporter();
    const python = language === 'python';
    const authPath = AUTH_PATH.test(file.path);
    const fileText = lines.join('\n');
    const appLevelAuth = (before) => lines.slice(0, before).some((line) => /\b(?:app|router|server|api|fastify|\w+Router)\s*\.\s*(?:use|addHook|register)\s*\(.*\b(?:auth\w*|jwt\w*|passport|guard\w*|protect\w*|session\w*|verify\w*|requireAuth\w*)\b/i.test(line)
      || /\bAPIRouter\s*\([^)]*dependencies\s*=|\bdependencies\s*=\s*\[[^\]]*(?:Depends|Security)/.test(line)
      || /\bapp\s*=\s*FastAPI\s*\([^)]*dependencies\s*=/.test(line)
      || /\bbefore_request\b/.test(line) || /\bMIDDLEWARE\b/.test(line));

    for (const change of file.changes ?? []) {
      if (change.side !== 'added' || isCommentLine(change.text, python ? 'python' : 'typescript')) continue;
      const index = change.line - 1;
      const code = stripLineComment(change.text, python ? 'python' : 'typescript');
      if (!code.trim()) continue;

      if (!python) {
        // ACC-601: Express and Fastify routes.
        const express = EXPRESS_ROUTE.exec(code);
        if (express && !PUBLIC_PATH.test(express[3]) && !appLevelAuth(index)) {
          const call = windowText(lines, index, index + 4, 'typescript').replace(code.slice(0, express.index + express[0].length), '');
          if (!AUTH_WORDS.test(call.split(/\)\s*;?\s*$/m)[0] ?? call)) {
            report('ACC-601', change, `A new ${express[2].toUpperCase()} route ${express[3]} has no authentication middleware on it or applied to the router before it; confirm it is meant to be public, or add auth`, LOWER);
          }
        }
        // ACC-601: NestJS routes.
        const nest = NEST_ROUTE.exec(code);
        if (nest) {
          const above = lines.slice(Math.max(0, index - 6), index).join('\n');
          let classIndex = index - 1;
          while (classIndex >= 0 && !/\bclass\s+\w+/.test(lines[classIndex])) classIndex -= 1;
          const classDecorators = classIndex >= 0 ? lines.slice(Math.max(0, classIndex - 6), classIndex + 1).join('\n') : '';
          const argument = /@\w+\s*\(\s*(['"`][^'"`]*['"`])?/.exec(code)?.[1] ?? '';
          if (!AUTH_WORDS.test(above) && !AUTH_WORDS.test(classDecorators) && !PUBLIC_PATH.test(argument || "''") && !/@Public\b/.test(fileText)) {
            report('ACC-601', change, `A new ${nest[1].toUpperCase()} handler has no @UseGuards, @Auth or role decorator on it or on its controller; confirm it is meant to be public`, LOWER);
          }
        }
      } else {
        // ACC-601: FastAPI.
        const fastapi = FASTAPI_ROUTE.exec(code);
        if (fastapi && !/\bdependencies\s*=/.test(code) && !PUBLIC_PATH.test(code) && !appLevelAuth(index)) {
          const signature = windowText(lines, index, index + 8, 'python').split(/\)\s*(?:->[^:]*)?:/)[0];
          if (!/\b(?:Depends|Security)\s*\(/.test(signature) && !AUTH_WORDS.test(lines.slice(Math.max(0, index - 3), index).join('\n'))) {
            report('ACC-601', change, 'A new FastAPI route has no Depends(...) or Security(...) for the current user, and its router has no shared dependency; confirm it is meant to be public', LOWER);
          }
        }
        // ACC-601: Flask.
        const flask = FLASK_ROUTE.exec(code);
        if (flask && !PUBLIC_PATH.test(code) && !appLevelAuth(index)) {
          const around = lines.slice(Math.max(0, index - 3), index + 4).join('\n');
          if (!AUTH_WORDS.test(around)) {
            report('ACC-601', change, 'A new Flask route has no login_required, jwt_required or similar decorator next to it and no before_request check in the file; confirm it is meant to be public', LOWER);
          }
        }
        // ACC-601: Django REST Framework.
        if (DRF_VIEW.test(code)) {
          const body = indentedBlock(lines, index).slice(0, 20).join('\n');
          if (!/\bpermission_classes\b|\bget_permissions\b|\bLoginRequiredMixin\b|\bPermissionRequiredMixin\b/.test(code + body)) {
            report('ACC-601', change, 'A new Django REST view sets no permission_classes, so it uses the project default; confirm the default in settings requires authentication', LOWER);
          }
        }
        if (API_VIEW_DECORATOR.test(code)) {
          const around = lines.slice(Math.max(0, index - 3), index + 4).join('\n');
          if (!/@permission_classes\b|@login_required\b|@permission_required\b/.test(around)) {
            report('ACC-601', change, 'A new @api_view function has no @permission_classes decorator, so it uses the project default; confirm the default in settings requires authentication', LOWER);
          }
        }
      }

      // ERR-601: errors thrown away.
      if (!python) {
        if (/\.\s*catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+|function\s*\(\s*\w*\s*\))\s*(?:=>)?\s*\{\s*\}\s*\)/.test(code) || /\.\s*catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:undefined|null|void 0)\s*\)/.test(code)) {
          report('ERR-601', change, 'A promise rejection is caught and ignored, so a failure leaves no trace and the code carries on as if it worked; log it, handle it or let it propagate', LOWER);
        }
        const catchOpen = /\bcatch\s*(?:\(\s*[\w$]*\s*(?::\s*\w+)?\s*\))?\s*\{\s*$/.test(code);
        if (catchOpen) {
          const block = braceBlock(lines, index);
          const body = block ? stripComments(block.body) : undefined;
          if (body !== undefined && (body === '' || /^(?:console\s*\.\s*(?:log|info|debug|warn|error)\s*\([^;]*\)\s*;?\s*)+$/.test(body.replace(/\s+/g, ' ')))) {
            report('ERR-601', change, body === ''
              ? 'This catch block is empty, so the error is thrown away; handle it or rethrow'
              : 'This catch block only writes to the console, so callers never learn the operation failed; log with context and rethrow or return an error', LOWER);
          }
        }
      } else {
        const bare = /^\s*except\s*:\s*(.*)$/.exec(code);
        const broad = /^\s*except\s+(?:\(?\s*(?:Exception|BaseException)\s*\)?)(?:\s+as\s+\w+)?\s*:\s*(.*)$/.exec(code);
        const match = bare ?? broad;
        if (match) {
          const inline = match[1].trim();
          const body = inline ? [inline] : indentedBlock(lines, index).slice(0, 6).map((line) => line.trim());
          const first = body.find((line) => line && !line.startsWith('#')) ?? '';
          const raises = body.some((line) => /^\s*raise\b/.test(line));
          const logs = body.some((line) => /\b(?:log(?:ger|ging)?|print|traceback|sentry|capture_exception)\b/i.test(line));
          const swallowedOnly = /^(?:pass|\.\.\.|continue|return(?:\s+(?:None|False|\[\]|\{\}|""|''))?)$/.test(first);
          if (!raises && first !== 'pass' && (bare ? !logs : swallowedOnly && !logs)) {
            report('ERR-601', change, bare
              ? 'A bare "except:" catches everything, including KeyboardInterrupt and SystemExit, and this handler neither logs nor re-raises; catch the specific error you expect'
              : 'This handler catches every Exception and carries on without logging or re-raising, so failures disappear; catch the specific error, or log it with the traceback', LOWER);
          }
        }
      }

      // ERR-602: fail-open authentication and authorization handlers.
      const handlerStart = python ? /^\s*except\b[^:]*:\s*(.*)$/.exec(code) : (/\bcatch\s*(?:\(\s*[\w$]*\s*(?::\s*\w+)?\s*\))?\s*\{\s*$/.test(code) ? [] : undefined);
      if (handlerStart) {
        const body = python
          ? [handlerStart[1], ...indentedBlock(lines, index)].filter(Boolean).slice(0, 12).join('\n')
          : stripComments(braceBlock(lines, index)?.body ?? '');
        const context = lines.slice(Math.max(0, index - 25), index).join('\n');
        if ((authPath || AUTH_CODE.test(context)) && ALLOWS.test(body) && !DENIES.test(body.replace(/\bnext\s*\(\s*\)/g, ''))) {
          report('ERR-602', change, 'This handler runs when an authentication or authorization check fails or errors, and it lets the request through (next(), return true or call_next); it should deny. Fail closed', LOWER);
        }
      }
    }
    return found;
  }

  return { analyze };
}
