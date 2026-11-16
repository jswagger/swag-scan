// The event log: scripts (and, in Claude Code, hooks) append one JSON line per event to <run-dir>/events.jsonl.
// A dashboard, a status line or any other tool can read the file later. The log is a side channel only:
//   - it costs no model tokens (scripts and hooks write it, never the model),
//   - it never blocks or fails a scan (every write is best effort and swallows errors),
//   - it holds no code and no finding text: only a small, fixed set of short fields.
// Turn it off with SWAG_SCAN_EVENTS=off. The shape is documented in the README ("Event log").

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const EVENT_VERSION = 1;
export const EVENTS_FILE = 'events.jsonl';

/** What an event means. `done` ends a phase for an agent; `saved` means its findings file was written. */
export const KINDS = ['run-started', 'started', 'progress', 'finding', 'saved', 'done', 'waiting', 'error', 'run-done'];
export const PHASES = ['scan', 'review', 'report'];

const STRING_FIELDS = ['agent', 'kind', 'phase', 'label', 'file', 'severity', 'id'];
const NUMBER_FIELDS = ['step', 'steps', 'count', 'total'];
const MAX_TEXT = 120;
/** Run-level events use this agent name. */
export const RUN = 'swag-scan';

const oneLine = (value) => String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/** Keeps only known short fields, so an event can never carry code or long text. Returns undefined for a bad event. */
export function cleanEvent(event, now = new Date()) {
  if (!event || !KINDS.includes(event.kind)) return undefined;
  const cleaned = { v: EVENT_VERSION, t: now.toISOString() };
  for (const field of STRING_FIELDS) {
    if (event[field] !== undefined && event[field] !== null && event[field] !== '') cleaned[field] = oneLine(event[field]);
  }
  if (cleaned.phase && !PHASES.includes(cleaned.phase)) delete cleaned.phase;
  for (const field of NUMBER_FIELDS) {
    if (Number.isFinite(event[field])) cleaned[field] = Math.max(0, Math.trunc(event[field]));
  }
  cleaned.agent ??= RUN;
  return cleaned;
}

/** Appends one event. Never throws. Returns true when a line was written. */
export function emit(runDir, event, { env = process.env, now = new Date() } = {}) {
  try {
    if (env.SWAG_SCAN_EVENTS === 'off') return false;
    const cleaned = cleanEvent(event, now);
    if (!cleaned) return false;
    appendFileSync(join(runDir, EVENTS_FILE), `${JSON.stringify(cleaned)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Reads every well-formed line. A half-written last line, or a damaged line, is skipped. */
export function readEvents(runDir) {
  try {
    return readFileSync(join(runDir, EVENTS_FILE), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event && typeof event === 'object' && KINDS.includes(event.kind) ? [event] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

/**
 * True while a scan is in progress here: an events file exists, was written to within the last half hour, and its last
 * event is not run-done or error. Cheap enough for a hook that runs on every subagent start and permission prompt.
 */
export function runIsActive(runDir, { now = Date.now(), windowMs = ACTIVE_WINDOW_MS } = {}) {
  const path = join(runDir, EVENTS_FILE);
  try {
    if (!existsSync(path)) return false;
    const { size, mtimeMs } = statSync(path);
    if (now - mtimeMs > windowMs) return false;
    const length = Math.min(size, 4096);
    const buffer = Buffer.alloc(length);
    const descriptor = openSync(path, 'r');
    try {
      readSync(descriptor, buffer, 0, length, size - length);
    } finally {
      closeSync(descriptor);
    }
    const last = buffer.toString('utf8').split('\n').filter(Boolean).at(-1);
    const kind = JSON.parse(last)?.kind;
    return kind !== 'run-done' && kind !== 'error';
  } catch {
    return false;
  }
}
