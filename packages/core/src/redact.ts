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

const MASK = "[REDACTED]";

const RULES: Rule[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: "anthropic-key", pattern: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai-key", pattern: /(?<![A-Za-z0-9])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", pattern: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "aws-access-key", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  { name: "google-api-key", pattern: /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9])/g },
  { name: "slack-token", pattern: /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe-key", pattern: /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "npm-token", pattern: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  { name: "jwt", pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replace: (_m, scheme) => `${scheme}[REDACTED]@`,
  },
  {
    name: "bearer-token",
    pattern: /\b(Bearer|Basic|token)\s+([A-Za-z0-9._~+/=-]+)/gi,
    keep: (_m, scheme = "", value = "") => scheme.toLowerCase() === "token" && value.length < 16,
    replace: (_m, scheme) => `${scheme} [REDACTED]`,
  },
  {
    name: "url-secret",
    pattern: /([?&#](?:[\w.-]*(?:secret|token|password|api[_-]?key|credential)[\w.-]*|code|session|key|sig|signature|state|ticket|otp|pin)=)([^\s&#"'<>`)]+)/gi,
    keep: (_m, _prefix, value = "") => isPlaceholder(value),
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
  {
    // Device approval codes also appear alone in prose, outside their login URLs.
    name: "login-code",
    pattern: /(?<![\w-])[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,2}(?![\w-])/g,
  },
  {
    name: "login-code",
    pattern: /\b((?:login|device|approval|verification|one[- ]time|pairing|recovery|security)\s+(?:code|pin)\s*(?:(?:is|shows)\s+|[:=]\s*)?["'`]?)([A-Za-z0-9-]{4,})/gi,
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
  {
    // KEY=value, "apiKey": "value", password: value ... where the name looks secret-ish.
    name: "secret-assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|cookie|session)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|(?:Bearer|Basic)\s+[^\s"',;`&]+|[^\s"',;`&]+)/gi,
    keep: (_m, _prefix, value = "") => isPlaceholder(value) || isCodeReference(value),
    replace: (_m, prefix, value = "") => {
      const quote = /^["']/.test(value) ? value[0] : "";
      return `${prefix}${quote}${MASK}${quote}`;
    },
  },
  {
    // Long high-entropy blobs (hex or base64-ish) that slipped past the specific rules.
    name: "high-entropy",
    pattern: /\b(?:(commit|tree|parent|sha(?:1|256)?)\s+)?([A-Za-z0-9+/_-]{32,}={0,2})/gi,
    keep: (_m, context = "", value = "") =>
      (!!context && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)) || !looksRandom(value),
    replace: (_m, context = "") => `${context ? `${context} ` : ""}${MASK}`,
  },
  {
    name: "private-host",
    pattern: /\b(?:[a-z0-9-]+\.)+(?:ts\.net|internal|local)\b/gi,
  },
  {
    name: "private-address",
    pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/g,
  },
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
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
  return scrub(input, home, true);
}

function scrub(input: string, home: string, checkEncoded: boolean): RedactionResult {
  const counts = new Map<string, number>();
  let text = input;
  if (checkEncoded && text.includes("%")) {
    // Scan decoded values, but never decode the published text: doing that would change URL
    // semantics. Mask the whole encoded token if it hides anything sensitive. Work is bounded
    // for nested redirects; deeper encodings are withheld rather than passed through unchecked.
    text = text.replace(/[^\s"'<>`()\[\]]+/g, (encoded) => {
      if (!/%[0-9a-f]{2}/i.test(encoded)) return encoded;
      let decoded = encoded;
      for (let depth = 0; depth < 8 && /%[0-9a-f]{2}/i.test(decoded); depth++) {
        decoded = decoded.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      }
      if (!/%[0-9a-f]{2}/i.test(decoded) && scrub(decoded, home, false).text === decoded) return encoded;
      counts.set("encoded-secret", (counts.get("encoded-secret") ?? 0) + 1);
      return MASK;
    });
  }
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match, ...rest) => {
      if (rule.keep?.(match, ...(rest as string[]))) return match;
      counts.set(rule.name, (counts.get(rule.name) ?? 0) + 1);
      return rule.replace ? rule.replace(match, ...(rest as string[])) : MASK;
    });
  }
  // Home paths reveal usernames. Not counted as a finding.
  if (home && home !== "/") text = text.split(home).join("~");
  // Transcripts may have come from another machine or user.
  text = text.replace(/\/(?:Users|home)\/[^/\s"'`<>]+/g, "~");
  text = text.replace(/\b[A-Z]:\\Users\\[^\\\s"'`<>]+/gi, "~");
  return { text, findings: [...counts].map(([rule, count]) => ({ rule, count })) };
}

/**
 * Only recognizable UUIDs are exempt. Slashes, separators, and 40 hex characters are also
 * valid credential formats; a git hash needs explicit git context to be kept.
 */
function looksRandom(s: string): boolean {
  if (/(?:^|[-_])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s)) return false;
  if (/^[0-9a-f]{32,}$/i.test(s)) return true;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= 4;
}

function isPlaceholder(value: string): boolean {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return /^(?:(?:(?:Bearer|Basic)\s+)?\[REDACTED\]|<redacted>|…|\.\.\.)$/i.test(value);
}

/** Keep only explicit, unquoted environment references, not arbitrary dotted passwords. */
function isCodeReference(value: string): boolean {
  return /^(?:(?:process|import\.meta)\.env\.[A-Za-z_][\w]*|\$\{[A-Za-z_][\w]*\})$/.test(value);
}
