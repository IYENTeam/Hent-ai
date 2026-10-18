import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const refs = join(import.meta.dir, "../../skill/hent-mode/references");
const docPath = process.env.CONVERSATION_DOC ?? join(refs, "conversation.md");

type SourceLine = { path: string; line: number; text: string };

const fixture = JSON.parse(readFileSync(join(refs, "conversation-sources.json"), "utf8")) as SourceLine[];
const doc = readFileSync(docPath, "utf8");

const table = doc.slice(doc.indexOf("## Numeric thresholds"));
const rows = [...table.matchAll(/^\| ([^|\s]+):(\d+) \| (.+?) \|$/gm)].map((m) => ({
  path: m[1]!,
  line: Number(m[2]),
  value: m[3]!.trim(),
}));

describe("conversation thresholds", () => {
  test("table covers the required thresholds", () => {
    const keys = new Set(rows.map((r) => `${r.path}:${r.line}`));
    for (const key of [
      "service/src/watcher-core.ts:165",
      "service/src/watcher-core.ts:270",
      "service/src/watcher-core.ts:271",
      "service/src/watcher-core.ts:272",
      "service/src/watcher-core.ts:273",
    ]) expect(keys.has(key)).toBe(true);
  });

  test.each(rows.map((r) => [`${r.path}:${r.line}`, r] as const))("%s value appears in its fixture line", (_key, row) => {
    const entry = fixture.find((f) => f.path === row.path && f.line === row.line);
    expect(entry).toBeDefined();
    expect(entry!.text).toContain(row.value);
  });
});
