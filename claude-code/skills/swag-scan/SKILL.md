---
name: swag-scan
description: Run Swag Scan, the pre-pull-request review of the current branch by the Analyst, Inspector and Security Guard. Use when asked to run Swag Scan, review a branch before a pull request, or check changes for bugs, code quality and security.
argument-hint: '[base-ref] [--ticket ID] [--agents analyst,inspector,security-guard] [--fresh]'
allowed-tools: Bash(swag-scan *)
---

# Swag Scan

Run the whole review for the current branch. Do not ask the user anything: use the arguments given, and defaults for the rest. The first run changes no files.

## 1. Scan (scripts only, no model)

Run exactly one command, in the repository root. `$ARGUMENTS` is what the user typed after the command name. If the first argument is not a flag, it is the base ref: pass it as `--base <ref>`. Pass the other arguments through unchanged.

```sh
swag-scan run [--base <ref>] [other arguments]
```

It prints one progress line per agent, then a short summary, and saves the results in `.swag-scan/run/`. Show the user the summary as is. If the command fails, show its one-sentence message and stop.

## 2. Decide who reviews

Read `.swag-scan/run/summary.json`. For each agent in `agents`:

- `status: "empty"`: nothing to check. Say so. Do not start the agent.
- `cache.hit: true`: this commit was already reviewed. Point to `cache.reports` and `cache.summary`. Do not start the agent.
- `leads: 0`: the scripts found nothing for this agent, so it does no model review (scripts first, models only where something is flagged). Say so, and still show its coverage line. Say "no leads", never "clean".
- otherwise: start the agent.

If no agent needs to start, skip step 3 and go straight to step 4: the report still explains why each agent did not run and shows the coverage.

## 3. Review (the three agents, in parallel)

Start every agent that needs to run at the same time, in one step, using the agent named for its id: `swag-scan:analyst`, `swag-scan:inspector`, `swag-scan:security-guard`. Tell each one only: "Review your leads from `.swag-scan/run/summary.json`." They know the rest.

## 4. Report

When every agent that was started has replied, build the combined report:

```sh
swag-scan report
```

It reads what the agents saved and prints one decisions-first report: what needs the developer's decision (a table with 🔴 Critical, 🟡 Feature gap / design issue and ✅ Cleanup / minor), what was fixed, the ticket's acceptance criteria with their status and linked findings, who looked at what, and coverage. Show it to the user as is. Add nothing to the findings and do not merge, re-rank or soften them.

- If it says an agent did not report, tell the user plainly that the area was not reviewed. Do not start that agent again unless the user asks.
- The report ends its summary with a next step. Do not add a list of flags.
- It never says the code is clean. Do not say so either, especially when files are ⚪ Unchecked.
