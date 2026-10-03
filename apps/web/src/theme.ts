import { useSyncExternalStore } from "react";

/**
 * Light, dark, or the OS setting. An inline script in index.html applies the saved choice before
 * first paint so the page never flashes; keep its key and values in sync with these.
 */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

const KEY = "opticon_theme";
const listeners = new Set<() => void>();

function readTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  return THEMES.includes(stored as Theme) ? (stored as Theme) : "system";
}

/** "system" removes the attribute so prefers-color-scheme decides. */
export function setTheme(theme: Theme): void {
  if (theme === "system") {
    localStorage.removeItem(KEY);
    delete document.documentElement.dataset.theme;
  } else {
    localStorage.setItem(KEY, theme);
    document.documentElement.dataset.theme = theme;
  }
  for (const l of listeners) l();
}

export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
}

export function useTheme(): Theme {
  return useSyncExternalStore((listener) => {
    // Another tab changing the theme updates this one too.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      const theme = readTheme();
      if (theme === "system") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
      listener();
    };
    listeners.add(listener);
    addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      removeEventListener("storage", onStorage);
    };
  }, readTheme);
}
