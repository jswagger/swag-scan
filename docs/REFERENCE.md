# Swag Scan reference

Back to the [README](../README.md). For what Swag Scan runs, reads and writes, see [TRANSPARENCY.md](TRANSPARENCY.md).

Contents: [Windows and the VS Code extension](#windows-and-the-vs-code-extension) · [GitHub Copilot](#github-copilot-experimental-not-part-of-the-plugin) · [Findings format](#findings-format) · [Event log](#event-log) · [Live view](#live-view-dashboard) · [Run everything at once](#run-everything-at-once) · [Bug Hunter](#bug-hunter) · [Ticket files](#ticket-files) · [Code Sweeper](#code-sweeper) · [Security Auditor](#security-auditor) · [Model roles](#model-roles) · [Tests](#tests)

## Windows and the VS Code extension

Swag Scan has been trial-run on Windows 11 with Node 22. One catch: if you use Claude Code through the VS Code extension, the `claude` command may not be on the PATH of your terminal (`claude: command not found`). That only matters if you want to load the plugin from a folder (for example a clone you are testing) instead of installing it. The extension ships its own copy of `claude`:

- **Find it:** `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-<version>-win32-x64\resources\native-binary\claude.exe`. The version is part of the folder name, so the path changes when the extension updates.
- **PowerShell** needs the call operator: `& "<path>\claude.exe" --plugin-dir <swag-scan folder>`
- **Command Prompt** takes the quoted path alone: `"<path>\claude.exe" --plugin-dir <swag-scan folder>`
- **Then type the command inside Claude**, not in the shell: start the session first, and only then enter `/swag-scan:config` (once) and `/swag-scan:run <ticket-id>`. Pasting both lines into the terminal runs the second one as a shell command and fails.

## GitHub Copilot (experimental, not part of the plugin)

The three skills can be copied into a project for Copilot agent mode in VS Code. The crew, report and live view are Claude Code only for now, and Copilot support has had much less testing.

```bash
git clone --depth 1 https://github.com/jswagger/swag-scan.git && node swag-scan/scripts/install-copilot.mjs
```

Run the installer from your project root. Skills land in `.github/skills/`. Use `--target .agents/skills` for that folder instead, `--project DIR` to install elsewhere, and `--force` to overwrite an existing install. The commands are then `/bug-hunter`, `/code-sweeper` and `/security-auditor`.

## Reference

### Findings format

Each agent hands in its judged findings in one shared shape, saved by `skills/review-tools-common/save-findings.mjs` to `.swag-scan/run/findings-<agent>.json`. The script checks the findings, assigns ids (`AN-1`, `IN-1`, `SG-1`, critical first) and adds the tool, base, coverage line and counts.

| Severity | Meaning | Needs |
| --- | --- | --- |
| 🔴 `critical` | Will break or is exploitable | `evidence` (a concrete failing input or state) and a `recommendation` or something to `verify` |
| 🟠 `design` | Feature gap or design issue | `verify`: the one thing to check |
| 🟡 `minor` | Cleanup | `recommendation` |

| Disposition | Meaning |
| --- | --- |
| `needs-decision` | The developer must weigh it. The default, and the only one the Analyst and Security Guard can use (they are report-only). |
| `auto-fixed` | The Inspector fixed it. Needs a `fixNote`. Listed in the report, not commented on in a review view. |
| `would-auto-fix` | A safe fix exists but auto-fix was off for this run (for example the first, report-only run). |

Other fields: `title`, `rule`, `file` and `line` (the line in the new version of the file, or a `locations` list), `flaggedText` (the exact code on that line, so the finding can be found again after fixes), `confidence`, and `voiceLine` (the agent's one-sentence voice, kept apart from the facts). The Analyst can hand in Bug Hunter's own findings file with `--format bug-hunter`: probable bugs become critical, suspicious items become design issues.

The ticket's id, source and title are saved in `.swag-scan/run/ticket-report.json` for the report header. Acceptance criteria are never tracked, scored or reported: reviewers only read them as context for what the ticket is meant to do, and a Status column in a ticket file is ignored.

### Event log

While a scan runs, scripts append one JSON line per event to `.swag-scan/run/events.jsonl`. A dashboard, a status line or any other tool can read it. It costs no model tokens, never blocks or fails a scan (writes are best effort), and holds no code and no finding text. `SWAG_SCAN_EVENTS=off` turns it off.

```json
{"v":1,"t":"2026-11-02T12:00:01.250Z","agent":"analyst","kind":"progress","phase":"scan","step":4,"steps":6,"label":"scan"}
```

| Field | Meaning |
| --- | --- |
| `v`, `t` | Format version (1) and the time (ISO, UTC). |
| `agent` | `analyst`, `inspector`, `security-guard`, or `swag-scan` for the run itself. |
| `kind` | `run-started`, `started`, `progress`, `finding`, `saved`, `done`, `waiting`, `error`, `run-done`. |
| `phase` | `scan` (scripts), `review` (an agent judging its leads) or `report`. |
| `step`, `steps` | Real counts such as "step 4 of 6". Never a percentage. |
| `label` | A short fixed word, such as `collect`, `scan`, `callers`, `packets`. |
| `count`, `total` | A number that goes with the kind: leads found, findings saved, items needing a decision. |
| `id`, `severity`, `file` | On `finding` only: the finding id, its severity and its file name. |

Scripts write the scan, finding and report events. In Claude Code, an asynchronous hook also records `started` and `done` for each agent's review, and `waiting` when a permission prompt appears. That hook only writes while a Swag Scan run is active in the project, and it only nudges: it does not track whether the prompt was approved.

### Live view (dashboard)

A page that shows the crew at work while a scan runs: the five steps, counts, each agent's face with its latest line, a newest-first timeline, and a "waiting for you" note when a permission prompt appears. It is built by a script from the event log, so it costs no model tokens, and the lines are fixed templates, not model output. It never opens by itself unless you ask.

```bash
node skills/review-tools-common/swag-scan.mjs dashboard [--watch] [--open]
```

- Writes `.swag-scan/dashboard.html` (self-contained: no network, no external fonts or scripts) and prints its path. With no scan yet it shows "Waiting for a scan".
- `--watch` keeps the page's data fresh until the scan ends (start it before `run`, or while one is running). The page picks up changes without reloading, and says "Not updating" if the watcher stops.
- `--open` opens the page in your browser. In Claude Code, `/swag-scan:run` starts the watcher and opens the page for you when `liveDashboard` is on in the config (the default).
- The page shows only what events carry: agent, step counts, file names and finding ids. It never tracks whether you approved a prompt.

### Run everything at once

One fixed command runs all three agents' scripts in a fixed order. No model decides what runs, it uses no model tokens, and it changes no files:

```bash
node skills/review-tools-common/swag-scan.mjs run [PROJ-123] [--base main] [--ticket-dir <dir>] [--agents analyst,security-guard] [--fresh] [--json]
```

`run` needs the config (below) and stops with "Please set up your config file first. Run /swag-scan:config to get started." without it. It compares against `targetBranch`, passes `maxFileLines` to the Code Sweeper and records `autoFix` for the Inspector in `summary.json` under `settings`. `--base` and `--ticket-dir` stay as one-off overrides for scripts and CI; `/swag-scan:run` never passes them.

### Config

`/swag-scan:config` asks the questions (multiple choice) and saves the answers with `swag-scan config set`. The file is `~/.swag-scan/settings.json`, or the file named by `SWAG_SCAN_SETTINGS`. Per-user, outside any repo, no network.

| Key | Default | What it does |
| --- | --- | --- |
| `ticketSourcePath` | none | Folder of Jira XML exports. `/swag-scan:run ID-123` reads `ID-123.xml` there. The older name `ticketFolder` is still read until `ticketSourcePath` is saved. |
| `targetBranch` | `main` | The branch the change is compared against. |
| `liveDashboard` | `true` | Whether `/swag-scan:run` opens the live view. |
| `autoFix` | `false` | Whether the Inspector may fix clear, low-risk cleanup items. Replaces `autoFix.enabled` in the Code Sweeper's `config.json` for runs started by Swag Scan. |
| `maxFileLines` | `1000` | The Code Sweeper flags a changed file longer than this (and only when it is new, just crossed the limit, or grew by `minFileGrowthLines`). Replaces `scan.thresholds.maxFileLines` for runs started by Swag Scan. |

The same file can be read and changed from a shell: `swag-scan config` (show), `swag-scan config get <key>`, `swag-scan config set <key> <value> [<key> <value> ...]`, `swag-scan config path`. A value that cannot be used is refused with one sentence and nothing is saved. The config counts as set up only when all five keys are saved, so an old file with just `ticketFolder` is asked to run `/swag-scan:config` once.

It prints one progress line per agent, then a short summary: leads per agent, the language coverage line, the ticket it found, and whether a stored review already covers this commit. Leads are script matches, not verified findings. Results are written to `.swag-scan/run/` (replaced every run, gitignored). Because the command is always the same shape, one permission rule covers it.

The scripts also run on their own. Scanners print candidates as JSON and never apply fixes:

```bash
node skills/review-tools-common/collect-diff.mjs \
  --config skills/code-sweeper/config.json origin/main \
  | node skills/code-sweeper/scripts/scan-patterns.mjs
```

Which diff is reviewed:

- No argument: the base is detected automatically. It tries `origin/HEAD`, `develop`, `test`, `main`, then `master`, and picks the closest one your branch grew from. The collector prints which one it chose. The branch you have checked out is scanned, whatever it is called, and the repository can be hosted anywhere (GitHub, Bitbucket or anything else): only local `git` is used. If it finds no changes, for example because the checked-out branch is the target branch, it says: "I'm sorry, no changes against the target branch were found. Please check your current branch that is checked out, and confirm your target branch is correct in your config."
- A ref such as `origin/main` is compared from `git merge-base <ref> HEAD`, so target-only commits are excluded.
- `HEAD` compares only the working tree, which is often empty on a clean feature branch.
- Untracked, non-ignored text files are included. Binary and oversized files are skipped.

## Bug Hunter

A regression safety net. It looks for removed guards, dropped awaits, changed contracts, and broken callers, then reads your ticket, including anything labeled Acceptance Criteria, as context for what the change is meant to do and why it may be wrong.

- **Rules:** `REMOVED_GUARD`, `REMOVED_AWAIT`, `REMOVED_ERROR_HANDLING`, `REMOVED_CLEANUP`, `MISSING_RELEASE`, `REMOVED_EARLY_EXIT`, `BEHAVIOR_CHANGE_PAIR`, `SIGNATURE_CHANGED`, `REMOVED_TEST_ASSERTION`, `TEST_DISABLED`.
- **Packets:** scripts rank findings by risk and bundle them with surrounding code and callers. Large diffs hit a size gate and ask whether to review everything or only the riskiest changes.
- **Languages:** TypeScript, JavaScript, Python, C#.
- **Reports:** saved to `.bug-hunter/reports`. Add `.bug-hunter/` to `.gitignore`.
- **Silence a finding:** `bug-hunter-ignore` or `bug-hunter-ignore: RULE_NAME` inline.

| Setting | Purpose | Default |
| --- | --- | --- |
| `autoFix` | Fix unambiguous 🔴 bugs. When `false`, no files are ever edited | `false` |
| `diff.maxDiffBytes` | Size gate for the diff | `102400` |
| `ticketContext` | Ticket used as context for the intent of the change. `--ticket <id-or-path>` overrides; see [Ticket files](#ticket-files) | `null` |
| `repositoryContext` | Nearby docs for local patterns and invariants | `null` |
| `rules.disabled` / `rules.severityOverrides` | Tune noisy rules | none |
| `models.<agent>.basic` / `.advanced` | See [Model roles](#model-roles) | |
| `report.outputDir` | Where reports are written | `.bug-hunter/reports` |

### Re-runs are cached

When nothing has changed since the last review (same commit, same base, same config and ticket, same tool version), Bug Hunter returns the earlier report instead of repeating the review. Results are kept in `.swag-scan/cache/` (add it to `.gitignore`). Nothing is cached while you have uncommitted changes, and asking for a fresh run (`--fresh`) skips the cache for every selected agent, so all of them review again. The cache is per agent: if only the ticket changed, only the agents that read the ticket (the Analyst) review again, and the others report "Reused the earlier review of this commit". The dashboard and report count their earlier findings and label them as reused.

### Ticket files

Bug Hunter reads a ticket to understand what the change is for. It needs no configuration if the branch name holds a ticket ID (such as `feature/PROJ-123`) and it can find the ticket folder.

- **Which ticket:** `--ticket PROJ-123` (an ID) or `--ticket path/to/file.md` (a path, inside or outside the repo). With neither, the ID is taken from the branch name. A `--ticket` you typed that cannot be found (a wrong path or an unknown ID) stops the run before any model review, with the reason and, for a path, the closest real file it can find. A ticket guessed from the branch name that is missing only adds a one-line note.
- **Where tickets live:** an ID is looked up as `PROJ-123.xml`, `.md` or `.txt` (or `PROJ-123-any-title.xml`; a browser's `PROJ-123 (1).xml` works too) in the first of: `--ticket-dir`, the `SWAG_SCAN_TICKET_DIR` environment variable, `ticketSourcePath` in `~/.swag-scan/settings.json` (a per-user file, outside any repo; older name `ticketFolder`), or `ticketContext.path` in the repo's config. There is no built-in default folder.
- **Jira XML exports (the easy way):** open the ticket in Jira, choose Export, then **Export XML**. Jira shows the XML in a new browser tab instead of downloading it, so press Ctrl+S (Cmd+S on Mac) and save it as `PROJ-123.xml` in your ticket folder. If your browser offers a file type, choose "Webpage, HTML Only" and make sure the name ends in `.xml`. Copying the whole page into a new text file named `PROJ-123.xml` works too. Swag Scan reads it with no libraries and takes only the issue key, the summary, the description, and any custom field with "Acceptance" in its name (such as `Acceptance Criteria`). If the description has a line that says only "Acceptance Criteria" followed by a list, that list is used too. Comments, status, links and other fields are left out. Jira has written the description's HTML in three ways over the years (escaped, written straight into the XML, or in a CDATA block), and all three are read. A file from a search holds several issues; the one whose key matches is used. A custom field that Jira leaves empty in its XML cannot be recovered; if criteria go missing, check the field in the exported file.
- **Word and Excel files** (`.doc`, `.docx`, `.xls`, `.xlsx`) are not read. Jira's own Word and Excel exports are HTML saved under those names, and real Office files need a library; use Export XML instead.
- **What reviewers see:** only the title, the description and the acceptance criteria, as context for the intent of the change. Criteria are not a checklist, and their status is never tracked or reported. Implementation or development logs, notes and any other section are removed, because they describe what was built and would bias the review. The report names the sections that were left out. A ticket with no headings is passed whole, with a note.
- **Format assumed (tolerant, markdown):**

  ```markdown
  # PROJ-123: Add login

  Free text or a "## Description" section.

  ## Acceptance Criteria
  | # | Title | Description | Repository |
  |---|-------|-------------|------------|
  | 1 | Login form | Shows email and password | web-app |

  ## Repositories
  - web-app: feature/PROJ-123
  - api (feature/PROJ-123, base develop)
  ```

  Table columns may be in any order and any subset, and bullets, numbered items or checkboxes also work for criteria. A Status column or a checked box is ignored, because most teams do not track criteria the same way. Repositories can be a table, or bullets like `name: branch`, `name (branch, base ref)` or `name @ branch`.

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

Scans JavaScript/TypeScript, Python, and C# by file, so language-specific heuristics only run on matching files. Python, C#, TypeScript and JavaScript files are read in full so a statement written over several lines, or built from several string pieces, is matched as one. `.mjs`, `.cjs`, `.mts` and `.cts` count as JavaScript or TypeScript, and `.cshtml` and `.razor` as C#. The scan coverage lists, for each language, which rule families ran and which have no rules (`coverage.ruleFamilies`), so an empty result is never read as "safe". Coverage is heuristic, not exhaustive.

New in 0.7.0, supply chain, secrets, access control and error handling. `SUP` rules and the `SEC` rules run on changed files of any language; `ACC` and `ERR` rules need the real file and cover TypeScript, JavaScript and Python (C# already has `CS-610`, `CRIT-301` and `ARCH-404`). `PY-601`, `PY-602`, `PY-604`, `PY-607`, `PY-608` and `PY-609` also gained Python cases (`asyncio.create_subprocess_shell`, Django `.extra` and `RawSQL`, `ALLOWED_HOSTS = ['*']`, zip slip, `torch.load` without `weights_only=True`, `tempfile.mktemp`). The coverage line now counts 15 rule families, with "Supply chain and CI/CD" the new one.

| Rule | Looks for | Reported as |
| --- | --- | --- |
| `SUP-601` | A `pull_request_target` workflow that checks out the pull request head | High Risk |
| `SUP-602` | Text an outsider controls (`github.event` title, body, branch name, comment; `inputs.*`) inside a `run:` step | High Risk |
| `SUP-603` | A `uses:` action not pinned to a 40-character commit SHA | Suspicious, lower confidence |
| `SUP-604` | `permissions: write-all` | High Risk |
| `SUP-605` | A new `preinstall`, `install` or `postinstall` script in `package.json` | High Risk |
| `SUP-606` | A new dependency in `package.json`, `requirements*.txt`, `pyproject.toml` or a `.csproj` `PackageReference` (no advisory check: there is no network access) | Suspicious, lower confidence |
| `SUP-607` | A new `.pth` file, or `setup.py` code that runs `exec`, `subprocess` or a network call | High Risk |
| `SEC-601` | A well-known provider key (Anthropic, OpenAI, GitHub, AWS, Slack, Stripe, Hugging Face, Google) or a private key block; the value is redacted in the report | High Risk (Stripe test keys: lower confidence) |
| `SEC-602` | A literal secret value in a committed `.env` file (`.env.example` and similar templates are ignored) | High Risk |
| `SEC-603` | A literal credential or bearer token in an MCP config file such as `.mcp.json` | High Risk |
| `ACC-601` | A new Express, Fastify, NestJS, FastAPI, Flask or Django REST route with no authentication marker nearby (TypeScript, JavaScript, Python) | Suspicious, lower confidence |
| `ERR-601` | `.catch(() => {})`, a `catch` that is empty or only logs, bare `except:`, `except Exception` that carries on without logging | Suspicious, lower confidence |
| `ERR-602` | An auth handler that lets the request through when its check fails (`next()`, `return true`, `call_next` in a `catch` or `except`) | Suspicious, lower confidence |
| `PY-612` | An XML parser set to resolve entities or load external content (XXE) | High Risk |

New in 0.6.0, TypeScript, JavaScript and Python rules. Each one is a lead for the model pass to verify, and context-dependent ones are lower confidence. They read a call written over several lines as one call, and rules that need the lines around a change run only when the real file can be read. `v-html` is matched only in JS/TS files because `.vue` files are not scanned.

| Rule | Looks for | Reported as |
| --- | --- | --- |
| `TS-601` | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`. TLS certificate verification is off; trust the specific CA instead. | High Risk |
| `TS-602` | `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `dangerouslySetInnerHTML`, `v-html` (in JS/TS files) given anything but a plain literal or sanitized value. Use `textContent` or DOM methods, or sanitize first (DOMPurify). | Suspicious, lower confidence unless request-like input is visible |
| `TS-603` | `new Function(` or `setTimeout`/`setInterval` with a built string. Same risk as `eval`; pass a function. | High Risk |
| `TS-604` | `ignoreExpiration: true`, a `none` JWT algorithm, `jwt.decode` read for a role or user id. Use `jwt.verify` with a fixed algorithm list. | High Risk / lower confidence |
| `TS-605` | Cookie `httpOnly: false` or `secure: false`; CORS any origin with credentials. List trusted origins; set httpOnly and secure. | High Risk / lower confidence |
| `TS-606` | `fs` calls, `res.sendFile` and `path.join` with request input. Resolve the path and check it stays in the base folder. | Suspicious |
| `TS-607` | `fetch`, `axios`, `got`, `http.get` with a URL from request input. SSRF: allow only known hosts. | High Risk |
| `TS-608` | `createCipher`; `createHash` with MD5 or SHA-1. Use `createCipheriv` with AES-GCM and SHA-256 or better. | High Risk / lower confidence |
| `TS-609` | `__proto__` writes; request data in a deep merge or `Object.assign`. Prototype pollution and mass assignment: copy only expected fields. | High Risk / lower confidence |
| `TS-610` | `$where`; a Mongo query built from `req.body`/`req.query` or an unchecked field. NoSQL injection: pick fields and check types. | High Risk / lower confidence |
| `PY-601` | `eval`/`exec`, `subprocess` with `shell=True`, `os.system`/`os.popen` given anything but a plain string. Command and code injection; pass a list, use `ast.literal_eval`. | High Risk / lower confidence |
| `PY-602` | `execute`, `executemany`, `executescript`, `raw`, `read_sql` or `text(` with an f-string, `%`, `.format` or `+` query. SQL injection; use parameters. | High Risk |
| `PY-603` | `render_template_string`/`Template` built from a value, `mark_safe`, `Markup`, `|safe`, `autoescape=False`. Template and HTML injection. | High Risk / lower confidence |
| `PY-604` | `debug=True`, `DEBUG = True`, `app.run(debug=True)`, a traceback or exception text returned to the client. Debug mode and error leaks. | High Risk / lower confidence |
| `PY-605` | `open`, `send_file`, `os.path.join`, `shutil` and `Path` with request input; `requests`/`httpx`/`urlopen` with a URL from request input. Path traversal and SSRF. | High Risk / lower confidence |
| `PY-606` | `assert` used for authorization, JWT verification off, `jwt.decode` with no `algorithms`, `@csrf_exempt`, CORS any origin with credentials, insecure session cookies. Weak access control. | High Risk / lower confidence |
| `PY-607` | `Model(**request.json)`, serializer `fields = "__all__"`, `tarfile.extractall` with no filter, uploaded zips extracted. Mass assignment and archive path traversal. | Suspicious, lower confidence |
| `PY-608` | `yaml.load` without a safe loader, `pickle`/`dill`/`marshal`/`shelve`/`torch.load` loading. Unsafe deserialization. | High Risk / lower confidence |
| `PY-609` | `hashlib.md5`/`sha1`, `random` for tokens or passwords, `MODE_ECB`, a literal `SECRET_KEY`. Weak cryptography and randomness. | High Risk / lower confidence |
| `PY-610` | `verify=False`, `_create_unverified_context`, `ssl.CERT_NONE`, `check_hostname = False`. TLS verification is off. | High Risk |
| `PY-611` | A `file://` URL fetched with request input nearby. Restrict fetches to http and https. | Suspicious, lower confidence |

New in 0.5.0, C# rules. Each one is a lead for the model pass to verify, and context-dependent ones are lower confidence. `CS-609` also reads changed `web.config` files.

| Rule | Looks for | Reported as |
| --- | --- | --- |
| `CS-601` | `FromSqlRaw`, `ExecuteSqlRaw(Async)`, `SqlQueryRaw` built with interpolation, concatenation or `string.Format` | High Risk |
| `CS-602` | `Html.Raw(` on anything but a plain literal | Suspicious, lower confidence |
| `CS-603` | `DtdProcessing.Parse`, `XmlResolver = new XmlUrlResolver()` (XXE) | High Risk |
| `CS-604` | `DES`, `RC2`, `TripleDES`; `MD5` and `SHA1` (lower confidence) | High Risk / lower confidence |
| `CS-605` | `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime`, `ValidateIssuerSigningKey`, `RequireSignedTokens` or `RequireHttpsMetadata` set to `false` | High Risk |
| `CS-606` | `AllowAnyOrigin()` or `SetIsOriginAllowed(_ => true)` with `AllowCredentials()` in one policy | High Risk |
| `CS-607` | `[IgnoreAntiforgeryToken]` | Suspicious, lower confidence |
| `CS-608` | `Path.Combine` / `Path.Join` with request input | Suspicious, lower confidence |
| `CS-609` | A fixed `machineKey`, or `enableViewStateMac="false"`, in `web.config` (the key is never printed) | High Risk |
| `CS-610` | A new `[Http*]` action or `MapGet`/`MapPost`/... endpoint with no `[Authorize]`, `[AllowAnonymous]`, `RequireAuthorization` or authorized base class nearby | Suspicious, lower confidence |

The existing rules also grew for C#: `CRIT-108` now covers `NetDataContractSerializer`, `LosFormatter`, `SoapFormatter` and `ObjectStateFormatter`; `CRIT-109` covers `TypeNameHandling.Auto`, `Objects` and `Arrays`; `CRIT-111` covers `ServerCertificateCustomValidationCallback` and `DangerousAcceptAnyServerCertificateValidator`; `CRIT-301` catches empty and console-only `catch` blocks over several lines; `ARCH-404` flags a catch in an auth handler that carries on; and `DATA-502` also matches LINQ filters such as `.Where(r => guids.Contains(r.ReportGuid))`.

The scan coverage now says how many rules each language ran and how many found something (`Rule families that ran: C# (7 files): 14 of 14 families, 2 of 37 rules found something`), so a result with few hits from a large rule set is not read as clean.

New in 0.4.0, all heuristics for code that talks to a database or a model:

| Rule | Looks for | Reported as |
| --- | --- | --- |
| `DATA-501` | Database writes inside `scan.readOnlyPaths` | High Risk |
| `DATA-502` | `...Guid IN %s` (or, in C#, `ids.Contains(x.Guid)`) with no user or tenant predicate | Suspicious, lower confidence |
| `ARCH-403` | Config that gives an analysis service database write access | Suspicious |
| `LLM-501` | Model output flowing into SQL, a process, `eval`, a path, an S3 key, a URL or PDF generation | High Risk |
| `LLM-502` | `toolConfig`, `tools`, function calling or agent setup, with the tools it exposes | Suspicious |
| `LLM-503` | Document or user text in the system message, or before the instructions with no delimiter | Suspicious |
| `LLM-504` | `exec` / `spawn` / `subprocess` / `Process.Start` inside an MCP or LLM tool handler | Suspicious |
| `REG-401` | In prompt files, removed lines with "never", "do not" or "only" | Suspicious |
| `HYG-501` | A `main_*.py` entry point in a deployable folder that bypasses authentication | Suspicious |
| `HYG-502` | A personal absolute path (a user home folder) in committed config | Suspicious |

`node skills/security-auditor/scripts/scan-patterns.mjs --config <file>` reads a different config, in the same shape as `config.json`. A basic pass reviews common implementation risks (`CRIT-1xx`, `CRIT-2xx`), then an advanced pass looks at attack paths and architecture.

| Setting | Purpose | Default |
| --- | --- | --- |
| `models.<agent>.basic` / `.advanced` | See [Model roles](#model-roles) | |
| `scan.projectStack` | `backend`, `frontend`, `full-stack`, or `unknown` | `backend` |
| `scan.readOnlyPaths` | Globs for code that must only read data, such as `["src/analyze/**"]`. Inside these paths `DATA-501` treats any database write as High Risk. The scan coverage lists which changed files match. Empty means the write check does not run. | `[]` |
| `scan.dataAccess.sqlHelpers` / `sqlHelperWriteMethods` | Names of your SQL helper objects (`sql_helper`, `SqlHelper`) and the method names on them that write (`insert`, `execute_non_query`, ...). A method that starts with one of these names counts. | see config |
| `scan.dataAccess.allowedProcedures` | Stored procedures that `EXEC` / `CALL` may run in a read-only path, such as `dbo.sp_report` | `[]` |
| `scan.dataAccess.tenantPredicates` | Column names that scope a query to a user or tenant; `DATA-502` stays quiet when one is present | `UserGuid`, `UserId`, `OwnerId`, `TenantGuid`, `TenantId`, ... |
| `scan.llm.modelCallWrappers` | Functions and methods that call a model (`_converse_sync`, `messages.create`, `ConverseAsync`, ...); their results are treated as untrusted model output | common Bedrock, Anthropic, OpenAI and Gemini names |
| `scan.llm.promptFilePatterns` | File-name globs for files that hold prompts or guardrail text. A file with a prompt constant (`SUMMARY_PROMPT = ...`) is also recognised. | `*prompt*`, `*guardrail*`, `*system_message*`, `*instructions*` |
| `scope.maxRelatedFiles` / `maxRelationshipHops` | How far review follows related code | `5` / `1` |

## Model roles

Bug Hunter and Security Auditor run two passes. `models.<agent>.basic` and `.advanced` pick a model for each pass on the agent you're using (`claude` or `copilot`). `null` or a missing entry uses the agent's default model, and without model-selectable subagents the agent does both passes itself.

| Agent | `basic` | `advanced` |
| --- | --- | --- |
| `claude` | `haiku` | `sonnet` |
| `copilot` | `null` | `null` |

**Migrating:** earlier versions used a flat `models.basic` / `models.advanced`. That shape is no longer read. Move the values under your agent, for example `models.claude.basic`.

## Tests

Both Node 22 and 24 run in CI. No third-party dependencies.

```bash
node --test \
  "skills/bug-hunter/test/*.test.mjs" \
  "skills/code-sweeper/test/*.test.mjs" \
  "skills/security-auditor/test/*.test.mjs" \
  "skills/review-tools-common/test/*.test.mjs"
```
