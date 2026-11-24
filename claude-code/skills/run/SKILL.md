---
name: run
description: Run Swag Scan, the pre-pull-request review of the current branch by the Analyst, Inspector and Security Guard. Use when asked to run Swag Scan, review a branch before a pull request, or check changes for bugs, code quality and security.
argument-hint: '[ticket-id] [--agents analyst,inspector,security-guard] [--fresh]'
allowed-tools: Bash(swag-scan *)
---

# Swag Scan

Run the whole review for the current branch. Do not ask the user anything: the settings come from the config that `/swag-scan:config` saved, and the arguments given are all that is typed. The usual call is `/swag-scan:run your_ticket_Id`. The first run changes no files.

## 0. Check the config, then the live view

Before anything else, read the config:

```sh
swag-scan config show --json
```

If `configured` is `false`, say exactly: "Please set up your config file first. Run /swag-scan:config to get started." Then stop. Do not start the live view or the scan.

Otherwise the config decides the rest: the branch to compare against is `targetBranch`, the ticket folder is `ticketSourcePath`, and the live view follows `liveDashboard`. Nobody passes those as flags.

If `liveDashboard` is `false`, skip the live view: never start it and never open a browser. If it is `true`, start the live view in the background (do not wait for it):

```sh
swag-scan dashboard --watch --open
```

It opens a page that shows the crew at work and stops by itself when the scan ends. It costs no model tokens. If it fails to start, say so in one sentence and carry on: the scan does not depend on it.

## 1. Scan (scripts only, no model)

Run exactly one command, in the repository root. `$ARGUMENTS` is what the user typed after the command name. If the first argument is not a flag, it is the ticket ID (for example `ID-123`, looked up as `ID-123.xml` in the ticket folder). Pass the arguments through unchanged. Add nothing for the base branch or the ticket folder: `swag-scan run` reads them from the config.

```sh
swag-scan run [ticket-id] [other arguments]
```

It prints one progress line per agent, then a short summary, and saves the results in `.swag-scan/run/`. Show the user the summary as is. If the command fails, show its one-sentence message and stop.

## 2. Decide who reviews

Read `.swag-scan/run/summary.json`. For each agent in `agents`:

- `status: "empty"`: nothing to check. Say so, and show the user the agent's `suggestion` text as written (it asks them to check the checked-out branch and the target branch in their config). Do not start the agent.
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

It reads what the agents saved and prints one decisions-first report: what needs the developer's decision (a table with 🔴 Critical, 🟠 Feature gap / design issue and 🟡 Cleanup / minor), what was fixed, who looked at what, and coverage. Show it to the user as is. Add nothing to the findings and do not merge, re-rank or soften them.

- If it says an agent did not report, tell the user plainly that the area was not reviewed. Do not start that agent again unless the user asks.
- The report ends its summary with a next step. Do not add a list of flags.
- It never says the code is clean. Do not say so either, especially when files are ⚪ Unchecked.
