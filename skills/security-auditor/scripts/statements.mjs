// Splits source text into logical statements and joins adjacent string literals, so a rule can match code
// that spans several lines or is built from several pieces. It does not parse the language: it only
// tracks strings, comments and brackets, and it gives up on a statement that runs past MAX_STATEMENT_LINES.

const STRING_MARK = '\u0001';
const MAX_STATEMENT_LINES = 40;

const PREFIX_BY_LANGUAGE = {
  python: /^[rRbBuUfF]{1,2}$/,
  csharp: /^(?:\$@|@\$|\$|@)$/,
};

const LEADING_CONTINUATION = /^(?:\+|\.(?!\d)|&&|\|\||\?)/;
const TRAILING_CONTINUATION = /(?:[+,=&|?.]|\\)$/;

const DYNAMIC_PIECE_PATTERNS = [
  new RegExp(`${STRING_MARK}\\s*\\+\\s*[A-Za-z_$(]`),
  new RegExp(`[A-Za-z_$)\\]]\\s*\\+\\s*${STRING_MARK}`),
  new RegExp(`${STRING_MARK}\\s*\\.\\s*format\\s*\\(`),
  new RegExp(`${STRING_MARK}\\s*%\\s*[A-Za-z_(]`),
  new RegExp(`\\b[Ss]tring\\.Format\\s*\\(\\s*${STRING_MARK}`),
];

const SQL_UPPERCASE = /\b(?:SELECT\b[\s\S]*?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[\w.[\]"`]+\s+SET\b|DELETE\s+FROM\b|MERGE\s+INTO\b|TRUNCATE\s+TABLE\b)/;
const SQL_ANY_CASE = /\b(?:SELECT\b[\s\S]*?\bFROM\b[\s\S]*?\b(?:WHERE|JOIN|ORDER\s+BY|GROUP\s+BY|LIMIT)\b|INSERT\s+INTO\s+[\w.[\]"`]+[\s\S]*?\bVALUES\b|UPDATE\s+[\w.[\]"`]+\s+SET\b[\s\S]*?=|DELETE\s+FROM\s+[\w.[\]"`]+\s+WHERE\b)/i;

/** True when joined string-literal text reads like a SQL statement (not prose that happens to say "select"). */
export function looksLikeSql(text) {
  return SQL_UPPERCASE.test(text) || SQL_ANY_CASE.test(text);
}

/** Placeholders inside an interpolated string body: `{name}` (Python f-string, C# $""), or `${name}` (JS template). */
export function interpolations(body, language) {
  const pattern = language === 'python' || language === 'csharp' ? /(?<!\{)\{([^{}]+)\}/g : /\$\{([^}]*)\}/g;
  return [...body.matchAll(pattern)].map((match) => ({ index: match.index, expression: match[1] }));
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

function buildStatement(tokens, firstLine, lastLine, language) {
  const literals = tokens.filter((token) => token.type === 'string');
  for (const token of literals) {
    token.expressions = token.interpolated ? interpolations(token.body, language).map((item) => item.expression) : [];
  }
  const references = new Set();
  for (const token of tokens) {
    const names = token.type === 'string' ? token.expressions.join(' ') : token.text;
    for (const name of names.match(IDENTIFIER) ?? []) references.add(name);
  }
  const expanded = tokens
    .map((token) => (token.type === 'string' ? `${STRING_MARK}${token.expressions.map((item) => `(${item})`).join('')}` : token.text))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const skeleton = tokens
    .map((token) => (token.type === 'string' ? STRING_MARK : token.text))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const text = tokens
    .map((token) => (token.type === 'string' ? `${token.quote}${token.body}${token.quote}` : token.text))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const dynamic = literals.some((token) => token.interpolated) || DYNAMIC_PIECE_PATTERNS.some((pattern) => pattern.test(skeleton));
  return {
    firstLine,
    lastLine,
    text,
    skeleton,
    sql: literals.map((token) => token.body).join(' '),
    dynamic,
    expanded,
    references,
    parts: tokens,
  };
}

function isInterpolated(language, prefix, quote, body) {
  if (language === 'python') return /[fF]/.test(prefix) && /(?:^|[^{])\{[^{}]+\}/.test(body);
  if (language === 'csharp') return prefix.includes('$') && /(?:^|[^{])\{[^{}]+\}/.test(body);
  return quote === '`' && body.includes('${');
}

/**
 * @param {string[]} sourceLines
 * @param {'python'|'csharp'|'typescript'|'javascript'} language
 * @returns {{firstLine:number,lastLine:number,text:string,skeleton:string,sql:string,dynamic:boolean}[]}
 *   `text` has comments removed and adjacent string literals joined. `sql` is every string body, space-separated.
 *   `skeleton` is `text` with each string replaced by a marker. `dynamic` means a string is built with a variable.
 *   `expanded` is `skeleton` with each interpolated expression kept in brackets after its marker, `references` is every
 *   identifier outside a plain string, and `parts` is the token list (code and strings, in order).
 */
export function logicalStatements(sourceLines, language) {
  const source = sourceLines.join('\n');
  const statements = [];
  const hashComments = language === 'python';
  const slashComments = language !== 'python';
  const prefixPattern = PREFIX_BY_LANGUAGE[language];
  let tokens = [];
  let code = '';
  let depth = 0;
  let line = 1;
  let startLine = null;
  let index = 0;

  const pushCode = () => {
    if (code) tokens.push({ type: 'code', text: code });
    code = '';
  };

  const flush = (endLine) => {
    pushCode();
    if (tokens.some((token) => token.type === 'string' || /\S/.test(token.text))) {
      statements.push(buildStatement(tokens, startLine ?? endLine, endLine, language));
    }
    tokens = [];
    depth = 0;
    startLine = null;
  };

  const nextLineContinues = () => {
    const rest = source.slice(index + 1);
    const match = rest.match(/^(?:[ \t]*\r?\n)*[ \t]*(\S[^\n]{0,2})/);
    return Boolean(match && LEADING_CONTINUATION.test(match[1]));
  };

  while (index < source.length) {
    const char = source[index];

    if (char === '\n') {
      const tooLong = startLine !== null && line - startLine >= MAX_STATEMENT_LINES;
      const trailing = (code.trimEnd() || (tokens.at(-1)?.type === 'code' ? tokens.at(-1).text.trimEnd() : ''));
      const continues = depth > 0 || TRAILING_CONTINUATION.test(trailing) || nextLineContinues();
      line += 1;
      index += 1;
      if (continues && !tooLong) code += ' ';
      else flush(line - 1);
      continue;
    }

    if ((hashComments && char === '#') || (slashComments && char === '/' && source[index + 1] === '/')) {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (slashComments && char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      line += (source.slice(index, stop).match(/\n/g) ?? []).length;
      code += ' ';
      index = stop;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      if (char === '`' && language !== 'javascript' && language !== 'typescript') {
        code += char;
        index += 1;
        continue;
      }
      let prefix = '';
      const prefixMatch = prefixPattern ? code.match(/([A-Za-z$@]{1,2})$/) : null;
      if (prefixMatch && prefixPattern.test(prefixMatch[1]) && !/[\w$]$/.test(code.slice(0, -prefixMatch[1].length))) {
        prefix = prefixMatch[1];
        code = code.slice(0, -prefix.length);
      }
      const verbatim = language === 'csharp' && prefix.includes('@');
      const raw = language === 'python' && /[rR]/.test(prefix);
      const triple = (language === 'python' || language === 'csharp') && source.startsWith(char.repeat(3), index) && char !== '`';
      const quoteLength = triple ? 3 : 1;
      const closing = char.repeat(quoteLength);
      const multiline = triple || char === '`' || verbatim;
      let cursor = index + quoteLength;
      let body = '';
      const stringStartLine = line;

      while (cursor < source.length) {
        const current = source[cursor];
        if (current === '\\' && !verbatim && !(language === 'python' && raw && source[cursor + 1] === '\n')) {
          body += source.slice(cursor, cursor + 2);
          if (source[cursor + 1] === '\n') line += 1;
          cursor += 2;
          continue;
        }
        if (verbatim && current === '"' && source[cursor + 1] === '"') {
          body += '""';
          cursor += 2;
          continue;
        }
        if (source.startsWith(closing, cursor)) {
          cursor += quoteLength;
          break;
        }
        if (current === '\n') {
          if (!multiline) break;
          line += 1;
        }
        body += current;
        cursor += 1;
      }

      if (startLine === null) startLine = stringStartLine;
      const gap = code;
      code = '';
      const previous = tokens.at(-1);
      const interpolated = isInterpolated(language, prefix, char, body);
      if (previous?.type === 'string' && /^\s*(?:\+\s*)?$/.test(gap)) {
        previous.body += body;
        previous.interpolated = previous.interpolated || interpolated;
      } else {
        if (gap) tokens.push({ type: 'code', text: gap });
        tokens.push({ type: 'string', quote: char, body, interpolated });
      }
      index = cursor;
      continue;
    }

    if (startLine === null && /\S/.test(char)) startLine = line;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if ((char === ')' || char === ']' || char === '}') && depth > 0) depth -= 1;
    code += char;
    index += 1;
  }

  flush(line);
  return statements;
}
