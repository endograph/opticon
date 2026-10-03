import { expect, test } from "bun:test";
import { type SessionEvent, type SessionMeta, projectSessionForShare } from "@opticon/core";
import { ShareSync } from "../src/daemon/sync";
import type { SessionMessage, SessionStore } from "../src/daemon/store";

test("share creation and live uploads send the scrubbed preview, including title-only updates", async () => {
  const meta: SessionMeta = {
    provider: "claude", id: "session-id", path: "/private/session.jsonl",
    title: "password=initial-password", cwd: "/tmp/token=project-secret",
  };
  const events: SessionEvent[] = [
    { kind: "message", id: "message", role: "user", text: "password=message-secret" },
    { kind: "tool", id: "tool", category: "mcp", name: "token=tool-secret", status: "ok", input: "raw-input", output: "raw-output" },
    { kind: "thinking", id: "thinking", text: "raw-thinking" },
  ];
  let onUpdate: ((message: SessionMessage) => void) | undefined;
  const store = {
    events: async () => ({ meta, events }),
    subscribe: async (_key: string, callback: typeof onUpdate) => {
      onUpdate = callback;
      return () => {};
    },
  } as unknown as SessionStore;
  const created: Record<string, unknown>[] = [];
  const uploaded: Record<string, unknown>[] = [];
  const sync = new ShareSync(store);
  // Substitute only the network client and login; exercise the real projection, queue, and diff.
  const internals = sync as unknown as {
    client: unknown;
    auth: unknown;
    reconcile(demand: { shareId: string; provider: "claude"; sessionId: string }[]): void;
    queues: Map<string, Promise<void>>;
  };
  internals.client = {
    action: async (_fn: unknown, args: Record<string, unknown>) => {
      created.push(args);
      return { shareId: "share-id", slug: "test-slug" };
    },
    mutation: async (_fn: unknown, args: Record<string, unknown>) => {
      uploaded.push(args);
    },
  };
  internals.auth = { token: "test-owner-token" };
  sync.account = { configured: true, signedIn: true, liveSync: true, webUrl: "https://example.test" };

  const preview = projectSessionForShare({ meta, events });
  await sync.share("claude/session-id", { anyone: true, users: [], orgs: [], teams: [] });
  expect(created[0]).toMatchObject({ title: preview.meta.title, project: preview.meta.project });
  expect(uploaded[0]).toMatchObject({ title: preview.meta.title, events: preview.events });
  expect(JSON.stringify({ created, uploaded })).not.toMatch(/initial-password|project-secret|message-secret|tool-secret|raw-input|raw-output|raw-thinking/);

  internals.reconcile([{ shareId: "share-id", provider: "claude", sessionId: "session-id" }]);
  expect(onUpdate).toBeDefined();
  const changed = { ...meta, title: "Updated: password=live-password" };
  const newEvents: SessionEvent[] = [{ kind: "message", id: "live", role: "assistant", text: "https://example.test/cli?code=F4K3-C0D3" }];
  onUpdate!({ type: "events", meta: changed, events: newEvents });
  await internals.queues.get("share-id");
  expect(uploaded.at(-1)).toMatchObject({ title: "Updated: password=[REDACTED]", events: projectSessionForShare({ meta: changed, events: newEvents }).events });

  const count = uploaded.length;
  onUpdate!({ type: "events", meta: { ...meta, title: "Title only: password=last-password" }, events: [] });
  await internals.queues.get("share-id");
  expect(uploaded).toHaveLength(count + 1);
  expect(uploaded.at(-1)).toMatchObject({ title: "Title only: password=[REDACTED]", events: [] });
  expect(JSON.stringify(uploaded)).not.toMatch(/live-password|last-password|F4K3-C0D3/);
});
