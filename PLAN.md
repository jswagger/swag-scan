# Swag Scan: working plan (branch `plugin-restructure`)

> **Temporary file.** Delete `PLAN.md` before this branch is merged into `main`
> (`git rm PLAN.md`), and make that its own commit.

## Contents

- [Resume here](#resume-here)
- [Try it on another machine](#try-it-on-another-machine-temporary-no-plugin-install)
- [To do](#to-do) (before push, live agent tests, push and PR, after merge, cleanup)
- [Backlog](#backlog-later-not-blocking-the-pr)
- [Vision / roadmap](#vision--roadmap-placeholders-nothing-here-is-built-yet) (nothing here is built yet)
  - [Agents layer](#agents-layer-placeholder)
    - [Agent portraits](#agent-portraits-draft-1-approved)
    - [Agent voice in reports](#agent-voice-in-reports-idea-to-build-with-the-agents)
    - [Agent 1: Analyst](#agent-1-analyst-quality-assurance)
    - [Agent 2: Inspector](#agent-2-inspector-code-quality)
    - [Agent 3: Security Guard](#agent-3-security-guard)
  - [User experience and orchestration](#user-experience-and-orchestration-placeholder)
  - [Review view: findings shown like a code review](#review-view-findings-shown-like-a-code-review-placeholder-build-only-if-it-proves-reliable)
  - [Live view: feedback while a scan runs](#live-view-feedback-while-a-scan-runs-placeholder-lightweight-or-not-at-all)
  - [Installation and onboarding](#installation-and-onboarding-placeholder) (setup wizard, setup scan)
  - [The default run: the golden path](#the-default-run-the-golden-path-placeholder)
  - [Future possibilities](#future-possibilities-ideas-only-not-committed-to)
- [Marketing and showcase](#marketing-and-showcase-placeholder)
- [Decisions already made](#decisions-already-made-dont-relitigate)
- [Useful commands](#useful-commands) · [Gotchas](#gotchas) · [Session log](#session-log)

## Resume here

Last updated: 2026-11-04

- **Scope:** Claude Code first (see Decisions). Copilot and Codex later, through the neutral core.
- **Prototype, Phase 1 (tools) is done:** base auto-detect, empty-diff message, language coverage (⚪ Unchecked), unattended size gate, large changes
  split into packets, ticket handling, result cache. Live agent tests are parked.
- **Prototype, Phase 2 (agents) mostly built:** orchestrator `skills/review-tools-common/swag-scan.mjs run`; persona sources in
  `skills/review-tools-common/personas/` and generator `scripts/build-agents.mjs` -> `agents/{analyst,inspector,security-guard}.md` (`maxTurns: 50`);
  entry skill `claude-code/skills/swag-scan/SKILL.md` (`/swag-scan:swag-scan`, registered through the manifest `skills` key); `bin/swag-scan` wrapper;
  `hooks/hooks.json` + `hooks/guard-bash.mjs` (default-deny Bash allowlist for the three agents only, keyed on hook `agent_type`).
  Shared findings format built (`findings.mjs`, `save-findings.mjs`, README "Findings format"): severities critical/design/minor, `disposition`, `flaggedText`, `criteria` links.
  Consolidated report built (step 7): `swag-scan report` -> `report.mjs` renders decisions-first markdown + `report.json` with no model, AC rows with linked
  findings, honest per-agent states, coverage; keeps a copy in `.swag-scan/reports/<commit>/` and records reviewed agents in the cache.
  **Next:** a live Claude Code test (parked until you want it), then Phase 3: event log, multi-repo worktrees, dashboard.
  **Unverified until a real session:** that `agent_type` is `swag-scan:analyst` (or bare `analyst`) in hook input, that a skill can start the plugin agents
  by name in parallel, and how the agents behave with the `SKILL.md` instructions.
- **Phase 3 (package):** event log is built (`events.mjs`, `hooks/events.mjs`, README "Event log"; subagent start/stop and permission prompts come from
  async hooks, verified in the hooks docs). **Dashboard prototype built (2026-11-04, uncommitted):** `skills/review-tools-common/dashboard.mjs` (pure `buildState` from the event log,
  page writer, watcher) + `dashboard-page.html` (the mock-up's look, offline, light and dark) -> `.swag-scan/dashboard.html`. Command:
  `swag-scan dashboard [--watch] [--open]`; `/swag-scan:swag-scan --live` starts it (SKILL.md step 0, **unverified in a real session**).
  The page keeps its state and refreshes by re-loading `dashboard-data.js` (no page reload, so toasts survive). Shows waiting, live, finished,
  error and "not updating" states, fixed per-agent lines, "waiting for you" toast (live runs only). Screenshot-checked in headless Chrome.
  **Approved as a first draft (2026-11-04).** Finished banner is green with an "Open the full report" button. **Color rule (decided):** green means the scan
  itself completed, whatever it found (critical findings included); orange means the scan process failed (not the user's code). Do not tie green to "clean".
  **Known gap:** the button opens `report.md`, which Safari shows as unrendered Markdown. Fine for now; later render the report as HTML or do something else.
  **Next:** multi-repo worktree runs (the dashboard will need a per-repo view).
  **Decision (2026-11-02): where repositories live is a per-user answer, asked during setup** ("In what folder do all of your repositories live?"), saved in
  the user-level settings file (`~/.swag-scan/settings.json`, key such as `repoRoots`). A ticket's `## Repositories` names are resolved against those folders.
  Add it to the setup wizard's questions (Installation and onboarding) as an optional, multi-repo-only question.
- **Future, not yet:** every agent (Analyst, Inspector, Security Guard) gets edit capability. Needs safe-fix tooling and a separate-commit flow first.
  Today only the Inspector can edit, and only with auto-fix on.
- Tests: 243 pass. Regenerate agents with `node scripts/build-agents.mjs` (a test fails if they are stale).
- Update this section at the end of every session, and tick boxes as you go.

## Try it on another machine (temporary, no plugin install)

The plugin is not installed anywhere; Claude Code loads it straight from a folder for one session with `--plugin-dir`. Nothing is installed or changed on that machine.

1. **Once:** `git clone https://github.com/jswagger/swag-scan.git ~/swag-scan && cd ~/swag-scan && git checkout plugin-restructure`. Needs Node 22 or 24 and the `claude` CLI on the PATH.
   Later, `git pull` in that folder gets new work.
2. **Optional shortcut** (zsh): `alias claude-swag='claude --plugin-dir ~/swag-scan'`.
3. **Per ticket, if the ticket is a file** (see README "Ticket files"): put the folder that holds `PROJ-123.md` into `~/.swag-scan/settings.json` as
   `{"ticketFolder": "/path/to/tickets"}`, or pass `--ticket-dir` / `--ticket <path>`. With no ticket the Analyst still runs, without acceptance criteria.
4. **Run:** `cd` into the *other* repo, check out the ticket's branch (committed, ahead of its base), then start `claude --plugin-dir ~/swag-scan`
   (or `claude-swag`) and type `/swag-scan:swag-scan` (add a base such as `main`, `--ticket PROJ-123`, or `--live` for the dashboard page).
5. **What to watch for (the unverified list):** the three agents start in parallel and follow SKILL.md; the Bash guard does not block the scripts they
   need (a block shows its reason); a permission toast appears on the dashboard when a prompt does; the report at the end is decisions-first.
   Copy any error text or odd behavior back here. Results are in `<repo>/.swag-scan/` (gitignored); the first run changes no files.

## To do

### Trial-run feedback (from `project_swag_scan_testing.md`, 35 findings over 4 runs: TypeScript/React and Python, Windows)
Verdict: agents' judgment is the strongest part, the scripts-only layer is the noisiest. Finding numbers in brackets. Work order: criticals first, check in, then the rest.

| # | Sev | Item | Findings | Status |
|---|-----|------|----------|--------|
| 1 | 🔴 | Bash guard ate backslashes in Windows paths (`C:\tools\x`) | 1 | Fixed in `hooks/guard-bash.mjs` (+1 test). Windows re-run still needed to confirm |
| 2 | 🔴 | Analyst's report went to `<repo>/.bug-hunter/reports` | 24, 29 | Fixed: Analyst passes `--out .swag-scan/run/bug-hunter-reports` (source: `scripts/build-agents.mjs`) |
| 3 | 🔴 | Untracked files flooded the scan (691 vs 3) | 28, 32 | Fixed: warning + "N in branch diff, M untracked" line; `testdata/`, `fixtures/`, `__snapshots__/` skipped for untracked files (+2 tests) |
| 4 | 🟡 | Wrong base is silent (90 files vs 9) | 12 | Fixed: collector warns when another base makes the change 3x+ smaller (20+ fewer files). Reading the base from the ticket not done (chosen: warn only) |
| 5 | 🟡 | Ticket parsing: two tables merged, ids clash, other repos' criteria linked | 21, 22, 30 | Fixed: each table parsed on its own; criteria scoped to the scanned repo (folder name match, no filter if none match); report shows "Other repo, not scanned" and "(all)" |
| 6 | 🟡 | Dashboard watcher dies on EPERM rename; stays LIVE and clock runs when idle | 15, 18-20 | Fixed 18-20: rename retried then overwritten, a failed write never ends the watcher, stale page freezes its clock and says how long ago. Finding 15 (idle state with no agents) not done |
| 7 | 🟡 | Scanner noise: SWEEP-107/111/112, REMOVED_EARLY_EXIT, locale JSON, size gate | 4, 7-10, 13 | Todo |
| 8 | 🟡 | `report.md` opens as raw text; write `report.html` | 25, 26 | Fixed 26: `report-html.mjs` writes a self-contained `report.html` (dark/light, escaped, no scripts) next to `report.md` and the dashboard button prefers it. 25 partly: long paths now wrap, but the paths are still repeated in every row |
| 9 | 🟡 | Small bugs: `ticket.id` shows path, `_development.md` lookup, Windows test portability (CRLF, POSIX paths) | 2, 3, 5, 6 | Fixed 2, 3, 5 (`.gitattributes` pins LF; tests tolerant). 6 does not reproduce: the underscore name matches, exact name wins |
| 10 | 🟡 | Docs: Windows/VS Code CLI not on PATH, PowerShell vs cmd launch, "first run in a new repo" checklist | env notes, 31 | Todo |
| 11 | ✅ | Later: multi-repo mode; scanner rule for relaxed guards + mocked helpers | 34, 35 | Backlog |

Note: the scanner noise in row 7 is mostly filtered out by the agents before the final report, so it is lower urgency than it looks.

### Before the first push
- [ ] Skim `git log --oneline main..HEAD` and `git diff main --stat`.
- [ ] Run the tests and validator once more on the final commit (commands below).

### Live agent tests (not yet run; scripts are tested, skills inside real agents are not)
Test repo: `/tmp/swag-test` (`main` has a guarded, awaited, parameterized `app.js`; `feature` rewrites it with the guard,
`await` and try/catch removed, SQL concatenation, commented-out code, and a `TODO remove`). Recreate it if `/tmp` was cleared.

- [ ] **Claude Code:** from `/tmp/swag-test` on `feature`, start `claude --plugin-dir <this repo>` and run:
  - [ ] `/swag-scan:security-auditor main`: flags the SQL concatenation as `CRIT-101` and notes the removed controls.
  - [ ] `/swag-scan:bug-hunter main`: flags the removed guard, `await` and try/catch, and writes a report under `.bug-hunter/reports`.
  - [ ] `/swag-scan:code-sweeper main --no-fix`: reports the commented-out code and the `TODO` as 🟡 Dusty, and `git status` shows no edits.
  - [ ] No path prompts and no model-name errors in any of the three.
- [ ] **Copilot (VS Code agent mode):**
  - [ ] `cd /tmp/swag-test && node <this repo>/scripts/install-copilot.mjs`
  - [ ] Open `/tmp/swag-test` in VS Code and run the same three commands (`/security-auditor main`, `/bug-hunter main`, `/code-sweeper main --no-fix`) with the same pass criteria.
  - [ ] Both passes run on the default model, with no model-switch claim (`models.copilot` is `null`).

### Push and PR
- [ ] Push `plugin-restructure` only. Never push or merge `main` from here.
- [ ] Open the PR. CI runs only on pull requests and pushes to `main`, so it first runs here.
- [ ] Both CI jobs are green. **Node 22 has never been run**, so watch it.
- [ ] The README badge resolves (`.github/workflows/test.yml` in `jswagger/swag-scan`).

### After merge to `main`
- [ ] `/plugin marketplace add jswagger/swag-scan` then `/plugin install swag-scan@swag-scan` works on a clean machine.
- [ ] Decide on the version tag (`0.1.0` is set in both manifests).

### Cleanup before merge
- [ ] **Delete `PLAN.md`** in its own commit.

## Backlog (later, not blocking the PR)
- [ ] **Agent turn cap:** each agent has `maxTurns: 50` (set in `scripts/build-agents.mjs`), a guess until real runs show how many turns a review needs.
      Revisit with data, and make hitting the cap visible ("I ran out of turns, so this review is partial") instead of a quiet stop.
- [ ] Designer feedback on the logo, then redo `.claude-plugin/icon.png` and the README logo. The current icon is a placeholder.
      Consider a dark-mode README logo via `<picture>`.
- [ ] Decide whether the Copilot installer should copy `test/` folders. It currently skips them.
- [ ] Add `node_modules/` and `.DS_Store` to `.gitignore` (it holds only `.bug-hunter/`).
- [ ] The `TOOLS=<parent directory of this skill folder>` line in each `SKILL.md` is a placeholder the agent fills in.
      It worked in the headless test. Revisit if another agent has trouble with it.
- [ ] Optional: a deterministic scanner rule for commented-out code (`SWEEP-113`). The `SKILL.md` line covers it by agent judgment for now.
- [ ] Out of scope for now: Codex support (v0.2.0) and npm publishing (after v0.1.0).

## Vision / roadmap (placeholders; nothing here is built yet)

**Where this started:** a set of single-purpose review tools run after implementing a feature or ticket and before opening
a pull request. Each runs automated checks on only the code that was changed or added.

**Already built (not part of this roadmap):** Bug Hunter (regressions), Security Auditor (security),
Code Sweeper (unclean or verbose code).

**Where it's going:** a bigger collection of pre-PR checks under the Swag Scan name. Planned **new** additions:

| Planned skill | Working name | What it will do | Status |
| --- | --- | --- | --- |
| Test quality | **Test Tailor** | Analyzes the unit tests added in a change and judges their value | Placeholder |
| Technical debt | **Debt Collector** | Uses a scoring system to say whether the change paid down technical debt or added to it | Placeholder |
| Acceptance criteria | *(name not chosen yet)* | Checks whether the ticket's acceptance criteria are met by the change | Placeholder, needs a name |

Open questions to settle before building each (more detail to come from you):
- [ ] **Test Tailor:** Code Sweeper already has test-value rules (`SWEEP-108` trivial assertions, `SWEEP-109` repeated `as any`
      fixtures, `SWEEP-110` near-identical sibling tests) and a `tests.removeLowValue` setting. Decide whether those move to
      Test Tailor, stay in Code Sweeper, or are shared, so the two don't overlap.
- [ ] **Debt Collector:** define the scoring system (what counts as debt added or paid, the scale, and how it's reported).
- [ ] **Acceptance-criteria checker:** Bug Hunter already reads a ticket file (`ticketContext`, `--ticket`) to check edge cases
      against acceptance criteria. Decide whether the new skill replaces that, builds on it, or stays separate. Also pick a name.
- [ ] Each new skill follows the existing pattern: platform-neutral `skills/<name>/SKILL.md`, a `config.json`, Node scripts using
      built-ins only, tests, and a short section in the root README. No per-skill READMEs.
- [ ] Update the plugin description, keywords and README intro once any of these ship (they currently describe three skills).

### Agents layer (placeholder)

**Idea:** assign the individual skills to specialist agents, each with its own permissions and perspective. Think of an agent as
a tradesperson (say, an electrician) with a tool belt: a fixed set of tools for the tasks they are always given. The skills are
the tools, and the agent is who carries them and how they approach the job.

#### Agent portraits (draft 1, approved)

Each agent gets a profile picture: a modern, minimalist cartoon head in flat shapes, using the banner's palette. Files live in
`assets/agents/`: one SVG and one PNG per agent (`analyst`, `inspector`, `security-guard`) and `swag-scan-crew.html`, the contact
sheet with all three at several sizes (they stay readable at 20 px). Draft quotes and report lines below are placeholders.

- **Tool icons (draft):** each tool has a physical icon on `swag-scan-crew.html` (Tool belts section), built and planned alike.
  Analyst: Bug Hunter = magnifying glass, Acceptance Checker = clipboard, Test Runner = test tube.
  Inspector: Code Sweeper = broom, Debt Collector = stack of coins, Test Tailor = tailor's measuring tape.
  Security Guard: Security Auditor = padlock, Dependency Checker = package box, Permissions Reviewer = key.
- **Crew sheet image:** `assets/agents/swag-scan-crew.png` (2560 px wide, light theme) is the finished sheet: the Swag Scan logo
  on top, then each agent with its tool belt, in the banner's palette and type (Montserrat and Inter, navy, copper, beige belts,
  solid navy for built and dashed for coming soon). Each portrait has a navy ring and a small hexagon "S" badge that echoes the
  logo. Its HTML source is `swag-scan-crew.html` in the same folder (it loads `../swagScanLogo.jpg`). Regenerate the PNG with
  headless Chrome at 1280 x 2000 and a device scale of 2.
- [x] **Banner names updated** to Analyst and Inspector (HTML and PNG re-exported). The banner still says "Criteria Checker"; the crew
      sheet says "Acceptance Checker". Pick one name.
- [ ] Use the portraits in the README, the plugin listing and the scan report output (a report line per agent, with its face).
- [x] Names settled: Analyst (was QA), Inspector (was Tech Lead), Security Guard. Update the rest of the docs and skill text to match as they are touched.
- [ ] If the SVGs change, regenerate the PNGs (`qlmanage -t -s 512 -o <dir> <file>.svg` works on macOS).

#### Agent voice in reports (idea, to build with the agents)

**Idea:** when an agent reports something it found, the message is written in that agent's voice, so the personality comes
through in the report itself. The crew sheet's quotes and report lines show the feel: a developer should be able to tell who is
speaking before reading the name.

| Agent | Voice | Draft example |
| --- | --- | --- |
| Analyst | Precise, numbers first, a little dry. Says what was and wasn't verified. | "48 tests passed, 2 failed. Coverage on the changed lines is 91%." |
| Inspector | Warm and patient, thinks like a building inspector (loose ends, cut corners, built to spec). | "Found a loose end: a TODO with no owner, and two helpers that name the same thing differently." |
| Security Guard | Few words, serious, no filler. Says what to do first. | "1 hardcoded secret in config.py. Rotate it, then rerun." |

**Rules (so the voice never costs accuracy):**
- **Voice is wording only.** Every finding still carries the same facts: rule ID, file and line, evidence, why it matters, and a
  concrete recommendation. The voice sits in the sentence that introduces or explains them and never replaces them.
- **Short and light.** One sentence of voice, not a paragraph. No heavy accents or catchphrases, and no jokes at the developer's
  expense. If the voice makes a message longer or less clear, drop the voice.
- **Serious findings stay plain.** Critical security findings and failing tests lead with the fact and the action. The voice
  can follow but must not soften them.
- **Machine-readable output has no voice.** The findings JSON (see the Review view), config, and anything a script parses use
  plain fields. Only the human-facing text is in voice.
- **The same voice everywhere the agent speaks:** the per-finding text in the report, the comments in the review view, and the
  one-line summary. The final overall report stays neutral and easy to scan, with the agents' lines inside it.
- **Costs nothing extra.** It is part of the same model output, guided by a few lines of persona text in each agent's
  definition. Script-written messages (for example the Test Runner's counts) can use fixed templates per agent.
- **Configurable.** Proposal: a `voice` setting with `full` (default), `light`, and `off` (plain reports), so teams that want
  neutral output can have it.

Open questions (voice):
- [ ] **Where the persona text lives:** one platform-neutral file per agent (voice, example lines, do and don't), loaded by the
      Claude Code agent definitions and the Copilot custom agents alike. Same question as the Inspector's principles file.
- [ ] **Checking it:** add a simple test that voiced messages still contain the file, line and recommendation.
- [ ] **Setting names and defaults:** confirm `voice` values and whether `quick` runs (scripts only) get any voice at all.

#### Agent 1: Analyst (quality assurance)

| Item | Detail |
| --- | --- |
| Role | Quality assurance: decides whether a change works and does what the ticket asked |
| Tool belt | **Bug Hunter** (built), **acceptance-criteria checker** (planned, unnamed), **Test Runner** (new, planned) |
| Persona | The nerd: evidence-first, all about statistics (see Character below, plus the draft sketch) |
| Portrait | [`assets/agents/analyst.svg`](assets/agents/analyst.svg) (PNG alongside) |
| Permissions | To be decided (see questions) |

**Character:** the stats person who stepped right out of an office. Thick-rimmed glasses, side-parted brown hair, tie, and a
pocket protector with pens. Draft one-liner: "Eleven of twelve acceptance criteria are covered. Let's talk about the twelfth."
Draft report line: "48 tests passed, 2 failed. Coverage on the changed lines is 91%." Portrait background: soft blue-grey.

New placeholder skill in this belt:

| Planned skill | Working name | What it will do | Status |
| --- | --- | --- | --- |
| Run the tests | **Test Runner** ("maybe", name not final) | Runs the project's tests relevant to the change and reports pass, fail and gaps | Placeholder |

**Draft persona sketch (to refine with you):** a careful, evidence-first tester who asks "does this actually work, and did it
break anything that worked before?" Trusts a failing test over a plausible explanation, never claims a pass without running
something, reports what was and wasn't verified, and leaves style and security to other agents.

**Focus items (draft):**
- [ ] Regressions in changed code (Bug Hunter)
- [ ] Acceptance criteria met by the change (acceptance-criteria checker)
- [ ] Tests run and results reported honestly, including what couldn't be run (Test Runner)

#### Agent 2: Inspector (code quality)

| Item | Detail |
| --- | --- |
| Role | Guardian of code quality: keeps the code base clean, tidy, and focused |
| Tool belt | **Code Sweeper** (built), **Debt Collector** (planned), **Test Tailor** (planned) |
| Persona | The old, wise building inspector: kind and patient, but nothing leaves the site unchecked (see Character below) |
| Portrait | [`assets/agents/inspector.svg`](assets/agents/inspector.svg) (PNG alongside) |
| Context to add later | SOLID principles and other engineering principles (details to come from you) |
| Permissions | To be decided |

**Character:** a building inspector. Older, kind smiling eyes, grey mustache and bushy brows, wearing a yellow hard hat and an
orange hi-vis vest, with a pencil behind his ear. He is there to check that everything was built properly: no loose ends, no
cut corners, no inconsistencies. Explains why before saying what. Draft one-liner: "Everything is built to spec except one
corner. Someone cut it." Draft report line: "Found a loose end: a TODO with no owner, and two helpers that name the same thing
differently." Portrait background: warm tan.

**Focus items (draft):**
- [ ] Clean, simple, non-verbose code (Code Sweeper)
- [ ] Technical debt paid down, not added (Debt Collector)
- [ ] Unit tests that earn their place (Test Tailor)
- [ ] Code stays tidy and focused, guided by SOLID and other principles supplied later as agent context

Open questions (Inspector):
- [x] **Name:** decided, "Inspector" (was "Tech Lead").
- [ ] **Principles as context:** where do SOLID and other principles live, so they are loaded for this agent (and maybe shared
      with Code Sweeper's review)? One platform-neutral file the agent reads, or text inside the agent definition?
- [ ] **Overlap:** Code Sweeper and Test Tailor both look at test quality today (see the Test Tailor question above). With both on
      the same belt, decide who owns which rules.

#### Agent 3: Security Guard

| Item | Detail |
| --- | --- |
| Role | Keeps security problems out of the change: vulnerable code, risky dependencies, and over-broad permissions |
| Tool belt | **Security Auditor** (built), **Dependency Checker** (planned), **Permissions Reviewer** (planned) |
| Persona | Serious, few words, suited up (see Character below) |
| Portrait | [`assets/agents/security-guard.svg`](assets/agents/security-guard.svg) (PNG alongside) |
| Permissions | To be decided. Proposal: report-only, because security findings need human judgment before any edit |

**Character:** dark suit, slicked-back hair, sunglasses he never takes off, a flat mouth, and a coiled earpiece. Draft
one-liner: "Found a key in that file. Rotate it before anything else." Draft report line: "1 hardcoded secret in config.py.
Rotate it, then rerun." Portrait background: dark navy.

New placeholder skills in this belt:

| Planned skill | Working name | What it will do | Status |
| --- | --- | --- | --- |
| Dependency review | **Dependency Checker** (name not final) | Looks at added or bumped packages and lockfile changes | Placeholder |
| Permissions review | **Permissions Reviewer** (name not final) | Looks at changes to who or what is allowed to do what | Placeholder |

**Dependency Checker, ideas to refine:**
- Packages added or version-bumped in manifests and lockfiles (npm, pip, NuGet and so on).
- Known-vulnerable versions, unpinned or wildcard versions, and unexpected new transitive dependencies.
- Packages that are new, unmaintained, or typosquat-like names.
- Open question: needs a source for vulnerability data. The repo is zero-dependency and works offline, so decide between
  local-only heuristics, an optional lookup, or asking the agent to use the ecosystem's own audit command.

**Permissions Reviewer, ideas to refine:**
- Changes to authentication and authorization logic, roles, and access checks.
- Changes to CORS settings, public endpoints, and cloud or infrastructure permissions.
- CI and workflow permissions, such as GitHub Actions `permissions:` blocks and secrets exposure.
- Open question: where it stops and Security Auditor starts (Security Auditor already flags some authorization gaps).

**Focus items (draft):**
- [ ] Vulnerabilities and risky patterns in changed code (Security Auditor)
- [ ] New or changed dependencies are safe and justified (Dependency Checker)
- [ ] Permissions are no broader than the change needs (Permissions Reviewer)

Open questions (Security Guard):
- [ ] **Overlap:** decide who owns what between Security Auditor and Permissions Reviewer, so findings aren't duplicated.
- [ ] **Autofix:** confirm report-only for the whole belt, or allow safe fixes such as pinning a version.

#### Open questions (Analyst and shared)

- [ ] **Test Runner:** how does it find the project's test command (config, auto-detect, ask)? Which test frameworks first?
      Does it run only tests related to the change or the full suite? What timeout and what happens on failure?
- [ ] **Permissions:** the Analyst has to run commands to run tests. Should it be read-only on source files, with the
      ability to run tests and write only reports? What can it never do (push, delete, edit source)?
- [ ] **Overlap:** Bug Hunter reads acceptance criteria from a ticket today. Where does the line fall between Bug Hunter and
      the acceptance-criteria checker, inside this one agent?
- [x] **Claude Code packaging, verified 2026-11-02 against code.claude.com docs.** A plugin agent is `agents/<name>.md` (YAML frontmatter, body = system
      prompt), invoked as `swag-scan:<name>` or `@agent-swag-scan:<name>`. Supported frontmatter: `name`, `description`, `model`, `effort`, `maxTurns`,
      `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation`, `color`. **Ignored for plugin agents: `permissionMode`, `hooks`,
      `mcpServers`, `initialPrompt`.** `tools` is an allowlist by tool name only; the docs show no `Bash(<pattern>)` form for it, so an agent file cannot
      pin Bash to the Swag Scan scripts. Finer control needs plugin-level `hooks/hooks.json` (fires session-wide) or the user's allow/deny rules.
      `${CLAUDE_PLUGIN_ROOT}` is substituted inline in agent and skill Markdown (not in the Bash environment). A plugin `bin/` folder is put on the Bash
      PATH, so a bare `swag-scan` command is possible. The `agents` manifest key takes `.md` files only. A plugin `settings.json` only honors `agent` and
      `subagentStatusLine`. `workflows/*.js` (orchestrate several subagents from a script) and `monitors` (background process, output reaches Claude) exist
      and are worth a look for the dashboard and orchestration. Still unverified: the name format for preloading a plugin skill via `skills:`.
- [ ] **Copilot custom agents:** deferred with the rest of Copilot and Codex support.
- [ ] **How agents get invoked:** by name, as a combined "run my Analyst agent" command, or both? Does the agent run its tools in a
      fixed order and produce one combined report?
- [ ] Other agents to come (for example security, code quality, test quality, tech debt). Which skills go on which belt?

### User experience and orchestration (placeholder)

**Goal:** once the skills and agents exist, make Swag Scan as easy and configurable as possible. A developer finishes a ticket
(maybe built by a software factory), has commits on a branch, or on three branches across three repos, and wants to know the
code meets their quality bar. They click a button, go get coffee, and come back to either fixes already applied or a short,
precise report of the hard decisions. All of this without burning a vast amount of tokens.

**Principle: scripts do the work, models do the judging.** The existing tools already work this way, and the budget depends on
keeping it true as agents are added.
- Scripts first: collect the diff, scan, rank findings, and run tests with no model involved. Cost appears only when something is flagged.
- Cheap model for triage, stronger model only for what survives (the existing `models.<agent>.basic` / `advanced` split).
- Skip unneeded work: no change means no run, and a clean scan means no model call. Consider caching results by commit hash.
- Hard limits: size gates (Bug Hunter has one) and a per-run budget cap.

**The "click a button" flow (proposal):**
1. One entry point, a single `swag-scan` command (and a button or script that calls it), runs the agents in order for a branch.
2. Fixed order, cheapest first: a quick script-only pass (tests, scanners), then the agents that need judgment.
3. Autonomous fixes with guardrails: safe fixes go in a **separate commit or branch** so they can be reviewed or reverted as one
   unit. Security, migration, and breaking-change findings stay report-only.
4. One consolidated, decisions-first report that replaces the per-skill reports:
   - **Done for you:** what was fixed, with the diff.
   - **Needs your decision:** a short list of hard calls, each with evidence, options, and a recommendation.

**Several branches across several repos:**
- A small runner takes a list of `repo + branch` entries and runs the flow in each **in parallel**, each in its own git worktree
  so the user's checkouts aren't touched.
- One summary across all of them (for example "repo A: 2 decisions, repo B: clean, repo C: 5 fixes applied, 1 decision"),
  with detail one click away.
- Each repo can carry its own config, with shared defaults for the rest.

**Configuration (keep it simple and layered):**
- Profiles: `quick` (scripts only), `standard`, `thorough`. A profile picks which agents run, which models they use, and the autofix level.
- Per-repo overrides in the existing `config.json` files, plus a repo-level on/off switch for each agent.

**Design rule: choosing what runs must be a clean user experience, never a buried JSON setting.** Users pick the level and
the agents at the moment they run it. `config.json` stays for advanced tuning only.

**Choosing a level** (draft meanings, to refine):

| Level | What runs | Model use | Autofix |
| --- | --- | --- | --- |
| `quick` | Scripts only: scanners, tests, size checks | None | Off (report only) |
| `standard` (default) | Scripts, then model review of flagged items | Cheap triage, stronger model on what survives | Safe fixes only |
| `thorough` | Everything in `standard`, plus deeper review (wider related-file search, all agent checks) | Stronger model more often, larger size gates | Safe fixes only |

**Choosing agents:** one, several, or all. Draft ways to invoke it:
- `/swag-scan` runs all agents at `standard`. With no arguments in an interactive session it can show a short menu (agent
  checklist and level) instead of guessing.
- `/swag-scan analyst`, or `/swag-scan analyst security-guard`, runs only the named agents.
- `/swag-scan --level quick` or `--level thorough` sets the level. Flags combine: `/swag-scan inspector --level thorough --no-fix`.
- `--dry-run` shows what would run and what would be fixed, and changes nothing.
- Direct shortcuts per agent, such as `/swag-scan:analyst`, `/swag-scan:inspector`, `/swag-scan:security-guard`.
- The individual skills (for example `/bug-hunter`) keep working on their own.
- Before starting, print one line saying what will run: for example "Running: Analyst, Security Guard at standard, auto-fix on".

**Remembering choices:** precedence from strongest to weakest is command flags, then the user's own saved preference
(local, not committed), then the repo's team default (committed), then built-in defaults. A guided `swag-scan init` could write
the repo default for the user, so nobody edits JSON by hand.

**Risks and open questions:**
- [ ] 🟡 **Interactive menus** work in a live session but not in an unattended or headless run. The same choices must be available
      as flags, and a headless run must never wait on a prompt. Platform support for menus and arguments (Claude Code, Copilot) is unverified.
- [ ] Finalize what each level runs and costs, and whether `quick` should be allowed to autofix anything.
- [ ] 🟡 **Headless runs are less proven than they look.** In this project's verification, a broad-Bash nested session was blocked by
      the permission classifier, and narrow Bash allowlists failed because the agent varied its command form. For unattended runs,
      scripts must be invoked in a fixed, predictable way, ideally by a **deterministic orchestrator script** and not by the model
      deciding what to run. This is the main design change to make.
- [ ] 🟡 **Platforms differ.** An unattended orchestrator is easiest on Claude Code (headless mode and plugin agents). Copilot is more
      interactive, so "go get coffee" may need a different mechanism. Not verified; check current Copilot docs.
- [ ] 🟡 **Autonomous edits can hurt.** The separate-commit rule and a clean dry-run mode matter most. Decide the default autofix level per profile.
- [ ] ✅ **Token cost is unmeasured.** Once a flow exists, record actual usage per agent and per repo, then tune.
- [ ] Decide the shape of the entry point (CLI script, slash command, VS Code task) and where the consolidated report is written.

**Suggested build order:**
1. A deterministic orchestrator for one repo and one agent. The Analyst is the best fit, since Test Runner is script-based.
   This proves the unattended run, the permissions, and the report format.
2. The consolidated, decisions-first report.
3. Multi-repo runs with worktrees, then profiles and config.

### Installation and onboarding (placeholder)

**Goal:** a brand-new developer on Claude Code, with several branches across several repos, installs Swag Scan and gets a useful
first result as painlessly as possible.

**The first five minutes (proposal):**
1. **Install once** with two commands (`/plugin marketplace add jswagger/swag-scan`, then `/plugin install swag-scan@swag-scan`).
   Ideally a user-level install covers every repo. How Claude Code scopes plugin installs is unverified; check the docs.
2. **Zero required setup:** `/swag-scan` works in any repo on built-in defaults. No JSON, no config file.
3. **First-run setup (`/swag-scan:setup`)** asks a few quick questions (below), checks the basics (Node version, git repo,
   base branch), and offers a **dry run** on the current branch so the first result changes nothing.
4. **A short, decisions-first first report** that ends by pointing to the next step, such as "run with `--level thorough` to go deeper".

**The first-run questions.** Rule: the user should answer at most about three, and every one has a pre-selected default.

| # | Question | Answer style | Notes |
| --- | --- | --- | --- |
| 1 | Which branch should I compare your changes against? | Multiple choice with the detected default pre-selected (for example `main`), plus "other" | Detect first. Only ask to confirm. |
| 2 | What should I run? | Multiple choice of presets: everything at `standard`, a single agent, or `quick` checks only (see levels) | Maps to the level and agent choices above |
| 3 | Should I fix things automatically? | Multiple choice: safe fixes in a separate commit, report only, or ask each time | Security findings stay report-only regardless |

Asked only if needed, never by default:
- **Test command**, only when it can't be detected. Show what was found and ask yes or no.
- **Which repos**, only for a multi-repo run. Ask once, "In what folder do all of your repositories live?" (more than one folder allowed), and save it in the
  user-level settings (`repoRoots`). A ticket's repository names are then found under those folders. Paths can still be pasted for one-off runs.

**Setup wizard (idea):** shape first-run setup like an old-fashioned installation wizard, the starting point when someone first
installs or downloads Swag Scan. It walks them through every choice they need up front, in a simple, intuitive order.

Draft screens (3 to 5 steps, with a step counter such as "Step 2 of 4"):
1. **Welcome and checks:** what Swag Scan does in two lines, plus the basics (Node version, git repo, detected language and test command).
2. **Compare against:** the base branch question, with the detected default pre-selected.
3. **What to run:** the level and agents question, as presets.
4. **Auto-fix:** the fix-behavior question.
5. **Summary and confirm:** a plain list of the choices, then "Save and run a dry run now?" as the final button.

Wizard behaviors: Back and Skip on every step, "Use defaults" to finish immediately, nothing is written until the
user confirms on the summary screen, and it can be re-run any time (`/swag-scan:setup`) to change choices.

**Design idea: make the wizard's engine a plain zero-dependency Node script, not a model conversation.**
- It costs no tokens, behaves identically every time, works on any agent or platform, and fits the "agent-neutral, scripts do the
  work" principle.
- **Catch:** an agent's Bash tool usually has no interactive terminal, so an interactive prompt script cannot run through the
  agent. So the script gets two modes: **interactive** (run directly in the user's own terminal) and **answers mode**
  (`--base main --level standard --fix safe`, no prompts).
- **In-agent path:** `/swag-scan:setup` has the agent ask the questions (multiple choice, where the platform supports it),
  then call the script in answers mode to validate and save them.
- **First-use trigger:** if no saved answers exist, the first `/swag-scan` offers to start the wizard. Whether a plugin can run
  anything automatically on install is unverified; assume it cannot and rely on first-use detection.
- **Later:** once an npm package exists (planned after v0.1.0), the terminal wizard could be a one-line command (for example `npx`),
  which is the closest match to a "download and run the installer" feel.
**Wizard front ends (one engine, several skins):** the answers-mode script is the engine, and each front end only collects answers
and hands them to it.

| Front end | How it feels | Notes |
| --- | --- | --- |
| In chat | Agent asks multiple-choice questions, then calls the script | Zero extra pieces. Best for a first run inside the agent. Platform support for choice prompts is unverified. |
| Terminal | Step-by-step prompts with a step counter | Zero dependencies (Node `readline`). Needs the user's own terminal, not the agent's. |
| Local HTML form | A simple page with buttons, checkboxes, and fill-in blanks | The most visual and lightest to use. Details below. |

**Local HTML form (idea):** a single self-contained HTML file with no external scripts, fonts, or network calls. The user picks
a level, ticks agents, chooses the base branch, and presses one button. Same questions and same defaults as the other front ends.
- **Catch:** a web page opened from disk can't write files. Three ways to get the answers back to the script:
  1. **Show a command to paste.** The page builds a line such as `node scripts/setup.mjs --base main --level standard --fix safe`.
     Simplest and safest, but the user has to copy and run it.
  2. **Download a small answers file** that the script reads. One extra step, and still no server.
  3. **The script serves the page itself** on `127.0.0.1` (Node `http`, zero dependencies), opens the browser, saves the answers
     the moment the user clicks Save, then shuts down. Best experience, one click and done, but it is a small local server:
     bind to localhost only, use a random port and a one-time token, serve only this one page, and exit after one save.
- **Leaning:** option 3 for the polished experience, with option 1 as the fallback, since pasting one command is the simplest thing that
  can work and costs almost nothing to build first.
- Keep the page agent-neutral. Don't host it or rely on any vendor's page hosting; it must work offline from the repo or plugin folder.
- Accessibility basics: labels on every field, keyboard-friendly, readable in light and dark mode.
- [ ] Decide which front end ships first, and whether the HTML form is a v1 feature or a later polish.
- [ ] Decide which path is the default for new users: the in-agent setup, the terminal wizard, or the HTML form.
- [ ] Decide where saved answers live (a user-level file, outside the repo) and their format.

**Setup scan (idea): a discovery step that runs before the wizard.** A zero-token, read-only script inspects the user's
environment and hands the wizard a report, so every question opens already filled in with a sensible default and the user mostly
just confirms. This is "detect first" made concrete, and it proactively removes questions.

What it could detect (all local, all best-effort):

| Area | Examples of what it finds | Used to pre-fill |
| --- | --- | --- |
| Git | Repo root, current branch, default branch (`origin/HEAD`, else `main` or `master`), remotes, worktrees, uncommitted changes | Base branch question |
| Branch state | Branches ahead of the base, commit count and diff size on each | Which branches to offer, and a suggested level (`quick` for a huge diff, for example) |
| Languages | Mix of source files in the repo and in the diff (JS/TS, Python, C#) | Which skills and rules apply |
| Tests | Test command and framework, found from `package.json` scripts, `pytest` or `tox` config, `*.csproj`, and similar | Test Runner command |
| CI | Existing workflow files and what they already run | Avoid duplicating checks |
| Tickets | Ticket ID in the branch name, or ticket files in the repo | Acceptance-criteria checker input |
| Tooling | Node version, `git` version, whether the `claude` CLI is on `PATH`, whether the VS Code extension bundles one | Setup checks and friendly errors |
| Existing setup | Any Swag Scan config, `.bug-hunter/`, or installed skills (`.github/skills`, `.agents/skills`) | Detect a re-run or an upgrade |
| Permissions | Existing agent permission settings, such as Claude Code allow rules in `.claude/settings.json` | Suggest a small allowlist, and warn about rules that would block a run |
| Many repos | Scan a chosen parent folder for repos with branches ahead of their base | Pre-fill the repo list for a multi-repo run |

**Rules for the scan:**
- **Read-only, local, no network.** It changes nothing and sends no file contents anywhere.
- **Never open secrets.** Skip `.env` files, key files, and credential stores. It reads settings and config names, not secret values.
- **Show what it found.** The wizard displays the findings ("Found: 3 repos, Node 24, tests via `npm test`") so the user can see and correct them.
- **Every finding is an editable default, never a decision.** Heuristics will sometimes be wrong.
- **Bounded:** a time limit and file-count limit so a huge repo or folder doesn't hang the first run.
- **Reusable:** the same report powers a quick "doctor" check later (`/swag-scan:doctor`) to explain why a run failed.

**Shape:** a zero-dependency script such as `scripts/discover.mjs` that prints one JSON report. The wizard (in chat, terminal,
or HTML) reads that report to pre-fill its answers, and the same script runs in answers mode with no prompts.
- [ ] Define the JSON report format, and keep it stable so all wizard front ends can share it.
- [ ] Decide how much of the permissions inspection is safe and useful, given that setting formats differ per platform and are unverified.
- [ ] Decide the scan's default scope when run from a parent folder with many repos.

**Rules for asking:**
- **Detect first, ask only what can't be detected,** and show the detected value as the default.
- Every question can be skipped with "use defaults". Setup must never block the first run.
- Answers are **saved**, never asked twice, and can be changed later by re-running `/swag-scan:setup`. Preferences are local to the
  user and not committed. An optional step writes a team default into the repo.
- A headless or unattended run **never asks**. It uses saved answers or built-in defaults, and fails with a clear message
  that names the missing answer.
- Prefer multiple choice over free text. Use fill-in-the-blank only for paths and branch names.

**How to ask (unverified, check per platform):**
- Claude Code has a structured multiple-choice question tool that a skill can ask the agent to use. Confirm it is available
  to plugin skills in every context.
- Copilot: probably numbered options in chat. Not verified.

**Known friction to design around:**
- [ ] **Base branch:** the configs default to `origin/HEAD`, which fails with no remote or an unset default branch. Detect and fall back.
- [ ] **Node 22 or 24 required:** setup should give a friendly message, not a stack trace, when it's missing.
- [ ] **`claude` CLI may not be on PATH** (it wasn't on the author's machine). An unattended runner must find it, and setup should check.
- [ ] **First-run permission prompts:** setup could suggest a small allowlist, matching the "fixed, predictable command form" rule above.
- [ ] A team can commit a default so new developers get the plugin enabled and configured automatically. Unverified; check how
      Claude Code project settings pre-register a marketplace and enable a plugin.

**Suggested build order for onboarding:**
1. Sensible defaults and base-branch detection, so zero-config works.
2. `/swag-scan:setup` with the three questions, the checks, and the dry run.
3. Repo registration for the multi-repo case (`/swag-scan:repos add <path>`, then `--all-repos`).
4. A short "Getting started" section in the README: the two install commands and one command to try.

### The default run: the "golden path" (placeholder)

**Scenario:** a brand-new developer has finished the wizard, has three branches across three repos, doesn't know the settings, and
just asks the agent: "can you run Swag Scan for me?" This is the moment that decides whether they stay. It has to run smoothly,
feel fast, and never ask for anything else.

**Requirements for the default run:**
- **No questions.** The wizard already collected what's needed. If it was skipped, use built-in defaults and the scan's findings.
- **One request, whole job.** "Run Swag Scan" maps to the default `/swag-scan` run without the user knowing flags or agent names.
- **Fast, with visible progress.** Print what is happening right away ("Scanning 3 branches...") and show each branch's result as it
  finishes, not one wall of output at the end. Branches and repos run in parallel.
- **Safe on the first try.** The first run **changes no files** (report only, no autofix), which builds trust. Autofix turns on
  later, at the user's choice.
- **Never a stack trace.** Every failure becomes one plain sentence with the fix (for example "No commits ahead of `main` on this
  branch, so there is nothing to review").
- **A clear next step.** The report ends with one suggestion, such as "Go deeper on the 4 flagged items?", never a list of flags.

**Proposed default strategy: fast first, deeper on demand (progressive).**
1. **Pass 1: all agents in `quick` mode, on every branch, in parallel.** Scripts only, no model. Target is seconds, not minutes
   (unmeasured, to be confirmed on real repos). Analyst: scanners plus affected tests with a time limit. Inspector: Code Sweeper's scanner.
   Security Guard: Security Auditor's scanner.
2. **Show the results immediately,** decisions-first and short, with the findings labeled honestly as **leads** from scripts, since no
   model has verified them yet.
3. **Offer one click or reply to go deeper,** and run the model review **only on the flagged items** (the existing cheap triage, then
   stronger model on what survives), under a budget cap. This is the `standard` level applied to just the leads.

**Where I'd push back on "just run everything in quick mode":** `quick` has no model judgment, so on its own the first report
could feel thin or noisy (pattern matches, not verified findings), and a thin first impression is its own way to lose a developer.
The progressive plan keeps the speed and the zero-token first pass, and still gets to real, verified findings after one more step.
- [ ] Decide whether the default run stops after pass 1 and offers to go deeper, or continues automatically into pass 2 for the
      top flagged items under a small budget. Fully automatic risks a surprise bill, and stopping risks a thin first report.

**Smoothness details to design:**
- **Tests can be slow.** Run them with a time limit, in the background, and report partial results ("tests still running") instead of
  blocking the whole report.
- **Many branches:** parallel, each isolated (git worktrees, see above), with one combined summary at the end.
- **Resolve "run Swag Scan" reliably:** the main skill's description must match plain requests in natural language, and the
  agent must map them to the default run with no arguments.
- **Re-run is cheap:** results cached by commit hash, so asking again with no new commits returns instantly.
- **Show the cost honestly:** one line, such as "Pass 1 used no model tokens", so users learn what the tool spends.

**How we'll know it works (acceptance checks, to turn into tests):**
- [ ] Golden-path test: from a fresh install in a throwaway repo, one request runs the default flow end to end with zero prompts.
- [ ] Time to first result stays under a target we set after measuring on real repos.
- [ ] Zero edits to the user's files on the first run.
- [ ] Each common failure (no base branch, no commits ahead, Node missing, tests time out) produces a one-sentence fix and no stack trace.
- [ ] Record tokens and wall-clock time per run so we can tune with data, not guesses.

**Advanced settings come later:** only after a good first result do we point to levels, agent choice, autofix, and `config.json`
(see "User experience and orchestration").

### Review view: findings shown like a code review (placeholder, build only if it proves reliable)

**Idea:** the agents are characters, so present results the way a developer experiences a human code review (say, a Bitbucket
pull request): each changed file as a diff, added lines in green, removed lines in red, and each agent's comment attached to the
line it flagged, with that agent's portrait and name. A developer sees exactly which code an agent is talking about instead of
matching `file:line` references by hand.

**Rule for this feature:** it ships only if it works nearly every run at close to zero cost. If a prototype fails often, we
drop it and keep the plain report. A broken or misplaced comment is worse than no comment.

**Chosen route (cheapest, fastest, least likely to fail):**
1. **A script does all the rendering, never the model.** The agent only supplies its findings as JSON (agent, file, line,
   severity, message). A new zero-dependency script in `skills/review-tools-common/` reads the diff and that JSON and writes
   the output. No tokens spent, same result every run, works on any agent or platform, and needs no network.
2. **Per-finding snippets first.** Each finding in the normal report includes the flagged line plus a few lines of context as a
   small diff hunk, under that agent's name. This is plain text, so it works in a terminal, chat, or CI log.
3. **One review file as a later step.** A single self-contained HTML file (inline CSS, no scripts needed to read it, portraits
   embedded from `assets/agents/`) holding only the files that have findings. The path is printed at the end of the run. It never
   auto-opens, so headless and CI runs behave the same as interactive ones.
4. **Skipped for now:** one `.diff` file per commented file (the HTML covers it), live comment bubbles, and anything that needs
   a server or a library.

**What gets a comment: only findings that need a decision.** The review view is for things the developer must weigh, not
things already handled.
- **Auto-fixed items get no comment in the diff view.** Findings that meet the auto-fix criteria are fixed every run unless the
  user has turned auto-fix off on purpose (for example Code Sweeper's `autoFix.enabled`, or `--no-fix` / dry-run for one run).
  They appear only in the final report, in an "Auto-fixed" list saying what changed, and the diff view then shows the
  already-fixed code. (Today Code Sweeper auto-fixes clear, low-risk 🔴 Unclean findings and never auto-fixes 🟡 Dusty ones.)
- **Commented (needs a decision):** findings that are never auto-fixed (such as 🟡 Dusty), findings downgraded because a safe fix
  wasn't possible (for example a function with outside references), report-only agents such as the Security Guard, and anything
  where the fix is a judgment call.
- **When auto-fix is off:** items that would have been fixed are no longer handled, so they become decisions and do get comments,
  marked "would have been auto-fixed" so the developer knows they are low-risk.
- **Each finding carries a `disposition`** in the shared findings JSON: `auto-fixed`, `needs-decision`, or
  `would-auto-fix` (auto-fix was off). The script comments only on the last two; the summary report lists all three.
- **Same agent, two places:** the Inspector can have both kinds in one run, so the report might say "4 auto-fixed, 2 need your
  call" with only the 2 appearing as comments.
- **Do not touch the criteria here.** What counts as auto-fixable stays defined by each skill and its config. The review view
  only reads the disposition.

**When it runs: last, after every agent's auto-fixes are done.** The review view is built from the final state of the code, so it
is the last step of a run, alongside the final report.
1. All agents run and apply their auto-fixes (one agent's fixes can shift another agent's line numbers, so nothing is built
   until the last fix is in).
2. Take the final diff against the base, once.
3. Re-anchor every `needs-decision` finding to that final diff. Each finding keeps the exact flagged text next to its line
   number, and the script finds that text near the reported line. If the text is not found, the finding goes to "Unplaced
   findings" (see the reliability rules).
4. Build the final report and the review view from that same final diff. They only read the finished state and do not depend on
   each other, so they can run in parallel. The only link is that the report prints the review file's path (or says it was
   skipped).
- The review view never edits code, so running it last cannot change anything the agents already did.
- If a run stops early or an agent fails, build the view from whatever state exists, mark which agents finished, and never wait
  on a missing agent.

**Reliability rules (the thing that keeps the failure rate low):**
- A finding is shown inline only if its line number is verified to exist on the new side of the diff. Otherwise it appears in
  an "Unplaced findings" list at the bottom, with the `file:line` as today. Nothing is dropped and nothing is misplaced.
- If rendering fails for any reason, the run still ends with the normal report. The review file is an extra, never a
  requirement.
- Output goes to a gitignored folder (or the OS temp directory), so it can't be committed by accident.
- Large diffs: cap the number of files and lines shown, and say what was left out.

**Open questions / checks before building:**
- [ ] **Line numbers:** confirm Code Sweeper, Bug Hunter and Security Auditor each report new-side line numbers that match the
      diff. Code Sweeper's scanner already reports file and line, so check the other two. Add a test that maps every reported
      line onto the diff.
- [ ] **Findings JSON shape:** one shared shape for all agents, defined once in `review-tools-common`, including `disposition`.
- [x] **Line numbers after auto-fix:** decided. The view is built last, from the post-fix diff (see "When it runs"). Still to
      confirm: the findings JSON carries the flagged text, not only the line number, so re-anchoring works.
- [ ] **Orchestration hook:** where the last step plugs into the orchestrator (see the User experience section) so it always
      runs after the final agent, and what happens in a single-agent run (same step, just one agent).
- [ ] **First-run mode:** the golden path's first run is report-only. Confirm those findings show as `would-auto-fix` and get
      comments, not a silent list.
- [ ] **Success bar:** run the prototype on a set of real branches and count placed versus unplaced findings. Proposal: build the
      HTML file only if at least 95% of findings land on the right line.
- [ ] **Binary, renamed, and deleted files:** show a one-line note instead of a diff.
- [ ] **Where the folder lives and how it's cleaned up** between runs.
- [ ] **Auto-open:** leave off by default. Maybe an opt-in flag for interactive runs.

### Live view: feedback while a scan runs (placeholder, lightweight or not at all)

**Idea:** a scan can take many minutes. Instead of silence, the developer sees the crew at work: the Inspector's face with "Checked
5 of 12 files. Built to spec so far.", then the Security Guard's face with "Possible issue in `config.py`. Pulling the details.",
then the Analyst with "Tests running, step 3 of 5." The permission prompts stay in the chat window as they do now.

**Hard limits (these come before the feature):**
- **No model tokens spent on the live view.** Progress comes from the scripts that already run. The voiced lines are fixed
  templates per agent and event type (for example "Possible issue in {file}. Pulling the details."), not model output. The model's
  own voice is saved for the findings in the report (see Agent voice in reports).
- **No extra permission prompts.** The agent never runs a command just to post an update. The scripts that already run write the
  events themselves.
- **Optional and never in the way.** If the live view fails, is closed, or is not supported, the scan runs and reports as normal.
- **Small effort.** One event file, one small page, one small Claude Code add-on at most. If a step turns out bigger than that, drop it. Build
  it only after the golden path works, because scan quality comes first.
- **Steps, not percentages.** Show "step 3 of 5" or "5 of 12 files", which are real counts. Do not show a percent for the model
  review phases, where the time can't be predicted.

**Design: one event file, thin viewers.**
1. **Event file.** Scripts append one line per event to a file in the run folder (the same gitignored folder as the Review view):
   time, agent, kind (`started`, `progress`, `finding`, `done`), and small fields such as counts or the file name. No code, no
   findings text beyond the file name. One shared writer in `review-tools-common`.
2. **Viewer A, an auto-refreshing HTML page (works for everyone, including Copilot).** A script rewrites a self-contained page
   from the event file every few seconds, and the page reloads itself. It shows each agent's portrait, their latest line, and the
   step count. The path is printed once and the page is never opened automatically unless the user passes `--live`.
   Browsers block a local page from reading other files live, which is why the data is written into the page itself.
3. **Viewer B, inside Claude Code (Claude Code only).** A small add-on in the plugin reads the same event file and shows it in the
   chat window. Cheapest first: a status line entry (for example "Inspector: 5 of 12 files") and a short toast when an agent
   starts or finds something. Later, if the surface supports it, a live pane beside the chat with the portraits.
4. **Same final report either way.** The live view is only a preview. The report and the Review view stay the source of truth.

**Reference design:** `assets/agents/live-view-mockup.html` is the approved mock-up (a sped-up sample scan: crew cards with live
speech bubbles, a five-step tracker, running counts, and a newest-first timeline). It is sample data only. Replay, pause and speed
buttons are mock-up controls and would not ship.
The mock-up also shows the permission toast: "Analyst is waiting for you. Approve the request in the chat window." It appears,
then goes away on its own after a few seconds or when dismissed. **The page never tracks whether the user approved.** It only
nudges, which keeps the dashboard light and avoids any link between the page and the approval itself.

**Permissions and one-screen use (idea).** Some developers have only one screen, so switching between a progress page and the
window where permission prompts appear gets annoying. Ideas, best first:
1. **Fewer prompts in the first place (decided: definitely try; works everywhere, no new UI).** Give the scripts one fixed entry point
   (for example `node .../swag-scan.mjs <command>`) so a single allow rule covers them, instead of many command shapes that
   defeat allowlists (see Gotchas). Ship a recommended allowlist, and look at a plugin hook that auto-allows only Swag Scan's own
   read-only scripts and writes to its run folder. Everything else still asks. In onboarding, suggest a permission mode that
   fits auto-fix (for example accepting edits) so edits don't prompt one by one. This is the biggest win for the least work.
2. **Put the live view where the prompts already are (decide later).** The Claude Code add-on (status line, toast, maybe a pane) shows progress in
   the same window, so there is no second screen to watch. This is Viewer B above.
3. **A "waiting for you" toast or flag (decided: OK to include).** A permission hook writes an event ("Inspector is waiting for your approval"), so the page
   (and optionally a sound) tells the user when to switch back, as a toast or a flag on the page. It saves staring at the chat, but the user still has to switch.
4. **Approve from the page: not planned (decided).** A browser page cannot answer Claude Code's prompts, and it should not be able to,
   since approvals are a security decision made in the host app. The add-on API appears to include permission-check hooks and a
   way to ask the user a question inside the add-on's own UI, so an in-pane prompt might be possible. Not verified, so do not plan
   on it.
5. **Show the page inside the editor (decide later).** For VS Code users, open the live page in an editor tab beside the chat (for example the
   built-in Simple Browser, which may need a small local server) so everything is on one screen. To be tested.

**Status of these ideas:** (1) is a firm goal, and (3) is in scope as a toast or flag on the page. (2) and (5) wait until the
add-on and editor-tab checks below are answered. (4) is not planned. The remaining decision points come later.

**What to verify before building:**
- [ ] Can a Claude Code add-on ship inside the Swag Scan plugin (it is a plugin "mod" with a hooks module), and does it load for
      users who install from the marketplace? What does the user have to approve?
- [ ] Permissions: does a plugin hook that auto-allows only Swag Scan's own scripts work for marketplace installs, and what does
      the user see when it is installed? Does a single fixed entry-point script keep allow rules matching across runs?
- [ ] Does VS Code's Simple Browser open a local file or only a local server, and is that worth the extra moving part?
- [ ] Which surfaces can draw a pane (terminal, desktop app, VS Code), and which only show a status line or toast? Design for
      the status line and toast first, since they are the most likely to work everywhere.
- [ ] Does Claude Code tell an add-on when a subagent starts and stops? If so, those can be events too, with no script changes.
- [ ] Event file shape (kinds, fields) and how often to write, so a fast scan doesn't spend its time updating a file.
- [ ] Cleanup of old run folders, and what the page shows when a run ends or crashes ("Run ended early").
- [ ] Copilot in VS Code: only the HTML viewer applies. Confirm it's worth shipping there.

### Future possibilities (ideas only, not committed to)

Not planned yet. These are the ideas that came out of discussing where Swag Scan could grow. Pick from here later.

**Suggested order if we build more:** Security Guard first (it's in the plan above), then Release Manager, then Docs Steward.

**More tools for the Security Guard**
- **Secrets Sentry:** hardcoded secrets, committed `.env` files, and keys in test fixtures. Security Auditor covers some of this
  already (`CRIT-201`), so decide whether it splits out.

**Release Manager** (is this change ready to ship?)
- **PR Packager:** writes the PR description and a change summary from the diff and ticket, so reviewers understand intent.
- **Breaking-Change Detector:** changes to public APIs, config shapes, CLI flags, and schemas.
- **Migration Checker:** database and data migrations. Are they reversible, safe on large tables, and ordered correctly?

**Docs Steward** (does the documentation still tell the truth?)
- **Docs Drift Checker:** README, comments, and API docs that no longer match the changed code.
- **Changelog Keeper:** drafts changelog entries for user-visible changes.

**Performance Engineer** (build last; false positives are likely)
- An efficiency checker for N+1 queries, repeated work in loops, and unbounded growth, plus a lightweight benchmark gate.

**Accessibility or UX Reviewer** (only if frontends are a target)
- Missing labels, keyboard traps, and similar issues in changed UI code.

**Watch-outs when building any of these**
- Decide who owns overlapping rules early (as with Test Tailor and Code Sweeper, and Secrets Sentry and Security Auditor).
- Safe automated fixes suit docs and changelog work. Security, migration, and breaking-change findings should report only.
- Give new tools names in the same spirit as Test Tailor and Debt Collector.

## Marketing and showcase (placeholder)

**Asset on hand:** `assets/banner/swag-scan-banner.png` (1600×1530) and its source `assets/banner/swag-scan-banner.html`.
It shows the three planned agents, their tool belts, the "scripts first, models only where they matter" flow, and the planned run
levels. It also has a hosted draft on claude.ai (private until shared). Built tools are solid and planned ones are dashed
and marked "coming soon", with a footer saying the rest is on the roadmap.

**Where to use it, best first:**
- [ ] **GitHub README:** add a "How it works" section below the install lines with the banner image, keeping the logo and tagline on top.
      Needs the committed PNG (a README can't embed a private page). Mind the file size and consider a dark-mode variant via `<picture>`.
- [ ] **GitHub social preview image** (repo settings; the card shown when the link is shared). GitHub recommends about 2:1
      (1280×640), so make a wide variant: logo, headline, and a simplified diagram.
- [ ] **Launch posts** (blog, LinkedIn, X) for v0.1.0, plus talk slides and a future docs page.
- [ ] **Marketplace:** as far as known, a plugin marketplace is a catalog (`marketplace.json`) with no banner field; the plugin icon is the
      only visual element found in the docs. A plugin directory listing might support more. Unverified; check before submitting.

**Keeping it honest:** the banner shows unbuilt things as "coming soon". Update it as tools and agents ship, and re-check the
labels before using it anywhere public.

**Regenerating the PNG (headless Chrome, no installs):**

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1600,1530 --virtual-time-budget=8000 --force-device-scale-factor=1 \
  --screenshot="$PWD/assets/banner/swag-scan-banner.png" "file://$PWD/assets/banner/swag-scan-banner.html"
```

The HTML loads Google Fonts (Inter and Montserrat) over the network, so render with a connection.

- [ ] Designer feedback may change the look; regenerate the PNG and the social preview from the updated source.
- [ ] Before merging to `main`, decide what stays in `assets/` (PNG only, or the source HTML too).

## Decisions already made (don't relitigate)
- **Scope (2026-11-02): Claude Code first.** Build and polish the plugin for Claude Code. Copilot and Codex are a later, nice-to-have. Keep the core
  agent-neutral so they can be added without a rewrite: scripts and skills in `skills/`, persona text and the findings shape in plain files, and
  every Claude Code-only piece (agents, `bin/`, hooks, entry command) in its own thin layer that is generated from or points to the neutral sources.
- Renamed the existing repo to `swag-scan` (no new repo). One source of truth in `skills/`, with thin per-platform wrappers.
- Targets Claude Code and GitHub Copilot (VS Code) for v0.1.0.
- Model roles are a per-agent map (`models.claude` / `models.copilot`). `null` means the agent's default model.
  No backward-compat fallback for the old flat `models.basic` shape (README migration note only).
- Plugin icon is the symbol only, redrawn bold and simplified. `plugin.json` references it with `"icon"`.
- Code Sweeper reports commented-out code and stale TODOs as 🟡 Dusty, by agent judgment and not by a scanner rule.
- Agents are the Analyst (was QA), the Inspector (was Tech Lead) and the Security Guard. Reports and live lines are written in each agent's voice.
- Auto-fixed items appear only in the final report. The review view comments only on items that need a decision, and it is built last, from the final diff.
- Live view and review view cost no extra model tokens and never block a scan. Fewer permission prompts is a firm goal. A browser page does not approve permissions, but may show a "waiting for you" toast or flag.

## Useful commands

```bash
# tests
node --test "skills/bug-hunter/test/*.test.mjs" "skills/code-sweeper/test/*.test.mjs" \
  "skills/security-auditor/test/*.test.mjs" "skills/review-tools-common/test/*.test.mjs"

# validate the plugin (the CLI is bundled with the VS Code extension; `claude` is not on PATH)
~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude plugin validate . --strict

# install into a project for Copilot
node scripts/install-copilot.mjs --project <dir> [--target .agents/skills] [--force]
```

## Gotchas
- Headless `claude -p` runs with broad Bash were blocked by the auto-mode classifier, and narrow Bash allowlists failed
  because the agent varies its command form. Use an interactive session for the live tests.
- The marketplace reads the default branch, so the Claude Code install commands only work after the merge.

## Session log
- 2026-10-31: restructure tasks 0 to 7, pre-PR verification (CLI validation, CI, Code Sweeper test, migration note), plugin icon.
- 2026-10-31 (later): captured the vision in the roadmap sections (agents, orchestration, onboarding, golden path), added a contents table, built the banner and saved it to `assets/banner/`.
- 2026-10-31 (evening): designed the three agent portraits (then QA, Tech Lead, Security Guard), saved them to `assets/agents/`, and recorded each agent's character in the agents layer.
- 2026-10-31 (night): added the "Review view" idea (diffs with agent comments on flagged lines) to the roadmap, scoped to a script-rendered, no-token route with a reliability bar.
- 2026-10-31 (late): review view only comments on findings that need a decision; auto-fixed items go in the final report only (added `disposition` to the findings idea).
- 2026-10-31 (late, 2): review view runs as the last step, after all agents' auto-fixes, from the final diff, in parallel with the final report; findings keep flagged text for re-anchoring.
- 2026-10-31 (night, 2): renamed QA to Analyst and Tech Lead to Inspector (building-inspector look: hard hat, hi-vis vest, pencil behind the ear); portraits are now `analyst`, `inspector`, `security-guard` in `assets/agents/`.
- 2026-10-31 (night, 3): added a Tool belts section with an icon per tool (built and planned) to the crew page.
- 2026-10-31 (night, 4): restyled the crew sheet under the Swag Scan logo and banner style (agent card plus tool belt per column), and saved it as `assets/agents/swag-scan-crew.png`.
- 2026-10-31 (night, 5): added "Agent voice in reports" to the agents layer: findings are worded in each agent's persona, with facts unchanged and a `voice` setting.
- 2026-10-31 (night, 6): renamed the agents in the banner (HTML and PNG) and pushed the branch.
- 2026-10-31 (night, 7): added "Live view" (progress while a scan runs): one event file written by scripts, canned per-agent lines, an HTML page and an optional Claude Code status line or pane; zero extra tokens.
- 2026-10-31 (night, 8): saved the live view mock-up to `assets/agents/live-view-mockup.html` and added ideas for permission prompts and one-screen use to the Live view plan.
- 2026-10-31 (night, 9): recorded decisions: aim for fewer permission prompts, a "waiting for you" toast or flag is OK in the live page, approving from the page is not planned.
- 2026-10-31 (night, 10): added the "waiting for you" toast to the live view mock-up (no approval tracking, by design).
- 2026-11-02: prototype phase 1 (shore up the tools), step 0 audit done on throwaway fixtures. Findings: no-arg runs use base `HEAD`
  (config says `HEAD`, README says `origin/HEAD`), so a committed branch gives a silent empty diff. The size gate counts changed-line
  text only, about 46% of the collector's JSON size. `0 excluded files` is correct when nothing matches, but the message is misleading
  (it also shows 0 when the diff is empty). `--ticket` takes a bare name only; the ticket folder comes from repo config.
  Step 1 done (uncommitted): collector auto-detects the base (`baseRef: "auto"` in all three configs), reports an empty diff with a
  suggested ref, and prints a changed/excluded/scanned and bytes-vs-gate summary line; 138 of 138 tests pass.
  Step 2 done: `review-tools-common/coverage.mjs` gives a per-language coverage line; the collector, all three scanners and the Bug
  Hunter report carry it, unsupported files show as ⚪ Unchecked, and each SKILL.md says never to list them as Clean.
  Step 3 done: `check-diff-size` returns a `decision` (`proceed`, `ask`, `review-riskiest`); unattended mode comes from
  `--non-interactive`, `SWAG_SCAN_NONINTERACTIVE=1` or `CI`, and the report says the run did not ask. The gate counts changed-line text
  (about half the collector's JSON). Step 3b: `build-packets` used to cut any contiguous change over 300 lines (`MAX_HUNK_LINES`) and
  mark the packet `truncated`, never disclosed, so a 500-line new file was partly reviewed in silence. It now splits such changes into
  several packets, so every changed line is reviewed or listed as omitted. 151 of 151 tests pass.
  Step 6 done (Bug Hunter side): `review-tools-common/ticket.mjs` finds the ticket (ID from the branch name, `--ticket` as ID or path, folder from
  `--ticket-dir`, `SWAG_SCAN_TICKET_DIR`, `~/.swag-scan/settings.json` or repo config), parses it tolerantly, and gives reviewers only title,
  description and acceptance criteria (status and logs removed). It also parses `## Repositories` for the multi-repo step. The user settings
  file `~/.swag-scan/settings.json` is a first piece of the onboarding "saved answers" idea. 165 of 165 tests pass. Format is in the README.
  Cache done (Bug Hunter): `review-tools-common/cache.mjs` (`check` and `store`) keys a finished run by HEAD, base commit, config, ticket text and a
  fingerprint of the tool's own scripts; results live in `.swag-scan/cache/` (gitignored); never cached with uncommitted changes. Code Sweeper
  and Security Auditor adopt it through the Phase 2 orchestrator. Phase 1 is complete except the live agent tests (parked).
  Phase 2 started. Orchestrator step done (uncommitted): `skills/review-tools-common/swag-scan.mjs run` (in `skills/` so it travels with the
  Copilot install) runs Analyst, Inspector and Security Guard scripts in a fixed order, report-only, 0 model tokens, one progress line per
  agent, results in `.swag-scan/run/`, plain-sentence errors, cache status per agent. Bug found and fixed on the way: the tools scanned their
  own output folders; the collector now always ignores `.swag-scan/` and `.bug-hunter/`. 184 of 184 tests pass.
  Plan: phase 1 tools (collector fixes, language coverage, non-interactive gate, ticket handling), phase 2 agents and orchestrator, phase 3 event log, multi-repo, dashboard.
- 2026-11-04: dashboard prototype (live view page). Built from the event log by a script, no model. Choices: data file re-loaded by the page instead of
  meta refresh (toasts survive); page and data live in `.swag-scan/` (not `run/`, which a new run wipes); the watcher ignores a finished run left over from
  before it started; `--live` is opt-in and never auto-opens. Differences from the mock-up: real steps (Read the diff, Scripts scan, Agents review,
  Findings saved, Report); stats are files scanned, leads, findings, need-your-call, elapsed ("Fixed for you" dropped: first run is report-only);
  no per-file "checked n of 12" because scripts report steps, not files; no replay controls; system fonts (no Google Fonts, offline rule). 8 new tests.
- 2026-11-04 (later): finished banner restyled and the prototype approved (see Resume here for the color rule and the Markdown-in-Safari gap). 243 tests pass.
- 2026-11-06: trial-run feedback arrived (Windows; TypeScript/React and Python repos). Added the "Trial-run feedback" table under To do. Fixed the three criticals: guard keeps Windows backslashes (lexer follows real bash rules inside double quotes, keeps `C:\` paths), Analyst report routed into `.swag-scan/`, untracked-file flood warning + fixture folders skipped. Full suite 246 passing on macOS; the Windows guard fix still needs a Windows re-run. Saved Jeremy's `Memory.md` working preferences to memory.
- 2026-11-06 (later): fixed items 4, 5, 6 and 9 of the trial-run table (base-ref warning, ticket tables parsed separately and scoped to the repo, dashboard watcher survives write errors, `ticket.id` shows the name, `.gitattributes`). 251 tests pass on macOS. Still Todo: 7 (scanner noise), 8 (`report.html`), 10 (docs), and the idle state of Finding 15.
- 2026-11-06 (evening): item 8 done: `report.html` next to `report.md`, dashboard button opens it. 255 tests pass. Checked visually with headless Chrome (dark theme, tables, wrapped paths). Still Todo: 7 (scanner noise), 10 (docs), Finding 15 (idle state), Finding 25 (shorter paths in tables).
