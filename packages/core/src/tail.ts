import { stat } from "node:fs/promises";
import { createParser } from "./providers";
import type { Provider, SessionEvent, SessionMeta, SessionParser } from "./types";

const CHUNK = 8 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * Follows one append-only session file. Each `read()` consumes bytes since the last read and
 * returns events that were created or replaced. An incomplete trailing line is held until its
 * newline arrives. If the file shrinks, it was rewritten, so parsing restarts from the beginning.
 */
export class SessionTail {
  private parser: SessionParser;
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  /** All events in first-seen order; replacements keep their original position. */
  readonly events = new Map<string, SessionEvent>();

  constructor(
    readonly provider: Provider,
    readonly path: string,
    private readonly title?: string,
  ) {
    this.parser = createParser(provider, path, title);
  }

  get meta(): SessionMeta {
    return this.parser.meta;
  }

  /** Returns changed events plus whether the session restarted (consumers should drop prior state). */
  async read(): Promise<{ changed: SessionEvent[]; reset: boolean }> {
    const { size } = await stat(this.path);
    const reset = size < this.offset;
    if (reset) {
      this.parser = createParser(this.provider, this.path, this.title);
      this.offset = 0;
      this.rest = Buffer.alloc(0);
      this.events.clear();
    }
    const changed = new Map<string, SessionEvent>();
    const file = Bun.file(this.path);
    while (this.offset < size) {
      const end = Math.min(size, this.offset + CHUNK);
      const chunk = Buffer.from(await file.slice(this.offset, end).arrayBuffer());
      this.offset = end;
      const data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
      let start = 0;
      for (let nl = data.indexOf(NEWLINE); nl !== -1; nl = data.indexOf(NEWLINE, start)) {
        const line = data.toString("utf8", start, nl);
        start = nl + 1;
        if (!line.trim()) continue;
        for (const event of this.parser.push(line)) {
          this.events.set(event.id, event);
          changed.delete(event.id);
          changed.set(event.id, event);
        }
      }
      this.rest = Buffer.from(data.subarray(start));
    }
    return { changed: [...changed.values()], reset };
  }
}
