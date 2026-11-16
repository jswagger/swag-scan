# Swag Scan: trial-run handoff (round 2)

You are the next agent to trial-run Swag Scan on a real repository, on a different computer from the one that built it. Your job has two parts:

1. **Verify the fixes** made after round 1 (the table in section 3), especially the ones that could only be tested on macOS.
2. **Collect the evidence** the maintainer says would improve the tool most (section 5), and write it up in the format in section 6.

You are testing, not fixing. **Do not edit the tool's code.** If something is broken, record it with the exact error text and move on.

This file is temporary, like `PLAN.md`: delete it before merging `plugin-restructure` into `main`.

---

## 1. What Swag Scan is (two minutes)

A Claude Code plugin that reviews the diff of a feature branch with three agents, each with scripts that find *leads* and a model that judges them:

| Agent | Looks for | Scripts behind it |
|-------|-----------|-------------------|
| **Analyst** | Regressions, removed guards, changed behavior, ticket coverage | Bug Hunter |
| **Inspector** | Code quality: size, duplication, loose types, weak tests | Code Sweeper |
| **Security Guard** | Security issues | Security Auditor |

A run is: scripts scan (no model, no tokens) → agents review the leads in parallel → findings are saved → one **decisions-first report** is built. It is **report-only**: nothing in the reviewed repository should be edited. Output goes to `<repo>/.swag-scan/`. A `--live` flag opens a dashboard page that shows progress.

Round 1 was run on a TypeScript/React repo and a Python repo, on Windows 11 with Node 22. Verdict: the agents' judgment was the strongest part (honest "verify" findings, one probable real bug), the scripts-only layer was the noisiest, and a few Windows and workflow bugs needed fixing. They have been fixed; you are checking that the fixes hold.

## 2. Setup

1. **Get the tool.** `git clone https://github.com/jswagger/swag-scan.git`, then `git checkout plugin-restructure && git pull`. If you already have it, `git pull` on that branch. Confirm you have the latest by running `git log --oneline -3`; the top commit should be *"Document Windows and VS Code launch steps and a first-run checklist"* or later. If it is not, stop and tell the maintainer, because the branch may not have been pushed.
2. **Needs:** Node 22 or 24, `git`, and the Claude Code CLI.
3. **Run the tool's own tests first** (from the tool's folder). Record the totals; round 1 ended at **261 passing** on macOS.
   ```bash
   node --test "skills/bug-hunter/test/*.test.mjs" "skills/code-sweeper/test/*.test.mjs" \
     "skills/security-auditor/test/*.test.mjs" "skills/review-tools-common/test/*.test.mjs"
   ```
   **On Windows this matters:** round 1 had 4 failing tests there (numbered 131, 132, 195, 196 in that output) caused by the Bash guard. They should now pass. Copy the output of any failing test exactly.
4. **Launch Claude with the plugin loaded from the folder** (nothing is installed):
   - macOS/Linux: `claude --plugin-dir <path to swag-scan>`
   - Windows with the VS Code extension, where `claude` may not be on the PATH: see the README section *Windows and the VS Code extension* for the bundled `claude.exe` path and the PowerShell vs Command Prompt forms.
   - Then **type the slash command inside the Claude session**, not in the shell: `/swag-scan:swag-scan <base> [--ticket <path-or-id>] [--live]`.
5. **Start the session inside the repository you are reviewing** (`cd` first). One session per repository.

### Before the first run in the repository under review

Follow the README section *First run in a new repository*. In short: pick the real merge target as the base, add `.swag-scan/` to `.git/info/exclude`, and make sure large local data folders are excluded. **Do not commit or push anything in the repository under review.**

You can also run the scripts-only scan with no model and no tokens, which is a good first look:

```bash
node <swag-scan folder>/skills/review-tools-common/swag-scan.mjs run --repo <repo> --base <ref> [--ticket <path>]
```

## 3. Fixes to verify

For each row, say **confirmed**, **not confirmed** (with evidence), or **could not test** (and why). Row numbers match the maintainer's `PLAN.md` table.

| # | Fix | How to check | Expected |
|---|-----|--------------|----------|
| 1 | Bash guard no longer eats backslashes in Windows paths | Windows only. Run the unit tests; then run the full crew and watch for any agent command being blocked | Guard tests pass. No `guard blocked` text in the run. **Also see question Q1** |
| 2 | Analyst report no longer lands in the reviewed repo | After a full run, run `git status --ignored` in the reviewed repo and look for `.bug-hunter/` | No `.bug-hunter/` folder in the repo. The Analyst's report is under `.swag-scan/run/bug-hunter-reports/` |
| 3 | Untracked-file flood is visible | Have untracked files present (a few, then many if you can) and read the scan summary | Summary shows `Scanned N files: X in the branch diff, Y untracked.` With more than 20 untracked, or more than 5 times the branch diff, a `Warning:` line says how to exclude them. Folders named `testdata`, `fixtures`, `__snapshots__` are skipped for untracked files |
| 4 | Wrong-base warning | Run once with an obviously wrong base (for example an old long-lived branch) | A warning says the change touches many more files against that base than against another, naming the other base. **No warning** with the right base |
| 5 | Ticket tables | Use a ticket with a prose criteria list and a per-repo checklist, if you have one | Both lists parsed, no header row appearing as a criterion, criteria for other repositories shown as `Other repo, not scanned`, blank repository shown as `(all)`, and no finding linked to another repository's criterion |
| 6 | Dashboard watcher survives write errors | Run with `--live` and keep the dashboard open in a browser for the whole run, ideally on Windows | Watcher never exits early. If the page loses its connection it says how long ago the last update was, and its clock **stops** rather than keeps counting |
| 7 | Less scanner noise | Compare the lead counts in the scan summary with what the Inspector and Analyst keep | Fewer pre-existing-size leads (files over 500 lines, functions over 50 lines) unless the diff really grew them; import lines not reported as type assertions; locale JSON not reported by the Security Guard |
| 8 | Report opens as a web page | Click **Open the full report** on the finished dashboard | Opens `run/report.html`: real tables, bold text, readable in light and dark. Tell us if anything renders badly (emoji, long paths, narrow window) |
| 9 | Ticket shown by name | Pass `--ticket` as a full file path | Summary says `Ticket PROJ-123`, not the path |
| 10 | Docs | Follow the README Windows and first-run sections literally | Every step works as written. Record any step that does not |

## 4. Rules for the run

- **Report-only.** The reviewed repository's tracked files must not change. Check `git status` and `git diff --stat` before and after.
- Do not say a finding is a bug unless you reproduced it. The tool marks uncertain findings "verify"; verify them yourself by reading the code, and say whether they held up.
- Copy error text exactly. Do not paraphrase.
- Note **timings** and, if the CLI shows it, **token or cost figures**, for the whole run and per agent.

## 5. What the maintainer most wants to know

These are the open questions. Answer as many as you can with evidence; "could not tell" is a fine answer.

### Does the tool tell the truth?
- **Q1. Was the Bash guard actually active for the three agents?** Round 1 could not tell, because the run worked even with the bug in place. Report any evidence either way: a command an agent tried that was blocked (with the message shown), or a permission prompt that appeared when it should not have. If you want to probe it, ask the Analyst to run `git status` (allowed) and then `touch .swag-scan/guard-probe` (not on the allowlist, and harmless if it does run). Report what happened to each, and delete the probe file afterwards. Do not try anything destructive.
- **Q2. Of the findings the agents report, how many hold up?** For every finding, read the code and mark it: *real bug*, *real risk but safe today*, *false alarm*, or *cannot tell*. Give a one-line reason. This is the most valuable data you can give.
- **Q3. Is the agents' stated confidence calibrated?** Round 1 had one "medium" that should have been "low". Note any finding where the confidence label looked wrong, in either direction.
- **Q4. What did the agents miss?** If you know of a real defect in the diff (a bug that was fixed later, a review comment the team made, a failing test), say whether Swag Scan flagged it. If you cannot know, skip this.

### Does it behave on different code and machines?
- **Q5. Which languages and project shapes did you run it on?** Anything new is valuable: C#, Go, a monorepo, a repo with CRLF files, a repo with a very large diff (over 100 KB), a repo with no ticket. Say which.
- **Q6. Size gate on a big diff.** If any run has a diff over about 100 KB, the tool reviews the riskiest parts first. Report the number of parts reviewed and skipped, and whether the skipped list in the report was clear. Round 1 never saw this under a real agent run.
- **Q7. Does the 50-turn limit ever get hit?** If an agent stops early, say so and where.
- **Q8. Security Guard actually running.** In round 1 it was always skipped for lack of leads. If you can run on a diff that gives it leads (new network calls, secrets, SQL, file paths from input), report what it did and whether its findings were useful.
- **Q9. A different operating system.** If you are on macOS or Linux rather than Windows, say so, and list anything that depends on the platform (paths, line endings, the dashboard opening by itself, the browser used).

### Is it useful to a person?
- **Q10. Read the report as the developer who owns the branch.** Which two or three items would you act on first? Was the order right? Was anything confusing, repetitive or too long? Quote the line.
- **Q11. The agents' voice lines** (the one-liner each agent writes in its own style). Helpful, neutral or irritating? Give an example of the best and the worst.
- **Q12. The dashboard.** Did it open by itself? Was anything misleading while the run was going (a wrong state, a stuck clock, a missing agent)? One known gap: after a scripts-only run with no agents, the page stays "LIVE" and the clock keeps running; tell us if you hit anything else like it.
- **Q13. What would make you trust it more, or run it more often?** One or two sentences.
- **Q14. What one thing did you wish it did that it does not?** Multi-repo runs for tickets that span several repositories are already planned; say if you hit a case where that mattered, and which repositories.

### Cost and speed
- **Q15. Time per run and per agent, and token or cost figures if shown.** Include the diff size (files and lines) so the numbers can be compared. Round 1: 9 files took 1:14 with two agents; 3 files took 0:42.

## 6. How to write up your feedback

Write **one markdown file** and hand it to the maintainer. **Do not commit it to this repository.** Save it outside the repo or leave it untracked. Use the same structure as round 1 so it can be merged:

1. **Conclusions first** (short): a one-line verdict, what worked, what needs fixing by priority.
2. **Fix verification table:** rows 1 to 10 from section 3, each *confirmed / not confirmed / could not test*, with evidence.
3. **Run log:** one entry per run, starting at **Run 5**: where, base, files and lines in the diff, leads per agent, findings per agent, time, and any cost figures.
4. **Findings table:** `| # | Severity | Area | Finding |`, severity *critical / design / minor / note*, **numbered from 36** (round 1 ended at 35). Read the end of the file again right before you write, in case someone else added rows.
5. **Answers to Q1 to Q15,** each marked answered, partly, or not tested.
6. **Verification of findings** (Q2): a table of each finding the agents reported, your verdict, and the reason.

### Sanitize before you hand it over

The write-up will be passed to other agents and may be shared. **Never include** real ticket IDs, file names, repository names, branch names, people's names, company names, or local user paths. Use stand-ins: the ticket is `PROJ-456`, files are `file-a`, `file-b`, the repository is "the host repo", paths are `<home>`. Tool-side names are fine: the tool's own scripts, rule IDs (such as `SWEEP-107`), flags, finding IDs, and error text from the tool. If an error message contains a path or name, replace just that part and say you did.

## 7. If something goes wrong

- A crash, a hang, a blocked command, a permission prompt, a dashboard that stops: **stop, copy the exact text and the contents of `.swag-scan/run/events.jsonl`** (sanitized), and record it as a finding. Then continue with whatever still works.
- If the tool's tests fail on your machine, record the failing test names and the first error line of each before anything else. That is the single most useful signal for a new platform.
- If you cannot tell whether something is a tool bug or a problem in your setup, say so and include what you tried. A good question beats a confident guess.
