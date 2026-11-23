// Secret rules for the Security Auditor (SS-104): well-known provider key formats in any changed file, literal values in
// committed `.env` files, and literal credentials in MCP configuration. The value of a secret is never printed: the
// evidence has it replaced, and the description names only the provider.

import { createReporter } from './rule-helpers.mjs';

const PROVIDERS = [
  { name: 'Anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'GitHub', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g },
  { name: 'Slack', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}|\bxapp-\d-[A-Za-z0-9-]{10,}/g },
  { name: 'Stripe', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
  { name: 'Stripe (test key)', pattern: /\b(?:sk|rk)_test_[A-Za-z0-9]{16,}/g, lower: true },
  { name: 'Stripe webhook', pattern: /\bwhsec_[A-Za-z0-9]{24,}/g },
  { name: 'Hugging Face', pattern: /\bhf_[A-Za-z0-9]{34,}/g },
  { name: 'Google API', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
];

const PLACEHOLDER = /(?:x{4,}|\*{3,}|\.{3,}|<[^>]+>|\$\{[^}]*\}|\{\{[^}]*\}\}|your[_-]?|example|placeholder|changeme|dummy|sample|redacted|insert[_-]|todo\b)/i;
const ENV_FILE = /(?:^|\/)\.env(?:\.[\w.-]+)?$/i;
const ENV_TEMPLATE = /(?:^|\/)\.env\.(?:example|sample|template|dist|defaults?|schema)$|\.env\.[\w.-]*\.(?:example|sample|template)$/i;
const MCP_FILE = /(?:^|\/)(?:\.mcp\.json|mcp\.json|mcp_settings\.json|claude_desktop_config\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json|\.claude\/settings(?:\.local)?\.json)$/i;
const SECRET_NAME = /(?:api[_-]?key|apikey|secret|token|password|passwd|credential|authorization|private[_-]?key|auth|bearer|access[_-]?key)/i;
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*?)\s*$/;
const JSON_PAIR = /^\s*"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/;
const ENV_REFERENCE = /^\$\{?[A-Za-z_]|^\$\{(?:env|input|secret)[:.]|^%[A-Za-z_]+%$|^\$\{\{|^\{\{/i;

const isPlaceholder = (value) => !value || PLACEHOLDER.test(value) || /^(.)\1{5,}$/.test(value);

function redactAll(text, matches) {
  let result = text;
  for (const { value, label } of matches) result = result.split(value).join(`[${label} redacted]`);
  return result.trim().slice(0, 240);
}

export function createSecretsRules() {
  function analyze({ file }) {
    const path = file.path.replaceAll('\\', '/');
    const { found, report } = createReporter();
    const added = (file.changes ?? []).filter((change) => change.side === 'added');

    for (const change of added) {
      // SEC-601: well-known provider key formats, in any file.
      const matches = [];
      for (const provider of PROVIDERS) {
        for (const match of change.text.matchAll(provider.pattern)) {
          if (isPlaceholder(match[0].replace(/^sk-(?:ant-|proj-|svcacct-|admin-)?/, ''))) continue;
          matches.push({ value: match[0], label: `${provider.name} key`, provider, line: change.line });
        }
      }
      if (matches.length > 0) {
        const providers = [...new Set(matches.map((match) => match.provider.name))];
        const lower = matches.every((match) => match.provider.lower);
        report('SEC-601', change, `A ${providers.join(' and ')} credential is written into the code or config; anyone who can read the repository can use it. Rotate it, remove it from history and load it from the environment or a secret store`, {
          evidence: redactAll(change.text, matches),
          ...(lower ? { confidence: 'lower' } : {}),
        });
      }

      // SEC-602: literal values in committed .env files.
      if (ENV_FILE.test(path) && !ENV_TEMPLATE.test(path)) {
        const assignment = ENV_ASSIGNMENT.exec(change.text);
        if (assignment && !/^\s*#/.test(change.text)) {
          const value = assignment[2].replace(/^['"]|['"]$/g, '');
          if (value && !ENV_REFERENCE.test(value) && !isPlaceholder(value) && SECRET_NAME.test(assignment[1])) {
            report('SEC-602', change, `A real-looking value is set for ${assignment[1]} in a .env file that is part of the change; .env files hold secrets and should be in .gitignore, with a .env.example that has no values`, {
              evidence: `${assignment[1]}=[value redacted]`,
            });
          }
        }
      }

      // SEC-603: literal credentials in MCP configuration.
      if (MCP_FILE.test(path)) {
        const pair = JSON_PAIR.exec(change.text);
        if (pair && SECRET_NAME.test(pair[1]) && pair[2] && !ENV_REFERENCE.test(pair[2]) && !isPlaceholder(pair[2])) {
          report('SEC-603', change, `The MCP configuration holds a literal value for ${pair[1]}; configuration files are shared and committed, so reference an environment variable instead (for example "\${${pair[1].toUpperCase().replace(/[^A-Z0-9]+/g, '_')}}")`, {
            evidence: `"${pair[1]}": "[value redacted]"`,
          });
        } else if (/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/.test(change.text) && !ENV_REFERENCE.test(/\bBearer\s+(\S+)/.exec(change.text)?.[1] ?? '') && !PLACEHOLDER.test(change.text)) {
          report('SEC-603', change, 'The MCP configuration has a literal bearer token in a header; reference an environment variable instead', { evidence: change.text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/, '$1[token redacted]').trim().slice(0, 240) });
        }
      }
    }
    return found;
  }

  return { analyze };
}
