import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// SS-104, supply chain and CI rules. Each rule has a true-positive case and a harmless case, run on a real file on disk.

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scannerPath = fileURLToPath(new URL('../scripts/scan-patterns.mjs', import.meta.url));

function scan(files) {
  const result = spawnSync(process.execPath, [scannerPath], { cwd: workspaceRoot, encoding: 'utf8', input: JSON.stringify({ files }) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const added = (path, lines) => ({ path, changes: lines.map((text, index) => ({ side: 'added', line: index + 1, text })) });

/** Writes the lines to a real file (folders included) and scans it as if every line were added. */
function scanFile(context, name, lines) {
  const directory = mkdtempSync(join(tmpdir(), 'supply-chain-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'));
  return scan([added(path, lines)]);
}

const ids = (report) => report.candidates.map((candidate) => candidate.ruleId);
const flagged = (context, rule, name, lines) => ids(scanFile(context, name, lines)).includes(rule);

test('SUP-601 flags pull_request_target that checks out the pull request and ignores the safe forms', (context) => {
  const risky = [["on: pull_request_target", "jobs:", "  b:", "    steps:", "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567", "        with:", "          ref: ${{ github.event.pull_request.head.sha }}"], ["on:", "  pull_request_target:", "jobs:", "  b:", "    steps:", "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567", "        with:", "          ref: ${{ github.head_ref }}"]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-601', ".github/workflows/ci.yml", lines), true, lines.join(' '));
  const harmless = [["on: pull_request_target", "jobs:", "  b:", "    steps:", "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567"], ["on: pull_request", "jobs:", "  b:", "    steps:", "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567", "        with:", "          ref: ${{ github.event.pull_request.head.sha }}"]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-601', ".github/workflows/ci.yml", lines), false, lines.join(' '));
});

test('SUP-602 flags untrusted event text inside a run step and ignores the safe forms', (context) => {
  const risky = [["jobs:", "  b:", "    steps:", "      - run: echo \"${{ github.event.pull_request.title }}\""], ["jobs:", "  b:", "    steps:", "      - run: |", "          echo ${{ github.head_ref }}"], ["jobs:", "  b:", "    steps:", "      - run: echo ${{ github.event.issue.body }}"]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-602', ".github/workflows/ci.yml", lines), true, lines.join(' '));
  const harmless = [["jobs:", "  b:", "    steps:", "      - uses: actions/github-script@0123456789abcdef0123456789abcdef01234567", "        with:", "          t: ${{ github.event.pull_request.title }}"], ["jobs:", "  b:", "    steps:", "      - run: echo \"$TITLE\"", "        env:", "          TITLE: ${{ github.event.pull_request.title }}"], ["jobs:", "  b:", "    steps:", "      - run: echo ${{ github.sha }}"]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-602', ".github/workflows/ci.yml", lines), false, lines.join(' '));
});

test('SUP-603 flags actions not pinned to a commit and ignores the safe forms', (context) => {
  const risky = [["jobs:", "  b:", "    steps:", "      - uses: actions/checkout@v4"], ["jobs:", "  b:", "    steps:", "      - uses: some/action@main"]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-603', ".github/workflows/ci.yml", lines), true, lines.join(' '));
  const harmless = [["jobs:", "  b:", "    steps:", "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v4"], ["jobs:", "  b:", "    steps:", "      - uses: ./.github/actions/local"]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-603', ".github/workflows/ci.yml", lines), false, lines.join(' '));
});

test('SUP-604 flags permissions: write-all and ignores the safe forms', (context) => {
  const risky = [["permissions: write-all", "jobs: {}"]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-604', ".github/workflows/ci.yml", lines), true, lines.join(' '));
  const harmless = [["permissions:", "  contents: read", "jobs: {}"]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-604', ".github/workflows/ci.yml", lines), false, lines.join(' '));
});

test('SUP-605 flags a new install-time script in package.json and ignores the safe forms', (context) => {
  const risky = [["{", "  \"scripts\": {", "    \"postinstall\": \"node setup.js\"", "  }", "}"], ["{", "  \"scripts\": {", "    \"preinstall\": \"curl x | sh\"", "  }", "}"]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-605', "package.json", lines), true, lines.join(' '));
  const harmless = [["{", "  \"scripts\": {", "    \"build\": \"tsc\"", "  }", "}"], ["{", "  \"devDependencies\": {", "    \"install\": \"^0.13.0\"", "  }", "}"]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-605', "package.json", lines), false, lines.join(' '));
});

test('SUP-606 flags new dependencies in package.json, requirements, pyproject and csproj and ignores the safe forms', (context) => {
  const risky = [["{", "  \"dependencies\": {", "    \"left-pad\": \"^1.3.0\"", "  }", "}"], ["{", "  \"devDependencies\": {", "    \"vitest\": \"^2.0.0\"", "  }", "}"]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-606', "package.json", lines), true, lines.join(' '));
  const harmless = [["{", "  \"name\": \"app\",", "  \"version\": \"1.0.0\"", "}"], ["{", "  \"scripts\": {", "    \"build\": \"tsc\"", "  }", "}"]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-606', "package.json", lines), false, lines.join(' '));
});

test('SUP-606 flags a new Python dependency and ignores the safe forms', (context) => {
  const risky = [["flask==3.0"], ["requests>=2"]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-606', "requirements.txt", lines), true, lines.join(' '));
  const harmless = [["# a comment"], ["-r base.txt"]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-606', "requirements.txt", lines), false, lines.join(' '));
});

test('SUP-606 flags a new NuGet package and ignores the safe forms', (context) => {
  const risky = [["<ItemGroup>", "  <PackageReference Include=\"Newtonsoft.Json\" Version=\"13.0.3\" />", "</ItemGroup>"]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-606', "App.csproj", lines), true, lines.join(' '));
  const harmless = [["<PropertyGroup>", "  <TargetFramework>net8.0</TargetFramework>", "</PropertyGroup>"]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-606', "App.csproj", lines), false, lines.join(' '));
});

test('SUP-606 flags a new pyproject dependency and ignores the safe forms', (context) => {
  const risky = [["[project]", "dependencies = [", "  \"httpx>=0.27\",", "]"], ["[tool.poetry.dependencies]", "python = \"^3.11\"", "rich = \"^13\""]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-606', "pyproject.toml", lines), true, lines.join(' '));
  const harmless = [["[project]", "name = \"app\"", "version = \"1.0\""], ["[tool.poetry.dependencies]", "python = \"^3.11\""]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-606', "pyproject.toml", lines), false, lines.join(' '));
});

test('SUP-607 flags a .pth file and setup.py that runs code at install and ignores the safe forms', (context) => {
  const risky = [["import os; os.system('x')"]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-607', "evil.pth", lines), true, lines.join(' '));
  const harmless = [[]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-607', "notes.txt", lines), false, lines.join(' '));
});

test('SUP-607 flags setup.py that runs commands and ignores the safe forms', (context) => {
  const risky = [["import subprocess", "subprocess.run(['curl', 'x'])", "setup(name='a')"], ["from urllib.request import urlopen", "urlopen('http://x')"]];
  for (const lines of risky) assert.equal(flagged(context, 'SUP-607', "setup.py", lines), true, lines.join(' '));
  const harmless = [["from setuptools import setup", "setup(name='a', version='1.0')"]];
  for (const lines of harmless) assert.equal(flagged(context, 'SUP-607', "setup.py", lines), false, lines.join(' '));
});

