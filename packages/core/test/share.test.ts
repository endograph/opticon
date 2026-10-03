import { describe, expect, test } from "bun:test";
import { redact } from "../src/redact";
import { MAX_SHARED_TEXT } from "../src/protocol";
import { projectForShare, projectSessionForShare } from "../src/share";
import type { SessionEvent } from "../src/types";

describe("redact", () => {
  const cases: [string, string][] = [
    ["password=hunter2", "password=[REDACTED]"],
    ["password=x", "password=[REDACTED]"],
    ["password=correct.horse.battery.staple", "password=[REDACTED]"],
    ['password="correct horse battery staple"', 'password="[REDACTED]"'],
    ["password='correct horse battery staple'", "password='[REDACTED]'"],
    ['{"password":"two \\"quoted\\" words"}', '{"password":"[REDACTED]"}'],
    ['password="two\nlines"', 'password="[REDACTED]"'],
    ['password="unterminated secret', 'password="[REDACTED]"'],
    ['password="process.env.NOT_ACTUALLY_CODE"', 'password="[REDACTED]"'],
    ["password=$notACodeReference", "password=[REDACTED]"],
    ["password=<actual-secret>", "password=[REDACTED]"],
    ["mcp__internal__sk-proj-" + "Xy12".repeat(10), "mcp__internal__[REDACTED]"],
    ["bearer AbCdEfGhIjKlMn0123456789", "bearer [REDACTED]"],
    ["Authorization: bearer short", "Authorization: bearer [REDACTED]"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [REDACTED]"],
    ["https://example.test/cli?code=TEST-1234&view=1", "https://example.test/cli?code=[REDACTED]&view=1"],
    ["Check that the page shows the code F4K3-C0D3.", "Check that the page shows the code [REDACTED]."],
    ["Your verification code is 123456.", "Your verification code is [REDACTED]."],
    ["[Approve](https://example.test/cli?code=abcd1234)", "[Approve](https://example.test/cli?code=[REDACTED])"],
    ["https://example.test/#session=short", "https://example.test/#session=[REDACTED]"],
    ["My credential is 0123456789abcdef0123456789abcdef01234567", "My credential is [REDACTED]"],
    ["My credential is AbCdEfGh12/JkLmNoPq34/RsTuVwXy56/ZaBcDeFg78", "My credential is [REDACTED]"],
    ["My credential is AbCdEfGh12_JkLmNoPq34-RsTuVwXy56-ZaBcDeFg78", "My credential is [REDACTED]"],
    ["https://device.tail123.ts.net:8454/", "https://[REDACTED]:8454/"],
    ["db.corp.internal 10.1.2.3 172.16.3.4 192.168.4.5 100.64.1.2", "[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]"],
    ["Contact someone@example.test", "Contact [REDACTED]"],
    ["/Users/another/dev/app /home/another/dev/app C:\\Users\\another\\app", "~/dev/app ~/dev/app ~\\app"],
    ["key sk-ant-api03-abcdefghijklmnopqrstuv here", "key [REDACTED] here"],
    ["export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123", "export GITHUB_TOKEN=[REDACTED]"],
    ['{"apiKey": "hunter2hunter2"}', '{"apiKey": "[REDACTED]"}'],
    ["postgres://admin:pw123@db:5432/x", "postgres://[REDACTED]@db:5432/x"],
    ["Authorization: Bearer abcdefghijklmnop1234", "Authorization: Bearer [REDACTED]"],
    ["id AKIAABCDEFGHIJKLMNOP", "id [REDACTED]"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "[REDACTED]"],
    ["blob 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a", "blob [REDACTED]"],
  ];
  test.each(cases)("%p", (input, expected) => {
    expect(redact(input, "/Users/me").text).toBe(expected);
  });

  test.each([
    "commit 3b812bf371abf5d4257ef29e697c7ed36e64d73d",
    "unknown-t3-f92f8e8d-0d1c-4eb7-b859-1d8006de4719",
    "const token = process.env.API_TOKEN",
    "sessionToken=${session}",
    "`password=…`-style assignments and `token = process.env.X` aren't flagged.",
    "token=[REDACTED]",
    '"token":"[REDACTED]"',
    "https://example.test/docs?q=hello%20world",
  ])("keeps %p", (input) => {
    expect(redact(input, "/Users/me").text).toBe(input);
  });

  test("leaves ordinary prose, identifiers, and paths alone except home", () => {
    const text = "Call this_is_a_really_long_identifier_name_for_tests in /Users/me/dev/app/src/components/thing.ts";
    expect(redact(text, "/Users/me")).toEqual({
      text: "Call this_is_a_really_long_identifier_name_for_tests in ~/dev/app/src/components/thing.ts",
      findings: [],
    });
  });

  test.each([
    "https://example.test/approve?redirect=https%3A%2F%2Fexample.test%2Fauth%3Ftoken%3DAbCdEfGh12345678",
    "https://example.test/approve?redirect=https%3A%2F%2Fexample.test%2Fcli%3Fcode%3DF4K3-C0D3",
    "https://example.test/?redirect=https%253A%252F%252Fexample.test%252F%253Fcode%253DF4K3-C0D3",
    "token%3Dhunter2%ZZ",
    "password%3D%22correct%20horse%20battery%20staple%22",
    `token%${"25".repeat(12)}3Dhunter2`,
  ])("scrubs encoded credentials: %p", (input) => {
    expect(redact(input).text).toBe("[REDACTED]");
    expect(redact(input).findings).toEqual([{ rule: "encoded-secret", count: 1 }]);
  });

  test.each(cases)("redaction is idempotent: %p", (input) => {
    const once = redact(input, "/Users/me");
    expect(redact(once.text, "/Users/me")).toEqual({ text: once.text, findings: [] });
  });

  test.each([
    "sk-ant-" + "x".repeat(24),
    "sk-proj-" + "x".repeat(24),
    "ghp_" + "x".repeat(24),
    "AKIA" + "X".repeat(16),
    "AIza" + "x".repeat(35),
    "xoxb-" + "x".repeat(24),
    "sk_live_" + "x".repeat(24),
    "npm_" + "x".repeat(36),
    "eyJxxxxxxxx.eyJxxxxxxxx.xxxxxxxx",
  ])("recognizes a credential embedded in a tool name: %p", (credential) => {
    const result = projectForShare([{ kind: "tool", id: "1", category: "mcp", name: `mcp__${credential}/query`, status: "ok" }]);
    expect(result.events[0]).toMatchObject({ name: "mcp__[REDACTED]/query" });
  });
});

test("share projection drops thinking and tool details, redacts text", () => {
  const events: SessionEvent[] = [
    { kind: "message", id: "1", role: "user", text: "use token=supersecretvalue" },
    { kind: "thinking", id: "2", text: "private thoughts" },
    { kind: "tool", id: "3", category: "tool", name: "Bash", status: "ok", summary: "cat .env", input: { x: 1 }, output: "SECRET" },
  ];
  expect(projectForShare(events)).toEqual({
    events: [
      { kind: "message", id: "1", timestamp: undefined, role: "user", text: "use token=[REDACTED]" },
      { kind: "tool", id: "3", timestamp: undefined, category: "tool", name: "Bash", status: "ok" },
    ],
    findings: [{ rule: "secret-assignment", count: 1 }],
  });
});

test("the session projection scrubs metadata, tool names and notices without mutating local data", () => {
  const session = {
    meta: { title: "password=hunter2", cwd: "/Users/me/dev/token=project-secret", path: "/private/transcript.jsonl", gitBranch: "private-branch" },
    events: [
      { kind: "tool", id: "1", category: "mcp", name: "private.tail123.ts.net/query", status: "ok", input: { secret: "raw" }, output: "raw" },
      { kind: "notice", id: "2", level: "error", text: "Authorization: bearer short" },
      { kind: "thinking", id: "3", text: "private" },
    ] satisfies SessionEvent[],
  };
  const before = structuredClone(session);
  const shared = projectSessionForShare(session);
  expect(shared.meta).toEqual({ title: "password=[REDACTED]", project: "token=[REDACTED]" });
  expect(shared.events).toEqual([
    { kind: "tool", id: "1", category: "mcp", name: "[REDACTED]/query", status: "ok" },
    { kind: "notice", id: "2", level: "error", text: "Authorization: bearer [REDACTED]" },
  ]);
  expect(shared.findings).toContainEqual({ rule: "secret-assignment", count: 2 });
  expect(shared.findings).toContainEqual({ rule: "private-host", count: 1 });
  expect(shared.findings).toContainEqual({ rule: "bearer-token", count: 1 });
  expect(session).toEqual(before);
});

test("redacts complete credentials before truncating long messages and titles", () => {
  const value = "x ".repeat(MAX_SHARED_TEXT / 2 - 8) + "sk-proj-" + "z".repeat(100);
  const result = projectSessionForShare({
    meta: { title: value },
    events: [{ kind: "message", id: "1", role: "user", text: value }],
  });
  expect(JSON.stringify(result)).not.toContain("sk-proj");
  expect(result.meta.title!.length).toBeLessThanOrEqual(MAX_SHARED_TEXT);
  expect(result.events[0]).toMatchObject({ text: result.meta.title });
  expect(result.findings).toEqual([{ rule: "openai-key", count: 2 }]);
});
