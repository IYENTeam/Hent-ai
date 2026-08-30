import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createSemanticGenerationPlan } from "./semantic-plan.js";
import {
  SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
  SEMANTIC_TAG_COLLECTION_SCHEMA_VERSION,
} from "./semantic-tags.js";

const execFileAsync = promisify(execFile);

describe("semantic asset verifier CLI", () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

  it("validates the complete recursive surface and rejects an unplanned visible image", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "hent-semantic-verify-"));
    dirs.push(assetRoot);
    const setDir = join(assetRoot, "sets", "gothic-semantic-v1");
    await mkdir(setDir, { recursive: true });
    const plan = createSemanticGenerationPlan();
    await writeFile(join(setDir, "generation-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

    const tags: Record<string, unknown> = {};
    const emotions: Record<string, string[]> = {};
    for (const item of plan.items) {
      await writeFile(join(setDir, item.filename), `pixels-${item.id}`);
      const itemTags = {
        schemaVersion: SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
        emotion: item.emotion,
        gesture: item.gesture,
        expression: item.expression,
        background: item.background,
        clothing: item.clothing,
        composition: "three-quarter portrait",
        lighting: "scene-aware soft light",
        mood: item.emotion,
      };
      tags[item.filename] = itemTags;
      emotions[item.emotion] = [...(emotions[item.emotion] ?? []), item.filename];
    }
    await writeFile(join(setDir, "semantic-tags.json"), `${JSON.stringify({ schemaVersion: SEMANTIC_TAG_COLLECTION_SCHEMA_VERSION, items: tags }, null, 2)}\n`);
    await writeFile(join(assetRoot, "manifest.json"), `${JSON.stringify({
      version: 1,
      activeSet: "legacy",
      sets: {
        "gothic-semantic-v1": { emotions, semanticAssets: tags },
      },
    }, null, 2)}\n`);

    const script = resolve("../scripts/verify-semantic-assets.mjs");
    await expect(execFileAsync(process.execPath, [script, "--complete", setDir])).resolves.toMatchObject({
      stdout: expect.stringContaining("semantic set verified"),
    });

    await mkdir(join(setDir, "nested"));
    await writeFile(join(setDir, "nested", "extra.png"), "extra pixels");
    await expect(execFileAsync(process.execPath, [script, "--complete", setDir])).rejects.toMatchObject({
      stderr: expect.stringContaining("visible set images must be exactly"),
    });
  });
});
