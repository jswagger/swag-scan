# Changelog

Swag Scan follows [semantic versioning](https://semver.org). It is in beta, so it stays below 1.0.0: a new feature or a change that renames or removes something raises the minor number (0.1.0 to 0.2.0), and a fix, docs or chore change raises the patch number (0.1.0 to 0.1.1). The version lives in `.claude-plugin/plugin.json`, and every pull request raises it and adds an entry here, newest first.

## 0.7.0 - SS-104 (part 3: supply chain, secrets, access control, error handling)

The Security Auditor now looks beyond application code: build files, dependencies, committed secrets and the way errors are handled.

- **Supply chain and CI/CD (`SUP-601` to `SUP-607`).** `pull_request_target` workflows that check out the pull request, untrusted event text inside `run:` steps, actions not pinned to a commit, `permissions: write-all`, new install-time scripts, new dependencies in `package.json`, `requirements*.txt`, `pyproject.toml` and `.csproj` files (as "review this" leads), and `.pth` files or `setup.py` code that runs at install time. Swag Scan cannot check dependencies against advisories because it makes no network calls.
- **Secrets (`SEC-601` to `SEC-603`).** Well-known provider keys (Anthropic, OpenAI, GitHub, AWS, Slack, Stripe, Hugging Face, Google, private keys) in any file, literal values in committed `.env` files, and literal credentials in MCP config files. The value is always redacted in the report.
- **Access control and error handling.** New routes with no authentication marker (`ACC-601`), errors that are caught and thrown away (`ERR-601`), and auth handlers that fail open (`ERR-602`) for TypeScript, JavaScript and Python.
- **More Python.** XXE parser settings (`PY-612`), `asyncio.create_subprocess_shell`, Django `.extra` and `RawSQL`, `ALLOWED_HOSTS = ['*']`, zip slip, `tempfile.mktemp`, and `torch.load` is quiet when `weights_only=True`.
- **Coverage.** The rule-family line now counts a fifteenth family, "Supply chain and CI/CD".
- **Instructions.** The Security Auditor instructions gained supply chain and error-handling checklists and list every new rule ID.

## 0.6.0 - SS-104 (part 2: TypeScript, JavaScript and Python rules)

The Security Auditor now checks much more of what a TypeScript, JavaScript or Python web change can get wrong. Supply chain, CI and secrets rules follow in a later release.

- **TypeScript and JavaScript (`TS-601` to `TS-610`).** TLS verification off, `innerHTML` and other HTML sinks, `new Function` and string timers, JWT checks switched off, insecure cookies and wide-open CORS, file paths and URLs built from request input, weak hashes and `createCipher`, prototype pollution and mass assignment, and NoSQL injection.
- **Python (`PY-601` to `PY-611`).** `eval`, `shell=True` and `os.system` with built values, SQL built by formatting, template injection, debug mode, path traversal and SSRF, `assert` used for authorization and JWT or CSRF checks switched off, mass assignment, `yaml.load` and `pickle`, weak hashing and randomness, and TLS verification off.
- **Calls over several lines.** These rules read a call as a whole, so an argument on its own line is still checked.
- **Model-pass checklists.** The Security Auditor instructions now include a TypeScript checklist and a longer Python checklist for the cases the scanner cannot see.

## 0.5.0 - SS-104 (part 1: C# rules)

The Security Auditor now checks much more of what a C# web change can get wrong. The TypeScript, Python, supply chain and secrets rules follow in later releases.

- **Entity Framework raw SQL (`CS-601`).** `FromSqlRaw`, `ExecuteSqlRaw` and `SqlQueryRaw` built with interpolation, concatenation or `string.Format` are reported. `FromSqlInterpolated` and parameterised calls are not.
- **Endpoints with no authorization marker (`CS-610`).** A new `[HttpGet]` / `[HttpPost]` ... action, or a minimal API `MapGet` / `MapPost` ..., with no `[Authorize]`, `[AllowAnonymous]`, `RequireAuthorization` or authorized base class nearby is reported as a lower-confidence lead.
- **Id lists with no owner check (`DATA-502`).** A LINQ filter such as `.Where(r => guids.Contains(r.ReportGuid))` with no user or tenant predicate is now reported, not only SQL strings. `UserId` and `OwnerId` count as owner predicates.
- **More C# rules.** `Html.Raw` on data (`CS-602`), XXE (`CS-603`), MD5, SHA-1, DES, RC2 and TripleDES (`CS-604`), token validation switched off (`CS-605`), any origin with credentials in CORS (`CS-606`), `[IgnoreAntiforgeryToken]` (`CS-607`), `Path.Combine` with request input (`CS-608`), and a fixed `machineKey` or `enableViewStateMac="false"` in `web.config` (`CS-609`).
- **Existing rules widened.** `CRIT-108` also covers `NetDataContractSerializer`, `LosFormatter`, `SoapFormatter` and `ObjectStateFormatter`. `CRIT-109` covers `TypeNameHandling.Auto`, `Objects` and `Arrays`. `CRIT-111` covers `ServerCertificateCustomValidationCallback` and `DangerousAcceptAnyServerCertificateValidator`. `CRIT-301` catches empty and console-only `catch` blocks that span several lines. `ARCH-404` flags a catch in an authentication or authorization handler that carries on.
- **A C# checklist for the model pass.** The Security Auditor's instructions now list what to check on every new or changed C# endpoint and query, so a scan with 0 leads on a risky endpoint is not read as safe.
- **The report says how many rules found something.** The coverage line now reads, for example, "C# (7 files): 14 of 14 families, 2 of 37 rules found something".
- **Fixed:** a C# class that held a string with `{placeholders}` and a SQL word was reported as one lower-confidence "SQL built from pieces" lead on the line where the class starts. C# SQL is now judged line by line only.
- `web.config` is now counted as data, so it no longer shows up as an unchecked language.

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
