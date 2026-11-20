# Changelog

Swag Scan follows [semantic versioning](https://semver.org). It is in beta, so it stays below 1.0.0: a new feature or a change that renames or removes something raises the minor number (0.1.0 to 0.2.0), and a fix, docs or chore change raises the patch number (0.1.0 to 0.1.1). The version lives in `.claude-plugin/plugin.json`, and every pull request raises it and adds an entry here, newest first.

## 0.3.0 - SS-103 (part 1 of 2)

Security Auditor scanner fixes. The new data-access and AI-model rules follow in 0.4.0.

- Fixed `CRIT-105`: ordinary `.exec(` calls such as `/(\d+)/.exec(s)` or `cursor.exec(sql)` are no longer reported as dynamic code evaluation. Bare `eval(` and `exec(`, `window.eval(` and `child_process.exec(` are still reported.
- Fixed `CRIT-104`: `shell=True` is now caught when the call has nested brackets, such as `subprocess.run(shlex.split(cmd), shell=True)`, and when the call is written over several lines.
- Fixed `CRIT-201`: key names with a prefix or suffix, such as `SECRET_KEY`, `API_SECRET`, `DB_PASSWORD` and `client_secret`, are now caught. Values stay hidden in the report.
- `.mjs`, `.cjs`, `.mts` and `.cts` files are now read as JavaScript or TypeScript, and `.cshtml` and `.razor` files as C#, so the rules for those languages run on them.
- `CRIT-202` no longer reports the bare word `id`, so ordinary random numbers are not flagged. C# `new Random(` is now treated as predictable.
- The scanner now reads the surrounding source of TypeScript and JavaScript files, not only Python and C#, and joins string pieces and multi-line statements before matching. A SQL statement built over several lines (`CRIT-101`) is now reported as one lower-confidence lead.
- The scan coverage now lists which rule families ran for each language, and which have no rules, so "no candidates" is not read as "safe".
- New setting `scan.readOnlyPaths` (a list of globs, empty by default) in the Security Auditor `config.json`. The scanner reads it and reports which changed files match. The rules that act on it arrive in the next release.

## 0.2.0 - SS-102

- Removed the acceptance-criteria check. The report no longer has an "Acceptance criteria" table, no status is read from your ticket, and findings no longer link to criteria. Anything labeled Acceptance Criteria in your Jira export is now only extra context, so the reviewers understand what the ticket is for and can explain why a change looks wrong.
- A `Status` column or checked box in a ticket file is ignored.
- If a scan finds no changes, you now get a clear message: check the branch you have checked out, and confirm the target branch in your config. This also covers a branch that has the same name as the target branch.
- Confirmed that Swag Scan scans whatever branch is checked out, whatever it is called, and works the same for repositories on GitHub, Bitbucket or anywhere else. Tests now cover both.

## 0.1.0 - SS-101

First versioned release.

- Added `/swag-scan:config`: five quick questions that save `ticketSourcePath`, `targetBranch`, `liveDashboard`, `autoFix` and `maxFileLines` in `~/.swag-scan/settings.json`.
- Renamed `/swag-scan:swag-scan` to `/swag-scan:run`. Type `/swag-scan:run your_ticket_Id`: the base branch, ticket folder and live view come from the config, and `--no-live` is gone.
- `/swag-scan:run` asks you to run `/swag-scan:config` first when no config exists.
- The Inspector's auto-fix is now off by default, and `maxFileLines` defaults to 1000.
