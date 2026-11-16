import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownToHtml, renderReportHtml } from '../report-html.mjs';

test('headings, bold, code, quotes and bullets become real elements', () => {
  const html = markdownToHtml([
    '# Swag Scan report: feature vs main', '',
    '**2 items need your decision** (1 critical).', '',
    '> **Analyst:** Check the guard.', '',
    '- plain item', '- `src/app.js` (python)', '',
    '_Status comes from the ticket._',
  ].join('\n'));
  assert.match(html, /<h1>Swag Scan report: feature vs main<\/h1>/);
  assert.match(html, /<strong>2 items need your decision<\/strong>/);
  assert.match(html, /<blockquote><strong>Analyst:<\/strong> Check the guard\.<\/blockquote>/);
  assert.match(html, /<ul><li>plain item<\/li><li><code>src\/app\.js<\/code> \(python\)<\/li><\/ul>/);
  assert.match(html, /<em>Status comes from the ticket\.<\/em>/);
});

test('tables keep escaped pipes inside a cell and use the header row', () => {
  const html = markdownToHtml(['| # | Severity | Item |', '| --- | --- | --- |', '| AN-1 | 🔴 Critical | **Guard** · `a\\|b` |'].join('\n'));
  assert.match(html, /<th>#<\/th><th>Severity<\/th><th>Item<\/th>/);
  assert.match(html, /<td>AN-1<\/td><td>🔴 Critical<\/td><td><strong>Guard<\/strong> · <code>a\|b<\/code><\/td>/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 2, 'one header row and one body row');
});

test('fenced code stays literal and nothing from the report can inject markup', () => {
  const html = markdownToHtml(['### AN-1 <img src=x onerror=alert(1)>', '', '```', 'if (a < b && c) { **not bold** }', '```', '', 'Text with <script>alert(1)</script> and `<b>`.'].join('\n'));
  assert.doesNotMatch(html, /<img|<script|<b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<pre><code>if \(a &lt; b &amp;&amp; c\) \{ \*\*not bold\*\* \}<\/code><\/pre>/);
});

test('the page is self-contained, themed, and escapes its title', () => {
  const page = renderReportHtml('# Hi', 'A <title>');
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<title>A &lt;title&gt;<\/title>/);
  assert.match(page, /prefers-color-scheme: dark/);
  assert.doesNotMatch(page, /<link|<script|https?:\/\//, 'no network, no scripts');
});
