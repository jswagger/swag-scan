// Supply chain and CI/CD rules for the Security Auditor (SS-104). They look at changed GitHub workflow files, package
// manifests and install-time Python files, whatever the language of the rest of the change. Every rule is a lead for
// the model pass, not a verdict. Nothing here reads the network: whether a dependency has a known advisory is out of
// scope, so a new dependency is only a "review this" lead.

import { LOWER, createReporter } from './rule-helpers.mjs';

const WORKFLOW_PATH = /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;
const ACTION_PATH = /(?:^|\/)(?:\.github\/actions\/[^/]+\/action|action)\.ya?ml$/i;
const PACKAGE_JSON = /(?:^|\/)package\.json$/i;
const REQUIREMENTS = /(?:^|\/)requirements[^/]*\.(?:txt|in)$/i;
const PYPROJECT = /(?:^|\/)pyproject\.toml$/i;
const CSPROJ = /\.(?:cs|vb|fs)proj$|(?:^|\/)Directory\.Packages\.props$/i;
const PTH_FILE = /\.pth$/i;
const SETUP_PY = /(?:^|\/)setup\.py$/i;

const PR_HEAD_REF = /\bgithub\s*\.\s*event\s*\.\s*pull_request\s*\.\s*head\s*\.\s*(?:sha|ref)\b|\bgithub\s*\.\s*head_ref\b|\brefs\/pull\/\S*\/(?:merge|head)\b|\bgithub\s*\.\s*event\s*\.\s*workflow_run\s*\.\s*head_(?:sha|branch)\b/;
const UNTRUSTED_CONTEXT = /\$\{\{\s*(?:github\s*\.\s*(?:event\s*\.\s*(?:issue\s*\.\s*(?:title|body)|pull_request\s*\.\s*(?:title|body|head\s*\.\s*(?:ref|label|repo\s*\.\s*(?:default_branch|description)))|comment\s*\.\s*body|review\s*\.\s*body|review_comment\s*\.\s*body|discussion\s*\.\s*(?:title|body)|head_commit\s*\.\s*(?:message|author\s*\.\s*(?:name|email))|commits\b[^}]*?\.\s*(?:message|author\s*\.\s*(?:name|email))|pages\b[^}]*?\.\s*page_name|workflow_run\s*\.\s*(?:head_branch|head_commit\s*\.\s*message|display_title))|head_ref)|inputs\s*\.\s*\w+)\b[^}]*\}\}/;
const USES_LINE = /^\s*-?\s*uses\s*:\s*['"]?([^'"\s#]+)/;
const FULL_SHA = /@[0-9a-f]{40}$/i;
const INSTALL_SCRIPT = /^\s*"(preinstall|install|postinstall)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const VERSION_LIKE = /^(?:[\^~<>=*]|\d|latest$|next$|workspace:|npm:|file:|link:|git|https?:|github:)/i;
const SETUP_RISK = /\b(?:exec|subprocess|os\s*\.\s*system|os\s*\.\s*popen|urlopen|urlretrieve|requests\s*\.\s*(?:get|post)|socket\s*\.\s*socket|eval|__import__)\s*\(|\bcurl\b|\bwget\b/;
const DEP_SECTION = /^\s*"(dependencies|devDependencies|optionalDependencies|peerDependencies)"\s*:\s*\{/;
const ANY_OBJECT_KEY = /^\s*"([^"]+)"\s*:\s*\{/;
const JSON_DEP = /^\s*"(@?[\w.-]+(?:\/[\w.-]+)?)"\s*:\s*"([^"]*)"\s*,?\s*$/;
const REQUIREMENT_LINE = /^\s*(?![#-])([A-Za-z0-9][\w.-]*(?:\[[^\]]*\])?)\s*(?:[=<>!~]=?|@|;|\s*$)/;
const PYPROJECT_TABLE = /^\s*\[(.+?)\]\s*$/;
const PYPROJECT_ARRAY_START = /^\s*(?:dependencies|requires|optional-dependencies\.\w+|\w+)\s*=\s*\[\s*$|^\s*(?:dependencies|requires)\s*=\s*\[/;
const PYPROJECT_REQUIREMENT = /^\s*['"]([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*(?:[=<>!~;@ ]|['"])/;
const POETRY_DEP = /^\s*([A-Za-z0-9][\w.-]*)\s*=\s*(?:['"{])/;
const PACKAGE_REFERENCE = /<PackageReference\b[^>]*\bInclude\s*=\s*"([^"]+)"|<PackageVersion\b[^>]*\bInclude\s*=\s*"([^"]+)"/i;

const isRun = (line) => /^\s*-?\s*run\s*:/.test(line);

/** Lines (0-based) of every `run:` step body in a workflow, so `${{ }}` inside them can be told from `${{ }}` in `with:`. */
function runLines(lines) {
  const inRun = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!isRun(lines[index])) continue;
    inRun.add(index);
    const indent = /^\s*/.exec(lines[index])[0].length + (/^\s*-/.test(lines[index]) ? 2 : 0);
    const block = /:\s*[|>][+-]?\s*$/.test(lines[index]);
    if (!block) continue;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].trim() && /^\s*/.exec(lines[next])[0].length <= indent) break;
      inRun.add(next);
    }
  }
  return inRun;
}

function insideDependencySection(lines, index) {
  for (let at = index - 1; at >= 0; at -= 1) {
    const section = DEP_SECTION.exec(lines[at]);
    if (section) return section[1];
    if (ANY_OBJECT_KEY.test(lines[at])) return undefined;
  }
  return undefined;
}

function pyprojectDependency(lines, index) {
  for (let at = index; at >= 0; at -= 1) {
    const table = PYPROJECT_TABLE.exec(lines[at]);
    if (table) return /(?:^|\.)dependencies$|\.group\.[^.]+\.dependencies$|^build-system$/i.test(table[1]) && POETRY_DEP.test(lines[index]) && !/^python\s*=/i.test(lines[index].trim());
    if (at < index && /^\s*\]/.test(lines[at])) return false;
    if (at < index && PYPROJECT_ARRAY_START.test(lines[at]) && /\[\s*$/.test(lines[at]) && /(?:dependencies|requires)/.test(lines[at])) return PYPROJECT_REQUIREMENT.test(lines[index]);
    if (at === index && /(?:dependencies|requires)\s*=\s*\[/.test(lines[at])) return PYPROJECT_REQUIREMENT.test(lines[at].slice(lines[at].indexOf('[') + 1));
  }
  return false;
}

export function createSupplyChainRules() {
  function analyze({ file, sourceLines }) {
    const path = file.path.replaceAll('\\', '/');
    const { found, report } = createReporter();
    const added = (file.changes ?? []).filter((change) => change.side === 'added');
    if (added.length === 0) return found;
    const lines = Array.isArray(sourceLines) ? sourceLines : [];
    const hasSource = lines.length > 0;

    if (WORKFLOW_PATH.test(path) || ACTION_PATH.test(path)) {
      const runs = hasSource ? runLines(lines) : new Set();
      const text = lines.join('\n');
      const targetsPullRequestHead = /\bpull_request_target\b/.test(text) || (!hasSource && added.some((change) => /\bpull_request_target\b/.test(change.text)));
      for (const change of added) {
        const line = change.text;
        const noComment = line.replace(/\s+#.*$/, '');
        if (/^\s*#/.test(line)) continue;

        // SUP-601: pull_request_target that checks out code from the pull request.
        if (/\bpull_request_target\b/.test(noComment) && hasSource && lines.some((other) => PR_HEAD_REF.test(other) && /\bref\s*:/.test(other))) {
          report('SUP-601', change, 'This workflow runs on pull_request_target, which has repository secrets and write access, and it checks out code from the pull request; that code can steal the secrets. Check out the base branch, or split the untrusted build into a pull_request workflow');
        }
        if (targetsPullRequestHead && /\bref\s*:/.test(noComment) && PR_HEAD_REF.test(noComment)) {
          report('SUP-601', change, 'A pull_request_target workflow checks out the pull request head; its code then runs with secrets and write access. Check out the base branch, or split the untrusted build into a pull_request workflow');
        }

        // SUP-602: untrusted event text inside a run: step.
        const context = UNTRUSTED_CONTEXT.exec(noComment);
        if (context && (runs.has(change.line - 1) || (!hasSource && isRun(noComment)))) {
          report('SUP-602', change, 'Text that an outsider controls (a title, body, branch name or input) is placed directly in a run: script, so it can inject shell commands. Pass it through an env: variable and read "$VAR" in the script');
        }

        // SUP-603: actions not pinned to a commit.
        const uses = USES_LINE.exec(noComment);
        if (uses && !/^(?:\.\/|docker:\/\/)/.test(uses[1]) && !FULL_SHA.test(uses[1])) {
          report('SUP-603', change, `The action ${uses[1].split('@')[0]} is pinned to a tag or branch, which its owner can move to new code; pin to a 40-character commit SHA and keep the version in a comment`, LOWER);
        }

        // SUP-604: write-all permissions.
        if (/^\s*permissions\s*:\s*write-all\b/.test(noComment)) {
          report('SUP-604', change, 'permissions: write-all gives every job in the workflow write access to the repository; grant only the scopes each job needs');
        }
      }
    }

    if (PACKAGE_JSON.test(path)) {
      for (const change of added) {
        // SUP-605: install-time scripts.
        const script = INSTALL_SCRIPT.exec(change.text);
        if (script && !VERSION_LIKE.test(script[2])) {
          report('SUP-605', change, `A ${script[1]} script runs on every machine that installs this package, with that user's permissions; confirm it is needed and does not download or run unreviewed code`);
          continue;
        }
        // SUP-606: new dependencies.
        const dependency = JSON_DEP.exec(change.text);
        if (dependency && hasSource) {
          const section = insideDependencySection(lines, change.line - 1);
          if (section) report('SUP-606', change, `New ${section} entry ${dependency[1]}; check that the package is the intended one (typosquats), maintained and needed. This is a review lead, not a finding`, LOWER);
        }
      }
    }

    if (REQUIREMENTS.test(path)) {
      for (const change of added) {
        const requirement = REQUIREMENT_LINE.exec(change.text);
        if (requirement && !/^\s*(?:-|#)/.test(change.text)) {
          report('SUP-606', change, `New Python dependency ${requirement[1]}; check that the package is the intended one (typosquats), maintained and pinned. This is a review lead, not a finding`, LOWER);
        }
      }
    }

    if (PYPROJECT.test(path) && hasSource) {
      for (const change of added) {
        if (pyprojectDependency(lines, change.line - 1)) {
          report('SUP-606', change, 'New Python dependency in pyproject.toml; check that the package is the intended one (typosquats), maintained and needed. This is a review lead, not a finding', LOWER);
        }
      }
    }

    if (CSPROJ.test(path)) {
      for (const change of added) {
        const reference = PACKAGE_REFERENCE.exec(change.text);
        if (reference) {
          report('SUP-606', change, `New NuGet package ${reference[1] ?? reference[2]}; check that it is the intended package, maintained and needed. This is a review lead, not a finding`, LOWER);
        }
      }
    }

    // SUP-607: install-time code in Python.
    if (PTH_FILE.test(path)) {
      const first = added[0];
      report('SUP-607', first, 'A .pth file is read by Python at startup, and a line that starts with "import" is executed; this is a known way to hide code that runs in every Python process. Confirm the file is expected');
    }
    if (SETUP_PY.test(path)) {
      for (const change of added) {
        if (/^\s*#/.test(change.text)) continue;
        if (SETUP_RISK.test(change.text)) {
          report('SUP-607', change, 'setup.py runs this code when the package is installed (exec, subprocess or a network call); install-time code should only describe the package. Move it out or confirm it is needed');
        }
      }
    }

    return found;
  }

  return { analyze };
}
