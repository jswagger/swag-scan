---
name: security-auditor
description: 'Review code changes and pull request diffs for security vulnerabilities, insecure patterns, authorization gaps, and architectural risks. Use before creating or reviewing a pull request.'
argument-hint: 'Optional base ref, such as origin/main'
---

# Security Auditor

Review additions and revisions for security vulnerabilities and risky patterns. Use the shared review-tool helper to collect diff evidence and the bundled scanner to flag repeatable patterns; verify every candidate in context before reporting it. This is a focused code review, not a guarantee that the code is secure.

## Configuration

Read [config.json](./config.json) before starting. `models.<agent>.basic` and `models.<agent>.advanced` are preferred model selectors for the agent you are running in (`claude` or `copilot`); `null` or a missing entry means use that agent's default model. They are not claims about a specific model version. When model-selectable subagents are available and the entry is set, use it for the matching pass. Give each the collected diff JSON and scanner candidate JSON; do not ask them to recollect the diff. Otherwise perform both passes with the current model and do not claim a model switch.

`scan.readOnlyPaths` is a list of globs for code that must only read data (empty by default); `coverage.readOnlyPaths` in the scanner output lists which changed files match, and `DATA-501` applies inside them. `scan.dataAccess` (SQL helper names and their write methods, allowed procedures, tenant predicates) and `scan.llm` (model-call wrapper names, prompt-file patterns) hold the names the data-access and LLM rules match on. A candidate may carry `severity: "high"`: report it under High Risk once you have confirmed it in context; `severity: "suspicious"` belongs under Suspicious unless the code shows it is worse. `scan.exclude` patterns are omitted by collection and scanning. `scan.testFiles.mode` may be `skip` or `lower-confidence`; test-path matches are lower-confidence by default. The scanner detects changed source-file languages from their extensions and applies language-specific heuristics only to matching files; check `coverage.detectedLanguages` before interpreting its candidates. Choose `scan.projectStack` for the target repository as a separate architectural hint: use `backend` for server/API/data services, `frontend` for UI-only projects, `full-stack` when both are present, and `unknown` only when the repository role cannot be determined. The default is `backend`. In a frontend repository, lower-priority crypto and broad-permission candidates should be assessed in context, not discarded: raise their priority when the changed code actually implements cryptography, server-side authorization, or service-account permissions.

## Procedure

1. Determine the comparison base. Use the provided argument when present; otherwise use `diff.baseRef` from the config. Collect the change set with [collect-diff.mjs](../review-tools-common/collect-diff.mjs), passing this skill's config path. For any base other than `HEAD`, the collector resolves `git merge-base <base> HEAD` before diffing, while retaining working-tree and untracked changes. Include untracked, non-ignored files.
2. Run [scan-patterns.mjs](./scripts/scan-patterns.mjs) on the collector's JSON output. Treat its output as candidate locations, not confirmed findings. Keep both JSON outputs as the shared review input; delegated passes must use them rather than collecting again. The scanner checks added lines and emits `REG-401` candidates for removed lines containing security-control terms (and, in prompt files, guardrail wording). The scripts use Node.js built-ins and do not need third-party dependencies.
3. Use the basic model role for common implementation risks. Review the changed code for:
   - **CRIT-101:** dynamic string construction in database queries, OS commands, or HTML rendering, including Python SQL f-strings and C# SQL near `SqlCommand` or `Query`; prefer parameterized queries and safe APIs. Treat SQL candidates as contextual, lower-confidence leads: placeholders and fixed SQL fragments may be safe when values are passed separately to the driver. C# LINQ `.Select(...)` projections are not SQL sinks by themselves.
   - **CRIT-102:** blacklist-based input validation; prefer explicit allowlists, exact types, or enums.
   - **CRIT-103:** validation added only on the client; check the directly corresponding API/controller for server-side enforcement.
   - **CRIT-201:** hard-coded credentials or secrets, including prefixed or suffixed names such as `SECRET_KEY` and `DB_PASSWORD`, quoted dictionary keys, fallback literals, and credentials embedded in connection URLs. Recommend environment configuration or a secrets manager. Never reproduce a secret value in the report; scanner evidence is redacted.
   - **CRIT-104:** shell execution through `subprocess` with `shell=True` or `os.system`, including calls with nested brackets or written over several lines; prefer argument arrays and safe process APIs.
   - **CRIT-105:** dynamic evaluation through `eval` or `exec`, `window.eval`, or `child_process.exec`. Ordinary `.exec(` method calls (a regular-expression `.exec(`, a database cursor) are not reported; remove the evaluation or constrain inputs with a safe parser.
   - **CRIT-106:** potentially unsafe `pickle` or `yaml.load` deserialization; only deserialize trusted data and use `SafeLoader` for YAML.
   - **CRIT-107:** disabled TLS certificate verification such as `verify=False`; restore verification and configure trusted certificates.
   - **CRIT-108 (C#):** `BinaryFormatter`, `NetDataContractSerializer`, `LosFormatter`, `SoapFormatter` or `ObjectStateFormatter`; replace with a safe, constrained serializer.
   - **CRIT-109 (C#):** `TypeNameHandling.All`, `Auto`, `Objects` or `Arrays`; avoid unrestricted polymorphic deserialization and use an explicit type allowlist (a `SerializationBinder`) if polymorphism is required.
   - **CRIT-110 (C#):** `[AllowAnonymous]`; verify the endpoint is intentionally public and has appropriate abuse protections.
   - **CRIT-111 (C#):** `ServerCertificateValidationCallback`, `ServerCertificateCustomValidationCallback` or `DangerousAcceptAnyServerCertificateValidator`; ensure certificate validation is not bypassed and hostname/chain checks remain enabled.
   - **CRIT-112 (C#):** `Process.Start`; validate executable and arguments, avoid shell interpretation, and constrain untrusted input.
   - **CRIT-202:** homegrown cryptography or predictable randomness used for security tokens or identifiers, including `random.choice`, `uuid.uuid1` and C# `new Random(`; recommend standard crypto libraries and a CSPRNG.
   - **CRIT-203:** encryption without integrity protection, including CBC-mode use without a separate integrity control; prefer authenticated encryption such as AES-GCM or ChaCha20-Poly1305.
   - **CRIT-301:** swallowed exceptions, including Python `except` blocks whose next statement is `pass` and C# `catch` blocks that are empty or only write to the console, on one line or several; distinguish intentional handling from lost failures.
   - **CRIT-302:** raw exception details exposed to users, including Python `str(exc)` in responses; check for stack traces, database details, or unfiltered error messages.
   - **CRIT-303:** logs whose arguments are request bodies, user objects, payloads, or credentials, including Python `logging` calls (message wording and caught exceptions alone are not leads); recommend masking and narrow structured logging.
   - **DATA-501:** a database write inside a `scan.readOnlyPaths` path (INSERT, UPDATE, DELETE, MERGE, TRUNCATE, DROP, ALTER, a non-allowlisted `EXEC` / `CALL`, `.commit(`, a SQL helper write method). Check how the SQL is built across the whole statement, including constants assembled from several pieces; High Risk when confirmed. A `.execute(` with SQL that is not visible is a lower-confidence lead: find the SQL.
   - **DATA-502:** SQL filtered by a caller-supplied id list (`...Guid IN %s`) with no user or tenant predicate; check whether the caller is allowed to read every id (this is an IDOR / BOLA lead, see ARCH-402).
   - **HYG-501 / HYG-502:** an authentication-bypass `main_*.py` entry point in a deployable folder, and a personal absolute path in committed config; both are hygiene leads.
   - **C# rules (SS-104).** Each is a lead for you to verify, never a verdict:
     - **CS-601:** `FromSqlRaw`, `ExecuteSqlRaw(Async)` or `SqlQueryRaw` whose first argument is interpolated, concatenated or built with `string.Format`; prefer `FromSqlInterpolated`, `ExecuteSqlInterpolated` or parameters.
     - **CS-602 (lower confidence):** `Html.Raw(` on anything but a plain literal; check whether the value can hold user, model or database text.
     - **CS-603:** `DtdProcessing.Parse` or `XmlResolver = new XmlUrlResolver()` (XXE); prohibit DTDs and set `XmlResolver` to null.
     - **CS-604:** `DES`, `RC2` and `TripleDES` (broken); `MD5` and `SHA1` (lower confidence, since a non-security checksum is fine). Recommend AES-GCM and SHA-256 or better.
     - **CS-605:** `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime`, `ValidateIssuerSigningKey`, `RequireSignedTokens` or `RequireHttpsMetadata` set to `false`.
     - **CS-606:** `AllowAnyOrigin()` or `SetIsOriginAllowed(_ => true)` together with `AllowCredentials()` in one CORS policy; list trusted origins instead.
     - **CS-607 (lower confidence):** `[IgnoreAntiforgeryToken]`; acceptable for a token-authenticated API, risky with cookie sessions.
     - **CS-608 (lower confidence):** `Path.Combine` or `Path.Join` with a value that looks like request input; require the resolved path to stay inside the intended folder.
     - **CS-609:** in `web.config`, a fixed `machineKey` (`validationKey` / `decryptionKey`) or `enableViewStateMac="false"` (ViewState forgery, as in the SharePoint ToolShell attacks). The key value is never printed.
     - **CS-610 (suspicious, lower confidence):** a new `[HttpGet|Post|Put|Delete|Patch]` action or minimal API `MapGet|MapPost|...` with no `[Authorize]`, `[AllowAnonymous]`, `RequireAuthorization` or authorized base class nearby. Check for a base controller, a filter or a global fallback policy before reporting.
     - **DATA-502 (C#):** a LINQ filter such as `.Where(r => guids.Contains(r.ReportGuid))` with no user or tenant predicate; this is the IDOR shape for guid-list endpoints.
     - **ARCH-404 (C#):** a `catch` in an authentication or authorization handler or middleware that calls `next`, returns success or returns `true`; it should deny (fail closed).
   - **C# checklist for the model pass.** 0 candidates on a C# change does not mean it is safe: the scanner is a set of heuristics. For every new or changed controller action, minimal API endpoint or data-access query, read the code and check: (1) authentication and authorization on the action, the class and the route group; (2) that any id taken from the request (a guid or a list of guids) is checked against the authenticated principal before it is used, which is ARCH-402; (3) that request bodies are validated, since `[ApiController]` validates only what has data annotations; (4) deserialization settings (`TypeNameHandling`, formatters); (5) secrets or keys in `appsettings*.json`, `web.config` and connection strings; (6) raw SQL and `Html.Raw`. Report the rule ID when one applies and describe the gap in words when none does.
   - **TypeScript and JavaScript rules (SS-104).** Each is a lead for you to verify, never a verdict:
     - **TS-601:** `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`; tLS certificate verification is off; trust the specific CA instead.
     - **TS-602:** `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `dangerouslySetInnerHTML`, `v-html` (in JS/TS files) given anything but a plain literal or sanitized value; use `textContent` or DOM methods, or sanitize first (DOMPurify).
     - **TS-603:** `new Function(` or `setTimeout`/`setInterval` with a built string; same risk as `eval`; pass a function.
     - **TS-604:** `ignoreExpiration: true`, a `none` JWT algorithm, `jwt.decode` read for a role or user id; use `jwt.verify` with a fixed algorithm list.
     - **TS-605:** Cookie `httpOnly: false` or `secure: false`; CORS any origin with credentials; list trusted origins; set httpOnly and secure.
     - **TS-606:** `fs` calls, `res.sendFile` and `path.join` with request input; resolve the path and check it stays in the base folder.
     - **TS-607:** `fetch`, `axios`, `got`, `http.get` with a URL from request input; sSRF: allow only known hosts.
     - **TS-608:** `createCipher`; `createHash` with MD5 or SHA-1; use `createCipheriv` with AES-GCM and SHA-256 or better.
     - **TS-609:** `__proto__` writes; request data in a deep merge or `Object.assign`; prototype pollution and mass assignment: copy only expected fields.
     - **TS-610:** `$where`; a Mongo query built from `req.body`/`req.query` or an unchecked field; noSQL injection: pick fields and check types.
   - **TypeScript checklist for the model pass.** 0 candidates on a TypeScript or JavaScript change does not mean it is safe. For every new or changed route handler, middleware or data-access call, read the code and check: (1) authentication and authorization on the route and that ids from the request are checked against the signed-in user; (2) request bodies, params and query validated with a schema before use (a field may arrive as an object, not a string); (3) anything rendered as HTML, and any file path or URL built from request input; (4) JWT and session handling (verify, algorithm list, expiry, cookie flags); (5) secrets in code, `.env` files committed, and CORS and TLS settings. Report the rule ID when one applies and describe the gap in words when none does.
   - **Python rules (SS-104).** Each is a lead for you to verify, never a verdict:
     - **PY-601:** `eval`/`exec`, `subprocess` with `shell=True`, `os.system`/`os.popen` given anything but a plain string; command and code injection; pass a list, use `ast.literal_eval`.
     - **PY-602:** `execute`, `executemany`, `executescript`, `raw`, `read_sql` or `text(` with an f-string, `%`, `.format` or `+` query; sQL injection; use parameters.
     - **PY-603:** `render_template_string`/`Template` built from a value, `mark_safe`, `Markup`, `|safe`, `autoescape=False`; template and HTML injection.
     - **PY-604:** `debug=True`, `DEBUG = True`, `app.run(debug=True)`, a traceback or exception text returned to the client; debug mode and error leaks.
     - **PY-605:** `open`, `send_file`, `os.path.join`, `shutil` and `Path` with request input; `requests`/`httpx`/`urlopen` with a URL from request input; path traversal and SSRF.
     - **PY-606:** `assert` used for authorization, JWT verification off, `jwt.decode` with no `algorithms`, `@csrf_exempt`, CORS any origin with credentials, insecure session cookies; weak access control.
     - **PY-607:** `Model(**request.json)`, serializer `fields = "__all__"`, `tarfile.extractall` with no filter, uploaded zips extracted; mass assignment and archive path traversal.
     - **PY-608:** `yaml.load` without a safe loader, `pickle`/`dill`/`marshal`/`shelve`/`torch.load` loading; unsafe deserialization.
     - **PY-609:** `hashlib.md5`/`sha1`, `random` for tokens or passwords, `MODE_ECB`, a literal `SECRET_KEY`; weak cryptography and randomness.
     - **PY-610:** `verify=False`, `_create_unverified_context`, `ssl.CERT_NONE`, `check_hostname = False`; tLS verification is off.
     - **PY-611:** A `file://` URL fetched with request input nearby; restrict fetches to http and https.
   - **Extended Python checklist for the model pass.** For every new or changed Flask, Django or FastAPI view, read the code and check: (1) authentication and permission decorators or dependencies on the view; (2) that ids from the request are checked against the signed-in user; (3) request data validated by a serializer, form or pydantic model with explicit fields; (4) `subprocess`, `eval`, SQL, templates and file paths built from request input; (5) deserialization (`pickle`, `yaml`), debug settings, CORS, CSRF and cookie settings; (6) secrets in settings files. Report the rule ID when one applies and describe the gap in words when none does.

When supported, delegate this pass using a subagent's model selector set to your agent's `models.<agent>.basic`, and include the complete collected diff JSON, scanner candidates, and the rule list above in its prompt. The pass can use the supplied evidence directly and must not rerun collection.
4. Use the advanced model role for architectural risks and multi-step attack paths. Review applicable changes for:
   - **ARCH-401:** implicit trust in internal requests, services, or message queues without authentication, authorization, or validation.
   - **ARCH-402:** IDOR/BOLA or access decisions based on user-provided IDs without verifying the authenticated principal's rights.
   - **ARCH-403:** over-privileged service accounts, integrations, or infrastructure permissions, including config that gives an analysis service write access to a database (the analysis account should be read-only).
   - **ARCH-404:** fail-open authorization or validation where errors, timeouts, or missing permissions permit execution.
   - **ARCH-405:** infrastructure ingress open to all IPv4 or IPv6 addresses.
   - **ARCH-406:** public cloud storage or resources.
   - **ARCH-407:** privileged containers, privilege escalation, or root workloads.
   - **ARCH-408:** infrastructure encryption disabled at rest.
   - Perimeter-only security with unprotected internal boundaries; centralized or monolithic authorization that leaves paths unchecked; server-memory sessions incompatible with distributed deployment; blocking identity-provider calls on every internal request; and multiple service contexts sharing database tables.
   - **LLM data access.** **LLM-501:** model output is untrusted input. When it reaches a SQL call, a process, `eval`, a file path, an S3 key, a URL or PDF generation, trace it from the model call to the sink and report what an attacker who controls the document could make the model emit; a text-to-SQL shape is High Risk unless the SQL is validated against an allowlist and runs on a read-only account. Output that is only stored, or only bound as a SQL parameter, is not a sink. Streamed text (`text`, `collected_text`) counts as model output.
   - **Tools and agency.** **LLM-502:** list every tool a model call or agent can use (the candidate lists the names it could see; read the tool definitions for the rest). Each tool that reaches a database must be read-only, with a read-only account behind it, not just a read-only prompt. Adding `toolConfig` to a call that had none changes what a prompt injection can do, so always review it. **LLM-504:** a tool handler that starts a process lets the model choose the command; if any argument comes from the tool input, report it as High Risk.
   - **Untrusted prompt content.** **LLM-503:** PDF, OCR, email or user text must not be in the system message, and in a user message it should come after the instructions and sit inside clear delimiters. A removed "never", "do not" or "only" line in a prompt file (`REG-401`) is Suspicious until you see where the rule went; if it was moved, say where; if it was dropped, say what the model can now do.
   - **Cost and denial of service (model calls).** Check that `maxTokens` (or the provider's equivalent) is set on every call; that there is an input ceiling (pages, characters or tokens) before the document reaches the model; that fan-out such as `asyncio.gather` or `Promise.all` over pages or documents is bounded; and that the credit or quota gate runs before the model call, not after. Report a missing control as Suspicious, with the call it applies to.
   - Use `scan.projectStack` as a relevance hint. Do not let a frontend setting suppress a concrete server-side or cryptographic risk present in the changed code.
   - Review IaC and deployment changes such as Terraform, Kubernetes, Docker, Helm, and workflow files; scanner infrastructure matches are prompts, not proof of exposure.

When supported, delegate this pass using a subagent's model selector set to your agent's `models.<agent>.advanced`, with the same collected diff JSON and candidate JSON. Focus on attack paths and infrastructure context; do not recollect the diff.
5. Keep related-code inspection narrow. Start with changed lines and their immediate context. Open another file only when it is directly linked to a concrete question raised by a change, such as the matching controller, validator, authorization middleware, schema, or direct caller/callee. Use `scope.maxRelatedFiles` and `scope.maxRelationshipHops` as defaults, and exceed them only when necessary to resolve a specific security question. State why any additional file was needed. Do not search unrelated modules, perform repository-wide audits, or infer missing behavior as fact.
6. Verify candidates against nearby mitigations and execution paths. Report only claims supported by the changed code and the limited related context. Review `coverage` metadata in scanner output; `coverage.ruleFamiliesLine` also says how many of the rules for each language found something, so a short list of hits from a large rule set is not a clean result; Python and infrastructure rules are targeted heuristics, and no candidates is not evidence of safety. Include `coverage.ruleFamiliesLine` in the report so the reader can see which rule families ran for each language and which have no rules. Treat `REG-401` removed-control matches as Suspicious until confirming the control was replaced or intentionally removed. If relevant context is unavailable, say so and keep the concern in Suspicious rather than asserting exploitability.
7. Report using exactly these sections, in this order:

   ### 🔴 High Risk
   Findings with strong evidence of a real security issue and a credible path to impact.

   ### 🟡 Suspicious
   Plausible risky logic or patterns that are not proven vulnerabilities. Be liberal here and explain uncertainty.

   ### 🟢 Clean
   Specific changed areas reviewed that appear to follow sound security practices in the available context. Do not imply exhaustive coverage.

   ### ⚪ Unchecked
   Changed files in a language the tools cannot read (only JavaScript, TypeScript, C# and Python are supported), from `coverage.unchecked`. Begin the report with the `coverage.line` text, followed by `coverage.ruleFamiliesLine`. Never put an unchecked file under Clean, and never call the change clean overall when files are unchecked.

For each finding, include the rule ID when applicable, file and line, concise evidence, impact, and a concrete remediation. Avoid duplicating the same issue in multiple sections. If a section has no entries, write `None found.` In Clean, list only areas actually reviewed; if none can be responsibly identified, write `No specific areas to report.`

## Script Usage

Run from the repository root:

```sh
TOOLS=<parent directory of this skill folder>  # sibling of review-tools-common; location-independent
node "$TOOLS/review-tools-common/collect-diff.mjs" --config "$TOOLS/security-auditor/config.json" [base-ref] \
  | node "$TOOLS/security-auditor/scripts/scan-patterns.mjs"
```

The collector defaults to `diff.baseRef` in the supplied config, or `HEAD` when unset. This config uses `auto`, which picks the closest of `origin/HEAD`, `develop`, `test`, `main` and `master` and falls back to `HEAD` when none exists. An empty diff is reported with a suggested ref. With `HEAD`, it compares the working tree to `HEAD`; with another ref, it compares the working tree to `git merge-base <ref> HEAD`, excluding target-only commits while retaining feature-branch and local changes. It also includes untracked, non-ignored text files. Binary files and untracked files over the configured collection limit are skipped. The scanner reads JSON from standard input and prints JSON candidates to standard output. It reports locations and rule IDs, not verdicts.