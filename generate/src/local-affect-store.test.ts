import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AFFECT_DIMENSIONS, AFFECT_SPACE_VERSION, VISUAL_AFFECT_SCHEMA_VERSION } from "../../shared/affect.js";
import { VISUAL_AFFECT_COLLECTION_SCHEMA_VERSION } from "./affect-tags.js";
import { migrateAffectAssetsToLocalStore } from "./local-affect-store.js";

describe("external local affect asset store", () => {
  it("dry-runs, copies by hash, and atomically activates a V2 set", async () => {
    const root = await mkdtemp(join(tmpdir(), "hent-store-test-"));
    const source = join(root, "repo-assets");
    const target = join(root, "external-assets");
    const pixels = Buffer.from("png-pixels");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(source, "sets", "source"), { recursive: true }));
    await writeFile(join(source, "sets", "source", "happy-001.png"), pixels);
    await writeFile(join(source, "manifest.json"), JSON.stringify({ sets: { source: { name: "Source", emotions: { happy: ["happy-001.png"] } } } }));
    const tagPath = join(root, "affect-vectors.json");
    const dimensions = Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, 0.5]));
    await writeFile(tagPath, JSON.stringify({
      schemaVersion: VISUAL_AFFECT_COLLECTION_SCHEMA_VERSION,
      affectSpaceVersion: AFFECT_SPACE_VERSION,
      items: {
        "happy-001.png": {
          schemaVersion: VISUAL_AFFECT_SCHEMA_VERSION,
          affectSpaceVersion: AFFECT_SPACE_VERSION,
          dimensions,
          confidence: 0.9,
          evidence: ["visible smile"],
          source: {
            model: "vision-test",
            taggedAt: "2026-08-30T00:00:00.000Z",
            imageSha256: createHash("sha256").update(pixels).digest("hex"),
            promptVersion: "visual-affect-pixels-v2",
          },
        },
      },
    }));
    await expect(migrateAffectAssetsToLocalStore({ sourceRoot: source, sourceSetId: "source", targetRoot: target, targetSetId: "target", tagCollectionPath: tagPath }))
      .resolves.toMatchObject({ dryRun: true, files: 1, activated: false });
    await expect(migrateAffectAssetsToLocalStore({ sourceRoot: source, sourceSetId: "source", targetRoot: target, targetSetId: "target", tagCollectionPath: tagPath, apply: true, activate: true }))
      .resolves.toMatchObject({ dryRun: false, files: 1, activated: true });
    expect(await readFile(join(target, "sets", "target", "happy-001.png"))).toEqual(pixels);
    expect(JSON.parse(await readFile(join(target, "manifest.json"), "utf8"))).toMatchObject({ activeSet: "target", sets: { target: { affectSpaceVersion: AFFECT_SPACE_VERSION } } });

    await expect(migrateAffectAssetsToLocalStore({
      sourceRoot: source,
      sourceSetId: "source",
      targetRoot: source,
      targetSetId: "source-v2",
      tagCollectionPath: tagPath,
      apply: true,
      activate: true,
    })).resolves.toMatchObject({ dryRun: false, files: 1, activated: true });
    expect(await readFile(join(source, "sets", "source-v2", "happy-001.png"))).toEqual(pixels);
    expect(JSON.parse(await readFile(join(source, "manifest.json"), "utf8"))).toMatchObject({ activeSet: "source-v2" });

    const before = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    await Promise.all(["concurrent-a", "concurrent-b"].map((targetSetId) => migrateAffectAssetsToLocalStore({
      sourceRoot: source, sourceSetId: "source", targetRoot: target, targetSetId, tagCollectionPath: tagPath, apply: true,
    })));
    const after = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    expect(after.activeSet).toBe(before.activeSet);
    expect(after.sets.target).toEqual(before.sets.target);
    expect(Object.keys(after.sets).sort()).toEqual(["concurrent-a", "concurrent-b", "target"]);
  });
});
