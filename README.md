<p align="center">
  <img src="assets/swagScanLogo.jpg" alt="Swag Scan logo" width="240">
</p>

# Swag Scan

[![Tests](https://github.com/jswagger/swag-scan/actions/workflows/test.yml/badge.svg)](https://github.com/jswagger/swag-scan/actions/workflows/test.yml)

Pre-PR review skills for coding agents. Three focused reviewers that check only your change, never the whole repo.

| Skill | Question it answers | Report |
| --- | --- | --- |
| [Bug Hunter](#bug-hunter) | What did this change break, and what new bugs did it add? | 🔴 Probable Bugs · 🟡 Suspicious · 🟢 Clean |
| [Code Sweeper](#code-sweeper) | Is this change clean, simple, and well tested? | 🔴 Unclean · 🟡 Dusty · 🟢 Clean |
| [Security Auditor](#security-auditor) | Does this change introduce vulnerabilities? | High Risk · Suspicious · Clean |

The skills don't overlap: Bug Hunter skips style and vulnerabilities, Code Sweeper skips bugs and security, and so on. Each one **collects** the diff, **scans** it with fast heuristics that flag *candidates*, then **reviews** each candidate in context. Matches are leads, not verdicts.

## Install

**Claude Code**

```
/plugin marketplace add jswagger/swag-scan
/plugin install swag-scan@swag-scan
```

**GitHub Copilot (VS Code)**

```bash
git clone --depth 1 https://github.com/jswagger/swag-scan.git && node swag-scan/scripts/install-copilot.mjs
```

Run it from your project root. Skills land in `.github/skills/`. Use `--target .agents/skills` for that folder instead, `--project DIR` to install elsewhere, and `--force` to overwrite an existing install.

## Use

```
/bug-hunter origin/main --ticket PROJ-123
/code-sweeper origin/main
/code-sweeper --no-fix          # review only, no edits
/security-auditor origin/main
```

In Claude Code, skills are namespaced: `/swag-scan:bug-hunter`. Leave off the base ref to use the configured default branch.

### Claude Code: the whole crew in one command

```
/swag-scan:swag-scan [base-ref] [--ticket PROJ-123] [--agents analyst,security-guard] [--fresh]
```

The command scans with scripts only (no model, no edits), then starts the **Analyst**, **Inspector** and **Security Guard** in parallel for the ones that have leads. Each saves its findings (with a line in its own voice), and a script builds one decisions-first report from them with no model tokens: items that need your decision, what was fixed, your ticket's acceptance criteria with their status and linked findings, who looked at what, and coverage. It is saved to `.swag-scan/reports/<commit>/`. Agents with no leads are skipped, and the report says "no leads", never "clean". You can also ask for them by name, for example `@agent-swag-scan:security-guard`.

Fewer permission prompts: add `Bash(swag-scan *)` to your allowed commands. The plugin puts a `swag-scan` command on the Bash path, and every run uses that one shape.

The three agents have limits: none can create files, only the Inspector can edit (and only with auto-fix on), and the Analyst and Security Guard are report-only. A plugin hook also restricts what they can run in Bash to the Swag Scan scripts, read-only git and read-only file commands, and lets them write only inside `.swag-scan/`. The hook ignores your own session and every other agent. It is a guardrail, not a sandbox.

### Findings format

Each agent hands in its judged findings in one shared shape, saved by `skills/review-tools-common/save-findings.mjs` to `.swag-scan/run/findings-<agent>.json`. The script checks the findings, assigns ids (`AN-1`, `IN-1`, `SG-1`, critical first) and adds the tool, base, coverage line and counts.

| Severity | Meaning | Needs |
| --- | --- | --- |
| 🔴 `critical` | Will break or is exploitable | `evidence` (a concrete failing input or state) and a `recommendation` or something to `verify` |
| 🟡 `design` | Feature gap or design issue | `verify`: the one thing to check |
| ✅ `minor` | Cleanup | `recommendation` |

| Disposition | Meaning |
| --- | --- |
| `needs-decision` | The developer must weigh it. The default, and the only one the Analyst and Security Guard can use (they are report-only). |
| `auto-fixed` | The Inspector fixed it. Needs a `fixNote`. Listed in the report, not commented on in a review view. |
| `would-auto-fix` | A safe fix exists but auto-fix was off for this run (for example the first, report-only run). |

Other fields: `title`, `rule`, `file` and `line` (the line in the new version of the file, or a `locations` list), `flaggedText` (the exact code on that line, so the finding can be found again after fixes), `criteria` (ids of the ticket's acceptance criteria it relates to, checked against the ticket), `confidence`, and `voiceLine` (the agent's one-sentence voice, kept apart from the facts). The Analyst can hand in Bug Hunter's own findings file with `--format bug-hunter`: probable bugs become critical, suspicious items become design issues.

Ticket criterion status (todo, done, future) is saved separately in `.swag-scan/run/ticket-report.json` for the report, and kept out of the files the agents read, because what is already built would bias a review.

### Run everything at once

One fixed command runs all three agents' scripts in a fixed order. No model decides what runs, it uses no model tokens, and it changes no files:

```bash
node skills/review-tools-common/swag-scan.mjs run [--base main] [--ticket PROJ-123] [--agents analyst,security-guard] [--fresh] [--json]
```

It prints one progress line per agent, then a short summary: leads per agent, the language coverage line, the ticket it found, and whether a stored review already covers this commit. Leads are script matches, not verified findings. Results are written to `.swag-scan/run/` (replaced every run, gitignored). Because the command is always the same shape, one permission rule covers it.

The scripts also run on their own. Scanners print candidates as JSON and never apply fixes:

```bash
node skills/review-tools-common/collect-diff.mjs \
  --config skills/code-sweeper/config.json origin/main \
  | node skills/code-sweeper/scripts/scan-patterns.mjs
```

Which diff is reviewed:

- No argument: the base is detected automatically. It tries `origin/HEAD`, `develop`, `test`, `main`, then `master`, and picks the closest one your branch grew from. The collector prints which one it chose. If it finds no changes, it says so and suggests a ref.
- A ref such as `origin/main` is compared from `git merge-base <ref> HEAD`, so target-only commits are excluded.
- `HEAD` compares only the working tree, which is often empty on a clean feature branch.
- Untracked, non-ignored text files are included. Binary and oversized files are skipped.

## Bug Hunter

A regression safety net. It looks for removed guards, dropped awaits, changed contracts, and broken callers, then checks the change against your ticket's acceptance criteria.

- **Rules:** `REMOVED_GUARD`, `REMOVED_AWAIT`, `REMOVED_ERROR_HANDLING`, `REMOVED_CLEANUP`, `MISSING_RELEASE`, `REMOVED_EARLY_EXIT`, `BEHAVIOR_CHANGE_PAIR`, `SIGNATURE_CHANGED`, `REMOVED_TEST_ASSERTION`, `TEST_DISABLED`.
- **Packets:** scripts rank findings by risk and bundle them with surrounding code and callers. Large diffs hit a size gate and ask whether to review everything or only the riskiest changes.
- **Languages:** JavaScript/TypeScript, C#, Python.
- **Reports:** saved to `.bug-hunter/reports`. Add `.bug-hunter/` to `.gitignore`.
- **Silence a finding:** `bug-hunter-ignore` or `bug-hunter-ignore: RULE_NAME` inline.

| Setting | Purpose | Default |
| --- | --- | --- |
| `autoFix` | Fix unambiguous 🔴 bugs. When `false`, no files are ever edited | `false` |
| `diff.maxDiffBytes` | Size gate for the diff | `102400` |
| `ticketContext` | Ticket used as acceptance criteria. `--ticket <id-or-path>` overrides; see [Ticket files](#ticket-files) | `null` |
| `repositoryContext` | Nearby docs for local patterns and invariants | `null` |
| `rules.disabled` / `rules.severityOverrides` | Tune noisy rules | none |
| `models.<agent>.basic` / `.advanced` | See [Model roles](#model-roles) | |
| `report.outputDir` | Where reports are written | `.bug-hunter/reports` |

### Re-runs are cached

When nothing has changed since the last review (same commit, same base, same config and ticket, same tool version), Bug Hunter returns the earlier report instead of repeating the review. Results are kept in `.swag-scan/cache/` (add it to `.gitignore`). Nothing is cached while you have uncommitted changes, and asking for a fresh run (`--fresh`) skips the cache.

### Ticket files

Bug Hunter checks the change against a ticket's acceptance criteria. It needs no configuration if the branch name holds a ticket ID (such as `feature/PROJ-123`) and it can find the ticket folder.

- **Which ticket:** `--ticket PROJ-123` (an ID) or `--ticket path/to/file.md` (a path, inside or outside the repo). With neither, the ID is taken from the branch name.
- **Where tickets live:** an ID is looked up as `PROJ-123.md` or `.txt` (or `PROJ-123-any-title.md`) in the first of: `--ticket-dir`, the `SWAG_SCAN_TICKET_DIR` environment variable, `ticketFolder` in `~/.swag-scan/settings.json` (a per-user file, outside any repo), or `ticketContext.path` in the repo's config. There is no built-in default folder.
- **What reviewers see:** only the title, the description and the acceptance criteria. Implementation or development logs, notes and any other section are removed, because they describe what was built and would bias the review. The report names the sections that were left out. A ticket with no headings is passed whole, with a note.
- **Format assumed (tolerant, markdown):**

  ```markdown
  # PROJ-123: Add login

  Free text or a "## Description" section.

  ## Acceptance Criteria
  | # | Title | Description | Repository | Status |
  |---|-------|-------------|------------|--------|
  | 1 | Login form | Shows email and password | web-app | 🔲 Todo |

  ## Repositories
  - web-app: feature/PROJ-123
  - api (feature/PROJ-123, base develop)
  ```

  Table columns may be in any order and any subset, and bullets, numbered items or checkboxes also work for criteria. Status is `🔲 Todo`, `✅ Done` or `🔮 Future` (words such as "done" are understood). Repositories can be a table, or bullets like `name: branch`, `name (branch, base ref)` or `name @ branch`. Status and repositories are parsed for the later consolidated report and multi-repo runs; reviewers are not given the status.

## Code Sweeper

Checks changed code for long lines and functions, nested conditionals, heavy boolean logic, long comments, duplication, loose types, oversized files, and weak tests (`SWEEP-101` to `SWEEP-112`).

Auto-fix is on by default for clear, low-risk findings. Dusty findings are never auto-fixed, and test removal stays off until you set `tests.removeLowValue` in `config.json`.

| Setting | Purpose | Default |
| --- | --- | --- |
| `autoFix.enabled` | Fix clear, low-risk 🔴 findings (`--no-fix` overrides per run) | `true` |
| `tests.removeLowValue` | Allow removing low-value tests | `false` |
| `scan.exclude` / `scan.testFiles.patterns` | Files skipped, and paths treated as tests | see config |
| `scan.thresholds` | Review heuristics, not hard style rules | see config |

## Security Auditor

Scans JavaScript/TypeScript, Python, and C# by file, so language-specific heuristics only run on matching files. Coverage is heuristic, not exhaustive. A basic pass reviews common implementation risks (`CRIT-1xx`, `CRIT-2xx`), then an advanced pass looks at attack paths and architecture.

| Setting | Purpose | Default |
| --- | --- | --- |
| `models.<agent>.basic` / `.advanced` | See [Model roles](#model-roles) | |
| `scan.projectStack` | `backend`, `frontend`, `full-stack`, or `unknown` | `backend` |
| `scope.maxRelatedFiles` / `maxRelationshipHops` | How far review follows related code | `5` / `1` |

## Model roles

Bug Hunter and Security Auditor run two passes. `models.<agent>.basic` and `.advanced` pick a model for each pass on the agent you're using (`claude` or `copilot`). `null` or a missing entry uses the agent's default model, and without model-selectable subagents the agent does both passes itself.

| Agent | `basic` | `advanced` |
| --- | --- | --- |
| `claude` | `haiku` | `sonnet` |
| `copilot` | `null` | `null` |

**Migrating:** earlier versions used a flat `models.basic` / `models.advanced`. That shape is no longer read. Move the values under your agent, for example `models.claude.basic`.

## Tests

Requires Node 22 or 24 (both run in CI). No third-party dependencies.

```bash
node --test \
  "skills/bug-hunter/test/*.test.mjs" \
  "skills/code-sweeper/test/*.test.mjs" \
  "skills/security-auditor/test/*.test.mjs" \
  "skills/review-tools-common/test/*.test.mjs"
```

## License

MIT
