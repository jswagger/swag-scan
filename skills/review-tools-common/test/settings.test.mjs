import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SETTING_DEFAULTS, SettingsError, loadSettings, parseSetting, renderSettings, saveSettings, settingsPath } from '../settings.mjs';
import { resolveTicketFolder } from '../ticket.mjs';

function home(context) {
  const directory = mkdtempSync(join(tmpdir(), 'swag-settings-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('with no file, every setting has its documented default and the config is not set up', (context) => {
  const loaded = loadSettings({}, home(context));
  assert.equal(loaded.configured, false);
  assert.deepEqual(loaded.values, { ticketSourcePath: '', targetBranch: 'main', liveDashboard: true, autoFix: false, maxFileLines: 1000 });
  assert.deepEqual(loaded.values, SETTING_DEFAULTS);
});

test('the settings file is ~/.swag-scan/settings.json unless SWAG_SCAN_SETTINGS names another', (context) => {
  const directory = home(context);
  assert.equal(settingsPath({}, directory), join(directory, '.swag-scan', 'settings.json'));
  assert.equal(settingsPath({ SWAG_SCAN_SETTINGS: join(directory, 'x.json') }, directory), join(directory, 'x.json'));
});

test('values are checked and typed', () => {
  assert.equal(parseSetting('liveDashboard', 'false'), false);
  assert.equal(parseSetting('autoFix', 'Yes'), true);
  assert.equal(parseSetting('maxFileLines', '1500'), 1500);
  assert.equal(parseSetting('targetBranch', ' develop '), 'develop');
  assert.equal(parseSetting('ticketSourcePath', ''), '');
  for (const [key, value] of [['maxFileLines', '0'], ['maxFileLines', '12.5'], ['maxFileLines', 'big'], ['autoFix', 'maybe'], ['targetBranch', ''], ['targetBranch', '--force'], ['targetBranch', 'two words'], ['nope', '1']]) {
    assert.throws(() => parseSetting(key, value), SettingsError, `${key}=${value}`);
  }
});

test('saving writes the file, keeps other keys, and a complete file counts as set up', (context) => {
  const directory = home(context);
  const env = {};
  writeFileSync(join(directory, 'seed.json'), JSON.stringify({ other: 1 }));
  const seeded = { SWAG_SCAN_SETTINGS: join(directory, 'seed.json') };
  saveSettings({ targetBranch: 'develop' }, seeded, directory);
  assert.equal(loadSettings(seeded, directory).configured, false, 'one key is not a full setup');
  saveSettings({ ticketSourcePath: directory, liveDashboard: 'false', autoFix: 'true', maxFileLines: '900' }, seeded, directory);
  const loaded = loadSettings(seeded, directory);
  assert.equal(loaded.configured, true);
  assert.deepEqual(loaded.values, { ticketSourcePath: directory, targetBranch: 'develop', liveDashboard: false, autoFix: true, maxFileLines: 900 });
  assert.equal(JSON.parse(readFileSync(seeded.SWAG_SCAN_SETTINGS, 'utf8')).other, 1);

  const fresh = saveSettings({ targetBranch: 'main' }, env, directory);
  assert.equal(fresh.path, join(directory, '.swag-scan', 'settings.json'), 'the folder is created when needed');
  assert.ok(existsSync(fresh.path));
});

test('a value that cannot be saved changes nothing', (context) => {
  const directory = home(context);
  const env = { SWAG_SCAN_SETTINGS: join(directory, 's.json') };
  saveSettings({ maxFileLines: '700' }, env, directory);
  assert.throws(() => saveSettings({ targetBranch: 'ok', maxFileLines: 'nope' }, env, directory), /whole number/);
  assert.equal(loadSettings(env, directory).values.maxFileLines, 700);
  assert.equal(loadSettings(env, directory).values.targetBranch, 'main');
});

test('the older ticketFolder key still works until ticketSourcePath is saved, then it is replaced', (context) => {
  const directory = home(context);
  const env = { SWAG_SCAN_SETTINGS: join(directory, 's.json') };
  writeFileSync(env.SWAG_SCAN_SETTINGS, JSON.stringify({ ticketFolder: '/old/tickets' }));
  assert.equal(loadSettings(env, directory).values.ticketSourcePath, '/old/tickets');
  assert.equal(loadSettings(env, directory).configured, false);
  assert.equal(resolveTicketFolder({ env, home: directory }).source, 'user settings');
  const saved = saveSettings({ ticketSourcePath: '/new/tickets' }, env, directory);
  assert.equal(JSON.parse(readFileSync(env.SWAG_SCAN_SETTINGS, 'utf8')).ticketFolder, undefined);
  assert.match(saved.notes[0], /\/new\/tickets does not exist yet/);
  assert.equal(resolveTicketFolder({ env, home: directory }).path.replaceAll('\\', '/').endsWith('/new/tickets'), true);
});

test('a broken settings file reads as defaults instead of crashing', (context) => {
  const directory = home(context);
  const env = { SWAG_SCAN_SETTINGS: join(directory, 's.json') };
  writeFileSync(env.SWAG_SCAN_SETTINGS, '{ not json');
  const loaded = loadSettings(env, directory);
  assert.equal(loaded.configured, false);
  assert.equal(loaded.values.targetBranch, 'main');
  assert.match(renderSettings(loaded), /not set up yet: run \/swag-scan:config/);
});
