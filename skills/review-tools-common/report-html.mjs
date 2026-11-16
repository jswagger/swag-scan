// Turns the report's Markdown into one self-contained web page, so "Open the full report" shows tables and bold text
// instead of raw characters. No model, no network, no libraries: it handles only what report.mjs writes
// (headings, paragraphs, tables, bullets, quotes, fenced code, **bold**, _italic_ and `code`).
// Everything is escaped first, because finding text comes from a model and the code under review.

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline formatting on text that is not yet escaped. Code spans are cut out first so their contents stay literal. */
function inline(text) {
  return text.split(/(`[^`]+`)/).map((part, index) => {
    if (index % 2) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    return escapeHtml(part)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])_(.+?)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  }).join('');
}

/** Splits a table row on pipes that are not escaped as \| (the report escapes pipes inside cells). */
function cells(row) {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((entry) => entry.trim().replace(/\\\|/g, '|'));
}

const isRule = (row) => cells(row).every((entry) => /^:?-{2,}:?$/.test(entry));

function renderTable(rows) {
  const [header, , ...body] = rows;
  const head = cells(header).map((entry) => `<th>${inline(entry)}</th>`).join('');
  const lines = body.map((row) => `<tr>${cells(row).map((entry) => `<td>${inline(entry)}</td>`).join('')}</tr>`).join('');
  return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${lines}</tbody></table></div>`;
}

export function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    const fence = /^(`{3,})/.exec(line);
    if (fence) {
      const code = [];
      for (i += 1; i < lines.length && !lines[i].startsWith(fence[1]); i += 1) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (line.trim().startsWith('|') && lines[i + 1] && isRule(lines[i + 1])) {
      const rows = [];
      for (; i < lines.length && lines[i].trim().startsWith('|'); i += 1) rows.push(lines[i]);
      i -= 1;
      out.push(renderTable(rows));
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i]); i += 1) items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
      i -= 1;
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      for (; i < lines.length && lines[i].startsWith('>'); i += 1) quote.push(lines[i].replace(/^>\s?/, ''));
      i -= 1;
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }
    const paragraph = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|`{3}|\||\s*[-*]\s|>)/.test(lines[i]); i += 1) paragraph.push(lines[i].trim());
    i -= 1;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}

const STYLE = `
:root { --bg: #F7F6F2; --surface: #FFFFFF; --fg: #29384B; --muted: #3F4D60; --line: #D6CFBF; --accent: #8A5A2B; --chip: #ECE7DC; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #1A2230; --surface: #232E40; --fg: #ECE7DC; --muted: #B3BDCD; --line: #3A475C; --accent: #E7C9A5; --chip: #2F3C52; color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #1A2230; --surface: #232E40; --fg: #ECE7DC; --muted: #B3BDCD; --line: #3A475C; --accent: #E7C9A5; --chip: #2F3C52; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 26px; line-height: 1.25; margin: 0 0 12px; overflow-wrap: anywhere; }
h2 { font-size: 20px; margin: 32px 0 10px; padding-top: 14px; border-top: 1px solid var(--line); }
h3 { font-size: 16px; margin: 24px 0 6px; overflow-wrap: anywhere; }
p, ul { margin: 8px 0; } li { margin: 3px 0; } p, li, td, th, blockquote { overflow-wrap: anywhere; }
code { font: 13px/1.4 ui-monospace, 'Cascadia Mono', Menlo, monospace; background: var(--chip); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 10px 0; padding: 6px 14px; border-left: 4px solid var(--accent); background: var(--surface); color: var(--muted); }
.table { overflow-x: auto; margin: 10px 0; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 8px 12px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; white-space: nowrap; } tr:last-child td { border-bottom: 0; }
td:first-child { white-space: nowrap; } /* finding and criterion ids stay on one line */
`;

/** The whole page as one string. `title` is the plain-text page title. */
export function renderReportHtml(markdown, title = 'Swag Scan report') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${markdownToHtml(markdown)}
</main>
</body>
</html>
`;
}
