---
name: test-tailor
description: Review the unit tests a change adds or edits and judge their long-term value. Recommends removing or condensing redundant, loose or ticket-specific tests. Use before creating or reviewing a pull request.
argument-hint: Optional base ref (for example origin/main)
---

# Test Tailor

Evaluate the unit tests in a diff for long-term value. A script collects the diff and flags repeatable patterns as *leads*; you read each test and decide. Test Tailor is report-only: it recommends, it never edits or deletes a test.

## Scope

- Only tests that were **added or edited in the diff**. A test the diff did not touch is never judged, even when a touched test duplicates it (you may name it as the thing being duplicated).
- Python (`pytest` and `unittest`), JavaScript and TypeScript (`jest`, `vitest`, `mocha`, `node:test`). Any other test file is listed as Unchecked.
- Not for bugs (Bug Hunter), clean code in non-test files (Code Sweeper) or vulnerabilities (Security Auditor). Bug Hunter already flags deleted assertions (`REMOVED_TEST_ASSERTION`) and disabled tests (`TEST_DISABLED`); do not repeat them.

## Configuration

Read [config.json](./config.json) first.

- `scan.exclude`: patterns omitted during collection and scanning.
- `scan.testFiles.patterns`: paths treated as tests. Only these files are judged.
- `scan.thresholds`: `maxSetupLines` (setup before the first assertion), `maxHookLines` (a `beforeEach` or `setUp` body) and `minDuplicateLiteralLines` (smallest copy-pasted fixture). Heuristics, not hard rules.

## Procedure

Run commands from the repository root.

```sh
TOOLS=<parent directory of this skill folder>  # sibling of review-tools-common; location-independent
CFG="$TOOLS/test-tailor/config.json"
node "$TOOLS/review-tools-common/collect-diff.mjs" --config "$CFG" [base-ref] \
  | node "$TOOLS/test-tailor/scripts/scan-patterns.mjs"
```

1. **Collect and scan.** Use the provided base ref, else `diff.baseRef` from the config. The scanner prints `candidates` (leads) and `tests` (every test the diff touched, with its assertion counts).
2. **Read each lead in context.** Open the test and the code it exercises. A lead is a script match, not a verdict.
3. **Place every touched test in one bucket** (see below). Use `tests` to make sure none is skipped: a test with real assertions and no lead is a candidate for 🟢.
4. **Flag ticket-specific tests** (`TT-108`). A test that only proves one ticket's work was done (it names the ticket, restates its acceptance criteria, or exercises a one-off path) is a removal candidate once the ticket ships. A regression test for a real bug is not: it earns its place.
5. **Recommend, do not act.** For each 🔴 or 🟡 test say whether to remove it, condense it into another (name which) or sharpen it (say how).

## Rules

| Rule | Bucket | Meaning |
|---|---|---|
| `TT-101` | 🟡 Loose | The test has no assertion |
| `TT-102` | 🟡 Loose | Every assertion only checks that a value exists or is truthy (`toBeTruthy`, `toBeDefined`, bare `assert x`) |
| `TT-103` | 🟡 Loose | Long setup before the first assertion |
| `TT-104` | 🟡 Loose | A `beforeEach` or `setUp` hook that is very large |
| `TT-105` | 🔴 Excessive | Near-identical sibling tests that could be one table-driven test |
| `TT-106` | 🔴 Excessive | The same fixture literal copy-pasted into several places in the file |
| `TT-107` | 🟡 Loose | An assertion replaced by a weaker one in the same edit (`toEqual` to `toBeTruthy`) |
| `TT-108` | ticket hint | The test mentions a ticket; judge whether it is ticket-specific |
| `TT-109` | 🟡 Loose, high priority | The test file mocks the module it tests, so the test may only check the mock |

## Report

Header: the resolved base (hash and date). Then these sections, in this order:

- **🔴 Excessive (Redundant / Bloat):** duplicate test cases, copy-pasted fixtures, or tests that overlap existing coverage without adding an edge case.
- **🟡 Loose (Low Value):** tests that pass trivially, lack meaningful assertions, or carry a large unnecessary setup.
- **🟢 Perfect Fit (High Value):** sharp, focused tests with robust assertions that exercise the new code paths. Name the tests you actually read; do not imply the whole suite was reviewed. If none can be responsibly identified, write `No specific tests to report.`
- **⚪ Unchecked:** changed test files in a language the tools cannot read (only JavaScript, TypeScript, C# and Python are supported). C# tests are not judged by Test Tailor yet; list them and begin the report with the `coverage.line` text. Never put an unchecked file under 🟢.

Each item includes the rule ID (when there is one), file and line, the test name, concise evidence, why it matters, and a concrete recommendation: **remove**, **condense into `<test>`** or **sharpen by asserting `<what>`**. Don't repeat an issue across sections. An empty section reads `None found.`

End with `No files changed.`
