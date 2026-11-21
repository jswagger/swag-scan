// Data-access, LLM / agent and hygiene rules for the Security Auditor scanner (DATA-5xx, LLM-5xx, HYG-5xx,
// plus the guardrail-text and database-grant extensions of REG-401 and ARCH-403).
//
// These rules work on logical statements (see statements.mjs), not single lines, and they are heuristics:
// every candidate is a lead for the review pass, and the ones that depend on context carry `confidence: 'lower'`.
// Names that differ between teams (SQL helper classes, allowed procedures, tenant predicates, model-call wrappers,
// prompt files) come from `scan.dataAccess` and `scan.llm` in config.json.

import { interpolations, looksLikeSql } from './statements.mjs';

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []);
const wordPattern = (names) => names.map((name) => escapeRegex(name)).join('|');
const normalizeProcedure = (name) => name.replace(/[[\]"`]/g, '').toLowerCase();
const clip = (text) => text.trim().slice(0, 240);

/** @param {{line:number,text:string,side:string}[]} changes */
const addedLineIn = (changes, first, last) =>
  changes.find((change) => change.side === 'added' && change.line >= first && change.line <= last)?.line;

// ---- DATA-501: database writes inside scan.readOnlyPaths ------------------------------------------------------------

const SQL_WRITE_UPPERCASE = /\b(?:INSERT\s+INTO|UPDATE\s+[\w.[\]"`]+\s+SET|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+TABLE|DROP\s+(?:TABLE|VIEW|INDEX|DATABASE|SCHEMA|PROCEDURE|FUNCTION)|ALTER\s+(?:TABLE|VIEW|INDEX|DATABASE|SCHEMA|PROCEDURE))\b/;
const SQL_WRITE_ANY_CASE = /\b(?:INSERT\s+INTO\s+[\w.[\]"`]+(?:\s*\(|[\s\S]*?\bVALUES\b)|UPDATE\s+[\w.[\]"`]+\s+SET\s+[\w.[\]"`]+\s*=|DELETE\s+FROM\s+[\w.[\]"`]+\s+WHERE\b|TRUNCATE\s+TABLE\s+\w|DROP\s+TABLE\s+\w|ALTER\s+TABLE\s+\w)/i;
const PROCEDURE_CALL = /\b(?:EXEC(?:UTE)?|CALL)\s+([\w.[\]"`]+)/g;
const ALWAYS_WRITE_CALL = /\.\s*(?:commit|ExecuteNonQuery(?:Async)?|SaveChanges(?:Async)?|WriteToServer(?:Async)?|BulkCopy)\s*\(/;
const EXECUTE_CALL = /\.\s*(?:execute|executemany|executescript)\s*\(/;
const READ_ONLY_SQL = /^\s*\(?\s*(?:SELECT|WITH)\b/i;

// ---- DATA-502: tenant scoping ---------------------------------------------------------------------------------------

const GUID_IN_PARAMETER = /\b(\w*guid)s?\s+IN\s*\(?\s*(?:%s|\?|@\w+|:\w+|\$\d+|\{[^}]*\}|\$\{[^}]*\})\s*\)?/gi;

// ---- ARCH-403 extension: database write grants for an analysis service --------------------------------------------

const CONFIG_FILE = /\.(?:tf|tfvars|hcl|ya?ml|json|toml|ini|cfg|conf|properties|bicep|sql|env)$/i;
const DATABASE_WRITE_GRANT = /\bGRANT\s+(?:ALL|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|EXECUTE)\b|\bdb_(?:datawriter|owner|ddladmin)\b|\bdynamodb:(?:PutItem|UpdateItem|DeleteItem|BatchWriteItem)\b|\brds-data:ExecuteStatement\b|\b(?:access|permissions?|privileges?|mode)["']?\s*[:=]\s*["']?(?:write|read[_-]?write|rw|all|admin|owner)\b/i;
const ANALYSIS_CONTEXT = /analy[sz]/i;

// ---- LLM rules ------------------------------------------------------------------------------------------------------

const LLM_CONTEXT = /\b(?:anthropic|bedrock|openai|langchain|langgraph|llama_?index|genai|gemini|claude|converse|invoke_?model|chat\.completions|messages\.create|model_?id)\b/i;
const CONVENTION_NAMES = /^(?:collected_text|model_output|llm_output|llm_response|model_response|completion_text|generated_text|generated_sql|ai_response)$/i;
const RESPONSE_SHAPE = /choices\s*\[\s*0\s*\]\s*\.\s*message\s*\.\s*content|\.content\s*\[\s*0\s*\]\s*\.\s*text|\[\s*['"]output['"]\s*\]\s*\[\s*['"]message['"]\s*\]|\.delta\.text|\[\s*['"]delta['"]\s*\]\s*\[\s*['"]text['"]\s*\]|\.output_text\b/;

const SINKS = [
  { kind: 'sql', firstArgumentOnly: true, pattern: /\.\s*(?:execute|executemany|executescript|exec_driver_sql|read_sql(?:_query)?|raw|query)\s*\(|\bread_sql\w*\s*\(|\bSqlCommand\s*\(|\bFromSql(?:Raw|Interpolated)?\s*\(|\bExecuteSql\w*\s*\(/ },
  { kind: 'sql', pattern: /\bCommandText\s*=/ },
  { kind: 'process', pattern: /\bsubprocess\.\w+\s*\(|\bos\.(?:system|popen|exec\w*|spawn\w*)\s*\(|\bPopen\s*\(|\b(?:child_process|childProcess|cp)\s*\.\s*\w+\s*\(|(?<![.\w$])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(|\bProcess\s*\.\s*Start\s*\(/ },
  { kind: 'eval', pattern: /(?<![.\w$])(?:eval|exec)\s*\(|\bnew\s+Function\s*\(|\bvm\.run\w*\s*\(/ },
  { kind: 'file path', firstArgumentOnly: true, pattern: /(?<![.\w$])open\s*\(|\bPath\s*\(|\bos\.path\.join\s*\(|\bpath\.(?:join|resolve)\s*\(|\bfs\s*\.\s*\w+\s*\(|\bFile\s*\.\s*\w+\s*\(|\bshutil\.\w+\s*\(|\bPath\.Combine\s*\(/ },
  { kind: 'S3 key', valueAfterMatch: true, pattern: /\bKey\s*[=:](?!=)/ },
  { kind: 'URL', firstArgumentOnly: true, pattern: /\brequests\.\w+\s*\(|\burlopen\s*\(|\bhttpx\.\w+\s*\(|(?<![.\w$])fetch\s*\(|\baxios(?:\.\w+)?\s*\(|\bhttps?\.(?:get|request)\s*\(|\.\s*(?:GetAsync|PostAsync|SendAsync|GetStringAsync)\s*\(|\bnew\s+Uri\s*\(/ },
  { kind: 'PDF generation', lowerConfidence: true, pattern: /\bgenerate_pdf\w*\s*\(|\bgeneratePdf\w*\s*\(|\bpdfkit\.\w+\s*\(|\bwrite_pdf\s*\(|\bpage\.pdf\s*\(|\bjsPDF\b/ },
];

const TOOLS_PATTERN = /\btoolConfig\b|\btool_?choice\b|\btools\s*[=:]\s*[[{(]|["']tools["']\s*:|\bfunction_?calls?\b|\bfunctions\s*=\s*\[|\bcreate_?(?:react_)?agent\s*\(|\bAgentExecutor\b|\binitialize_agent\b|\b(?:invoke_agent|InvokeAgent(?:Async)?)\s*\(|(?<![.\w$])Agent\s*\(|\bToolSpecification\b|\bToolConfiguration\b|\btoolSpec\b|\bFunctionDeclaration\b|\bmcp_servers\b/;
const DATABASE_FACING_TOOL = /sql|query|database|\bdb\b|_db|table|record|lookup|fetch_data/i;

const SYSTEM_CONTEXT = /\bsystem\w*\s*[=:]|["']system["']\s*:|\brole["']?\s*:\s*["']system["']|\bSystemMessage\s*\(/i;
const UNTRUSTED_NAME = /pdf|document|doc_?text|doctext|upload|user_?(?:input|text|message|query|prompt|content)|usertext|userinput|raw_?text|file_?content|extracted|\bocr|page_?text|attachment|email_?(?:body|text)|transcript|input_?text|customer_?(?:text|message)/i;
const INSTRUCTION_WORDS = /\b(?:summari[sz]e|extract|answer|respond|reply|follow|instructions?|you (?:are|must|should|will)|your task|task:|do not|don't|never|only)\b/i;
const DELIMITER_BEFORE = /(?:<[\w-]+>|```|"""|'''|-{3,}|={3,}|#{3,}|\[\/?[\w ]+\]|BEGIN [A-Z ]+|START [A-Z ]+)\s*$/i;

const TOOL_HANDLER_MARKER = /(?:^|\s)@(?:\w+\.)?(?:tool|function_tool|mcp_tool|call_tool)\b|\bMcpServerTool\b|\b\w+\s*\.\s*(?:tool|registerTool|add_tool|call_tool)\s*\(|\bregisterTool\s*\(|\bCallToolRequestSchema\b|\[\s*Tool(?:Function)?\s*[\](]/;
const PROCESS_SINK = /\bsubprocess\.\w+\s*\(|\bos\.(?:system|popen)\s*\(|\bPopen\s*\(|\b(?:child_process|childProcess|cp)\s*\.\s*\w+\s*\(|(?<![.\w$])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(|\bProcess\s*\.\s*Start\s*\(/;

const GUARDRAIL_WORDS = /\b(?:never|do not|don't|must not|only)\b/i;
const PROMPT_CONTENT = /\b[A-Z][A-Z0-9_]*(?:PROMPT|INSTRUCTIONS|GUARDRAILS?)[A-Z0-9_]*\s*=|\b(?:system_prompt|systemPrompt)\b|\bYou are (?:a|an|the)\b/;

// ---- Hygiene ------------------------------------------------------------------------------------------------------

const ENTRY_POINT = /(?:^|\/)main_[\w-]+\.py$/i;
const DEPLOYABLE_DIRECTORY = /(?:^|\/)(?:src|app|apps|api|backend|server|service|services|lambda|lambdas|functions|deploy|deployment|package)\//i;
const NOT_DEPLOYABLE_DIRECTORY = /(?:^|\/)(?:tests?|__tests__|scripts?|tools?|examples?|docs?|samples?|sandbox|dev|local)\//i;
const AUTH_BYPASS = /\b(?:bypass|skip|disable|no|without)[_\s-]?auth\w*|dependency_overrides\s*\[|\bauth\w*\s*=\s*(?:None|False|lambda)\b|\b(?:fake|mock|dummy|dev|test)_?user\b|\bDISABLE_AUTH\b/i;
const CONFIG_LIKE = /\.(?:json|ya?ml|toml|ini|cfg|conf|properties|env|xml|csproj|config|code-workspace)$|(?:^|\/)\.env[\w.]*$/i;
const PERSONAL_PATH = /(?:\/Users\/(?!Shared\b|runner\b)[\w.-]+\/|\/home\/(?!runner\b|vsts\b|node\b|app\b|ubuntu\b)[\w.-]+\/|[A-Za-z]:\\{1,2}Users\\{1,2}(?!Public\b|Default\b)[\w.-]+\\)/;

function contextText(file, sourceLines, firstLine, lastLine, before, after) {
  if (sourceLines) return sourceLines.slice(Math.max(0, firstLine - 1 - before), lastLine + after).join('\n');
  return (file.changes ?? [])
    .filter((change) => change.line >= firstLine - before && change.line <= lastLine + after)
    .map((change) => change.text)
    .join('\n');
}

function wrapperPattern(names) {
  if (names.length === 0) return undefined;
  const body = names.map((name) => escapeRegex(name).replace(/\\\./g, '\\s*\\.\\s*')).join('|');
  return new RegExp(`(?<![\\w$])(?:${body})(?:Async)?\\s*\\(`);
}

function assignment(statement) {
  const loop = statement.skeleton.match(/^(?:async\s+)?(?:for|foreach)\s*(?:await\s*)?\(?\s*(?:const|let|var)?\s*([\w$,\s]+?)\s+(?:in|of)\s+([\s\S]+?)\)?\s*[:{]?$/);
  if (loop) return { targets: loop[1].match(/[A-Za-z_$][\w$]*/g) ?? [], right: loop[2] };
  const plain = statement.skeleton.match(/^(?:(?:const|let|var|val|final)\s+)?(?:\(([\w$\s,]+)\)|([\w$.,\s]+?))\s*(?::\s*[\w<>[\], .|]+)?\s*\+?=(?!=)\s*([\s\S]*)$/);
  if (!plain) return undefined;
  const left = plain[1] ?? plain[2];
  const targets = (left.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((name) => !['const', 'let', 'var', 'val', 'final', 'self', 'this'].includes(name));
  return targets.length ? { targets: [targets.at(-1), ...targets.slice(0, -1)].filter((name, index, all) => all.indexOf(name) === index), right: plain[3] } : undefined;
}

/** The text from `startIndex` up to the next comma or closing bracket at the same level. */
function valueAfter(text, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) {
      if (depth === 0) return text.slice(startIndex, index);
      depth -= 1;
    } else if (char === ',' && depth === 0) return text.slice(startIndex, index);
  }
  return text.slice(startIndex);
}

const FUNCTION_START = /^\s*(?:async\s+)?def\s+\w+|^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:public|private|internal|protected)\s+(?:static\s+)?(?:async\s+)?[\w<>[\],.?]+\s+\w+\s*\(/;

/** The text of the first argument of the call that starts at `openIndex` (the index of its `(`), brackets balanced. */
function firstArgument(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    } else if (char === ',' && depth === 1) return text.slice(openIndex + 1, index);
  }
  return text.slice(openIndex + 1);
}

export function createDataAndLlmRules(scan = {}) {
  const sqlHelpers = strings(scan.dataAccess?.sqlHelpers);
  const writeMethods = strings(scan.dataAccess?.sqlHelperWriteMethods);
  const allowedProcedures = new Set(strings(scan.dataAccess?.allowedProcedures).map(normalizeProcedure));
  const tenantPredicates = strings(scan.dataAccess?.tenantPredicates);
  const wrappers = wrapperPattern(strings(scan.llm?.modelCallWrappers));

  const helperWrite = sqlHelpers.length && writeMethods.length
    ? new RegExp(`\\b(?:${wordPattern(sqlHelpers)})\\w*\\s*\\.\\s*(?:${wordPattern(writeMethods)})\\w*\\s*\\(`, 'i')
    : undefined;
  const helperAny = sqlHelpers.length ? new RegExp(`\\b(?:${wordPattern(sqlHelpers)})\\w*\\s*\\.\\s*\\w+\\s*\\(`, 'i') : undefined;
  const tenantPattern = tenantPredicates.length ? new RegExp(`\\b(?:${wordPattern(tenantPredicates)})\\b`, 'i') : undefined;

  function procedureAllowed(name) {
    const normalized = normalizeProcedure(name);
    return allowedProcedures.has(normalized) || allowedProcedures.has(normalized.split('.').at(-1));
  }

  function databaseWrites({ file, statements, readOnly }) {
    if (!readOnly) return [];
    const found = [];
    for (const statement of statements) {
      const line = addedLineIn(file.changes ?? [], statement.firstLine, statement.lastLine);
      if (line === undefined) continue;
      const reasons = [];
      let lowerConfidence = false;

      if (SQL_WRITE_UPPERCASE.test(statement.sql) || SQL_WRITE_ANY_CASE.test(statement.sql)) reasons.push('SQL write statement');
      const procedures = [...statement.sql.matchAll(PROCEDURE_CALL)].map((match) => match[1]);
      for (const name of procedures) {
        if (!procedureAllowed(name)) reasons.push(`stored procedure ${name} is not in scan.dataAccess.allowedProcedures`);
      }
      if (ALWAYS_WRITE_CALL.test(statement.skeleton)) reasons.push('commit or non-query call');
      if (helperWrite?.test(statement.skeleton)) reasons.push('write method on a SQL helper');
      if (EXECUTE_CALL.test(statement.skeleton) && !reasons.length && procedures.length === 0) {
        const sql = statement.sql.trim();
        if (!sql) {
          reasons.push('.execute with SQL that is not visible here');
          lowerConfidence = true;
        } else if (!READ_ONLY_SQL.test(sql)) reasons.push('.execute with SQL that is not a SELECT');
      }
      if (!reasons.length) continue;
      found.push({
        ruleId: 'DATA-501',
        line,
        severity: 'high',
        description: `Database write in a read-only path (scan.readOnlyPaths): ${[...new Set(reasons)].join('; ')}`,
        evidence: clip(statement.text),
        ...(lowerConfidence ? { confidence: 'lower' } : {}),
      });
    }
    return found;
  }

  function tenantScoping({ file, sourceLines, statements }) {
    const found = [];
    for (const statement of statements) {
      const line = addedLineIn(file.changes ?? [], statement.firstLine, statement.lastLine);
      if (line === undefined || !looksLikeSql(statement.sql)) continue;
      const matches = [...statement.sql.matchAll(GUID_IN_PARAMETER)];
      if (matches.length === 0) continue;
      const remaining = statement.sql.replace(GUID_IN_PARAMETER, ' ');
      // A filter added on the next lines (`sql += " AND UserGuid = %s"`, `.append(...)`) still scopes the query.
      const appended = contextText(file, sourceLines, statement.lastLine + 1, statement.lastLine + 4, 0, 0)
        .split('\n').filter((text) => /\+=|\.append\s*\(|\.extend\s*\(/.test(text)).join('\n');
      if (tenantPattern && (tenantPattern.test(remaining) || tenantPattern.test(appended))) continue;
      found.push({
        ruleId: 'DATA-502',
        line,
        severity: 'suspicious',
        confidence: 'lower',
        description: `SQL filters by caller-supplied ${matches[0][1]} IN (...) with no tenant or user predicate (${tenantPredicates.join(', ') || 'none configured'}); confirm the caller may read every id`,
        evidence: clip(statement.text),
      });
    }
    return found;
  }

  function databaseGrants({ file, sourceLines }) {
    if (!CONFIG_FILE.test(file.path)) return [];
    const found = [];
    for (const change of file.changes ?? []) {
      if (change.side !== 'added' || !DATABASE_WRITE_GRANT.test(change.text)) continue;
      const surrounding = `${file.path}\n${contextText(file, sourceLines, change.line, change.line, 8, 8)}`;
      if (!ANALYSIS_CONTEXT.test(surrounding)) continue;
      found.push({
        ruleId: 'ARCH-403',
        line: change.line,
        severity: 'suspicious',
        description: 'Configuration appears to give an analysis service write access to a database; analysis should use a read-only account',
        evidence: clip(change.text),
        context: 'infrastructure',
      });
    }
    return found;
  }

  function modelOutputTaint({ file, statements }) {
    if (!wrappers) return [];
    const tainted = new Map();
    const taint = (name, statement, via) => {
      if (!tainted.has(name)) tainted.set(name, { statement, via });
    };

    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of statements) {
        const parsed = assignment(statement);
        if (!parsed) continue;
        const references = (name) => statement.references.has(name);
        if (wrappers.test(statement.skeleton)) parsed.targets.forEach((name) => taint(name, statement, 'model call'));
        else if (RESPONSE_SHAPE.test(statement.text)) parsed.targets.forEach((name) => taint(name, statement, 'response shape'));
        for (const name of parsed.targets) {
          if (CONVENTION_NAMES.test(name)) taint(name, statement, 'convention');
        }
        for (const [name, origin] of [...tainted]) {
          if (parsed.targets.includes(name) || !references(name) || origin.statement === statement) continue;
          parsed.targets.forEach((target) => taint(target, statement, origin.via === 'convention' ? 'convention' : 'derived'));
        }
      }
    }

    const changes = file.changes ?? [];
    const found = [];
    for (const statement of statements) {
      for (const sink of SINKS) {
        const match = statement.expanded.match(sink.pattern);
        if (!match) continue;
        let inspected = statement.expanded;
        if (sink.firstArgumentOnly) inspected = firstArgument(statement.expanded, match.index + match[0].lastIndexOf('('));
        else if (sink.valueAfterMatch) inspected = valueAfter(statement.expanded, match.index + match[0].length);
        const direct = wrappers.test(inspected);
        const name = [...tainted.keys()].find((candidate) =>
          new RegExp(`(?<![\\w$.])${escapeRegex(candidate)}(?![\\w$])`).test(inspected)
          && tainted.get(candidate).statement !== statement);
        if (!direct && !name) continue;

        const origin = name ? tainted.get(name) : undefined;
        const line = addedLineIn(changes, statement.firstLine, statement.lastLine)
          ?? (origin ? addedLineIn(changes, origin.statement.firstLine, origin.statement.lastLine) : undefined);
        if (line === undefined) continue;
        found.push({
          ruleId: 'LLM-501',
          line,
          severity: 'high',
          ...(origin?.via === 'convention' || sink.lowerConfidence ? { confidence: 'lower' } : {}),
          description: `Model output flows into a ${sink.kind}${sink.kind === 'sql' ? ' call (text-to-SQL shape)' : ''}${name ? ` through ${name}` : ' directly'}; treat the output as untrusted input and validate or constrain it before use`,
          evidence: clip(statement.text),
          sink: sink.kind,
          ...(origin ? { sourceLine: origin.statement.firstLine } : {}),
        });
        break;
      }
    }
    return found;
  }

  function toolsAndAgency({ file, statements, llmContext }) {
    const found = [];
    for (const statement of statements) {
      const line = addedLineIn(file.changes ?? [], statement.firstLine, statement.lastLine);
      if (line === undefined) continue;
      const isModelCall = wrappers?.test(statement.skeleton);
      if (!TOOLS_PATTERN.test(statement.skeleton) || !(isModelCall || llmContext)) continue;
      const names = [...new Set([...statement.text.matchAll(/["']?\bname["']?\s*[:=]\s*["']([\w.-]+)["']/g)].map((match) => match[1]))];
      const databaseFacing = names.filter((name) => DATABASE_FACING_TOOL.test(name));
      found.push({
        ruleId: 'LLM-502',
        line,
        severity: 'suspicious',
        ...(isModelCall ? {} : { confidence: 'lower' }),
        description: `Model call or agent setup exposes tools${names.length ? ` (${names.join(', ')})` : ' (names are not visible here)'}; each tool that reaches a database must be read-only${databaseFacing.length ? `. Database-facing: ${databaseFacing.join(', ')}` : ''}`,
        evidence: clip(statement.text),
        tools: names,
        databaseFacing,
      });
    }
    return found;
  }

  function untrustedPromptContent({ file, statements, language, llmContext }) {
    if (!llmContext) return [];
    const found = [];
    for (const statement of statements) {
      const line = addedLineIn(file.changes ?? [], statement.firstLine, statement.lastLine);
      if (line === undefined || !statement.dynamic) continue;
      const untrusted = [...statement.references].filter((name) => UNTRUSTED_NAME.test(name));
      if (untrusted.length === 0) continue;

      if (SYSTEM_CONTEXT.test(statement.text)) {
        found.push({
          ruleId: 'LLM-503',
          line,
          severity: 'suspicious',
          description: `Untrusted text (${untrusted.join(', ')}) is placed in the system message; put document or user text in a user message, inside delimiters, never in the system prompt`,
          evidence: clip(statement.text),
        });
        continue;
      }

      const plain = (text) => text.replace(/\\[nrt]/g, ' ');
      let before = '';
      let hit;
      for (const part of statement.parts) {
        if (part.type === 'string') {
          const placeholders = part.interpolated ? interpolations(part.body, language) : [];
          const first = placeholders.find((item) => untrusted.some((name) => item.expression.includes(name)));
          if (first && !hit) {
            hit = { before: before + part.body.slice(0, first.index), after: part.body.slice(first.index) };
          } else if (hit) hit.after += part.body;
          else before += part.body;
        } else if (!hit && untrusted.some((name) => new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])`).test(part.text))) {
          hit = { before, after: '' };
        }
      }
      if (!hit) continue;
      const beforeText = plain(hit.before);
      if (!INSTRUCTION_WORDS.test(plain(hit.after)) || INSTRUCTION_WORDS.test(beforeText) || DELIMITER_BEFORE.test(beforeText.slice(-40))) continue;
      found.push({
        ruleId: 'LLM-503',
        line,
        severity: 'suspicious',
        confidence: 'lower',
        description: `Untrusted text (${untrusted.join(', ')}) comes before the instructions with no delimiter; put instructions first and wrap the text in clear delimiters`,
        evidence: clip(statement.text),
      });
    }
    return found;
  }

  function toolHandlerExecution({ file, sourceLines }) {
    if (!sourceLines) return [];
    const found = [];
    for (const change of file.changes ?? []) {
      if (change.side !== 'added' || !PROCESS_SINK.test(change.text)) continue;
      const lines = sourceLines;
      let marker;
      const indentation = (text) => text.length - text.trimStart().length;
      const here = lines[change.line - 1] ?? change.text;
      for (let index = change.line - 2; index >= Math.max(0, change.line - 61); index -= 1) {
        const text = lines[index];
        if (!text.trim() || indentation(text) >= indentation(here)) continue;
        if (TOOL_HANDLER_MARKER.test(text)) { marker = index; break; }
        if (FUNCTION_START.test(text)) {
          for (let above = index - 1; above >= 0 && /^\s*(?:@|\[)/.test(lines[above]); above -= 1) {
            if (TOOL_HANDLER_MARKER.test(lines[above])) { marker = above; break; }
          }
          break;
        }
      }
      if (marker === undefined) continue;
      found.push({
        ruleId: 'LLM-504',
        line: change.line,
        severity: 'suspicious',
        description: `Process execution inside an MCP tool or LLM tool handler (registered at line ${marker + 1}); if any argument comes from the tool input, the model controls the command`,
        evidence: clip(change.text),
      });
    }
    return found;
  }

  function guardrailRemoval({ change }) {
    return GUARDRAIL_WORDS.test(change.text)
      ? 'Removed line in a prompt file contains guardrail wording (never, do not, only); verify the rule was moved or intentionally dropped'
      : undefined;
  }

  function isPromptByContent({ file, sourceLines }) {
    const text = sourceLines ? sourceLines.join('\n') : (file.changes ?? []).map((change) => change.text).join('\n');
    return PROMPT_CONTENT.test(text);
  }

  function hygiene({ file, sourceLines }) {
    const found = [];
    const path = file.path.replaceAll('\\', '/');
    if (ENTRY_POINT.test(path) && DEPLOYABLE_DIRECTORY.test(path) && !NOT_DEPLOYABLE_DIRECTORY.test(path)) {
      const change = (file.changes ?? []).find((item) => item.side === 'added' && AUTH_BYPASS.test(item.text));
      if (change) {
        found.push({
          ruleId: 'HYG-501',
          line: change.line,
          severity: 'suspicious',
          description: 'Alternate entry point (main_*.py) in a deployable directory appears to bypass authentication; keep dev-only entry points out of deployed code',
          evidence: clip(change.text),
        });
      }
    }
    if (CONFIG_LIKE.test(path)) {
      for (const change of file.changes ?? []) {
        if (change.side !== 'added' || !PERSONAL_PATH.test(change.text)) continue;
        found.push({
          ruleId: 'HYG-502',
          line: change.line,
          severity: 'suspicious',
          description: 'Committed configuration contains a personal absolute path (a user home directory); use a relative path or an environment variable',
          evidence: clip(change.text),
        });
      }
    }
    return found;
  }

  return {
    llmContext: (file, sourceLines) => LLM_CONTEXT.test(sourceLines ? sourceLines.join('\n') : (file.changes ?? []).map((change) => change.text).join('\n')),
    isPromptByContent,
    guardrailRemoval,
    analyze(context) {
      return [
        ...databaseWrites(context),
        ...tenantScoping(context),
        ...databaseGrants(context),
        ...modelOutputTaint(context),
        ...toolsAndAgency(context),
        ...untrustedPromptContent(context),
        ...toolHandlerExecution(context),
        ...hygiene(context),
      ];
    },
  };
}
