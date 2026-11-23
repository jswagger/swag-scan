// Python rules for the Security Auditor (SS-104). They run on changed `.py` files. Every rule is a lead for the model
// pass, not a verdict; context-dependent ones are lower confidence. Calls are read across lines so a call split over
// several lines is still seen whole.

import {
  LOWER, callsOn, createReporter, isCommentLine, isPlainLiteral, linesFor, maskStrings, stripLineComment, windowText,
} from './rule-helpers.mjs';

const LANGUAGE = 'python';

const REQUEST_INPUT = /\brequest\s*\.\s*(?:args|form|values|json|data|files|cookies|headers|GET|POST|query_params|path_params|body)\b|\bflask\s*\.\s*request\b|\binput\s*\(|\bsys\s*\.\s*argv\b/;

const EVAL_CALL = /(?<![\w.])(?:eval|exec)\s*\(/;
const SHELL_TRUE = /\bshell\s*=\s*True\b/;
const SUBPROCESS_CALL = /\bsubprocess\s*\.\s*(?:run|call|check_call|check_output|Popen)\s*\(/;
const OS_SHELL = /\bos\s*\.\s*(?:system|popen)\s*\(/;
const SQL_EXECUTE = /\.\s*(?:execute|executemany|executescript|raw|read_sql(?:_query)?)\s*\(/;
const SQL_WORDS = /\b(?:select|insert|update|delete|drop|create|alter|union|where|from)\b/i;
const TEXT_SQL = /(?<![\w.])text\s*\(/;
const TEMPLATE_STRING = /\brender_template_string\s*\(|\bTemplate\s*\(/;
const MARK_SAFE = /(?<![\w.])(?:mark_safe|Markup)\s*\(|\|\s*safe\b/;
const AUTOESCAPE_OFF = /\bautoescape\s*=\s*False\b/;

const DEBUG_ON = /\bdebug\s*=\s*True\b|^\s*DEBUG\s*=\s*True\b|\bapp\s*\.\s*config\s*\[\s*['"]DEBUG['"]\s*\]\s*=\s*True\b/;
const RUN_CALL = /\b(?:app|application)\s*\.\s*run\s*\(/;
const HOST_ALL = /\bhost\s*=\s*['"](?:0\.0\.0\.0|::)['"]/;
const TRACEBACK_OUT = /(?<![\w.])(?:traceback\s*\.\s*(?:format_exc|print_exc|format_exception)|repr\s*\(\s*e\s*\)|str\s*\(\s*e\s*\))\s*\(?/;
const RESPONSE_CALL = /\b(?:return|jsonify|Response|JSONResponse|HttpResponse|JsonResponse|abort)\b/;

const PATH_SINK = /\b(?:open|send_file|send_from_directory|FileResponse|os\s*\.\s*(?:remove|unlink|rmdir|listdir|rename|makedirs)|shutil\s*\.\s*(?:copy|copyfile|move|rmtree)|Path)\s*\(/;
const PATH_JOIN = /\bos\s*\.\s*path\s*\.\s*join\s*\(/;
const REQUESTS_CALL = /\b(?:requests|httpx|session|client)\s*\.\s*(?:get|post|put|patch|delete|head|request)\s*\(|\burlopen\s*\(|\burllib\s*\.\s*request\s*\.\s*urlopen\s*\(/;
const FIXED_HOST = /^\s*f?['"]https?:\/\/[^/{'"\s]+/;

const MASS_ASSIGN_ARGS = /\*\*\s*(?:request\s*\.\s*(?:json|form|args|data|POST|GET)|data|payload|body|validated_data)\b/;
const MODEL_CALL = /\b(?:[A-Z]\w*\s*\(|\.\s*(?:create|update|update_or_create|get_or_create|bulk_create)\s*\()/;
const DRF_ALL_FIELDS = /\bfields\s*=\s*['"]__all__['"]|\bexclude\s*=\s*\(?\s*\[?\s*\)?\s*$/;

const YAML_LOAD = /(?<![\w.])yaml\s*\.\s*(?:load|load_all|unsafe_load|full_load)\s*\(/;
const PICKLE_LOAD = /\b(?:pickle|cPickle|_pickle|dill|cloudpickle|shelve|marshal|jsonpickle)\s*\.\s*(?:loads?|decode|open)\s*\(|\bpandas\s*\.\s*read_pickle\s*\(|\bpd\s*\.\s*read_pickle\s*\(|\btorch\s*\.\s*load\s*\(/;

const WEAK_HASH = /\bhashlib\s*\.\s*(?:md5|sha1)\s*\(|\bhashlib\s*\.\s*new\s*\(\s*['"](?:md5|sha1)['"]|\bMD5\s*\.\s*new\s*\(|\bSHA1\s*\.\s*new\s*\(/i;
const SECURITY_CONTEXT = /\b(?:password|passwd|pwd|secret|token|signature|sign|hmac|auth|credential|api[_-]?key|salt)\b/i;
const VERIFY_OFF = /\bverify\s*=\s*False\b|\b_create_unverified_context\b|\bssl\s*\.\s*CERT_NONE\b|\bcheck_hostname\s*=\s*False\b|\bPYTHONHTTPSVERIFY\b['"]?\s*[\]:,=]\s*['"]?0/;
const RANDOM_CALL = /\brandom\s*\.\s*(?:random|randint|randrange|choice|choices|sample|getrandbits|shuffle|uniform)\s*\(/;
const RANDOM_SECURITY = /\b(?:token|password|passwd|secret|otp|nonce|session[_-]?id|reset|verification|csrf|api[_-]?key|salt|code|pin)\b/i;
const ECB_MODE = /\bMODE_ECB\b|\bmodes\s*\.\s*ECB\s*\(/;
const ASSERT_AUTH = /^\s*assert\b[^\n]*\b(?:is_admin|is_staff|is_superuser|is_authenticated|has_perm|has_permission|permission|role|authorized|can_\w+|user\s*\.\s*\w*admin\w*)\b/;
const JWT_VERIFY_OFF = /\bverify_signature['"]?\s*[:=]\s*False\b|\bverify\s*=\s*False\b[^\n]*\bjwt\b|\balgorithms\s*=\s*\[[^\]]*['"]none['"]/i;
const JWT_DECODE_UNVERIFIED = /\bjwt\s*\.\s*decode\s*\(/;
const SECRET_KEY_LITERAL = /\b(?:SECRET_KEY|JWT_SECRET|SESSION_SECRET)\s*=\s*['"][^'"\n]{4,}['"]/;
const URL_FETCH_BAD_SCHEME = /\bfile:\/\//;
const TARFILE_EXTRACT = /\.\s*(?:extractall|extract)\s*\(/;
const ZIPFILE_EXTRACT = /\.\s*extractall\s*\(/;
const TAR_OPEN = /\btarfile\s*\.\s*(?:open|TarFile)\s*\(/;
const FLASK_SECRET_BAD = /\.\s*secret_key\s*=\s*['"][^'"\n]{1,}['"]/;
const CORS_ANY = /\ballow_origins\s*=\s*\[\s*['"]\*['"]\s*\]|\bCORS_ALLOW_ALL_ORIGINS\s*=\s*True\b|\bCORS_ORIGIN_ALLOW_ALL\s*=\s*True\b|\bcors_allowed_origins\s*=\s*['"]\*['"]/i;
const CORS_CREDENTIALS = /\ballow_credentials\s*=\s*True\b|\bCORS_ALLOW_CREDENTIALS\s*=\s*True\b/;
const COOKIE_INSECURE = /\b(?:SESSION_COOKIE_SECURE|CSRF_COOKIE_SECURE|SESSION_COOKIE_HTTPONLY)\s*=\s*False\b|\bset_cookie\s*\([^)]*\b(?:secure|httponly)\s*=\s*False\b/i;
const CSRF_OFF = /@csrf_exempt\b|\bWTF_CSRF_ENABLED\s*=\s*False\b|\bcsrf\s*\.\s*exempt\b/;

export function createPythonRules() {
  function analyze({ file, language, sourceLines }) {
    if (language !== 'python') return [];
    const { lines, hasSource } = linesFor(file, sourceLines);
    const { found, report } = createReporter();

    for (const change of file.changes ?? []) {
      if (change.side !== 'added' || isCommentLine(change.text, LANGUAGE)) continue;
      const index = change.line - 1;
      const code = stripLineComment(change.text, LANGUAGE);
      if (!code.trim()) continue;

      // PY-601: eval/exec and shell=True / os.system with values that are not plain strings.
      for (const { args } of callsOn(lines, index, code, EVAL_CALL, LANGUAGE)) {
        if (args[0] && !isPlainLiteral(args[0])) {
          report('PY-601', change, 'eval or exec runs a value that is not a plain string; anything an attacker can influence becomes code. Use ast.literal_eval for data, or a lookup table');
        }
      }
      for (const { args, raw } of callsOn(lines, index, code, SUBPROCESS_CALL, LANGUAGE)) {
        if (raw.some((argument) => SHELL_TRUE.test(argument)) && args[0] && !isPlainLiteral(args[0])) {
          report('PY-601', change, 'subprocess runs with shell=True and a command built from a value that is not a plain string (command injection); pass a list of arguments with shell=False', REQUEST_INPUT.test(raw[0] ?? '') ? {} : LOWER);
        }
      }
      for (const { args, raw } of callsOn(lines, index, code, OS_SHELL, LANGUAGE)) {
        if (args[0] && !isPlainLiteral(args[0])) {
          report('PY-601', change, 'os.system or os.popen runs a command built from a value that is not a plain string (command injection); use subprocess with a list of arguments', REQUEST_INPUT.test(raw[0] ?? '') ? {} : LOWER);
        }
      }

      // PY-602: SQL built by string formatting.
      for (const pattern of [SQL_EXECUTE, TEXT_SQL]) {
        for (const { args, raw } of callsOn(lines, index, code, pattern, LANGUAGE)) {
          const query = args[0] ?? '';
          if (/"I"/.test(query) || (/"S"/.test(query) && /["S]\s*(?:\+|%)|\.format\b|\+\s*[\w(]/.test(query))) {
            if (SQL_WORDS.test(raw[0] ?? '') || /"I"/.test(query)) {
              report('PY-602', change, 'A SQL query is built by formatting or joining text into it (f-string, %, .format or +); pass values as parameters instead so they cannot change the query');
            }
          }
        }
      }

      // PY-603: template and HTML injection.
      for (const { args } of callsOn(lines, index, code, TEMPLATE_STRING, LANGUAGE)) {
        if (args[0] && !isPlainLiteral(args[0])) {
          report('PY-603', change, 'A template is built from a value that is not a plain string (server-side template injection); keep the template fixed and pass the value as a variable');
        }
      }
      if (MARK_SAFE.test(code)) {
        const argument = /(?:mark_safe|Markup)\s*\(([^)]*)/.exec(code)?.[1];
        if (argument === undefined || !isPlainLiteral(maskStrings(argument, LANGUAGE))) {
          report('PY-603', change, 'mark_safe, Markup or |safe tells the template engine not to escape this value; confirm it never holds user text', LOWER);
        }
      }
      if (AUTOESCAPE_OFF.test(code)) {
        report('PY-603', change, 'Template autoescaping is turned off, so any user text in a template can inject HTML and script; leave autoescape on');
      }

      // PY-604: debug mode and tracebacks sent to the client.
      if (DEBUG_ON.test(code)) {
        report('PY-604', change, 'Debug mode is on; Flask and Django then show stack traces and, in Flask, an interactive console to anyone who can reach the app. Turn it off outside local development', LOWER);
      }
      for (const { raw } of callsOn(lines, index, code, RUN_CALL, LANGUAGE)) {
        if (raw.some((argument) => /\bdebug\s*=\s*True\b/.test(argument))) {
          report('PY-604', change, 'app.run(debug=True) exposes the Werkzeug debugger, which can run code on the server; never enable it in production');
        } else if (raw.some((argument) => HOST_ALL.test(argument)) && raw.some((argument) => /\bdebug\s*=\s*(?!False)/.test(argument))) {
          report('PY-604', change, 'The app listens on all interfaces with debug options set; limit it to 127.0.0.1 or turn debug off', LOWER);
        }
      }
      if (hasSource && TRACEBACK_OUT.test(code) && RESPONSE_CALL.test(windowText(lines, index - 1, index + 1, LANGUAGE))) {
        report('PY-604', change, 'An exception message or traceback is sent back in the response, which leaks file paths and internals; log it and return a generic error', LOWER);
      }

      // PY-605: file paths and server-side requests from request input.
      for (const pattern of [PATH_SINK, PATH_JOIN]) {
        for (const { raw } of callsOn(lines, index, code, pattern, LANGUAGE)) {
          const text = raw.join(', ');
          if (REQUEST_INPUT.test(text) && !/\b(?:secure_filename|basename|safe_join)\s*\(/.test(text)) {
            report('PY-605', change, 'A file path is built from request input; "../" or an absolute path can reach files outside the intended folder. Use secure_filename or safe_join, or resolve the path and check it stays inside the base folder', pattern === PATH_JOIN ? LOWER : {});
          }
        }
      }
      for (const { raw } of callsOn(lines, index, code, REQUESTS_CALL, LANGUAGE)) {
        const target = raw[0] ?? '';
        if (REQUEST_INPUT.test(target) && !FIXED_HOST.test(target)) {
          report('PY-605', change, 'The server fetches a URL taken from request input (SSRF); allow only known hosts and block private and metadata addresses');
        }
      }

      // PY-606: auth done with assert, JWT checks off, CSRF off, wide-open CORS.
      if (ASSERT_AUTH.test(code)) {
        report('PY-606', change, 'An authorization check is written as assert; Python skips asserts when run with -O, so the check disappears. Raise PermissionError or return 403 instead');
      }
      if (JWT_VERIFY_OFF.test(code)) {
        report('PY-606', change, 'JWT verification is turned off or accepts the "none" algorithm, so anyone can forge a token; verify the signature with a fixed algorithm list');
      }
      if (hasSource && JWT_DECODE_UNVERIFIED.test(code) && !/\balgorithms\s*=/.test(windowText(lines, index, index + 3, LANGUAGE))) {
        report('PY-606', change, 'jwt.decode is called without an algorithms list; require the algorithm you sign with, and never accept "none"', LOWER);
      }
      if (CSRF_OFF.test(code)) {
        report('PY-606', change, 'CSRF protection is switched off for this view or app; keep it on for anything that changes data with a cookie session', LOWER);
      }
      if (CORS_ANY.test(code) || CORS_CREDENTIALS.test(code)) {
        const around = windowText(lines, index - 8, index + 8, LANGUAGE);
        if (CORS_ANY.test(around) && CORS_CREDENTIALS.test(around)) {
          report('PY-606', change, 'CORS allows any origin together with credentials, so any website can make authenticated requests as the user; list the trusted origins', {}, `PY-606:cors:${Math.max(1, index - 7)}`);
        }
      }
      if (COOKIE_INSECURE.test(code)) {
        report('PY-606', change, 'A session or CSRF cookie is set without Secure or HttpOnly; turn both on outside local development', LOWER);
      }

      // PY-607: mass assignment and archive extraction.
      for (const { raw } of callsOn(lines, index, code, MODEL_CALL, LANGUAGE)) {
        if (MASS_ASSIGN_ARGS.test(raw.join(', '))) {
          report('PY-607', change, 'A model is created or updated from a whole request dictionary (**data), so a client can set fields such as is_admin; pick the allowed fields or use a serializer with an explicit field list', LOWER);
        }
      }
      if (DRF_ALL_FIELDS.test(code) && /\bfields\s*=\s*['"]__all__['"]/.test(code)) {
        report('PY-607', change, 'A serializer or form exposes every model field ("__all__"), so clients can write fields such as is_staff; list the fields explicitly', LOWER);
      }
      if (hasSource && TAR_OPEN.test(windowText(lines, Math.max(0, index - 6), index, LANGUAGE)) && TARFILE_EXTRACT.test(code) && !/\bfilter\s*=/.test(code)) {
        report('PY-607', change, 'tarfile extraction without a filter lets archive entries write outside the target folder ("../" or links); pass filter="data" or check every member path', LOWER);
      }
      if (ZIPFILE_EXTRACT.test(code) && /\bzip/i.test(windowText(lines, Math.max(0, index - 6), index, LANGUAGE)) && REQUEST_INPUT.test(windowText(lines, Math.max(0, index - 6), index, LANGUAGE))) {
        report('PY-607', change, 'An uploaded zip is extracted without checking member names; "../" entries can write outside the target folder', LOWER);
      }

      // PY-608: unsafe deserialization.
      for (const { raw, match } of callsOn(lines, index, code, YAML_LOAD, LANGUAGE)) {
        const text = raw.join(', ');
        const name = /\.\s*(\w+)\s*\($/.exec(match[0])?.[1] ?? 'load';
        if (name === 'unsafe_load' || (name !== 'safe_load' && !/\bLoader\s*=\s*(?:yaml\s*\.\s*)?(?:Safe|CSafe)Loader\b|\bSafeLoader\b/.test(text))) {
          report('PY-608', change, `yaml.${name} can build arbitrary Python objects from the file; use yaml.safe_load`);
        }
      }
      for (const { raw } of callsOn(lines, index, code, PICKLE_LOAD, LANGUAGE)) {
        const lower = !REQUEST_INPUT.test(raw.join(', '));
        report('PY-608', change, 'pickle-style loading runs code embedded in the data; never load data that came from a user, a network or a shared location. Use JSON or a signed format', lower ? LOWER : {});
      }

      // PY-609: weak hashing, passwords and non-secure randomness.
      if (WEAK_HASH.test(code)) {
        const around = windowText(lines, index - 3, index + 3, LANGUAGE);
        const securityUse = SECURITY_CONTEXT.test(around);
        report('PY-609', change, 'MD5 and SHA-1 are broken for passwords, signatures and integrity checks; use SHA-256 or better, and bcrypt, scrypt or argon2 for passwords (fine for a non-security checksum)', securityUse ? {} : LOWER);
      }
      for (const { match } of callsOn(lines, index, code, RANDOM_CALL, LANGUAGE)) {
        const around = windowText(lines, index - 3, index + 3, LANGUAGE);
        if (RANDOM_SECURITY.test(around) && !/\bsecrets\b|\bSystemRandom\b/.test(around)) {
          report('PY-609', change, `${match[0].replace(/\s*\($/, '')} is predictable; for tokens, passwords, codes and session ids use the secrets module`, LOWER);
        }
      }
      if (ECB_MODE.test(code)) {
        report('PY-609', change, 'ECB mode encrypts equal blocks to equal output and leaks patterns; use AES-GCM');
      }
      if (SECRET_KEY_LITERAL.test(code) || FLASK_SECRET_BAD.test(code)) {
        report('PY-609', change, 'A signing key is written into the code, so anyone with the source can forge sessions and tokens; read it from the environment or a secret store', LOWER);
      }

      // PY-610: TLS verification off.
      if (VERIFY_OFF.test(code)) {
        report('PY-610', change, 'TLS certificate verification is turned off (verify=False, CERT_NONE or an unverified context); the connection can be intercepted. Trust the specific CA bundle instead');
      }

      // PY-611: unsafe URL schemes.
      if (URL_FETCH_BAD_SCHEME.test(code) && REQUEST_INPUT.test(windowText(lines, index - 2, index + 2, LANGUAGE))) {
        report('PY-611', change, 'A file:// URL can be fetched with request input nearby; restrict fetches to http and https', LOWER);
      }
    }
    return found;
  }

  return { analyze };
}
