import { expect, test } from "bun:test";
import { parseRoute } from "../src/router";

test("artifact deep links", () => {
  const key = "claude/0b6b7c1e-0000-0000-0000-000000000000";
  expect(parseRoute(`/local/${key}`, "")).toEqual({ name: "local", key });
  expect(parseRoute(`/local/${key}/a/explainer-html-1x2y`, "")).toEqual({
    name: "local",
    key,
    artifact: "explainer-html-1x2y",
    version: undefined,
  });
  expect(parseRoute(`/local/${key}/a/flow-3k`, "?v=2")).toMatchObject({ artifact: "flow-3k", version: 2 });
  expect(parseRoute(`/local/${key}/a/flow-3k`, "?v=x")).toMatchObject({ version: undefined });
  expect(parseRoute(`/local/${key}/a/`, "")).toEqual({ name: "not_found" });
});
