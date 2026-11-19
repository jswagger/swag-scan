// The user-level Swag Scan config: one small JSON file outside any repository, set up with /swag-scan:config.
// Location: $SWAG_SCAN_SETTINGS, else ~/.swag-scan/settings.json. Nothing here touches the network.
//
//   ticketSourcePath  folder that holds Jira XML exports named <ID>.xml (empty means: no ticket folder)
//   targetBranch      the branch a change is compared against (default "main")
//   liveDashboard     open the live view while a scan runs (default true)
//   autoFix           let the Inspector fix clear, low-risk cleanup items (default false)
//   maxFileLines      flag a changed file that is longer than this many lines (default 1000)
//
// `ticketFolder` is the older name of `ticketSourcePath`. It is still read when the new key is not set.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const SETTING_KEYS = ['ticketSourcePath', 'targetBranch', 'liveDashboard', 'autoFix', 'maxFileLines'];

export const SETTING_DEFAULTS = Object.freeze({
  ticketSourcePath: '',
  targetBranch: 'main',
  liveDashboard: true,
  autoFix: false,
  maxFileLines: 1000,
});

export const SETUP_MESSAGE = 'Please set up your config file first. Run /swag-scan:config to get started.';

/** A setting the user gave that cannot be used. The message is shown as is. */
export class SettingsError extends Error {}

export function settingsPath(env = process.env, home = homedir()) {
  return env.SWAG_SCAN_SETTINGS ? resolve(env.SWAG_SCAN_SETTINGS) : join(home, '.swag-scan', 'settings.json');
}

/** The raw file contents. Missing or unreadable files read as "not there" so a scan never crashes on them. */
function readRaw(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { exists: true, raw: parsed } : { exists: true, raw: {} };
  } catch {
    return { exists: existsSync(path), raw: {} };
  }
}

/** Turns what a person typed into the right type for one key, or throws a SettingsError that says what is allowed. */
export function parseSetting(key, text) {
  const value = typeof text === 'string' ? text.trim() : text;
  if (key === 'ticketSourcePath' || key === 'targetBranch') {
    if (typeof value !== 'string') throw new SettingsError(`${key} must be text.`);
    if (key === 'targetBranch' && !value) throw new SettingsError('targetBranch cannot be empty. Use main, or the branch your changes are compared against.');
    if (key === 'targetBranch' && (value.startsWith('-') || /\s/.test(value))) throw new SettingsError(`"${value}" is not a branch name Swag Scan can use.`);
    return value;
  }
  if (key === 'liveDashboard' || key === 'autoFix') {
    if (typeof value === 'boolean') return value;
    if (/^(?:true|yes|on)$/i.test(value)) return true;
    if (/^(?:false|no|off)$/i.test(value)) return false;
    throw new SettingsError(`${key} must be true or false.`);
  }
  if (key === 'maxFileLines') {
    const number = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : Number.NaN;
    if (!Number.isInteger(number) || number < 1) throw new SettingsError('maxFileLines must be a whole number of lines, such as 1000.');
    return number;
  }
  throw new SettingsError(`Unknown setting "${key}". Choose from: ${SETTING_KEYS.join(', ')}.`);
}

/**
 * Reads the settings. `values` always has all five keys (defaults fill the gaps; a bad value in the file falls back to
 * the default). `configured` is true only when /swag-scan:config has saved every key, so a file that only has the older
 * `ticketFolder` still counts as "not set up yet".
 */
export function loadSettings(env = process.env, home = homedir()) {
  const path = settingsPath(env, home);
  const { exists, raw } = readRaw(path);
  const values = { ...SETTING_DEFAULTS };
  for (const key of SETTING_KEYS) {
    const source = key === 'ticketSourcePath' && raw.ticketSourcePath === undefined ? raw.ticketFolder : raw[key];
    if (source === undefined) continue;
    try {
      values[key] = parseSetting(key, source);
    } catch {
      // keep the default for a value that cannot be used
    }
  }
  const configured = exists && SETTING_KEYS.every((key) => raw[key] !== undefined);
  return { path, exists, configured, values };
}

/**
 * Saves some settings and keeps every other key in the file. Returns the new settings and a list of plain-language notes
 * (for example when a ticket folder does not exist yet). Values are validated before anything is written.
 */
export function saveSettings(updates, env = process.env, home = homedir()) {
  const path = settingsPath(env, home);
  const { raw } = readRaw(path);
  const next = { ...raw };
  const notes = [];
  for (const [key, text] of Object.entries(updates)) {
    next[key] = parseSetting(key, text);
    if (key === 'ticketSourcePath') {
      delete next.ticketFolder;
      const folder = next[key] && resolve(next[key].startsWith('~') ? join(home, next[key].slice(1)) : next[key]);
      if (folder && !existsSync(folder)) notes.push(`The folder ${next[key]} does not exist yet. Create it before you run Swag Scan on a ticket.`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { ...loadSettings(env, home), notes };
}

/** The settings as short text lines, for `swag-scan config show`. */
export function renderSettings({ path, configured, values }) {
  const shown = (key) => (key === 'ticketSourcePath' && !values[key] ? '(not set)' : String(values[key]));
  return [
    `Swag Scan config: ${path}${configured ? '' : ' (not set up yet: run /swag-scan:config)'}`,
    ...SETTING_KEYS.map((key) => `  ${key}: ${shown(key)}`),
  ].join('\n');
}
