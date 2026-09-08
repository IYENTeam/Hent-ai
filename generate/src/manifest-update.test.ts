import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createEmptyManifest, loadManifest, saveManifest } from "./asset-manifest.js";
import { updateManifestFile } from "./manifest-update.js";

it("rejects a stale CLI save after another manifest writer has committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "hent-manifest-edit-"));
  try {
    await saveManifest(root, createEmptyManifest());
    const stale = (await loadManifest(root))!;
    await updateManifestFile(join(root, "manifest.json"), () => ({ ...createEmptyManifest(), sets: { concurrent: { name: "preserve", createdAt: "today", emotions: {} } } }));
    const before = await readFile(join(root, "manifest.json"), "utf8");
    stale.activeSet = "other";
    await expect(saveManifest(root, stale)).rejects.toThrow("Manifest changed");
    expect(await readFile(join(root, "manifest.json"), "utf8")).toBe(before);
    const fresh = (await loadManifest(root))!;
    fresh.activeSet = "concurrent";
    await saveManifest(root, fresh);
    expect((await loadManifest(root))?.sets.concurrent.name).toBe("preserve");
  } finally { await rm(root, { recursive: true, force: true }); }
});
