// Shared helpers for the TypeScript / JavaScript and Python rule modules (SS-104).
//
// These languages put call arguments over several lines and build strings in several ways, so the rules need to see
// "the arguments of this call" rather than "this line". Everything here is plain string scanning: no parser, no
// dependencies. It is a heuristic reader, tuned to never throw and to give up quietly on odd input.

const CLIP = 240;

export const clip = (text) => text.replace(/\s+/g, ' ').trim().slice(0, CLIP);

export const isCommentLine = (line, language) => (language === 'python'
  ? /^\s*#/.test(line ?? '')
  : /^\s*(?:\/\/|\/\*|\*)/.test(line ?? ''));

/** A line without its trailing comment. A comment marker inside a string is kept. */
export function stripLineComment(line = '', language) {
  const python = language === 'python';
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || (!python && char === '`')) quote = char;
    else if (python ? char === '#' : (char === '/' && line[index + 1] === '/')) return line.slice(0, index).trimEnd();
  }
  return line.trimEnd();
}

/** Reads a string literal that starts at `index`: where it ends, and whether it has `${...}` / `{...}` placeholders. */
export function readString(text, index, language) {
  const python = language === 'python';
  const previous = text[index - 1] ?? '';
  let start = index;
  let prefix = '';
  if (python) {
    const found = /^[rRbBuUfF]{1,2}(?=['"])/.exec(text.slice(index, index + 3));
    if (found && !/[\w]/.test(previous)) {
      prefix = found[0].toLowerCase();
      start += found[0].length;
    }
  }
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && (python || quote !== '`')) return undefined;
  if (start === index && /[\w]/.test(previous) && python) return undefined;

  const triple = python && text.startsWith(quote.repeat(3), start);
  let position = start + (triple ? 3 : 1);
  let placeholders = false;
  let braceDepth = 0;
  while (position < text.length) {
    const char = text[position];
    if (char === '\\') { position += 2; continue; }
    if (quote === '`') {
      if (char === '$' && text[position + 1] === '{') { placeholders = true; braceDepth += 1; position += 2; continue; }
      if (braceDepth > 0 && char === '}') { braceDepth -= 1; position += 1; continue; }
      if (braceDepth === 0 && char === '`') break;
    } else if (triple ? text.startsWith(quote.repeat(3), position) : char === quote) break;
    else if (!triple && char === '\n' && python) break;
    position += 1;
  }
  const body = text.slice(start + (triple ? 3 : 1), position);
  if (python && prefix.includes('f') && /(?<!\{)\{(?!\{)[^{}]+\}/.test(body)) placeholders = true;
  return { end: Math.min(text.length, position + (triple ? 3 : 1)), interpolated: placeholders };
}

/** The text with every string replaced by "S" (plain) or "I" (has placeholders). */
export function maskStrings(text, language) {
  let masked = '';
  let index = 0;
  while (index < text.length) {
    const string = readString(text, index, language);
    if (string) {
      masked += string.interpolated ? '"I"' : '"S"';
      index = string.end;
    } else {
      masked += text[index];
      index += 1;
    }
  }
  return masked;
}

/** True for one string literal, or several joined by `+` or written next to each other, with nothing built into them. */
export const isPlainLiteral = (masked) => /^(?:"S"\s*\+?\s*)+$/.test((masked ?? '').trim());

/**
 * The arguments of the call whose `(` is at `openColumn` of `lines[lineIndex]`, read across following lines.
 * `args` has each argument with strings masked; `raw` has the same arguments as written (comments removed).
 */
export function callArgs(lines, lineIndex, openColumn, language, maxLines = 14) {
  const text = lines.slice(lineIndex, lineIndex + maxLines).map((line) => stripLineComment(line, language)).join('\n');
  const args = [];
  const raw = [];
  let masked = '';
  let index = openColumn + 1;
  let rawStart = index;
  let depth = 0;
  const push = (end) => {
    args.push(masked.replace(/\s+/g, ' ').trim());
    raw.push(text.slice(rawStart, end).replace(/\s+/g, ' ').trim());
    masked = '';
  };
  let closed = false;
  while (index < text.length) {
    const string = readString(text, index, language);
    if (string) {
      masked += string.interpolated ? '"I"' : '"S"';
      index = string.end;
      continue;
    }
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) { push(index); closed = true; break; }
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      push(index);
      index += 1;
      rawStart = index;
      continue;
    }
    masked += char;
    index += 1;
  }
  if (!closed) push(index);
  return { args, raw, closed };
}

/** Every call that matches `pattern` (which must end at the opening parenthesis) on a line, with its arguments. */
export function* callsOn(lines, lineIndex, code, pattern, language) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of code.matchAll(global)) {
    const openColumn = match.index + match[0].length - 1;
    yield { match, ...callArgs(lines.map((line, at) => (at === lineIndex ? code : line)), lineIndex, openColumn, language) };
  }
}

/** The file as lines: the real file when it could be read, otherwise just the added lines in place (blank elsewhere). */
export function linesFor(file, sourceLines) {
  if (Array.isArray(sourceLines)) return { lines: sourceLines, hasSource: true };
  const lines = [];
  for (const change of file.changes ?? []) if (change.side === 'added') lines[change.line - 1] = change.text;
  for (let index = 0; index < lines.length; index += 1) lines[index] ??= '';
  return { lines, hasSource: false };
}

/** Collects candidates, once per rule and key. `options` may set `confidence`, `severity` and `evidence`. */
export function createReporter() {
  const found = [];
  const reported = new Set();
  const report = (ruleId, change, description, options = {}, key = `${ruleId}:${change.line}`) => {
    if (reported.has(key)) return;
    reported.add(key);
    const { evidence, ...fields } = options;
    found.push({ ruleId, line: change.line, description, evidence: evidence ?? clip(change.text), ...fields });
  };
  return { found, report };
}

export const LOWER = { confidence: 'lower' };
export const SUSPICIOUS = { severity: 'suspicious', confidence: 'lower' };

export const windowText = (lines, from, to, language) => lines
  .slice(Math.max(0, from), to + 1)
  .map((line) => stripLineComment(line, language))
  .join('\n');
