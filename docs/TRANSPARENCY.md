# Transparency: what Swag Scan runs and what it touches

Swag Scan is meant to be read before it is trusted. This page lists every command it runs, every place it reads and writes, and what the three reviewers are allowed to do. Each claim can be checked with the commands in [Verify it yourself](#verify-it-yourself). Checked against commit `73cb28c`.

## The short version

| Question | Answer |
| --- | --- |
| Does it use third-party code? | **No.** There is no `package.json`. Every import in the scripts is a Node built-in (`node:fs`, `node:path`, and so on). |
| Do the scripts use the network? | **No.** There is no `http`, `https`, `net` or `fetch` call and no URL in any script. The live view is a self-contained page that re-reads a local file. |
| Is there telemetry? | **No.** There is no network code to send any. |
| Does my code leave my machine? | **The scripts send nothing anywhere.** The three reviewers are Claude Code subagents, so the changed lines and nearby code they read are seen by the model your Claude Code session already uses, under your own Claude Code account and data settings. |
| Does it change my repository? | The `/swag-scan:run` command writes only inside `.swag-scan/`. `/swag-scan:config` writes only `~/.swag-scan/settings.json`. Only the **Inspector** can edit source files, and only when auto-fix is on. The first run changes no files. |

## Commands the scripts run

The scripts call `git` with an argument list, not through a shell. Nothing here commits, checks out, fetches, pushes or otherwise changes your repository.

| Command | Why |
| --- | --- |
| `git rev-parse --show-toplevel` | Find the repository root |
| `git rev-parse HEAD`, `--short HEAD`, `--abbrev-ref HEAD` | Name the commit and branch being reviewed |
| `git rev-parse --verify --quiet <ref>^{commit}` | Check that a base ref exists |
| `git merge-base <ref> HEAD` | Find where your branch grew from the base |
| `git diff --no-ext-diff --unified=0 <base> --` | Read only the lines you changed |
| `git diff --name-only -z <base> --` | Count changed files |
| `git diff --quiet HEAD` | Decide whether a stored review can be reused (not with uncommitted changes) |
| `git ls-files --others --exclude-standard -z` | Include untracked, non-ignored text files |
| `git ls-files -z` | Match changed files against tracked ones |
| `git grep -n -w -F --untracked -e <symbol> -- <paths>` | Find callers of a changed function |
| `node <script>.mjs` | The plugin runs its own scripts, nothing else |
| `open` / `xdg-open` / `cmd /c start` on `.swag-scan/dashboard.html` | Open the live view. In Claude Code this happens when `liveDashboard` is on in the config (the default); from the command line, only with `--open`. |

## What it reads

- Your branch diff and the untracked, non-ignored text files in the repository. Binary and oversized files are skipped.
- The full text of each changed Python, C#, TypeScript and JavaScript file, read by the Security Auditor's scanner so it can match statements that span several lines. It is matched on your machine and not sent anywhere.
- Code around the changes: callers of changed symbols, and files related to them (see `scope.maxRelatedFiles` in the [reference](REFERENCE.md#security-auditor)).
- A ticket file (`.xml`, `.md` or `.txt`), only if you give a ticket ID (looked up in `ticketSourcePath`), point to one with `--ticket`, or the branch name names one. A Jira XML export is read by a small parser inside Swag Scan; Word and Excel files are not read. Reviewers see only its title, description and acceptance criteria.
- `~/.swag-scan/settings.json` (or the file named by `SWAG_SCAN_SETTINGS`): your config (ticket folder, target branch, live view, auto-fix, file size limit). The `SWAG_SCAN_TICKET_DIR` and `SWAG_SCAN_EVENTS` environment variables.
- The `config.json` next to each skill.

## What it writes

| Where | What | Notes |
| --- | --- | --- |
| `~/.swag-scan/settings.json` | Your config: ticket folder, target branch, live view, auto-fix, file size limit | Only when you run `/swag-scan:config` (or `swag-scan config set`). Outside every repository. |
| `.swag-scan/run/` | Scan results, `summary.json`, each agent's findings, `events.jsonl` | Replaced on every run. The event log holds counts, agent names, file names and finding ids, never code or finding text. |
| `.swag-scan/reports/<commit>/` | `report.md`, `report.html`, `report.json` | The report you read |
| `.swag-scan/cache/` | Stored reviews | At most 50 entries kept |
| `.swag-scan/dashboard.html`, `dashboard-data.js` | The live view | Self-contained: no network, no external fonts or scripts |
| `.bug-hunter/reports/` | Bug Hunter reports | Only when Bug Hunter runs on its own (for example in Copilot). Set `report.outputDir` to change it. |
| `.github/skills/` | Copies of the skill folders | Only when you run `scripts/install-copilot.mjs` |

`SWAG_SCAN_EVENTS=off` turns the event log off.

## What the three reviewers can do

| Reviewer | Tools | Can edit files? |
| --- | --- | --- |
| Analyst | Read, Grep, Glob, Bash | No. Edit and Write are disallowed. |
| Inspector | Read, Grep, Glob, Bash, Edit | **Yes, only with auto-fix on.** Write is disallowed. |
| Security Guard | Read, Grep, Glob, Bash | No. Edit and Write are disallowed. |

A plugin hook (`hooks/guard-bash.mjs`) limits what these three can run in Bash. It is a default-deny allowlist:

- the `swag-scan` command, and `node` running a `.mjs` file inside the plugin's `skills/` folder;
- read-only git: `status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `merge-base`, `blame`, `shortlog`, and a few read-only forms of `branch` and `remote`;
- read-only file and text commands such as `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `jq` and `find` (without `-exec` or `-delete`);
- writes only inside `.swag-scan/` (or `/dev/null`).

Everything else is blocked, including command substitution, subshells, variable assignment prefixes and unknown programs. The hook ignores your own session and every other agent. It is a guardrail, not a sandbox.

Two more hooks (`hooks/events.mjs`) run asynchronously and only while a Swag Scan run is active. They record when a reviewer starts, finishes or is waiting on a permission prompt. They never block anything and never print.

## Verify it yourself

Run these from a clone of the repository. Each should print nothing.

```bash
# 1. Any import that is not a Node built-in or a local file
grep -rhoE "from '[^']+'" skills hooks scripts bin --include=*.mjs --exclude-dir=test | sort -u | grep -vE "from '(node:|\.)"

# 2. Any network API
grep -rnE "node:(http|https|http2|net|tls|dgram|dns)|fetch\(|XMLHttpRequest|WebSocket" skills hooks scripts bin --include=*.mjs --exclude-dir=test

# 3. A package manifest
ls package.json
```

(The third prints an error because the file does not exist.) To see every external command, search for `execFileSync` and `spawn` in `skills/`, `hooks/` and `scripts/`.

To run the test suite, which needs Node 22 or 24 and nothing else:

```bash
node --test \
  "skills/bug-hunter/test/*.test.mjs" \
  "skills/code-sweeper/test/*.test.mjs" \
  "skills/security-auditor/test/*.test.mjs" \
  "skills/review-tools-common/test/*.test.mjs"
```

Found something that does not match this page? [Open an issue](https://github.com/jswagger/swag-scan/issues).
