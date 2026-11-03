#!/usr/bin/env node
// Hook (Claude Code layer): writes live-view events while a Swag Scan run is active, so the dashboard can show the crew
// starting, finishing and waiting for approval without the model, extra tokens or any extra permission prompt.
//   SubagentStart / SubagentStop        -> started / done (review) for the Analyst, Inspector or Security Guard
//   Notification (permission_prompt)    -> waiting: "<agent> is waiting for you"
// It does nothing unless <cwd>/.swag-scan/run/events.jsonl shows a run in progress, never blocks, never prints, always
// exits 0, and runs asynchronously. It does not track whether a prompt was approved: it only nudges.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUN, emit, runIsActive } from '../skills/review-tools-common/events.mjs';

const AGENT = /^(?:swag-scan:)?(analyst|inspector|security-guard)$/;

/** The crew member for a hook's agent_type, or undefined for any other agent (or the main session). */
export function crewId(agentType) {
  return typeof agentType === 'string' ? AGENT.exec(agentType)?.[1] : undefined;
}

/** Maps one hook input to an event, or undefined when it is not ours to record. */
export function eventFor(input) {
  const agent = crewId(input?.agent_type);
  switch (input?.hook_event_name) {
    case 'SubagentStart':
      return agent ? { kind: 'started', agent, phase: 'review' } : undefined;
    case 'SubagentStop':
      return agent ? { kind: 'done', agent, phase: 'review' } : undefined;
    case 'Notification':
      // The matcher in hooks.json limits this to permission prompts. The prompt may come from an agent or the main session.
      return { kind: 'waiting', agent: agent ?? RUN, phase: 'review' };
    default:
      return undefined;
  }
}

export function handle(input, { env = process.env } = {}) {
  const event = eventFor(input);
  if (!event) return false;
  const runDir = join(resolve(input.cwd ?? process.cwd()), '.swag-scan', 'run');
  if (!runIsActive(runDir)) return false;
  return emit(runDir, event, { env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    handle(JSON.parse(readFileSync(0, 'utf8')));
  } catch {
    // Never let the live view get in the way.
  }
  process.exit(0);
}
