#!/usr/bin/env node
// PreToolUse hook (Claude Code layer): limits what Swag Scan's three agents can run through Bash.
// Plugin agents cannot declare hooks or a Bash command allowlist themselves, so the plugin ships this hook.
//
// It acts ONLY when the call comes from the Analyst, Inspector or Security Guard (hook input `agent_type`).
// Your own session, and every other agent, are never touched: no output and exit 0 mean "no opinion".
// For the three agents it is a default-deny allowlist, not a list of banned words:
//   - the Swag Scan scripts (the `swag-scan` command, and node running a .mjs file inside the plugin's skills/ folder)
//   - read-only git (status, diff, log, show, rev-parse, ls-files, merge-base, blame, shortlog, branch --show-current)
//   - read-only file and text commands (ls, cat, head, tail, wc, grep, rg, find without -exec/-delete, jq, ...)
//   - writing output only into .swag-scan/ (or /dev/null)
// Anything else is blocked with exit code 2 and a reason the agent can read. Command substitution, subshells,
// variable assignment prefixes, and unknown programs are blocked because they can hide what actually runs.

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AGENT = /^(?:swag-scan:)?(?:analyst|inspector|security-guard)$/;

export const isSwagScanAgent = (agentType) => typeof agentType === 'string' && AGENT.test(agentType);

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'grep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'diff', 'stat', 'file',
  'which', 'basename', 'dirname', 'realpath', 'date', 'echo', 'printf', 'true', 'jq', 'find',
]);
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'merge-base', 'blame', 'shortlog']);
const GIT_BRANCH_OK = new Set(['--show-current', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv']);
const FIND_UNSAFE = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);

class Blocked extends Error {}

// A backslash before one of these ends a Windows path segment (C:\tools\x); it is never a shell escape there.
const PATH_CHAR = /[A-Za-z0-9_.@+,=%~-]/;
const DOUBLE_QUOTE_ESCAPES = new Set(['$', '`', '"', '\\', '\n']);

/** Splits a command into segments of plain words plus redirects. Only unquoted separators split. */
export function lex(command) {
  const segments = [];
  let words = [];
  let redirects = [];
  let word = '';
  let inWord = false;
  let quote = null;
  let windowsPath = false; // the current word started with a drive letter and a backslash

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
    windowsPath = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length || redirects.length) segments.push({ words, redirects });
    words = [];
    redirects = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = command[i + 1];

    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && DOUBLE_QUOTE_ESCAPES.has(next)) { word += next; i += 1; }
      else if (char === '`' || (char === '$' && next === '(')) throw new Blocked('command substitution is not allowed');
      else word += char;
      continue;
    }

    if (char === "'" || char === '"') { quote = char; inWord = true; continue; }
    if (char === '\\' && next !== undefined) {
      if (/^[A-Za-z]:$/.test(word)) windowsPath = true;
      if (windowsPath && PATH_CHAR.test(next)) { word += char; inWord = true; continue; }
      word += next;
      inWord = true;
      i += 1;
      continue;
    }
    if (char === '`' || (char === '$' && next === '(')) throw new Blocked('command substitution is not allowed');
    if ((char === '<' || char === '>') && next === '(') throw new Blocked('process substitution is not allowed');
    if (char === '(' || char === ')') throw new Blocked('subshells are not allowed');
    if (char === '\n' || char === ';') { endSegment(); continue; }
    if (char === '|' || char === '&') {
      if (char === '&' && (command[i - 1] === '>' || next === '>')) { /* part of 2>&1 or &> */ }
      else {
        if (next === char) i += 1;
        endSegment();
        continue;
      }
    }
    if (/\s/.test(char)) { endWord(); continue; }

    if (char === '>' || char === '<') {
      // A leading file-descriptor digit belongs to the redirect, not to a word.
      const fd = inWord && /^\d$/.test(word) ? word : '';
      if (fd) { word = ''; inWord = false; }
      endWord();
      let operator = char;
      while (command[i + 1] === char || command[i + 1] === '&') { operator += command[i + 1]; i += 1; }
      if (command[i - operator.length] === '&' ) operator = `&${operator}`;
      let j = i + 1;
      while (command[j] === ' ' || command[j] === '\t') j += 1;
      let target = '';
      let targetQuote = null;
      for (; j < command.length; j += 1) {
        const c = command[j];
        if (targetQuote) { if (c === targetQuote) targetQuote = null; else target += c; continue; }
        if (c === "'" || c === '"') { targetQuote = c; continue; }
        if (/[\s;|&]/.test(c)) break;
        target += c;
      }
      i = j - 1;
      if (operator.includes('&') && /^\d+$|^-$/.test(target)) continue; // 2>&1: duplicates a descriptor, writes nothing new
      redirects.push({ operator, target });
      continue;
    }
    word += char;
    inWord = true;
  }
  if (quote) throw new Blocked('unterminated quote');
  endSegment();
  return segments;
}

/** Removes here-document bodies (they are data, not commands). Blocks an unterminated one. */
function stripHeredocs(command) {
  const lines = command.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const marker = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i]);
    kept.push(marker ? lines[i].replace(marker[0], '') : lines[i]);
    if (!marker) continue;
    const terminator = marker[2];
    let closed = false;
    for (i += 1; i < lines.length; i += 1) {
      if (lines[i].trim() === terminator) { closed = true; break; }
    }
    if (!closed) throw new Blocked('unterminated here-document');
  }
  return kept.join('\n');
}

const inside = (path, folder) => path === folder || path.startsWith(folder + sep);

function checkRedirect({ operator, target }, cwd) {
  if (operator.startsWith('<') && !operator.includes('>')) return; // reading a file
  if (target === '/dev/null') return;
  if (!target) throw new Blocked('a redirect with no target');
  const resolved = resolve(isAbsolute(target) ? target : resolve(cwd, target));
  if (!inside(resolved, resolve(cwd, '.swag-scan'))) {
    throw new Blocked(`writing to ${target} (Swag Scan agents may only write inside .swag-scan/)`);
  }
}

function checkSegment({ words, redirects }, { cwd, pluginRoot }) {
  for (const redirect of redirects) checkRedirect(redirect, cwd);
  if (words.length === 0) return;
  const [program, ...args] = words;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) throw new Blocked('a variable assignment before a command');

  if (program === 'swag-scan') return;
  if (program === 'node') {
    const script = args[0];
    if (!script || script.startsWith('-')) throw new Blocked('node with flags or inline code');
    const resolved = resolve(isAbsolute(script) ? script : resolve(cwd, script));
    if (!resolved.endsWith('.mjs') || !inside(resolved, resolve(pluginRoot, 'skills'))) {
      throw new Blocked(`node running ${script} (only the Swag Scan scripts in the plugin's skills/ folder may run)`);
    }
    return;
  }
  if (program === 'git') {
    const [sub, ...rest] = args;
    if (rest.some((arg) => arg === '-o' || arg.startsWith('--output'))) throw new Blocked('git writing output to a file');
    if (rest.some((arg) => arg === '--ext-diff' || arg === '--textconv')) throw new Blocked('git running a configured external program');
    if (GIT_READ_ONLY.has(sub)) return;
    if (sub === 'branch' && rest.every((arg) => GIT_BRANCH_OK.has(arg))) return;
    if (sub === 'remote' && rest.length === 1 && rest[0] === '-v') return;
    throw new Blocked(`git ${sub ?? ''}`.trim());
  }
  if (READ_ONLY.has(program)) {
    if (program === 'find' && args.some((arg) => FIND_UNSAFE.has(arg))) throw new Blocked('find with -exec, -delete or file output');
    if (program === 'sort' && args.some((arg) => arg === '-o' || arg.startsWith('--output') || arg.startsWith('--compress-program'))) {
      throw new Blocked('sort writing to a file or running a program');
    }
    if (program === 'uniq' && args.filter((arg) => !arg.startsWith('-')).length > 1) throw new Blocked('uniq writing to an output file');
    if (program === 'file' && args.some((arg) => arg === '-C' || arg === '--compile')) throw new Blocked('file writing a compiled database');
    if (program === 'rg' && args.some((arg) => arg.startsWith('--pre') || arg.startsWith('--hostname-bin'))) throw new Blocked('rg running another program');
    if (program === 'date' && args.some((arg) => arg === '-s' || arg.startsWith('--set'))) throw new Blocked('date setting the clock');
    return;
  }
  throw new Blocked(`${program} is not on the Swag Scan agents' list`);
}

/** Returns { allow: true } or { allow: false, reason }. Never throws. */
export function evaluateCommand(command, { cwd = process.cwd(), pluginRoot } = {}) {
  try {
    if (typeof command !== 'string' || !command.trim()) return { allow: true };
    const segments = lex(stripHeredocs(command));
    for (const segment of segments) checkSegment(segment, { cwd, pluginRoot });
    return { allow: true };
  } catch (error) {
    return { allow: false, reason: error instanceof Blocked ? error.message : `could not check the command (${error.message})` };
  }
}

export function runHook(input, env = process.env) {
  if (!isSwagScanAgent(input?.agent_type) || input?.tool_name !== 'Bash') return { block: false };
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
  const verdict = evaluateCommand(input.tool_input?.command, { cwd: input.cwd ?? process.cwd(), pluginRoot });
  if (verdict.allow) return { block: false };
  return {
    block: true,
    message: `Swag Scan guard blocked this command: ${verdict.reason}. Swag Scan agents may run the Swag Scan scripts, read-only git, and read-only file commands, and may write only inside .swag-scan/. Report what you needed instead of running it.`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // not something we can read: no opinion
  }
  let result;
  try {
    result = runHook(input);
  } catch (error) {
    // For the three agents, fail closed; for anyone else we never got here with an opinion.
    result = isSwagScanAgent(input?.agent_type) ? { block: true, message: `Swag Scan guard could not check this command (${error.message}).` } : { block: false };
  }
  if (result.block) {
    process.stderr.write(`${result.message}\n`);
    process.exit(2);
  }
}
