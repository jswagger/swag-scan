import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { gatherTicketContext } from '../../bug-hunter/scripts/gather-context.mjs';
import {
  findTicketFile, parseCriteria, parseRepositories, parseTicket, resolveTicketFolder, scopeCriteria, ticketIdFromBranch,
} from '../ticket.mjs';

const TICKET = `# PROJ-123: Add login

Users need to sign in.

## Acceptance Criteria

| # | Title | Description | Repository | Status |
|---|-------|-------------|------------|--------|
| 1 | Login form | Shows email and password | web-app | ✅ Done |
| 2 | Token | API returns a token | api | 🔲 Todo |
| 3 | SSO | Later | api | 🔮 Future |

## Repositories

- web-app: feature/PROJ-123
- api (feature/PROJ-123, base develop)

## Implementation Notes

I used a hack in api/auth.js to make it work.
`;

function folder(context) {
  const directory = mkdtempSync(join(tmpdir(), 'ticket-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const none = { env: {}, userSettings: {} };

test('the ticket ID comes from Jira-style keys in the branch name', () => {
  assert.equal(ticketIdFromBranch('feature/PROJ-123'), 'PROJ-123');
  assert.equal(ticketIdFromBranch('feature/PROJ-123-add-login'), 'PROJ-123');
  assert.equal(ticketIdFromBranch('bugfix/AB2-7_thing'), 'AB2-7');
  assert.equal(ticketIdFromBranch('bugfix-2-typo'), undefined);
  assert.equal(ticketIdFromBranch('main'), undefined);
  assert.equal(ticketIdFromBranch(undefined), undefined);
});

test('the ticket folder follows flag, environment, user settings, then repo config, with no default', () => {
  const userSettings = { ticketFolder: '/user/tickets' };
  const env = { SWAG_SCAN_TICKET_DIR: '/env/tickets' };
  assert.equal(resolveTicketFolder({ flag: '/flag', env, userSettings, repoPath: '/repo' }).path, resolve('/flag')); // resolve() adds a drive letter on Windows
  assert.equal(resolveTicketFolder({ env, userSettings, repoPath: '/repo' }).source, 'SWAG_SCAN_TICKET_DIR');
  assert.equal(resolveTicketFolder({ env: {}, userSettings, repoPath: '/repo' }).source, 'user settings');
  assert.equal(resolveTicketFolder({ env: {}, userSettings: {}, repoPath: '/repo' }).source, 'repo config');
  assert.equal(resolveTicketFolder({ env: {}, userSettings: {} }), undefined);
  assert.equal(resolveTicketFolder({ env: {}, userSettings: { ticketFolder: '~/t' }, home: '/home/me' }).path, '/home/me/t');
});

test('ticket files are found by ID in any letter case, with or without a title suffix', (context) => {
  const directory = folder(context);
  writeFileSync(join(directory, 'proj-5.md'), 'x');
  writeFileSync(join(directory, 'PROJ-7-add-thing.md'), 'x');
  writeFileSync(join(directory, 'PROJ-70.md'), 'x');
  assert.equal(findTicketFile(directory, 'PROJ-5'), join(directory, 'proj-5.md'));
  assert.equal(findTicketFile(directory, 'PROJ-7'), join(directory, 'PROJ-7-add-thing.md'));
  assert.equal(findTicketFile(directory, 'PROJ-1'), undefined);
  assert.equal(findTicketFile(join(directory, 'missing'), 'PROJ-1'), undefined);
});

test('reviewers get the description and acceptance criteria and never the implementation log or statuses', () => {
  const parsed = parseTicket(TICKET);
  assert.match(parsed.review, /Users need to sign in\./);
  assert.match(parsed.review, /AC 1 Login form: Shows email and password \(repository: web-app\)/);
  assert.doesNotMatch(parsed.review, /hack|Implementation|Done|Todo|Future/);
  assert.deepEqual(parsed.omittedSections, ['Implementation Notes']);
  assert.deepEqual(parsed.acceptanceCriteria.map((row) => row.status), ['Done', 'Todo', 'Future']);
});

test('a log nested under the description is dropped, but other subsections stay', () => {
  const parsed = parseTicket('## Description\n\nMain text.\n\n### Edge cases\n\nEmpty input.\n\n### Dev notes\n\nSecret hack.\n');
  assert.match(parsed.review, /Main text\./);
  assert.match(parsed.review, /Edge cases\nEmpty input\./);
  assert.doesNotMatch(parsed.review, /Secret hack/);
});

test('the acceptance table tolerates reordered, missing and differently named columns', () => {
  const rows = parseCriteria([
    '| Status | Details | ID |',
    '| --- | --- | --- |',
    '| ✅ | Handles empty input | AC-1 |',
    '| | Rejects bad token | AC-2 |',
  ]);
  assert.deepEqual(rows.map((row) => [row.id, row.description, row.status]), [
    ['AC-1', 'Handles empty input', 'Done'],
    ['AC-2', 'Rejects bad token', 'Todo'],
  ]);
});

test('acceptance criteria also parse from bullets, numbered items and checkboxes', () => {
  const rows = parseCriteria(['- [ ] User can log in', '- [x] Logout clears the session', '3. AC3: Token expires']);
  assert.deepEqual(rows.map((row) => [row.id, row.description, row.status]), [
    ['1', 'User can log in', 'Todo'],
    ['2', 'Logout clears the session', 'Done'],
    ['AC3', 'Token expires', 'Todo'],
  ]);
});

test('repositories parse from tables and from several bullet styles, including a per-repo base', () => {
  assert.deepEqual(parseRepositories([
    '- web-app: feature/PROJ-123',
    '- api (feature/PROJ-123, base develop)',
    '* `svc` @ feature/x',
    '- plain-repo',
    '- https://github.com/x/y',
  ]), [
    { name: 'web-app', branch: 'feature/PROJ-123' },
    { name: 'api', baseRef: 'develop', branch: 'feature/PROJ-123' },
    { name: 'svc', branch: 'feature/x' },
    { name: 'plain-repo' },
    { name: 'https://github.com/x/y' },
  ]);
  assert.deepEqual(parseRepositories(['| Repository | Branch | Base |', '|---|---|---|', '| api | feature/a | develop |']), [
    { name: 'api', branch: 'feature/a', baseRef: 'develop' },
  ]);
});

test('a ticket with no headings is passed whole, with a note', () => {
  const parsed = parseTicket('Users must be able to log in.\nThe token expires after an hour.');
  assert.match(parsed.review, /token expires/);
  assert.match(parsed.notes[0], /no recognizable headings/);
});

test('the ticket is found from the branch name using the user-level folder', (context) => {
  const directory = folder(context);
  writeFileSync(join(directory, 'PROJ-123.md'), TICKET);
  const ticket = gatherTicketContext(null, undefined, { branch: 'feature/PROJ-123', env: {}, userSettings: { ticketFolder: directory } });
  assert.equal(ticket.found, true);
  assert.equal(ticket.source, 'branch name');
  assert.equal(ticket.ticketName, 'PROJ-123');
  assert.doesNotMatch(ticket.content, /hack/);
  assert.deepEqual(ticket.repositories.map((repository) => repository.name), ['web-app', 'api']);
  assert.match(ticket.notes.join(' '), /Not passed to reviewers.*Implementation Notes/);
});

test('--ticket accepts a bare ID or a path, and a path may sit outside any configured folder', (context) => {
  const tickets = folder(context);
  const elsewhere = folder(context);
  writeFileSync(join(tickets, 'PROJ-9.md'), '## Description\n\nFrom the folder.\n');
  writeFileSync(join(elsewhere, 'notes-on-login.md'), '## Description\n\nFrom a path.\n');
  const options = { env: {}, userSettings: { ticketFolder: tickets } };

  assert.match(gatherTicketContext(null, 'PROJ-9', options).content, /From the folder/);
  assert.match(gatherTicketContext(null, join(elsewhere, 'notes-on-login.md'), options).content, /From a path/);
  const relative = gatherTicketContext(null, 'notes-on-login.md', { ...options, root: elsewhere });
  assert.match(relative.content, /From a path/);
  assert.match(gatherTicketContext(null, join(elsewhere, 'nope.md'), options).notes[0], /Ticket file not found/);
});

test('a ticket inside the repo is read even though scan.exclude skips *.md as a scan target', (context) => {
  const repo = folder(context);
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'docs', 'PROJ-1.md'), '## Acceptance Criteria\n\n- Must work\n');
  const ticket = gatherTicketContext(null, 'docs/PROJ-1.md', { env: {}, userSettings: {}, root: repo });
  assert.equal(ticket.found, true);
  assert.match(ticket.content, /Must work/);
});

test('missing pieces give a helpful note, and an unset feature stays quiet', (context) => {
  const directory = folder(context);
  assert.deepEqual(gatherTicketContext(null, undefined, { branch: 'main', ...none }), { enabled: false, found: false, notes: [] });
  assert.match(gatherTicketContext(null, 'PROJ-1', none).notes[0], /no ticket folder is set/);
  assert.match(gatherTicketContext(null, 'PROJ-1', { env: {}, userSettings: { ticketFolder: directory } }).notes[0], /No PROJ-1\.md or PROJ-1\.txt found/);
  assert.match(gatherTicketContext(null, undefined, { branch: 'main', env: {}, userSettings: { ticketFolder: directory } }).notes[0], /no ticket ID/);
});

test('the CLI reads the ticket folder from the environment and the ID from the branch', (context) => {
  const tickets = folder(context);
  writeFileSync(join(tickets, 'PROJ-123.md'), TICKET);
  const script = fileURLToPath(new URL('../../bug-hunter/scripts/gather-context.mjs', import.meta.url));
  const config = fileURLToPath(new URL('../../bug-hunter/config.json', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--config', config, '--branch', 'feature/PROJ-123'], {
    input: JSON.stringify({ files: [] }),
    encoding: 'utf8',
    env: { ...process.env, SWAG_SCAN_TICKET_DIR: tickets, SWAG_SCAN_SETTINGS: join(tickets, 'none.json') },
  });
  assert.equal(result.status, 0, result.stderr);
  const { ticket } = JSON.parse(result.stdout);
  assert.equal(ticket.found, true);
  assert.equal(ticket.source, 'branch name');
  assert.match(ticket.content, /AC 2 Token/);
});

test('two criteria tables are parsed separately, and criteria for other repositories are scoped out', () => {
  const lines = [
    '| # | Title |', '| --- | --- |', '| 1 | First requirement |', '| 2 | Second requirement |',
    '', 'Tracking per repository:', '',
    '| # | Title | Repository | Status |', '| --- | --- | --- | --- |',
    '| 1a | Panel shows filter | ui-app | Todo |', '| 1b | Import sets type | backend-api | Todo |',
  ];
  const criteria = parseCriteria(lines);
  assert.deepEqual(criteria.map((row) => row.id), ['1', '2', '1a', '1b'], 'the second table header is not read as a row');
  assert.equal(criteria.find((row) => row.id === '1a').repository, 'ui-app');

  const scoped = scopeCriteria(criteria, 'ui-app');
  assert.deepEqual(scoped.filter((row) => row.otherRepo).map((row) => row.id), ['1b']);
  assert.equal(scoped.find((row) => row.id === '1').otherRepo, false, 'a criterion with no repository applies everywhere');
  assert.equal(scopeCriteria(criteria, 'something-else').some((row) => row.otherRepo), false, 'nothing is filtered when no criterion names this repository');
});
