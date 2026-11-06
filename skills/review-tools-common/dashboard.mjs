// The live view dashboard: turns the event log (events.mjs) into a self-contained HTML page. A script does all of it,
// so it costs no model tokens, and the lines the crew "says" are fixed templates, not model output.
//   buildState(events, summary)  pure: events in, one plain object out (what the page draws)
//   writeDashboard(...)          writes .swag-scan/dashboard.html and .swag-scan/dashboard-data.js
//   watchDashboard(...)          rewrites the data file every couple of seconds until the run ends
// The page holds its first snapshot inline, so it works alone (for example after the run). While a run is live it also
// re-loads dashboard-data.js next to it, which a page opened from disk is allowed to do (it may not fetch files).
// It never contains code or finding text: only the short fields that events carry.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN, readEvents } from './events.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PAGE_TEMPLATE = join(HERE, 'dashboard-page.html');
export const DASHBOARD_FILE = 'dashboard.html';
export const DATA_FILE = 'dashboard-data.js';
const MARKER = '/*__SWAG_SCAN_DATA__*/null';

export const CREW = ['analyst', 'inspector', 'security-guard'];
export const STEP_TITLES = ['Read the diff', 'Scripts scan', 'Agents review', 'Findings saved', 'Report'];
const NAMES = { analyst: 'Analyst', inspector: 'Inspector', 'security-guard': 'Security Guard', [RUN]: 'Swag Scan' };
const TOOLS = { analyst: ['t-bug', 'Bug Hunter'], inspector: ['t-broom', 'Code Sweeper'], 'security-guard': ['t-lock', 'Security Auditor'] };
const LABELS = {
  collect: 'reading the diff', 'size-gate': 'checking the size', ticket: 'reading the ticket', scan: 'scanning',
  callers: 'looking at callers', packets: 'bundling the leads',
};
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const place = (file) => (file ? ` in ${file}` : '');

/** Fixed lines per agent and event. Voice is wording only, and it never replaces a fact (counts, ids, file names). */
const VOICE = {
  analyst: {
    scanStart: () => 'Pulling the numbers on your diff.',
    scanDone: (n) => (n ? `${plural(n, 'lead')} from my scripts. Not verified yet.` : 'My scripts flagged nothing. Not a guarantee, only what they can see.'),
    reviewStart: () => 'Checking each lead against the code.',
    finding: (e) => `${e.id ?? 'Finding'}${place(e.file)}. Writing it up.`,
    saved: (n) => (n ? `${plural(n, 'finding')} recorded. What I verified is in the report.` : 'No findings. What I did and did not verify is in the report.'),
    reviewDone: () => 'Review finished.',
  },
  inspector: {
    scanStart: () => 'Walking the site. Checking it was built to spec.',
    scanDone: (n) => (n ? `${plural(n, 'loose end')} spotted by my scripts. Taking a closer look next.` : 'No loose ends spotted by my scripts. Only what they can see.'),
    reviewStart: () => 'Taking a closer look at each loose end.',
    finding: (e) => `Found a loose end${place(e.file)}.`,
    saved: (n) => (n ? `${plural(n, 'finding')} noted. Everything else is built to spec.` : 'No findings. Nothing else I could see was off spec.'),
    reviewDone: () => 'Inspection finished.',
  },
  'security-guard': {
    scanStart: () => 'Scanning for secrets and risky patterns.',
    scanDone: (n) => (n ? `${plural(n, 'lead')}. Not confirmed yet.` : 'Nothing flagged by my scripts.'),
    reviewStart: () => 'Confirming each lead.',
    finding: (e) => (e.severity === 'critical' ? `Critical${place(e.file)}. Deal with this first.` : `Possible issue${place(e.file)}. Pulling the details.`),
    saved: (n) => (n ? `${plural(n, 'finding')} recorded.` : 'No findings recorded.'),
    reviewDone: () => 'Review finished.',
  },
};
const NO_CHANGES = 'No changes to check.';

const at = (event) => Date.parse(event.t) || 0;

/**
 * Everything the page draws, from the event list and (optionally) summary.json. Pure: the same input gives the same
 * state. `now` is only used to mark how fresh the snapshot is.
 */
export function buildState(events, summary, { now = Date.now() } = {}) {
  const agents = Object.fromEntries(CREW.map((id) => [id, {
    id, name: NAMES[id], state: 'idle', line: 'Standing by.', tool: null, toolUsed: false,
    leads: null, findings: 0, saved: null, reviewed: false,
  }]));
  const feed = [];
  const waiting = [];
  const severities = { critical: 0, design: 0, minor: 0 };
  let status = events.length ? 'live' : 'waiting';
  let reached = 0;
  let startedAt;
  let endedAt;
  let needsDecision;
  let error;

  const say = (id, state, line) => {
    const agent = agents[id];
    if (!agent) return;
    agent.state = state;
    agent.line = line;
    agent.tool = TOOLS[id];
  };
  const note = (event, agent, text, flag = false) => feed.push({ t: event.t, ms: startedAt ? at(event) - startedAt : 0, agent, text, ...(flag ? { flag: true } : {}), ...(TOOLS[agent] ? { tool: TOOLS[agent][1], icon: TOOLS[agent][0] } : {}) });

  for (const event of events) {
    const id = event.agent ?? RUN;
    const voice = VOICE[id];
    switch (event.kind) {
      case 'run-started':
        startedAt = at(event);
        reached = Math.max(reached, 1);
        note(event, RUN, 'Reading your branch diff.');
        break;
      case 'started':
        startedAt ??= at(event);
        if (!voice) break;
        if (event.phase === 'review') {
          agents[id].reviewed = true;
          reached = Math.max(reached, 3);
          say(id, 'working', voice.reviewStart());
          note(event, id, voice.reviewStart());
        } else {
          say(id, 'working', voice.scanStart());
          note(event, id, voice.scanStart());
        }
        break;
      case 'progress':
        reached = Math.max(reached, 2);
        if (voice) say(id, 'working', `Step ${event.step ?? '?'} of ${event.steps ?? '?'}: ${LABELS[event.label] ?? event.label ?? 'working'}.`);
        break;
      case 'done':
        if (id === RUN) {
          if (event.phase === 'scan') {
            reached = Math.max(reached, 3);
            note(event, RUN, `Scripts finished: ${plural(event.count ?? 0, 'lead')} for the crew to review.`);
          }
        } else if (voice && event.phase === 'scan') {
          const agent = agents[id];
          agent.leads = event.count ?? 0;
          if (event.label === 'no changes') {
            say(id, 'done', NO_CHANGES);
            note(event, id, NO_CHANGES);
          } else {
            say(id, agent.leads > 0 ? 'ready' : 'done', voice.scanDone(agent.leads));
            note(event, id, voice.scanDone(agent.leads));
          }
        } else if (voice && event.phase === 'review') {
          const agent = agents[id];
          if (agent.saved === null) {
            say(id, 'done', voice.reviewDone());
            note(event, id, voice.reviewDone());
          } else {
            agent.state = 'done';
          }
        }
        break;
      case 'finding':
        reached = Math.max(reached, 3);
        if (voice) {
          agents[id].findings += 1;
          say(id, 'working', voice.finding(event));
          note(event, id, voice.finding(event), event.severity === 'critical');
        }
        if (event.severity in severities) severities[event.severity] += 1;
        break;
      case 'saved':
        reached = Math.max(reached, 4);
        if (voice) {
          agents[id].saved = event.count ?? 0;
          say(id, 'done', voice.saved(event.count ?? 0));
          note(event, id, voice.saved(event.count ?? 0));
        }
        break;
      case 'waiting': {
        const who = voice ? id : RUN;
        waiting.push({ t: event.t, agent: who });
        if (voice) agents[id].state = 'alert';
        note(event, who, `${NAMES[who]} is waiting for you. Approve the request in the chat window.`);
        break;
      }
      case 'error':
        status = 'error';
        error = event.label ?? 'The scan stopped.';
        endedAt = at(event);
        if (voice) say(id, 'error', error);
        note(event, voice ? id : RUN, error, true);
        break;
      case 'run-done':
        status = 'done';
        endedAt = at(event);
        needsDecision = event.count ?? 0;
        reached = 6;
        note(event, RUN, `Done. ${plural(needsDecision, 'item')} need${needsDecision === 1 ? 's' : ''} your decision.`);
        break;
      default:
        break;
    }
  }

  // Step 5 (Report) is current once every agent that started a review has saved its findings.
  const reviewers = CREW.filter((id) => agents[id].reviewed || agents[id].saved !== null);
  if (reached >= 3 && reached < 6 && reviewers.length && reviewers.every((id) => agents[id].saved !== null)) reached = 5;

  // A run that ends cleanly leaves no agent mid-task; an error leaves the agents as they were.
  if (status === 'done') {
    for (const id of CREW) {
      if (agents[id].state === 'working' || agents[id].state === 'ready' || agents[id].state === 'alert') agents[id].state = 'done';
      if (agents[id].state === 'idle') agents[id].line = 'Not part of this run.';
    }
  }

  const steps = STEP_TITLES.map((title, index) => ({
    title,
    state: reached >= 6 || index + 1 < reached ? 'done' : index + 1 === reached ? 'cur' : '',
  }));
  const last = events.length ? at(events.at(-1)) : undefined;
  const first = summary?.agents?.find((entry) => entry.scannedCount !== undefined) ?? summary?.agents?.[0];
  const findings = CREW.reduce((sum, id) => sum + (agents[id].saved ?? agents[id].findings), 0);

  return {
    v: 1,
    status,
    generatedAt: now,
    startedAt: startedAt ?? null,
    endedAt: endedAt ?? last ?? null,
    lastEventAt: last ?? null,
    run: {
      branch: summary?.branch ?? null,
      base: summary?.base?.ref ?? null,
      files: first?.scannedCount ?? first?.changedCount ?? null,
    },
    steps,
    stats: {
      files: first?.scannedCount ?? first?.changedCount ?? null,
      leads: CREW.some((id) => agents[id].leads !== null) ? CREW.reduce((sum, id) => sum + (agents[id].leads ?? 0), 0) : null,
      findings,
      needs: needsDecision ?? severities.critical + severities.design,
      needsFinal: needsDecision !== undefined,
    },
    agents: CREW.map((id) => agents[id]),
    feed: feed.slice(-200),
    waiting: waiting.slice(-5),
    result: status === 'done'
      ? { text: needsDecision === 0 ? 'Scan finished. Nothing needs your decision.' : `Scan finished. ${plural(needsDecision, 'item')} need${needsDecision === 1 ? 's' : ''} your decision.`, hint: 'Your next step: open the report. It lists what needs your decision and why.' }
      : status === 'error' ? { text: error, hint: 'Nothing was changed in your files.' } : null,
  };
}

const escapeScript = (json) => json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** The whole page, with the snapshot inline. */
export function renderPage(state, template = readFileSync(PAGE_TEMPLATE, 'utf8')) {
  if (!template.includes(MARKER)) throw new Error('The dashboard template has lost its data marker.');
  return template.replace(MARKER, () => escapeScript(JSON.stringify(state)));
}

function readSummary(runDir) {
  try {
    return JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Replaces a file in one step. On Windows the rename fails (EPERM, EBUSY, EACCES) while a browser has the target open, so it
 * is retried briefly and then replaced in place instead. The page re-reads the data file, so a plain overwrite is fine.
 */
function writeAtomic(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      sleep(40);
    }
  }
  writeFileSync(path, text);
  rmSync(temp, { force: true });
}

/**
 * Writes the page and its data file next to each other in <swagDir> (the repo's .swag-scan folder, outside the run
 * folder because a new run replaces that). Never throws for a missing run: it draws "Waiting for a scan".
 */
export function writeDashboard({ swagDir, now = Date.now(), pageOnly = false } = {}) {
  const runDir = join(swagDir, 'run');
  const state = buildState(readEvents(runDir), readSummary(runDir), { now });
  // The button on the finished banner. The path is relative to the page, which sits in .swag-scan/.
  if (state.status === 'done' && state.result) {
    const readable = ['report.html', 'report.md'].find((name) => existsSync(join(runDir, name))); // the web page reads better than raw Markdown
    if (readable) state.result.href = `run/${readable}`;
  }
  mkdirSync(swagDir, { recursive: true });
  const page = join(swagDir, DASHBOARD_FILE);
  const data = join(swagDir, DATA_FILE);
  if (!pageOnly || !existsSync(page)) writeAtomic(page, renderPage(state));
  writeAtomic(data, `window.SWAG_SCAN_DATA = ${escapeScript(JSON.stringify(state))};\n`);
  return { page, data, state };
}

/**
 * Keeps the data file fresh until the run ends (or `maxIdleMs` passes with no new event). Returns a promise that resolves
 * with the final state. `intervalMs` is how often the log is re-read.
 */
export function watchDashboard({ swagDir, intervalMs = 1500, maxIdleMs = 30 * 60 * 1000, onWrite } = {}) {
  return new Promise((resolveWatch) => {
    let lastSeen = Date.now();
    let lastCount = -1;
    // A finished run left over from before this watcher started is not the run we are waiting for.
    const before = buildState(readEvents(join(swagDir, 'run')), undefined);
    const isLeftover = (state) => (before.status === 'done' || before.status === 'error') && state.startedAt === before.startedAt && state.endedAt === before.endedAt;
    const tick = () => {
      let state;
      try {
        ({ state } = writeDashboard({ swagDir, pageOnly: true }));
      } catch {
        // A failed write must never end the watcher: the page shows "not updating" and the next tick tries again.
        setTimeout(tick, intervalMs);
        return;
      }
      onWrite?.(state);
      const count = state.feed.length + state.waiting.length;
      if (count !== lastCount) {
        lastCount = count;
        lastSeen = Date.now();
      }
      if ((state.status === 'done' || state.status === 'error') && !isLeftover(state)) {
        // One last full write so the page on disk is a complete snapshot that works without the data file.
        try {
          resolveWatch(writeDashboard({ swagDir }).state);
        } catch {
          resolveWatch(state); // the page on disk is only one snapshot behind
        }
        return;
      }
      if (Date.now() - lastSeen > maxIdleMs) {
        resolveWatch(state);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    // The first write is a full page, so the file exists before the user opens it.
    try {
      writeDashboard({ swagDir });
    } catch {
      // Same rule as in tick: a failed write is retried, never fatal.
    }
    setTimeout(tick, intervalMs);
  });
}
