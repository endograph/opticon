import type { MessageEvent, NoticeEvent, SessionEvent, ThinkingEvent, ToolEvent } from "@opticon/core";
import { memo, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Status } from "./local/api";

const PAGE = 150;
const COLLAPSED_ACTIVITY = 4;

type Step = ToolEvent | ThinkingEvent;
type Block =
  | { type: "message"; event: MessageEvent }
  | { type: "notice"; event: NoticeEvent }
  | { type: "activity"; id: string; events: Step[] };

/** Consecutive tool calls and thinking collapse into one activity block between messages. */
function toBlocks(events: SessionEvent[]): Block[] {
  const blocks: Block[] = [];
  for (const event of events) {
    if (event.kind === "message") blocks.push({ type: "message", event });
    else if (event.kind === "notice") blocks.push({ type: "notice", event });
    else {
      const last = blocks.at(-1);
      if (last?.type === "activity") last.events.push(event);
      else blocks.push({ type: "activity", id: event.id, events: [event] });
    }
  }
  return blocks;
}

export function Transcript({ events, status }: { events: SessionEvent[]; status: Status }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [shown, setShown] = useState(PAGE);
  const blocks = toBlocks(events);
  const visible = blocks.slice(-shown);

  // Follow new output while the reader is at the bottom; leave them alone if they scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  if (status === "missing") return <p className="hint pad">This session no longer exists on disk.</p>;
  if (status === "loading" && !events.length) return <p className="hint pad">Loading…</p>;

  return (
    <div
      className="transcript"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="transcript-inner">
        {blocks.length > shown && (
          <button type="button" className="button subtle more" onClick={() => setShown(shown + PAGE)}>
            Show earlier ({blocks.length - shown})
          </button>
        )}
        {!blocks.length && <p className="hint">No messages yet.</p>}
        {visible.map((block) => (
          <BlockView key={block.type === "activity" ? block.id : block.event.id} block={block} />
        ))}
      </div>
    </div>
  );
}

const BlockView = memo(function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "message":
      return block.event.role === "user" ? (
        <div className="message user">
          <div className="message-body">{block.event.text}</div>
        </div>
      ) : (
        <div className="message assistant">
          <div className="message-body markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{block.event.text}</Markdown>
          </div>
        </div>
      );
    case "notice":
      return <div className={`notice ${block.event.level}`}>{block.event.text}</div>;
    case "activity":
      return <Activity events={block.events} />;
  }
}, sameBlock);

/** Blocks are rebuilt every render, but the events inside keep their identity until replaced. */
function sameBlock({ block: a }: { block: Block }, { block: b }: { block: Block }): boolean {
  if (a.type === "activity" && b.type === "activity") {
    return a.events.length === b.events.length && a.events.every((e, i) => e === b.events[i]);
  }
  return a.type !== "activity" && b.type !== "activity" && a.event === b.event;
}

function Activity({ events }: { events: Step[] }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = expanded ? 0 : Math.max(0, events.length - COLLAPSED_ACTIVITY);
  return (
    <div className="activity">
      {hidden > 0 && (
        <button type="button" className="activity-more" onClick={() => setExpanded(true)}>
          {hidden} earlier step{hidden === 1 ? "" : "s"}
        </button>
      )}
      {events.slice(hidden).map((e) =>
        e.kind === "thinking" ? <Thinking key={e.id} text={e.text} /> : <ToolChip key={e.id} tool={e} />,
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <details className="step thinking">
      <summary>
        <span className="step-icon">∴</span>
        <span className="truncate">{text.split("\n", 1)[0]?.replaceAll("**", "")}</span>
      </summary>
      <div className="step-detail prose">{text}</div>
    </details>
  );
}

const STATUS_ICON = { running: "◌", ok: "✓", error: "✕" } as const;

function ToolChip({ tool }: { tool: ToolEvent }) {
  const hasDetail = tool.input !== undefined || !!tool.output;
  const head = (
    <>
      <span className={`step-icon status-${tool.status}`}>{STATUS_ICON[tool.status]}</span>
      <span className={`tool-name cat-${tool.category}`}>{tool.name}</span>
      {tool.summary && <span className="truncate mono dim">{tool.summary}</span>}
    </>
  );
  if (!hasDetail) return <div className="step">{head}</div>;
  return (
    <details className="step">
      <summary>{head}</summary>
      <div className="step-detail">
        {tool.input !== undefined && <pre>{typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 2)}</pre>}
        {tool.output && <pre className={tool.status === "error" ? "error" : ""}>{tool.output}</pre>}
      </div>
    </details>
  );
}
