import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { importAssets } from "./importer.js";
import { SEMANTIC_ASSET_TAGS_SCHEMA_VERSION } from "./semantic-assets/contracts.js";
import { ServiceDatabaseSemanticAssetRepository } from "./semantic-assets/db-repository.js";
import { DeterministicSemanticAssetRouter } from "./semantic-assets/router.js";
import {
  AFFECT_DIMENSIONS,
  AFFECT_SPACE_VERSION,
  RESPONSE_AFFECT_SCHEMA_VERSION,
  VISUAL_AFFECT_SCHEMA_VERSION,
  type AffectDimensionsV2,
} from "../../shared/affect.js";

const roots: string[] = [];

function temporaryAssetRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hent-semantic-import-"));
  roots.push(root);
  mkdirSync(join(root, "sets", "semantic-set"), { recursive: true });
  writeFileSync(join(root, "sets", "semantic-set", "a-legacy.png"), "legacy");
  writeFileSync(join(root, "sets", "semantic-set", "b-library.png"), "library");
  writeFileSync(join(root, "sets", "semantic-set", "c-invalid.png"), "invalid");
  writeFileSync(join(root, "channel-overrides.json"), JSON.stringify({ channel: { enabled: true } }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("semantic asset importer", () => {
  it("imports a complete VisualAffectV2 set and routes across coarse buckets", () => {
    const root = temporaryAssetRoot();
    const visual = (overrides: Partial<AffectDimensionsV2>) => ({
      schemaVersion: VISUAL_AFFECT_SCHEMA_VERSION,
      affectSpaceVersion: AFFECT_SPACE_VERSION,
      dimensions: Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, overrides[key] ?? 0.1])),
      confidence: 0.9,
      evidence: ["test pixel evidence"],
    });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      activeSet: "semantic-set",
      sets: {
        "semantic-set": {
          name: "Affect Set",
          emotions: { happy: ["b-library.png"], confused: ["a-legacy.png"], neutral: ["c-invalid.png"] },
          affectAssets: {
            "a-legacy.png": visual({ valence: 0.1, arousal: 0.9, anger: 0.95, irritation: 0.85 }),
            "b-library.png": visual({ valence: 0.9, arousal: 0.7, joy: 0.95, warmth: 0.8 }),
            "c-invalid.png": visual({ valence: 0.5, arousal: 0.2 }),
          },
        },
      },
    }));

    const db = new ServiceDatabase();
    expect(importAssets({ db, assetRoot: root }).warnings).toEqual([]);
    const queryDimensions = Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, key === "anger" ? 0.95 : key === "irritation" ? 0.85 : key === "arousal" ? 0.9 : 0.1])) as AffectDimensionsV2;
    const selection = new DeterministicSemanticAssetRouter(new ServiceDatabaseSemanticAssetRepository(db), () => 0)
      .route({
        channelId: "channel",
        emotion: "happy",
        text: "legacy text is irrelevant in V2",
        affect: {
          schemaVersion: RESPONSE_AFFECT_SCHEMA_VERSION,
          affectSpaceVersion: AFFECT_SPACE_VERSION,
          dimensions: queryDimensions,
          confidence: 0.9,
        },
      });
    expect(selection).toMatchObject({ mode: "affect-v2", media: { filename: "a-legacy.png" } });
    expect(JSON.parse(String((db.db.prepare("SELECT semantic_vector_json FROM assets WHERE filename = 'a-legacy.png'").get() as { semantic_vector_json: string }).semantic_vector_json))).toHaveLength(24);
    db.close();
  });

  it("persists validated tags and derived vectors while preserving legacy and malformed assets", () => {
    const root = temporaryAssetRoot();
    const libraryTags = {
      schemaVersion: SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
      emotion: "happy",
      gesture: "double thumbs up",
      expression: "bright smile",
      background: "moonlit library",
      clothing: "gothic velvet dress",
      composition: "waist-up portrait",
      lighting: "soft magenta rim light",
      mood: "joyful celebration",
    };
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      activeSet: "semantic-set",
      sets: {
        "semantic-set": {
          name: "Semantic Set",
          emotions: { happy: ["a-legacy.png", "b-library.png", "c-invalid.png"] },
          semanticAssets: {
            "b-library.png": { tags: libraryTags },
            "c-invalid.png": { tags: { ...libraryTags, emotion: "sorry" } },
          },
        },
      },
    }));

    const db = new ServiceDatabase();
    const report = importAssets({ db, assetRoot: root });
    expect(report.counts.assets).toBe(3);
    expect(report.warnings).toEqual(["Invalid semantic metadata: semantic-set/happy/c-invalid.png"]);

    const rows = db.db.prepare("SELECT filename, semantic_tags_json, semantic_vector_json FROM assets ORDER BY filename").all() as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ filename: "a-legacy.png", semantic_tags_json: null, semantic_vector_json: null });
    expect(JSON.parse(String(rows[1]!.semantic_tags_json))).toEqual(libraryTags);
    expect(JSON.parse(String(rows[1]!.semantic_vector_json))).toHaveLength(256);
    expect(rows[2]).toMatchObject({ filename: "c-invalid.png", semantic_tags_json: null, semantic_vector_json: null });

    const router = new DeterministicSemanticAssetRouter(new ServiceDatabaseSemanticAssetRepository(db));
    expect(router.route({ channelId: "channel", emotion: "happy", text: "bright smile in a moonlit library" }))
      .toMatchObject({ mode: "legacy-fallback", media: { filename: "a-legacy.png" } });
    expect(db.db.prepare("PRAGMA table_info(assets)").all().map((row) => (row as { name: string }).name))
      .toEqual(expect.arrayContaining(["semantic_tags_json", "semantic_vector_json"]));
    db.close();
  });

  it("keeps legacy manifests importable with filename-first routing", () => {
    const root = temporaryAssetRoot();
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      activeSet: "semantic-set",
      sets: { "semantic-set": { name: "Legacy Set", emotions: { happy: ["c-invalid.png", "a-legacy.png"] } } },
    }));
    const db = new ServiceDatabase();
    expect(importAssets({ db, assetRoot: root }).warnings).toEqual([]);
    const selection = new DeterministicSemanticAssetRouter(new ServiceDatabaseSemanticAssetRepository(db))
      .route({ channelId: "channel", emotion: "happy", text: "anything" });
    expect(selection).toMatchObject({ mode: "legacy-fallback", media: { filename: "a-legacy.png" } });
    db.close();
  });
});
