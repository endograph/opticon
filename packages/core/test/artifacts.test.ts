import { describe, expect, test } from "bun:test";
import { collectArtifacts } from "../src/artifacts";
import type { SessionEvent, ToolEvent } from "../src/types";

const tool = (id: string, name: string, input: unknown, status: ToolEvent["status"] = "ok"): ToolEvent => ({
  kind: "tool",
  id,
  category: "tool",
  name,
  status,
  input,
});

describe("collectArtifacts", () => {
  test("replays Claude Code writes and edits into versions", () => {
    const path = "/tmp/explainer.html";
    const [artifact, ...rest] = collectArtifacts([
      tool("w1", "Write", { file_path: path, content: "<h1>One $& one</h1>" }),
      tool("e1", "Edit", { file_path: path, old_string: "One", new_string: "Two $&" }),
      tool("e2", "MultiEdit", { file_path: path, edits: [{ old_string: "one", new_string: "1", replace_all: true }] }),
    ]);
    expect(rest).toEqual([]);
    expect(artifact).toMatchObject({ kind: "html", title: "explainer.html", path, created: true });
    expect(artifact!.id).toMatch(/^explainer-html-[0-9a-z]+$/);
    expect(artifact!.versions.map((v) => v.content)).toEqual([
      "<h1>One $& one</h1>",
      "<h1>Two $& $& one</h1>",
      "<h1>Two $& $& 1</h1>",
    ]);
  });

  test("an edit without a known base, or that doesn't apply, leaves the content to the file on disk", () => {
    const path = "/repo/docs/README.md";
    const [artifact] = collectArtifacts([
      tool("e1", "Edit", { file_path: path, old_string: "a", new_string: "b" }),
      tool("w1", "Write", { file_path: path, content: "hello" }),
      tool("e2", "Edit", { file_path: path, old_string: "missing", new_string: "x" }),
    ]);
    expect(artifact).toMatchObject({ kind: "markdown", title: "docs/README.md", created: false });
    expect(artifact!.versions.map((v) => v.content)).toEqual([undefined, "hello", undefined]);
  });

  test("skips failed and running calls and files it can't render", () => {
    const artifacts = collectArtifacts([
      tool("w1", "Write", { file_path: "/a.html", content: "x" }, "error"),
      tool("w2", "Write", { file_path: "/b.html", content: "x" }, "running"),
      tool("w3", "Write", { file_path: "/c.ts", content: "x" }),
      tool("b1", "Bash", { command: "echo > d.html" }),
    ] satisfies SessionEvent[]);
    expect(artifacts).toEqual([]);
  });

  test("inline HTML renders group by title", () => {
    const render = (id: string, title: string, html: string) =>
      ({ ...tool(id, "t3-code/html_render", { title, html, height: 600 }), category: "mcp" }) as ToolEvent;
    const artifacts = collectArtifacts([render("r1", "Flow", "<p>1</p>"), render("r2", "Other", "<p>x</p>"), render("r3", "Flow", "<p>2</p>")]);
    expect(artifacts.map((a) => [a.title, a.path, a.versions.map((v) => v.content)])).toEqual([
      ["Flow", undefined, ["<p>1</p>", "<p>2</p>"]],
      ["Other", undefined, ["<p>x</p>"]],
    ]);
  });

  test("Codex file changes: adds carry content, updates don't", () => {
    const artifacts = collectArtifacts([
      tool("c1", "edit", { "/r/plan.md": { type: "add", content: "# Plan" }, "/r/main.swift": { type: "add", content: "x" } }),
      tool("c2", "edit", { "/r/plan.md": { type: "update", unified_diff: "@@" } }),
    ]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.versions).toEqual([
      { eventId: "c1", timestamp: undefined, content: "# Plan" },
      { eventId: "c2", timestamp: undefined, content: undefined },
    ]);
  });

  test("ids are stable and distinct per source", () => {
    const events = [tool("w1", "Write", { file_path: "/x/a.md", content: "" }), tool("w2", "Write", { file_path: "/y/a.md", content: "" })];
    const [a, b] = collectArtifacts(events);
    expect(a!.id).not.toBe(b!.id);
    expect(collectArtifacts(events).map((x) => x.id)).toEqual([a!.id, b!.id]);
  });
});
