import { homedir } from "node:os";

/**
 * Aggressive secret scrubbing for shared text. Biased hard toward false positives:
 * a mangled snippet in a shared transcript is cheap, a leaked key is not.
 */
interface Rule {
  name: string;
  pattern: RegExp;
  /** Returns true to leave a match untouched. */
  keep?: (match: string, ...groups: string[]) => boolean;
  replace?: (match: string, ...groups: string[]) => string;
}

const RULES: Rule[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai-key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replace: (_m, scheme) => `${scheme}[REDACTED]@`,
  },
  {
    name: "bearer-token",
    pattern: /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/g,
    replace: (_m, scheme) => `${scheme} [REDACTED]`,
  },
  {
    // KEY=value, "apiKey": "value", password: value ... where the name looks secret-ish.
    name: "secret-assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
    keep: (_m, _prefix, value = "") => isCodeReference(value),
    replace: (_m, prefix) => `${prefix}[REDACTED]`,
  },
  {
    // Long high-entropy blobs (hex or base64-ish) that slipped past the specific rules.
    name: "high-entropy",
    pattern: /\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
    keep: (match) => !looksRandom(match),
  },
];

export interface RedactionFinding {
  rule: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

export function redact(input: string, home = homedir()): RedactionResult {
  const counts = new Map<string, number>();
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match, ...rest) => {
      if (rule.keep?.(match, ...(rest as string[]))) return match;
      counts.set(rule.name, (counts.get(rule.name) ?? 0) + 1);
      return rule.replace ? rule.replace(match, ...(rest as string[])) : "[REDACTED]";
    });
  }
  // Home paths reveal usernames. Not counted as a finding.
  if (home && home !== "/") text = text.split(home).join("~");
  return { text, findings: [...counts].map(([rule, count]) => ({ rule, count })) };
}

/**
 * Long identifiers, paths, git SHAs, and UUID-bearing ids are not secrets. A random-looking
 * unbroken run of 32+ characters is.
 */
function looksRandom(s: string): boolean {
  if (s.includes("/") || /^[0-9a-f]{40}$/.test(s)) return false;
  const longestRun = Math.max(...s.split(/[-_]/).map((part) => part.length));
  if (longestRun < 32) return false;
  return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(s)).length >= 2;
}

/** `token = process.env.X`, `auth: (opts)`, `secret=${value}` are code, not values. */
function isCodeReference(value: string): boolean {
  return /^[($`{[<]/.test(value) || /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+\)?$/.test(value);
}
