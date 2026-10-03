import { describe, expect, test } from "bun:test";
import { createClaudeParser } from "../src/providers/claude";
import { createCodexParser } from "../src/providers/codex";
import type { SessionEvent, SessionParser } from "../src/types";

function feed(parser: SessionParser, records: object[]): SessionEvent[] {
  return records.flatMap((r) => parser.push(JSON.stringify(r)));
}

const base = { cwd: "/repo", sessionId: "s1", gitBranch: "main" };

describe("claude", () => {
  const path = "/x/projects/-repo/0b6b7c1e-0000-0000-0000-000000000000.jsonl";

  test("messages, thinking, and tool lifecycle", () => {
    const parser = createClaudeParser(path);
    const events = feed(parser, [
      { ...base, type: "user", uuid: "u1", timestamp: "t1", message: { role: "user", content: "fix the build" } },
      { ...base, type: "assistant", uuid: "a1", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
      {
        ...base,
        type: "assistant",
        uuid: "a2",
        message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "bun test\n--x" } }] },
      },
      {
        ...base,
        type: "user",
        uuid: "u2",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "1 fail", is_error: true }] },
      },
      { ...base, type: "assistant", uuid: "a3", message: { content: [{ type: "text", text: "Fixed." }] } },
      { type: "ai-title", aiTitle: "Fix build", sessionId: "s1" },
    ]);
    expect(events.map((e) => e.kind)).toEqual(["message", "thinking", "tool", "tool", "message"]);
    expect(events[2]).toMatchObject({ id: "tu1", name: "Bash", status: "running", summary: "bun test" });
    expect(events[3]).toMatchObject({ id: "tu1", status: "error", output: "1 fail" });
    expect(parser.meta).toMatchObject({
      id: "0b6b7c1e-0000-0000-0000-000000000000",
      cwd: "/repo",
      gitBranch: "main",
      title: "Fix build",
    });
  });

  test("categorizes mcp, plugin, skill, and subagent tools", () => {
    const tools = [
      ["mcp__github__create_issue", {}],
      ["mcp__plugin_linear_linear__search", {}],
      ["Skill", { skill: "pdf" }],
      ["Skill", { skill: "anthropic-skills:docx" }],
      ["Agent", { subagent_type: "Explore", description: "find it" }],
    ] as const;
    const events = feed(
      createClaudeParser(path),
      tools.map(([name, input], i) => ({
        type: "assistant",
        uuid: `a${i}`,
        message: { content: [{ type: "tool_use", id: `t${i}`, name, input }] },
      })),
    );
    expect(events.map((e) => e.kind === "tool" && [e.category, e.name])).toEqual([
      ["mcp", "github/create_issue"],
      ["plugin", "linear_linear/search"],
      ["skill", "skill:pdf"],
      ["plugin", "skill:anthropic-skills:docx"],
      ["subagent", "agent:Explore"],
    ]);
  });

  test("filters harness noise and renders commands and interrupts", () => {
    const user = (uuid: string, content: unknown, extra = {}) => ({ type: "user", uuid, message: { content }, ...extra });
    const events = feed(createClaudeParser(path), [
      user("m1", "skill body", { isMeta: true }),
      user("m2", "<task-notification><task-id>x</task-id></task-notification>"),
      user("m3", "<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>"),
      user("m4", "<local-command-stdout>ok</local-command-stdout>"),
      user("m5", "[Request interrupted by user]"),
      user("m6", "hello<system-reminder>secret context</system-reminder>"),
      user("m7", "summary", { isCompactSummary: true }),
    ]);
    expect(events).toEqual([
      { kind: "message", id: "m3", timestamp: undefined, role: "user", text: "/model opus" },
      { kind: "notice", id: "m5", timestamp: undefined, level: "info", text: "Interrupted by user" },
      { kind: "message", id: "m6", timestamp: undefined, role: "user", text: "hello" },
      { kind: "notice", id: "m7", timestamp: undefined, level: "info", text: "Context compacted" },
    ]);
  });
});

describe("codex", () => {
  const id = "01a097a2-736d-7230-af52-005ba8db70a4";
  const path = `/x/sessions/2026/09/12/rollout-2026-09-12T22-00-02-${id}.jsonl`;
  const item = (item: object) => ({ timestamp: "t", type: "event_msg", payload: { type: "item_completed", item } });

  test("reads item_completed items and ignores raw response items", () => {
    const parser = createCodexParser(path);
    const events = feed(parser, [
      { type: "session_meta", payload: { id, cwd: "/repo" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "<injected>" }] } },
      item({ type: "UserMessage", id: "u1", content: [{ type: "text", text: "add tests" }] }),
      item({ type: "Reasoning", id: "r1", summary_text: [], raw_content: [] }),
      item({ type: "CommandExecution", id: "c1", command: ["/bin/zsh", "-lc", "bun test"], status: "failed", aggregated_output: "boom" }),
      item({ type: "McpToolCall", id: "m1", server: "cua", tool: "js", pluginId: "cu@openai", status: "completed", result: { isError: false, content: [] } }),
      item({ type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "Done." }], phase: "final" }),
      { type: "event_msg", payload: { type: "turn_aborted", turn_id: "t9", reason: "interrupted" } },
    ]);
    expect(events.map((e) => [e.kind, e.id])).toEqual([
      ["message", "u1"],
      ["tool", "c1"],
      ["tool", "m1"],
      ["message", "a1"],
      ["notice", "abort:t9"],
    ]);
    expect(events[1]).toMatchObject({ name: "shell", status: "error", summary: "bun test", output: "boom" });
    expect(events[2]).toMatchObject({ category: "plugin", name: "cua/js", status: "ok" });
    expect(parser.meta).toMatchObject({ id, cwd: "/repo", title: "add tests" });
  });

  test("index title wins over first message", () => {
    const parser = createCodexParser(path, "Named thread");
    feed(parser, [item({ type: "UserMessage", id: "u1", content: [{ type: "text", text: "hi" }] })]);
    expect(parser.meta.title).toBe("Named thread");
  });
});
