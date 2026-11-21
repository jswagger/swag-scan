# Changelog

Swag Scan follows [semantic versioning](https://semver.org). It is in beta, so it stays below 1.0.0: a new feature or a change that renames or removes something raises the minor number (0.1.0 to 0.2.0), and a fix, docs or chore change raises the patch number (0.1.0 to 0.1.1). The version lives in `.claude-plugin/plugin.json`, and every pull request raises it and adds an entry here, newest first.

## 0.4.0 - SS-103 (part 2 of 2)

Security Auditor rules for code that talks to a database or an AI model.

- **Database writes in read-only code (`DATA-501`, High Risk).** Inside the paths you list in `scan.readOnlyPaths`, any `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `DROP` or `ALTER`, an `EXEC` or `CALL` of a procedure that is not in `scan.dataAccess.allowedProcedures`, a `.commit(` or other non-query call, and a write method on a SQL helper class is reported. `.execute(` is reported unless its SQL is a visible `SELECT`. SQL built from several pieces is joined before it is checked.
- **Tenant scoping (`DATA-502`).** SQL that filters by a caller-supplied `...Guid IN %s` list with no user or tenant predicate (names in `scan.dataAccess.tenantPredicates`) is reported as a lower-confidence lead.
- **Database grants (`ARCH-403`).** Terraform, YAML, JSON, SQL and similar config that gives an analysis service write access to a database is now reported.
- **Model output (`LLM-501`, High Risk).** Output from a model call (names in `scan.llm.modelCallWrappers`, plus streamed text) that flows into a SQL call, a process, `eval`, a file path, an S3 key, a URL or PDF generation is reported. Anything shaped like text-to-SQL is High Risk.
- **Tools and agency (`LLM-502`).** Any `toolConfig`, `tools`, function calling or agent setup on a model call is reported, with the tool names it can see and the database-facing ones, which must be read-only.
- **Untrusted text in prompts (`LLM-503`).** Document or user text placed in the system message, or placed before the instructions with no delimiter.
- **Process execution in tool handlers (`LLM-504`).** `exec`, `spawn`, `subprocess` or `Process.Start` inside an MCP tool or LLM tool handler.
- **Guardrail text (`REG-401`).** In prompt files (named like `*prompt*`, or listed in `scan.llm.promptFilePatterns`, or recognised by a prompt constant inside), a removed line containing "never", "do not" or "only" is now Suspicious.
- **Quieter `CRIT-303`.** It now looks at what is logged, not at words in the message text. It fires for arguments named like request, body, payload, user, password, token or secret, and not for a caught exception.
- **Hygiene.** `HYG-501` flags a `main_*.py` entry point in a deployable folder that bypasses authentication. `HYG-502` flags personal absolute paths (such as `/Users/name/...`) in committed config.
- Candidates from the new rules carry a `severity` hint (`high` or `suspicious`). Rules that depend on context default to lower confidence.
- The scanner accepts `--config <file>` to read a different config.
- The Security Auditor instructions now include a cost and denial-of-service checklist and sections for LLM data access, tools and untrusted prompt content.

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
