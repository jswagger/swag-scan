// Which rules each reviewer's scripts apply to which language, so the report can say "17 rules applied" and mean it.
// Security Auditor already knows its own rules (coverage.ruleFamilies); Bug Hunter and Code Sweeper keep theirs inline,
// so they are listed here. test/rule-catalog.test.mjs compares these lists with the rule IDs in each script's source,
// so adding a rule without listing it here fails the tests.
//
// `languages` is omitted when a rule applies to every supported language (Python, C#, TypeScript, JavaScript).

const JS_TS = ['TypeScript', 'JavaScript'];

export const RULE_CATALOG = {
  'bug-hunter': [
    { id: 'REMOVED_GUARD' },
    { id: 'MISSING_RELEASE', languages: JS_TS },
    { id: 'REMOVED_AWAIT' },
    { id: 'REMOVED_ERROR_HANDLING' },
    { id: 'REMOVED_TEST_ASSERTION' },
    { id: 'TEST_DISABLED' },
    { id: 'REMOVED_CLEANUP' },
    { id: 'REMOVED_EARLY_EXIT' },
    { id: 'BEHAVIOR_CHANGE_PAIR' },
    { id: 'SIGNATURE_CHANGED' },
  ],
  'code-sweeper': [
    { id: 'SWEEP-101' }, { id: 'SWEEP-102' }, { id: 'SWEEP-103' }, { id: 'SWEEP-104' }, { id: 'SWEEP-105' },
    { id: 'SWEEP-106', languages: ['Python'] },
    { id: 'SWEEP-107', languages: JS_TS },
    { id: 'SWEEP-111' },
    { id: 'SWEEP-112', languages: JS_TS },
  ],
  'test-tailor': ['TT-101', 'TT-102', 'TT-103', 'TT-104', 'TT-105', 'TT-106', 'TT-107', 'TT-108', 'TT-109']
    .map((id) => ({ id, languages: ['Python', ...JS_TS] })),
};

/** Languages the scan actually read for this agent: the keys of `coverage.checked` ("C#", "Python", ...). */
const checkedLanguages = (coverage) => Object.keys(coverage?.checked ?? {});

/**
 * How many distinct rules the agent's scripts applied to the languages that were scanned, or undefined when it is not
 * known (no coverage, an unknown tool). 0 means nothing in a supported language was scanned.
 */
export function rulesApplied(tool, coverage) {
  if (!coverage) return undefined;
  const languages = checkedLanguages(coverage);
  if (tool === 'security-auditor') {
    if (!Array.isArray(coverage.ruleFamilies)) return undefined;
    const ids = new Set();
    for (const entry of coverage.ruleFamilies) for (const family of entry.ran ?? []) for (const id of family.rules ?? []) ids.add(id);
    return ids.size;
  }
  const catalog = RULE_CATALOG[tool];
  if (!catalog) return undefined;
  return catalog.filter((rule) => languages.some((language) => !rule.languages || rule.languages.includes(language))).length;
}
