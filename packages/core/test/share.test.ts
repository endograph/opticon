import { describe, expect, test } from "bun:test";
import { redact } from "../src/redact";
import { projectForShare } from "../src/share";
import type { SessionEvent } from "../src/types";

describe("redact", () => {
  const cases: [string, string][] = [
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
