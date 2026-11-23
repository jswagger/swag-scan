#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { renderCoverageLine, summarizeCoverage } from '../../review-tools-common/coverage.mjs';
import { createFileFilters } from '../../review-tools-common/file-filters.mjs';
import { createCSharpRules } from './csharp-rules.mjs';
import { createTypeScriptRules } from './typescript-rules.mjs';
import { createPythonRules } from './python-rules.mjs';
import { createSupplyChainRules } from './supply-chain-rules.mjs';
import { createSecretsRules } from './secrets-rules.mjs';
import { createAccessAndErrorRules } from './access-and-error-rules.mjs';
import { createDataAndLlmRules } from './data-and-llm-rules.mjs';
import { logicalStatements, looksLikeSql } from './statements.mjs';

// `--config <file>` points the scanner at another config (the same shape as config.json); the default is the one next to this skill.
const configFlag = process.argv.indexOf('--config');
const configPath = configFlag !== -1 && process.argv[configFlag + 1]
  ? process.argv[configFlag + 1]
  : new URL('../config.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { isExcluded, isTestFile, isReadOnlyPath, isPromptFile } = createFileFilters(config.scan);
const dataAndLlm = createDataAndLlmRules(config.scan);
const csharpRules = createCSharpRules(config.scan);
const typescriptRules = createTypeScriptRules();
const pythonRules = createPythonRules();
const supplyChainRules = createSupplyChainRules();
const secretsRules = createSecretsRules();
const accessAndErrorRules = createAccessAndErrorRules();

function languageForPath(path) {
  if (/\.py$/i.test(path)) return 'python';
  if (/\.(?:cs|cshtml|razor)$/i.test(path)) return 'csharp';
  if (/\.(?:[cm]?ts|tsx)$/i.test(path)) return 'typescript';
  if (/\.(?:[cm]?js|jsx)$/i.test(path)) return 'javascript';
  return undefined;
}

const readOnlyConfig = config.scan?.readOnlyPaths;
const configuredReadOnlyPaths = Array.isArray(readOnlyConfig)
  ? readOnlyConfig.filter((entry) => typeof entry === 'string' && entry.trim())
  : [];
const readOnlyWarning = readOnlyConfig === undefined || (Array.isArray(readOnlyConfig) && configuredReadOnlyPaths.length === readOnlyConfig.length)
  ? undefined
  : 'scan.readOnlyPaths must be a list of glob strings; entries that are not strings were ignored.';

const input = await new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});

const SENSITIVE_ARGUMENT_WORDS = new Set(['request', 'req', 'body', 'payload', 'user', 'password', 'passwd', 'token', 'secret', 'credit', 'ssn']);
const LOG_CALL = /\b(?:console\.(?:log|info|debug)|logging\.(?:debug|info|warning|warn|error|exception|critical)|(?:logger|log)\.(?:info|debug|warn|warning|error|exception|critical))\s*\(/;

/** CRIT-303 looks at what is logged, not at the message text: a word inside a plain string, or a caught exception, is not a lead. */
function loggedArgumentsAreSensitive(text) {
  const call = text.match(LOG_CALL);
  if (!call) return false;
  const argumentsText = text.slice(call.index + call[0].length).replace(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, (whole, quote, body, offset, all) => {
    const prefix = all[offset - 1];
    const interpolated = quote === '`' || prefix === 'f' || prefix === 'F' || prefix === '$';
    if (!interpolated) return ' ';
    return ` ${[...body.matchAll(/\$\{([^}]*)\}|\{([^{}]+)\}/g)].map((match) => match[1] ?? match[2]).join(' ')} `;
  });
  return (argumentsText.match(/[A-Za-z_$][\w$]*/g) ?? []).some((identifier) =>
    (identifier.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []).some((word) => SENSITIVE_ARGUMENT_WORDS.has(word.toLowerCase())));
}

const rules = [
  {
    id: 'CRIT-101',
    family: 'Injection (SQL, command, HTML)',
    description: 'Dynamic string construction near a query, command, or HTML sink',
    pattern: /\b(?:SELECT(?!\s*\()|INSERT|UPDATE|DELETE|WHERE|ORDER\s+BY|EXEC(?:UTE)?)\b.*(?:\$\{|\+\s*[\w$]|\.format\s*\(|\{[^}]+\})|(?:exec|spawn|innerHTML|outerHTML)\s*\(.*(?:\$\{|\+\s*[\w$])/i,
  },
  {
    id: 'CRIT-102',
    family: 'Input validation',
    description: 'Possible blacklist-style input filtering',
    pattern: /\.(?:replace|replaceAll)\s*\(\s*(?:(['"`])(?:\\.|(?!\1)[^\\])*?(?:<|>|&|(?!\1)["']|\\["']|\\x3[cCeE]|\\x26|\\x22|\\x27)(?:\\.|(?!\1)[^\\])*?\1|\/(?:\\.|[^/\n])*?(?:<|>|&|"|'|\\x3[cCeE]|\\x26|\\x22|\\x27)(?:\\.|[^/\n])*?\/[gimsuy]*)/,
  },
  {
    id: 'CRIT-201',
    family: 'Secrets',
    description: 'Possible hard-coded credential or secret assignment',
    pattern: /(?<![\w$.-])["']?[\w$.-]*(?:api[_-]?key|access[_-]?key|secret|password|passwd|token|credential|private[_-]?key|jwt[_-]?secret)(?:[_-]?(?:(?:access[_-]?)?key|value|string|token|secret|phrase))?["']?\s*[:=]\s*(?:[^;\n]*?\bor\s*)?(["'`])[^\n"'`]+\1|\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?|ftp|sftp|https?):\/\/[^/\s:@]+:[^/\s@]+@/i,
    redact: true,
  },
  {
    id: 'CRIT-202',
    family: 'Cryptography and randomness',
    description: 'Predictable random source near a security-sensitive identifier',
    pattern: /(?=.*(?:token|secret|session|nonce|password|credential|csrf|api[_-]?key|private[_-]?key|reset[_-]?code|verification[_-]?code|\b(?:auth|otp|salt)\b|(?<![a-z])key(?![a-z])))(?=.*(?:\bMath\.random|\brandom\.(?:random|choice)|\buuid\.uuid1|\brand\s*\(|\bnew\s+Random\s*\())/i,
    stackSensitive: true,
  },
  {
    id: 'CRIT-203',
    family: 'Cryptography and randomness',
    description: 'Possible unauthenticated CBC encryption usage',
    pattern: /\b(?:aes[-_]?\d+-cbc|createCipheriv\s*\(\s*['"`]aes-\d+-cbc|modes\.CBC\s*\(|AES\.MODE_CBC\b|MODE_CBC\b)/i,
    stackSensitive: true,
  },
  {
    id: 'CRIT-301',
    family: 'Error handling and logging',
    description: 'Possible empty catch block or swallowed exception',
    pattern: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}|\bexcept(?:\s+[^:]+)?\s*:\s*pass\b/i,
  },
  {
    id: 'CRIT-302',
    family: 'Error handling and logging',
    description: 'Raw exception detail may be returned or rendered to users',
    pattern: /\b(?:error|err|exception)\.(?:stack|message)\b.*(?:res\.|response|return|render|send|json|toast|innerHTML)|(?:res\.|response|return|render|send|json|toast|innerHTML).*\b(?:error|err|exception)\.(?:stack|message)\b|(?:return|jsonify|HTTPException|detail\s*=)[^#\n]*(?:str|repr)\s*\(\s*(?:e|exc|err|exception)\b|(?:str|repr)\s*\(\s*(?:e|exc|err|exception)\b[^#\n]*(?:response|return|jsonify|HTTPException|detail\s*=)/i,
  },
  {
    id: 'CRIT-303',
    family: 'Error handling and logging',
    description: 'Possible logging of request or sensitive data',
    pattern: /\b(?:console\.(?:log|info|debug)|logging\.(?:debug|info|warning|warn|error|exception|critical)|(?:logger|log)\.(?:info|debug|warn|warning|error|exception|critical))\s*\(/,
    check: (text) => loggedArgumentsAreSensitive(text),
  },
  {
    id: 'CRIT-104',
    family: 'Code and command execution',
    description: 'Possible shell command execution with shell enabled or os.system',
    pattern: /\b(?:subprocess\.(?:run|Popen|call|check_call|check_output)|Popen)\s*\(.*\bshell\s*=\s*True\b|\bos\.system\s*\(/i,
    languages: ['python'],
  },
  {
    id: 'CRIT-105',
    family: 'Code and command execution',
    description: 'Dynamic code evaluation with eval or exec',
    pattern: /(?<![.\w$])(?<!\bdef\s)(?<!\bfunction\s)(?:eval|exec)\s*\(|\b(?:window|globalThis|self)\s*\.\s*eval\s*\(|\b(?:child_process|childProcess|cp)\s*\.\s*exec(?:Sync)?\s*\(/,
    languages: ['python', 'javascript', 'typescript'],
  },
  {
    id: 'CRIT-106',
    family: 'Unsafe deserialization',
    description: 'Potentially unsafe pickle or YAML deserialization',
    pattern: /\bpickle\.(?:load|loads)\s*\(|\byaml\.load\s*\(/i,
    languages: ['python'],
  },
  {
    id: 'CRIT-107',
    family: 'TLS verification',
    description: 'TLS certificate verification is disabled',
    pattern: /\bverify\s*=\s*False\b/i,
    languages: ['python'],
  },
  {
    id: 'CRIT-108',
    family: 'Unsafe deserialization',
    description: 'Use of an unsafe .NET formatter (BinaryFormatter, NetDataContractSerializer, LosFormatter, SoapFormatter or ObjectStateFormatter) that can run attacker-chosen types',
    pattern: /\b(?:BinaryFormatter|NetDataContractSerializer|LosFormatter|SoapFormatter|ObjectStateFormatter)\b/,
    languages: ['csharp'],
  },
  {
    id: 'CRIT-109',
    family: 'Unsafe deserialization',
    description: 'Newtonsoft.Json TypeNameHandling (All, Auto, Objects or Arrays) may enable unsafe polymorphic deserialization',
    pattern: /\bTypeNameHandling\s*\.\s*(?:All|Auto|Objects|Arrays)\b/,
    languages: ['csharp'],
  },
  {
    id: 'CRIT-110',
    family: 'Authorization',
    description: 'AllowAnonymous disables authorization on the annotated endpoint',
    pattern: /\[\s*AllowAnonymous\s*\]/,
    languages: ['csharp'],
  },
  {
    id: 'CRIT-111',
    family: 'TLS verification',
    description: 'Server certificate validation callback or DangerousAcceptAnyServerCertificateValidator may bypass TLS certificate checks',
    pattern: /\bServerCertificate(?:Custom)?ValidationCallback\b|\bDangerousAcceptAnyServerCertificateValidator\b/,
    languages: ['csharp'],
  },
  {
    id: 'CRIT-112',
    family: 'Code and command execution',
    description: 'Process.Start launches an operating-system process; verify arguments and trust boundaries',
    pattern: /\bProcess\s*\.\s*Start\s*\(/,
    languages: ['csharp'],
  },
  {
    id: 'ARCH-403',
    family: 'Infrastructure and permissions',
    description: 'Possible wildcard or administrator-level permission',
    pattern: /\b(?:role|permission|scope|policy|grant|action|resource)\b.{0,80}(?:['"`]\*['"`]|\b(?:db_owner|root|administrator|admin)\b)|(?:['"`]\*['"`]|\b(?:db_owner|root|administrator|admin)\b).{0,80}\b(?:role|permission|scope|policy|grant|action|resource)\b/i,
    stackSensitive: true,
  },
  {
    id: 'ARCH-404',
    family: 'Authorization',
    description: 'Possible fail-open authorization or validation path',
    pattern: /(?:auth|authori[sz]|validat).*(?:failed|error|timeout).*(?:proceed|continue|allow|permit)|(?:proceed|continue|allow|permit).*(?:auth|authori[sz]|validat).*(?:failed|error|timeout)/i,
  },
  {
    id: 'ARCH-405',
    family: 'Infrastructure and permissions',
    description: 'Infrastructure rule may expose a service to all IPv4 or IPv6 addresses',
    pattern: /\b0\.0\.0\.0\/0\b|::\/0\b/,
  },
  {
    id: 'ARCH-406',
    family: 'Infrastructure and permissions',
    description: 'Cloud resource or storage configuration may allow public access',
    pattern: /\bpublicly_accessible\s*[:=]\s*true\b|\bpublic[-_]read\b|\b(?:block_public_acls|block_public_policy|restrict_public_buckets)\s*[:=]\s*false\b/i,
  },
  {
    id: 'ARCH-407',
    family: 'Infrastructure and permissions',
    description: 'Container or workload configuration may grant privileged execution',
    pattern: /\bprivileged\s*:\s*true\b|\ballowPrivilegeEscalation\s*:\s*true\b|\b(?:runAsUser|user)\s*:\s*0\b|^\s*USER\s+root\b/i,
  },
  {
    id: 'ARCH-408',
    family: 'Infrastructure and permissions',
    description: 'Infrastructure configuration may disable encryption at rest',
    pattern: /\b(?:encrypt(?:ion)?_enabled|storage_encrypted|encrypted)\s*[:=]\s*(?:false|0)\b/i,
  },
];

const removedControlPattern = /\b(?:auth(?:entication|orization)?|authori[sz](?:e|ation)|validat(?:e|ion)|permission|sanitize|sanitise|escape|csrf|access[_\s-]?control|require[_\s-]?role)(?:\b|(?=[_-]))/i;
const infrastructurePathPattern = /(?:^|\/)(?:infra(?:structure)?|terraform|k8s|kubernetes|helm|deploy|\.github\/workflows)(?:\/|$)|(?:^|\/)(?:dockerfile|docker-compose(?:\.[^/]*)?)$|\.(?:tf|tfvars|hcl|ya?ml|dockerfile|jsonnet)$/i;

let report;
try {
  report = JSON.parse(input);
  if (!report || !Array.isArray(report.files)) {
    throw new Error('Expected a JSON object with a files array.');
  }
} catch (error) {
  process.stderr.write(`Invalid diff JSON: ${error.message}\n`);
  process.exit(1);
}

const candidates = [];
const candidateKeys = new Set();
const scannedFiles = [];
const readOnlyFiles = [];

function addCandidate(candidate) {
  const key = `${candidate.ruleId}:${candidate.path}:${candidate.line}:${candidate.side ?? 'added'}`;
  if (candidateKeys.has(key)) return;
  candidateKeys.add(key);
  candidates.push(candidate);
}

const CONFIG_FILE_PATTERN = /\.(?:tf|tfvars|hcl|ya?ml|json|toml|ini|cfg|conf|properties|bicep|sql|env|xml|config)$/i;

/** When the file cannot be read, rebuild statements from the runs of consecutive added lines in the diff. */
function statementsFromDiff(file, language) {
  const added = (file.changes ?? []).filter((change) => change.side === 'added').sort((a, b) => a.line - b.line);
  const result = [];
  let block = [];
  const flushBlock = () => {
    if (block.length === 0) return;
    const offset = block[0].line - 1;
    for (const statement of logicalStatements(block.map((change) => change.text), language)) {
      result.push({ ...statement, firstLine: statement.firstLine + offset, lastLine: statement.lastLine + offset });
    }
    block = [];
  };
  for (const change of added) {
    if (block.length && change.line !== block.at(-1).line + 1) flushBlock();
    block.push(change);
  }
  flushBlock();
  return result;
}

function readSourceLines(file) {
  try {
    return readFileSync(file.path, 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

function findPythonSqlFstringLines(file, sourceLines) {
  if (!sourceLines || !file.path.endsWith('.py')) return [];

  const source = sourceLines.join('\n');
  const stringPattern = /(?:^|[^\w])(?:fr|rf|f)("""|'''|"|')([\s\S]*?)\1/gim;
  const strings = [];
  for (const match of source.matchAll(stringPattern)) {
    const body = match[2];
    if (!/\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER\s+BY)\b/i.test(body) || !/\{[^{}]+\}/.test(body)) {
      continue;
    }

    const bodyStart = match.index + match[0].indexOf(body);
    const firstLine = source.slice(0, bodyStart).split('\n').length;
    const lastLine = firstLine + body.split('\n').length - 1;
    const changedLines = (file.changes ?? [])
      .filter((change) => change.side === 'added' && change.line >= firstLine && change.line <= lastLine)
      .map((change) => change.line);
    if (changedLines.length > 0) strings.push({ line: changedLines[0], firstLine, lastLine });
  }
  return strings;
}

function findCSharpSqlLines(file, sourceLines) {
  if (!sourceLines || languageForPath(file.path) !== 'csharp') return [];

  return (file.changes ?? [])
    .filter((change) => change.side === 'added')
    .filter((change) => {
      const context = sourceLines.slice(Math.max(0, change.line - 5), change.line + 4).join('\n');
      const line = sourceLines[change.line - 1] ?? change.text;
      const hasQuerySink = /\b(?:SqlCommand|Query)\s*\(/i.test(context);
      const hasSql = /\b(?:SELECT(?!\s*\()\s+(?:\*|\w)|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|WHERE\s+\w+)\b/i.test(context);
      const hasSqlOnLine = /\b(?:SELECT(?!\s*\()\s+(?:\*|\w)|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|WHERE\s+\w+)\b/i.test(line);
      const hasInterpolationOnLine = /(?:\$@?"|@\$")/.test(line);
      const hasConcatenationOnLine = /(?:["'][^\n"']*["']\s*\+\s*\w+|\w+\s*\+\s*["'])/.test(line);
      return hasQuerySink && hasSql && (hasSqlOnLine || hasInterpolationOnLine || hasConcatenationOnLine);
    })
    .map((change) => change.line);
}

function isSwallowedPythonException(file, change, sourceLines) {
  if (!file.path.endsWith('.py')) return false;
  const line = sourceLines?.[change.line - 1] ?? change.text;
  const header = line.match(/^(\s*)except(?:\s+[^:]+)?\s*:\s*(.*)$/);
  if (!header) return false;
  if (/^pass\b/.test(header[2].trim())) return true;

  const addedChanges = (file.changes ?? []).filter((item) => item.side === 'added');
  const lines = sourceLines ?? addedChanges
    .map((item) => item.text);
  const startIndex = sourceLines ? change.line - 1 : addedChanges.findIndex((item) => item.line === change.line);
  if (startIndex < 0) return false;
  const indentation = header[1].length;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const nextLine = lines[index];
    if (!nextLine.trim() || nextLine.trimStart().startsWith('#')) continue;
    const nextIndentation = nextLine.length - nextLine.trimStart().length;
    if (nextIndentation <= indentation) return false;
    return /^\s*pass\s*(?:#.*)?$/.test(nextLine);
  }
  return false;
}

function isSafeYamlLoad(file, change, sourceLines) {
  if (!/\byaml\.load\s*\(/i.test(change.text)) return false;
  const context = sourceLines
    ? sourceLines.slice(change.line - 1, change.line + 3).join('\n')
    : change.text;
  return /\b(?:C)?SafeLoader\b/.test(context);
}

function addStatementCandidates(file, language, statements, testFile) {
  const addedLines = (file.changes ?? []).filter((change) => change.side === 'added').map((change) => change.line);
  const lowerForTests = testFile && config.scan?.testFiles?.mode === 'lower-confidence';
  for (const statement of statements) {
    const changedLine = addedLines.find((line) => line >= statement.firstLine && line <= statement.lastLine);
    if (changedLine === undefined || statement.lastLine === statement.firstLine) continue;
    const alreadyReported = (ruleId) => candidates.some((candidate) =>
      candidate.ruleId === ruleId && candidate.path === file.path && candidate.side !== 'removed'
      && candidate.line >= statement.firstLine && candidate.line <= statement.lastLine);

    if (language === 'python' && !alreadyReported('CRIT-104')
      && /\b(?:subprocess\.(?:run|Popen|call|check_call|check_output)|Popen)\s*\([\s\S]*?\bshell\s*=\s*True\b/.test(statement.skeleton)) {
      addCandidate({
        ruleId: 'CRIT-104',
        path: file.path,
        line: changedLine,
        description: 'Possible shell command execution with shell enabled (call spans several lines)',
        evidence: statement.text.slice(0, 240),
        ...(lowerForTests ? { confidence: 'lower' } : {}),
      });
    }

    // The splitter keeps a whole C# class body in one statement, which is not "SQL built from pieces"; C# SQL is checked line by line.
    const classBody = language === 'csharp' && /\b(?:namespace|class|struct|record|interface)\s+\w+|\)\s*\{[^}]*;/.test(statement.skeleton);
    if (!classBody && !alreadyReported('CRIT-101') && statement.dynamic && looksLikeSql(statement.sql)) {
      addCandidate({
        ruleId: 'CRIT-101',
        path: file.path,
        line: changedLine,
        description: 'SQL built from several pieces across lines; confirm every value is passed as a parameter, not joined into the text',
        evidence: statement.text.slice(0, 240),
        confidence: 'lower',
      });
    }
  }
}

for (const file of report.files) {
  if (isExcluded(file.path)) continue;
  const testFile = isTestFile(file.path);
  if (testFile && config.scan?.testFiles?.mode === 'skip') continue;
  scannedFiles.push(file);
  if (isReadOnlyPath(file.path)) readOnlyFiles.push(file.path);
  const language = languageForPath(file.path);
  const sourceLines = language || CONFIG_FILE_PATTERN.test(file.path) ? readSourceLines(file) : undefined;
  const statements = !language ? [] : (sourceLines ? logicalStatements(sourceLines, language) : statementsFromDiff(file, language));
  const promptFile = isPromptFile(file.path) || dataAndLlm.isPromptByContent({ file, sourceLines });
  const pythonSqlFstrings = findPythonSqlFstringLines(file, sourceLines);
  const csharpSqlLines = new Set(findCSharpSqlLines(file, sourceLines));
  const pythonSqlFstringLines = new Set(pythonSqlFstrings.flatMap((string) =>
    (file.changes ?? [])
      .filter((change) => change.side === 'added' && change.line >= string.firstLine && change.line <= string.lastLine)
      .map((change) => change.line)));

  for (const change of file.changes ?? []) {
    if (change.side === 'removed') {
      const match = change.text.match(removedControlPattern);
      const guardrail = promptFile ? dataAndLlm.guardrailRemoval({ change }) : undefined;
      if (!match && !guardrail) continue;
      addCandidate({
        ruleId: 'REG-401',
        path: file.path,
        line: change.line,
        side: 'removed',
        ...(guardrail ? { severity: 'suspicious' } : {}),
        description: guardrail ?? `Removed line contains security-control term "${match[0]}"; verify it was replaced or intentionally removed`,
        evidence: '[removed control line omitted from evidence]',
        ...(testFile && config.scan?.testFiles?.mode === 'lower-confidence'
          ? { confidence: 'lower' }
          : {}),
      });
      continue;
    }
    if (change.side !== 'added') continue;

    for (const rule of rules) {
      if (rule.languages && !rule.languages.includes(language)) continue;
      if (rule.id === 'CRIT-101' && language === 'csharp') continue;
      if (rule.id === 'CRIT-101' && pythonSqlFstringLines.has(change.line)) continue;
      if (rule.id === 'CRIT-106' && isSafeYamlLoad(file, change, sourceLines)) continue;
      if (!rule.pattern.test(change.text)) continue;
      if (rule.check && !rule.check(change.text)) continue;
      addCandidate({
        ruleId: rule.id,
        path: file.path,
        line: change.line,
        description: rule.description,
        evidence: rule.redact ? '[possible secret value omitted]' : change.text.trim().slice(0, 240),
        ...(rule.id.startsWith('ARCH-4') && infrastructurePathPattern.test(file.path)
          ? { context: 'infrastructure' }
          : {}),
        ...(testFile && config.scan?.testFiles?.mode === 'lower-confidence'
          ? { confidence: 'lower' }
          : {}),
        ...(config.scan?.projectStack === 'frontend' && rule.stackSensitive
          ? { reviewPriority: 'lower' }
          : {}),
      });
    }

    if (csharpSqlLines.has(change.line)) {
      addCandidate({
        ruleId: 'CRIT-101',
        path: file.path,
        line: change.line,
        description: 'Possible dynamically constructed SQL near SqlCommand or Query; confirm values are passed as parameters',
        evidence: change.text.trim().slice(0, 240),
        confidence: 'lower',
      });
    }

    if (isSwallowedPythonException(file, change, sourceLines)) {
      addCandidate({
        ruleId: 'CRIT-301',
        path: file.path,
        line: change.line,
        description: 'Python exception handler silently discards the exception with pass',
        evidence: change.text.trim().slice(0, 240),
        ...(testFile && config.scan?.testFiles?.mode === 'lower-confidence'
          ? { confidence: 'lower' }
          : {}),
      });
    }

    for (const string of pythonSqlFstrings) {
      const stringEvidence = sourceLines.slice(string.firstLine - 1, string.lastLine).join('\n');
      addCandidate({
        ruleId: 'CRIT-101',
        path: file.path,
        line: string.line,
        description: 'Potential SQL f-string construction; inspect whether interpolations are fixed SQL structure or placeholders, and confirm values are separately bound',
        evidence: stringEvidence.trim().slice(0, 240),
        confidence: 'lower',
      });
    }
  }

  addStatementCandidates(file, language, statements, testFile);

  for (const rules of [csharpRules, typescriptRules, pythonRules, accessAndErrorRules, supplyChainRules, secretsRules]) {
    for (const found of rules.analyze({ file, language, sourceLines })) {
      addCandidate({
        ...found,
        path: file.path,
        ...(testFile && config.scan?.testFiles?.mode === 'lower-confidence' ? { confidence: 'lower' } : {}),
      });
    }
  }

  const llmContext = Boolean(language) && dataAndLlm.llmContext(file, sourceLines);
  for (const found of dataAndLlm.analyze({ file, language, sourceLines, statements, readOnly: isReadOnlyPath(file.path), llmContext })) {
    addCandidate({
      ...found,
      path: file.path,
      ...(testFile && config.scan?.testFiles?.mode === 'lower-confidence' ? { confidence: 'lower' } : {}),
    });
  }
}

const FAMILY_ORDER = [
  'Injection (SQL, command, HTML)',
  'Input validation',
  'Secrets',
  'Cryptography and randomness',
  'Code and command execution',
  'Unsafe deserialization',
  'TLS verification',
  'Authorization',
  'Error handling and logging',
  'Removed security controls',
  'Infrastructure and permissions',
  'Data access',
  'LLM and agent safety',
  'Repository hygiene',
  'Supply chain and CI/CD',
];

// Rules that are not in the `rules` table: they run on a subset of languages, or compare removed lines.
const extraRuleFamilies = [
  { id: 'CRIT-101', family: 'Injection (SQL, command, HTML)', languages: ['python', 'csharp', 'typescript', 'javascript'] },
  { id: 'CRIT-104', family: 'Code and command execution', languages: ['python'] },
  { id: 'CRIT-301', family: 'Error handling and logging', languages: ['python'] },
  { id: 'REG-401', family: 'Removed security controls' },
  { id: 'DATA-501', family: 'Data access', languages: ['python', 'csharp', 'typescript', 'javascript'] },
  { id: 'DATA-502', family: 'Data access', languages: ['python', 'csharp', 'typescript', 'javascript'] },
  ...['LLM-501', 'LLM-502', 'LLM-503'].map((id) => ({ id, family: 'LLM and agent safety', languages: ['python', 'csharp', 'typescript', 'javascript'] })),
  { id: 'LLM-504', family: 'LLM and agent safety', languages: ['python', 'csharp', 'typescript', 'javascript'] },
  { id: 'CS-601', family: 'Injection (SQL, command, HTML)', languages: ['csharp'] },
  { id: 'CS-602', family: 'Injection (SQL, command, HTML)', languages: ['csharp'] },
  { id: 'CS-603', family: 'Unsafe deserialization', languages: ['csharp'] },
  { id: 'CS-604', family: 'Cryptography and randomness', languages: ['csharp'] },
  { id: 'CS-605', family: 'Authorization', languages: ['csharp'] },
  { id: 'CS-606', family: 'Authorization', languages: ['csharp'] },
  { id: 'CS-607', family: 'Authorization', languages: ['csharp'] },
  { id: 'CS-608', family: 'Injection (SQL, command, HTML)', languages: ['csharp'] },
  { id: 'CS-609', family: 'Cryptography and randomness', languages: ['csharp'] },
  { id: 'CS-610', family: 'Authorization', languages: ['csharp'] },
  { id: 'TS-601', family: 'TLS verification', languages: ['typescript', 'javascript'] },
  { id: 'TS-602', family: 'Injection (SQL, command, HTML)', languages: ['typescript', 'javascript'] },
  { id: 'TS-603', family: 'Code and command execution', languages: ['typescript', 'javascript'] },
  { id: 'TS-604', family: 'Authorization', languages: ['typescript', 'javascript'] },
  { id: 'TS-605', family: 'Authorization', languages: ['typescript', 'javascript'] },
  { id: 'TS-606', family: 'Input validation', languages: ['typescript', 'javascript'] },
  { id: 'TS-607', family: 'Input validation', languages: ['typescript', 'javascript'] },
  { id: 'TS-608', family: 'Cryptography and randomness', languages: ['typescript', 'javascript'] },
  { id: 'TS-609', family: 'Input validation', languages: ['typescript', 'javascript'] },
  { id: 'TS-610', family: 'Injection (SQL, command, HTML)', languages: ['typescript', 'javascript'] },
  { id: 'PY-601', family: 'Code and command execution', languages: ['python'] },
  { id: 'PY-602', family: 'Injection (SQL, command, HTML)', languages: ['python'] },
  { id: 'PY-603', family: 'Injection (SQL, command, HTML)', languages: ['python'] },
  { id: 'PY-604', family: 'Error handling and logging', languages: ['python'] },
  { id: 'PY-605', family: 'Input validation', languages: ['python'] },
  { id: 'PY-606', family: 'Authorization', languages: ['python'] },
  { id: 'PY-607', family: 'Input validation', languages: ['python'] },
  { id: 'PY-608', family: 'Unsafe deserialization', languages: ['python'] },
  { id: 'PY-609', family: 'Cryptography and randomness', languages: ['python'] },
  { id: 'PY-610', family: 'TLS verification', languages: ['python'] },
  { id: 'PY-611', family: 'Input validation', languages: ['python'] },
  { id: 'SUP-601', family: 'Supply chain and CI/CD' },
  { id: 'SUP-602', family: 'Supply chain and CI/CD' },
  { id: 'SUP-603', family: 'Supply chain and CI/CD' },
  { id: 'SUP-604', family: 'Supply chain and CI/CD' },
  { id: 'SUP-605', family: 'Supply chain and CI/CD' },
  { id: 'SUP-606', family: 'Supply chain and CI/CD' },
  { id: 'SUP-607', family: 'Supply chain and CI/CD' },
  { id: 'SEC-601', family: 'Secrets' },
  { id: 'SEC-602', family: 'Secrets' },
  { id: 'SEC-603', family: 'Secrets' },
  { id: 'ACC-601', family: 'Authorization', languages: ['python', 'typescript', 'javascript'] },
  { id: 'ERR-601', family: 'Error handling and logging', languages: ['python', 'typescript', 'javascript'] },
  { id: 'ERR-602', family: 'Authorization', languages: ['python', 'typescript', 'javascript'] },
  { id: 'PY-612', family: 'Injection (SQL, command, HTML)', languages: ['python'] },
  { id: 'HYG-501', family: 'Repository hygiene', languages: ['python'] },
  { id: 'HYG-502', family: 'Repository hygiene' },
];

function rulesForLanguage(language) {
  return [...rules, ...extraRuleFamilies].filter((rule) => !rule.languages || rule.languages.includes(language));
}

function ruleFamiliesFor(language) {
  const byFamily = new Map();
  for (const rule of rulesForLanguage(language)) {
    const ids = byFamily.get(rule.family) ?? new Set();
    ids.add(rule.id);
    byFamily.set(rule.family, ids);
  }
  const ran = FAMILY_ORDER.filter((family) => byFamily.has(family))
    .map((family) => ({ family, rules: [...byFamily.get(family)].sort() }));
  const notCovered = FAMILY_ORDER.filter((family) => !byFamily.has(family));
  return { ran, notCovered };
}

/** How many rules apply to a language and how many of them produced a candidate: 0 candidates from 3 rules is a thin result, not a clean one. */
function ruleCounts(language) {
  const ids = new Set(rulesForLanguage(language).map((rule) => rule.id));
  const matched = new Set(candidates
    .filter((candidate) => languageForPath(candidate.path) === language && ids.has(candidate.ruleId))
    .map((candidate) => candidate.ruleId));
  return { ran: ids.size, matched: matched.size, matchedNothing: ids.size - matched.size };
}

const languageNames = { python: 'Python', csharp: 'C#', typescript: 'TypeScript', javascript: 'JavaScript' };
const filesByLanguage = new Map();
for (const file of scannedFiles) {
  const language = languageForPath(file.path);
  filesByLanguage.set(language, (filesByLanguage.get(language) ?? 0) + 1);
}

const ruleFamilies = [...filesByLanguage.entries()]
  .sort(([a], [b]) => String(a).localeCompare(String(b)))
  .map(([language, files]) => ({
    language: language ?? 'other',
    label: language ? languageNames[language] : 'Other files (no language detected)',
    files,
    ...ruleFamiliesFor(language),
    rules: ruleCounts(language),
  }));

const ruleFamiliesLine = ruleFamilies.length
  ? `Rule families that ran: ${ruleFamilies.map((entry) => {
    const counted = `${entry.ran.length} of ${FAMILY_ORDER.length} families`;
    const missing = entry.notCovered.length ? `, no rules for ${entry.notCovered.join(' or ')}` : '';
    const found = `, ${entry.rules.matched} of ${entry.rules.ran} rules found something`;
    return `${entry.label} (${entry.files} ${entry.files === 1 ? 'file' : 'files'}): ${counted}${missing}${found}`;
  }).join('; ')}. No candidates does not mean safe.`
  : 'No scanned files, so no rule families ran.';

const readOnlyPaths = {
  configured: configuredReadOnlyPaths,
  matchedFiles: readOnlyFiles,
  note: configuredReadOnlyPaths.length
    ? (readOnlyFiles.length
      ? `${readOnlyFiles.length} changed ${readOnlyFiles.length === 1 ? 'file is' : 'files are'} inside scan.readOnlyPaths.`
      : 'No changed file is inside scan.readOnlyPaths.')
    : 'scan.readOnlyPaths is empty, so the DATA-501 write check did not run on any path.',
  ...(readOnlyWarning ? { warning: readOnlyWarning } : {}),
};

const pythonFiles = scannedFiles.filter((file) => file.path.endsWith('.py'));
const csharpFiles = scannedFiles.filter((file) => languageForPath(file.path) === 'csharp');
const infrastructureFiles = scannedFiles.filter((file) => infrastructurePathPattern.test(file.path));

const languageCoverage = (() => {
  const summary = summarizeCoverage(scannedFiles);
  return { checked: summary.checked, unchecked: summary.unchecked, line: renderCoverageLine(summary) };
})();

process.stdout.write(`${JSON.stringify({
  candidates,
  skipped: report.skipped ?? [],
  coverage: {
    ...languageCoverage,
    python: {
      changedFiles: pythonFiles.length,
      note: pythonFiles.length
        ? 'Targeted Python heuristics ran; this is not exhaustive security analysis.'
        : 'No changed Python files were collected.',
    },
    csharp: {
      changedFiles: csharpFiles.length,
      note: csharpFiles.length
        ? 'Targeted C# heuristics ran; this is not exhaustive security analysis.'
        : 'No changed C# files were collected.',
    },
    ruleFamilies,
    ruleFamiliesLine,
    readOnlyPaths,
    detectedLanguages: [...new Set(scannedFiles.map((file) => languageForPath(file.path)).filter(Boolean))],
    infrastructure: {
      changedFiles: infrastructureFiles.length,
      note: infrastructureFiles.length
        ? 'Infrastructure heuristics ran on changed IaC/workload files; verify cloud and deployment context.'
        : 'No recognized infrastructure files were collected.',
    },
  },
  note: 'Heuristic candidates only; verify context and mitigations before reporting.',
}, null, 2)}\n`);