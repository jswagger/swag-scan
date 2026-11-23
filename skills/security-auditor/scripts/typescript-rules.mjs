// TypeScript and JavaScript rules for the Security Auditor (SS-104). They run on changed `.ts`, `.tsx`, `.js`, `.jsx`,
// `.mjs` and `.cjs` files. Every rule is a lead for the model pass, not a verdict; context-dependent ones are lower
// confidence. Rules that read the lines around a change need the real file and are skipped when it cannot be read.

import {
  LOWER, callsOn, createReporter, isCommentLine, isPlainLiteral, linesFor, maskStrings,
  stripLineComment, windowText,
} from './rule-helpers.mjs';

const LANGUAGE = 'typescript';

const TLS_OFF = /\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED['"`\]]*\s*(?::|=(?!=))\s*['"`]?0\b/;

const DOM_ASSIGN = /\.\s*(?:innerHTML|outerHTML)\s*\+?=(?!=)\s*(.*)$/;
const DOM_CALLS = /(?<![\w$])(?:document\s*\.\s*(?:write|writeln)|[\w$.]+\s*\.\s*insertAdjacentHTML)\s*\(/;
const REACT_HTML = /\bdangerouslySetInnerHTML\b/;
const VUE_HTML = /\bv-html\b/;
const SANITIZED = /\b(?:sanitize\w*|DOMPurify|escapeHtml|escape|xss|encodeHTML|he\.encode)\b/i;
const TAINT_HINT = /\b(?:location|document\s*\.\s*(?:URL|cookie|referrer)|window\s*\.\s*name|URLSearchParams|searchParams|req|request|params|query|event\s*\.\s*data|e\s*\.\s*data)\b/;

const FUNCTION_CTOR = /(?<![\w$.])(?:new\s+)?Function\s*\(/;
const TIMER_CALL = /(?<![\w$.])(?:setTimeout|setInterval)\s*\(/;

const JWT_EXPIRY_OFF = /\bignoreExpiration\s*:\s*true\b/;
const JWT_NONE = /\balgorithms?\s*:\s*\[?[^\]\n]*['"`]none['"`]/i;
const JWT_DECODE = /(?<![\w$])(?:(?:jwt|jsonwebtoken|jose)\s*\.\s*decode|jwtDecode|jwt_decode|decodeJwt)\s*\(/;
const AUTH_USE = /\b(?:role|roles|isAdmin|admin|permissions?|scopes?|authorized|isAuthorized|userId|sub)\b/;

const COOKIE_HTTPONLY_OFF = /\bhttpOnly\s*:\s*false\b/;
const COOKIE_SECURE_OFF = /\bsecure\s*:\s*false\b/;
const CORS_ANY_ORIGIN = /\borigin\s*:\s*(?:['"`]\*['"`]|true\b)|Access-Control-Allow-Origin['"`]?\s*[,:]\s*['"`]\*['"`]/;
const CORS_CREDENTIALS = /\bcredentials\s*:\s*true\b|Access-Control-Allow-Credentials['"`]?\s*[,:]\s*['"`]?true/;

const REQUEST_INPUT = /\b(?:req|request)\s*\.\s*(?:params|query|body|headers|cookies|files?)\b|\bctx\s*\.\s*(?:params|query|request\s*\.\s*body)\b|\bevent\s*\.\s*(?:queryStringParameters|pathParameters|body)\b/;
const FS_CALL = /\b(?:fs(?:Promises)?|fsp|promises|fs\s*\.\s*promises)\s*\.\s*(?:readFile|writeFile|appendFile|createReadStream|createWriteStream|unlink|readdir|rm|rmdir|stat|access|open|copyFile|rename|mkdir)(?:Sync)?\s*\(/;
const SEND_FILE = /\b(?:res|response|reply)\s*\.\s*(?:sendFile|sendfile|download)\s*\(/;
const PATH_BUILD = /\bpath\s*\.\s*(?:join|resolve)\s*\(/;
const SSRF_CALL = /(?<![\w$.])(?:fetch|axios(?:\s*\.\s*(?:get|post|put|patch|delete|head|request))?|got(?:\s*\.\s*(?:get|post|put|patch|delete))?|needle|superagent(?:\s*\.\s*\w+)?|(?:https?|http2)\s*\.\s*(?:get|request))\s*\(/;
const FIXED_HOST = /^\s*[`'"]https?:\/\/[^/${}'"`\s]+/;

const WEAK_HASH_NAME = /^['"`](?:md5|md4|sha1|sha-1)['"`]$/i;
const CREATE_CIPHER = /(?<![\w$])createCipher\s*\(/;
const CREATE_HASH = /(?<![\w$])createHash\s*\(/;
const SUBTLE_SHA1 = /\bdigest\s*\(\s*['"`]SHA-1['"`]/i;

const PROTO_WRITE = /(?:\.\s*|\[\s*['"`])__proto__(?:['"`]\s*\])?\s*=(?!=)/;
const OBJECT_ASSIGN = /\bObject\s*\.\s*assign\s*\(/;
const DEEP_MERGE = /(?<![\w$])(?:(?:_|lodash|\$)\s*\.\s*(?:merge|mergeWith|defaultsDeep|set|setWith|zipObjectDeep|extend)|deepmerge|deepMerge|mergeDeep|defaultsDeep|deepExtend|merge|extend)\s*\(/;
const REQUEST_DATA = /\b(?:req|request)\s*\.\s*(?:body|query|params)\b|\bctx\s*\.\s*request\s*\.\s*body\b/;

const WHERE_OPERATOR = /['"`]?\$where['"`]?\s*:/;
const MONGO_QUERY = /\.\s*(?:find|findOne|findOneAndUpdate|findOneAndDelete|updateOne|updateMany|deleteOne|deleteMany|countDocuments|aggregate)\s*\(/;
const WHOLE_REQUEST_OBJECT = /^(?:\{\s*\.\.\.\s*)?(?:req|request)\s*\.\s*(?:body|query|params)\s*\}?$/;
const FIELD_FROM_REQUEST = /:\s*(?:req|request)\s*\.\s*(?:body|query)\s*\.\s*[\w$]+\s*(?:[,}]|$)/;

export function createTypeScriptRules() {
  function analyze({ file, language, sourceLines }) {
    if (language !== 'typescript' && language !== 'javascript') return [];
    const { lines, hasSource } = linesFor(file, sourceLines);
    const { found, report } = createReporter();

    for (const change of file.changes ?? []) {
      if (change.side !== 'added' || isCommentLine(change.text, LANGUAGE)) continue;
      const index = change.line - 1;
      const code = stripLineComment(change.text, LANGUAGE);
      if (!code.trim()) continue;

      // TS-601: TLS verification off.
      if (TLS_OFF.test(code)) {
        report('TS-601', change, 'TLS certificate verification is turned off (rejectUnauthorized: false or NODE_TLS_REJECT_UNAUTHORIZED=0); the connection can be intercepted. Trust the specific CA instead');
      }

      // TS-602: DOM and HTML sinks.
      const assign = DOM_ASSIGN.exec(code);
      if (assign) {
        const right = maskStrings(assign[1].replace(/;\s*$/, ''), LANGUAGE).trim();
        if (right && !isPlainLiteral(right) && !SANITIZED.test(right)) {
          report('TS-602', change, 'innerHTML or outerHTML is assigned a value that is not a plain string; use textContent, or sanitize the HTML first', TAINT_HINT.test(assign[1]) ? {} : LOWER);
        }
      }
      for (const { match, raw, args } of callsOn(lines, index, code, DOM_CALLS, LANGUAGE)) {
        const argument = /insertAdjacentHTML/.test(match[0]) ? args[1] : args[0];
        const rawArgument = /insertAdjacentHTML/.test(match[0]) ? raw[1] : raw[0];
        if (argument && !isPlainLiteral(argument) && !SANITIZED.test(argument)) {
          report('TS-602', change, `${/insertAdjacentHTML/.test(match[0]) ? 'insertAdjacentHTML' : 'document.write'} is given a value that is not a plain string; use DOM methods or sanitize the HTML first`, TAINT_HINT.test(rawArgument ?? '') ? {} : LOWER);
        }
      }
      if (REACT_HTML.test(code)) {
        const around = windowText(lines, index, index + 2, LANGUAGE).replace(/\s+/g, ' ');
        const html = /__html\s*:\s*([^}]*)/.exec(around)?.[1]?.trim();
        const masked = html === undefined ? undefined : maskStrings(html, LANGUAGE);
        if (masked === undefined || (!isPlainLiteral(masked) && !SANITIZED.test(masked))) {
          report('TS-602', change, 'dangerouslySetInnerHTML renders its value as HTML; confirm it is sanitized (for example with DOMPurify) and never holds user or API text', LOWER);
        }
      }
      if (VUE_HTML.test(code)) {
        report('TS-602', change, 'v-html renders its value as HTML; confirm it is sanitized and never holds user or API text', LOWER);
      }

      // TS-603: dynamic code.
      for (const { args } of callsOn(lines, index, code, FUNCTION_CTOR, LANGUAGE)) {
        if (!args.every((argument) => isPlainLiteral(argument))) {
          report('TS-603', change, 'new Function builds code from a value that is not a plain string, which is the same risk as eval; use a lookup table or a real function');
        }
      }
      for (const { args } of callsOn(lines, index, code, TIMER_CALL, LANGUAGE)) {
        if (args[0] && /^"[SI]"/.test(args[0])) {
          report('TS-603', change, 'setTimeout or setInterval is given a string, which runs through eval; pass a function instead');
        }
      }

      // TS-604: JWT checks.
      if (JWT_EXPIRY_OFF.test(code)) {
        report('TS-604', change, 'jwt.verify is told to ignore expiration, so a stolen token works forever; remove ignoreExpiration');
      }
      if (JWT_NONE.test(code)) {
        report('TS-604', change, 'The accepted JWT algorithms include "none", which allows unsigned tokens; list only the algorithms you sign with');
      }
      if (hasSource && JWT_DECODE.test(code)) {
        const used = windowText(lines, index, index + 6, LANGUAGE);
        if (AUTH_USE.test(used)) {
          report('TS-604', change, 'jwt.decode does not check the signature, and the result is read for a role, scope or user id nearby; use jwt.verify before any authorization decision', LOWER);
        }
      }

      // TS-605: cookies and CORS.
      if (COOKIE_HTTPONLY_OFF.test(code)) {
        report('TS-605', change, 'Cookie has httpOnly: false, so page scripts (and any XSS) can read it; set httpOnly: true for session cookies');
      }
      if (COOKIE_SECURE_OFF.test(code)) {
        report('TS-605', change, 'Cookie has secure: false, so it is also sent over plain HTTP; set secure: true outside local development', LOWER);
      }
      if (hasSource && (CORS_ANY_ORIGIN.test(code) || CORS_CREDENTIALS.test(code))) {
        const from = Math.max(0, index - 8);
        const around = lines.slice(from, index + 9);
        const anchor = around.findIndex((text) => CORS_ANY_ORIGIN.test(stripLineComment(text, LANGUAGE)));
        if (anchor !== -1 && around.some((text) => CORS_CREDENTIALS.test(stripLineComment(text, LANGUAGE)))) {
          report('TS-605', change, 'CORS allows any origin (origin: "*" or true) together with credentials, so any website can make authenticated requests as the user; list the trusted origins', {}, `TS-605:cors:${from + anchor + 1}`);
        }
      }

      // TS-606: file paths built from request input. TS-607: server-side requests to a URL from request input.
      for (const [pattern, lower] of [[FS_CALL, false], [SEND_FILE, false], [PATH_BUILD, true]]) {
        for (const { raw } of callsOn(lines, index, code, pattern, LANGUAGE)) {
          const text = raw.join(', ');
          if (REQUEST_INPUT.test(text) && !/\bpath\s*\.\s*basename\s*\(/.test(text)) {
            report('TS-606', change, 'A file path is built from request input; "../" can reach files outside the intended folder. Resolve the path and check it stays inside the base folder, or use path.basename', lower ? LOWER : {});
          }
        }
      }
      for (const { raw } of callsOn(lines, index, code, SSRF_CALL, LANGUAGE)) {
        const target = raw[0] ?? '';
        if (REQUEST_INPUT.test(target) && !FIXED_HOST.test(target)) {
          report('TS-607', change, 'The server fetches a URL taken from request input (SSRF); allow only known hosts and block private and metadata addresses');
        }
      }

      // TS-608: weak crypto.
      if (CREATE_CIPHER.test(code)) {
        report('TS-608', change, 'createCipher derives the key and IV from a password with no random IV and was removed in recent Node versions; use createCipheriv with AES-GCM');
      }
      for (const { raw } of callsOn(lines, index, code, CREATE_HASH, LANGUAGE)) {
        if (WEAK_HASH_NAME.test(raw[0] ?? '')) {
          report('TS-608', change, 'MD5 and SHA-1 are broken for passwords, signatures and integrity checks; use SHA-256 or better, and a password hasher for passwords (fine for a non-security checksum)', LOWER);
        }
      }
      if (SUBTLE_SHA1.test(code)) {
        report('TS-608', change, 'SHA-1 is broken for signatures and integrity checks; use SHA-256 or better', LOWER);
      }

      // TS-609: prototype pollution and mass assignment.
      if (PROTO_WRITE.test(code)) {
        report('TS-609', change, 'Writing to __proto__ can change every object in the process (prototype pollution); use Object.create(null) or a Map');
      }
      for (const { raw } of callsOn(lines, index, code, DEEP_MERGE, LANGUAGE)) {
        if (REQUEST_DATA.test(raw.join(', '))) {
          report('TS-609', change, 'Request data is deep-merged into an object, which can set __proto__ or constructor.prototype (prototype pollution); copy only the fields you expect', LOWER);
        }
      }
      for (const { raw } of callsOn(lines, index, code, OBJECT_ASSIGN, LANGUAGE)) {
        if (REQUEST_DATA.test(raw.join(', '))) {
          report('TS-609', change, 'Request data is copied onto an object with Object.assign; pick the allowed fields so a client cannot set others (mass assignment)', LOWER);
        }
      }

      // TS-610: NoSQL injection.
      if (WHERE_OPERATOR.test(code)) {
        report('TS-610', change, '$where runs JavaScript inside the database; replace it with normal query operators and never put request data in it');
      }
      for (const { raw } of callsOn(lines, index, code, MONGO_QUERY, LANGUAGE)) {
        const first = raw[0] ?? '';
        if (WHOLE_REQUEST_OBJECT.test(first)) {
          report('TS-610', change, 'A query is built straight from the request body, query or params, so a client can send operators such as {"$ne": null}; pick the fields and check their types');
        } else if (FIELD_FROM_REQUEST.test(first) && !/\bString\s*\(|\.toString\s*\(|\bz\.|\bjoi\b/i.test(first)) {
          report('TS-610', change, 'A query field takes a value straight from the request; if it is an object such as {"$ne": null} it becomes an operator. Convert with String() or validate the type', LOWER);
        }
      }
    }
    return found;
  }

  return { analyze };
}

