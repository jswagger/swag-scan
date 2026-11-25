// Finding the branch a change is compared against, and explaining plainly when it cannot be found.
// Shared by collect-diff.mjs (which resolves the base) and `swag-scan doctor`. Read-only git, passed in as `runGit`.

/** Branches tried, in order, when the target branch is "auto". */
export const BASE_CANDIDATES = [
  'origin/HEAD', 'origin/develop', 'develop', 'origin/test', 'test',
  'origin/main', 'main', 'origin/master', 'master',
];

/** Branch names a person could pick: local ones first, then origin's (without "origin/"), no duplicates, never HEAD. */
export function listBranches(runGit) {
  let output;
  try {
    output = runGit(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
  } catch {
    return [];
  }
  const names = [];
  for (const ref of String(output).split('\n').map((line) => line.trim()).filter(Boolean)) {
    const name = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '');
    if (name !== 'HEAD' && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The branch to suggest: the first well-known base name that exists, else the first other branch. Never the checked-out one. */
export function suggestBranch(names, current) {
  for (const preferred of ['develop', 'test', 'main', 'master']) {
    if (names.includes(preferred) && preferred !== current) return preferred;
  }
  return names.find((name) => name !== current);
}

function shownBranches(names) {
  const shown = names.slice(0, 8).join(', ');
  return names.length > 8 ? `${shown} and ${names.length - 8} more` : shown;
}

/** One plain sentence group for a target branch that does not exist: what was found, a suggestion, and how to fix it. */
export function missingBranchMessage(requested, names, current) {
  const suggestion = suggestBranch(names, current);
  return `Swag Scan: I could not find a branch named "${requested}" in this repository. `
    + (names.length ? `Branches I found: ${shownBranches(names)}. ` : 'I did not find any other branches. ')
    + (suggestion ? `Did you mean "${suggestion}"? ` : '')
    + 'Pick one with /swag-scan:config (choose "auto" to let Swag Scan detect it), or for this repository only: swag-scan config set targetBranch <branch> --this-repo.';
}

/** A warning for "auto" when no candidate branch exists, so the scan fell back to comparing against HEAD. */
export function noBaseWarning(names, current) {
  const suggestion = suggestBranch(names, current);
  return 'I could not find a branch to compare against (looked for origin/HEAD, develop, test, main and master), '
    + 'so only your uncommitted and untracked changes were scanned. '
    + (names.length ? `Branches I found: ${shownBranches(names)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''} ` : '')
    + 'Pick the branch your work merges into with /swag-scan:config.';
}
