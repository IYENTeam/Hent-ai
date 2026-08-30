import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AFFECT_DIMENSIONS, AFFECT_SPACE_VERSION, VISUAL_AFFECT_SCHEMA_VERSION } from "../../shared/affect.js";
import { buildVisualAffectTagPrompt, tagVisualAffectOffline } from "./affect-tags.js";
import { createSemanticGenerationPlan } from "./semantic-plan.js";

const dimensions = Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, 0.5]));

describe("VisualAffectV2 offline tagging", () => {
  it("binds actual image bytes and never asks the LLM to preserve a planned emotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "hent-affect-test-"));
    const item = createSemanticGenerationPlan().items[0]!;
    await writeFile(join(root, item.filename), Buffer.from("pixels"));
    const invoke = vi.fn(async () => ({
      schemaVersion: VISUAL_AFFECT_SCHEMA_VERSION,
      affectSpaceVersion: AFFECT_SPACE_VERSION,
      dimensions,
      confidence: 0.9,
      evidence: ["visible brow tension"],
    }));
    const affect = await tagVisualAffectOffline({ setDir: root, item, tagger: { invoke }, model: "vision-test", taggedAt: "2026-08-30T00:00:00.000Z" });
    expect(affect.source).toMatchObject({ model: "vision-test", promptVersion: "visual-affect-pixels-v2" });
    expect(affect.source?.imageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(invoke.mock.calls[0]?.[0].prompt).not.toContain(`emotion must be ${item.emotion}`);
    expect(buildVisualAffectTagPrompt()).toContain("actual image pixels");
    expect(JSON.parse(await readFile(join(root, ".affect", `${item.id}.json`), "utf8"))).toEqual(affect);
  });
});
