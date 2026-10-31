# Swag Scan: working plan (branch `plugin-restructure`)

> **Temporary file.** Delete `PLAN.md` before this branch is merged into `main`
> (`git rm PLAN.md`), and make that its own commit.

## Resume here

Last updated: 2026-10-31

- **Done:** repo flattened to `skills/`, agent-neutral paths, Claude Code plugin and marketplace manifests,
  Copilot installer, per-agent model roles, root README, CI workflow, Code Sweeper end-to-end test,
  placeholder plugin icon. 134 of 134 tests pass on Node 24, and `claude plugin validate . --strict` passes.
- **Next:** the live agent tests below (nothing has run through a real agent session yet), then push the branch.
- Update this section at the end of every session, and tick boxes as you go.

## To do

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
- [ ] Designer feedback on the logo, then redo `.claude-plugin/icon.png` and the README logo. The current icon is a placeholder.
      Consider a dark-mode README logo via `<picture>`.
- [ ] Decide whether the Copilot installer should copy `test/` folders. It currently skips them.
- [ ] Add `node_modules/` and `.DS_Store` to `.gitignore` (it holds only `.bug-hunter/`).
- [ ] The `TOOLS=<parent directory of this skill folder>` line in each `SKILL.md` is a placeholder the agent fills in.
      It worked in the headless test. Revisit if another agent has trouble with it.
- [ ] Optional: a deterministic scanner rule for commented-out code (`SWEEP-113`). The `SKILL.md` line covers it by agent judgment for now.
- [ ] Out of scope for now: Codex support (v0.2.0) and npm publishing (after v0.1.0).

## Decisions already made (don't relitigate)
- Renamed the existing repo to `swag-scan` (no new repo). One source of truth in `skills/`, with thin per-platform wrappers.
- Targets Claude Code and GitHub Copilot (VS Code) for v0.1.0.
- Model roles are a per-agent map (`models.claude` / `models.copilot`). `null` means the agent's default model.
  No backward-compat fallback for the old flat `models.basic` shape (README migration note only).
- Plugin icon is the symbol only, redrawn bold and simplified. `plugin.json` references it with `"icon"`.
- Code Sweeper reports commented-out code and stale TODOs as 🟡 Dusty, by agent judgment and not by a scanner rule.

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
