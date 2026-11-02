// Per-language coverage: which changed files the tools can read, and which they cannot.
// A file in an unsupported language is "Unchecked", never "Clean". Silence is not safety.

const SUPPORTED = [
  ['Python', /\.py$/i],
  ['C#', /\.cs$/i],
  ['TypeScript', /\.[cm]?tsx?$/i],
  ['JavaScript', /\.[cm]?jsx?$/i],
];

const KNOWN_UNSUPPORTED = {
  go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', rb: 'Ruby', php: 'PHP',
  swift: 'Swift', m: 'Objective-C', c: 'C', h: 'C/C++ header', cpp: 'C++', cc: 'C++', hpp: 'C++', dart: 'Dart',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', sql: 'SQL', vue: 'Vue', svelte: 'Svelte',
  html: 'HTML', css: 'CSS', scss: 'SCSS', lua: 'Lua', r: 'R', pl: 'Perl', ex: 'Elixir', exs: 'Elixir',
  fs: 'F#', vb: 'Visual Basic', tf: 'Terraform', proto: 'Protobuf', graphql: 'GraphQL',
};

// Data, documents and images are not source code, so they are never "Unchecked": there is no code in them to miss.
const NON_CODE = new Set([
  'md', 'markdown', 'txt', 'rst', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'lock',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'pdf', 'snap', 'map', 'log', 'env', 'gitignore',
]);

export const isNonCode = (path) => NON_CODE.has(path.slice(path.lastIndexOf('/') + 1).split('.').slice(1).pop()?.toLowerCase() ?? '');

export function supportedLanguage(path) {
  return SUPPORTED.find(([, pattern]) => pattern.test(path))?.[0];
}

export function unsupportedLanguage(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  const extension = name.slice(dot + 1).toLowerCase();
  return KNOWN_UNSUPPORTED[extension] ?? `.${extension}`;
}

/** `files` are collector files (already filtered by scan.exclude). */
export function summarizeCoverage(files = []) {
  const checked = {};
  const unchecked = [];
  let nonCode = 0;
  for (const file of files) {
    const language = supportedLanguage(file.path);
    if (language) checked[language] = (checked[language] ?? 0) + 1;
    else if (isNonCode(file.path)) nonCode += 1;
    else unchecked.push({ path: file.path, language: unsupportedLanguage(file.path) });
  }
  return { checked, unchecked, nonCode, fileCount: files.length };
}

const plural = (count) => `${count} ${count === 1 ? 'file' : 'files'}`;

/** One line for the top of every report. */
export function renderCoverageLine(coverage) {
  const checked = Object.entries(coverage.checked).sort(([a], [b]) => a.localeCompare(b));
  const parts = [];
  parts.push(checked.length
    ? `Checked: ${checked.map(([language, count]) => `${language} (${plural(count)})`).join(', ')}`
    : 'Checked: nothing in a supported language');
  if (coverage.unchecked.length) {
    const languages = [...new Set(coverage.unchecked.map((file) => file.language))].sort();
    parts.push(`⚪ Unchecked: ${plural(coverage.unchecked.length)} in ${languages.join(', ')} (not a supported language, so not reviewed)`);
  }
  if (coverage.nonCode) parts.push(`${plural(coverage.nonCode)} of data or docs, not code`);
  return `Coverage: ${parts.join(' · ')}.`;
}
