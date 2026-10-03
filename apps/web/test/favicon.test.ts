import { expect, test } from "bun:test";
import { join } from "node:path";

const web = join(import.meta.dir, "..");

// index.html inlines the icon (the compiled CLI embeds only JS and CSS), so keep it in sync with favicon.svg.
test("index.html inlines favicon.svg", async () => {
  const svg = (await Bun.file(join(web, "favicon.svg")).text()).trim();
  const html = await Bun.file(join(web, "index.html")).text();
  const href = html.match(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,([^"]+)"/)?.[1];
  expect(href).toBeDefined();
  // An unescaped "#" starts a URL fragment, which silently truncates the icon.
  expect(href).not.toContain("#");
  expect(decodeURIComponent(href!)).toBe(svg);
});
