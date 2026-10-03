const SYSTEM_TAGS = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;

/** Removes harness-injected tags from user-visible text. */
export function stripInjected(text: string): string {
  return text.replace(SYSTEM_TAGS, "").trim();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function firstLine(text: string, max = 120): string {
  return truncate(text.trim().split("\n", 1)[0] ?? "", max);
}

export function parseJson(line: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}
