import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AFFECT_DIMENSIONS, affectVectorFromDimensions, parseVisualAffectV2 } from "../../shared/affect.js";
import { ServiceDatabase } from "./db.js";
import { registerNativeAsset } from "./native-assets.js";
import { createHentAiServer, listen } from "./server.js";
import { ServiceDatabaseSemanticAssetRepository } from "./semantic-assets/db-repository.js";
import { DeterministicSemanticAssetRouter } from "./semantic-assets/router.js";
import { sha256Bytes } from "./storage.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const visualAffect = {
  schemaVersion: "VisualAffectV2",
  affectSpaceVersion: "AffectSpaceV2",
  dimensions: Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, 0.8])),
  confidence: 0.9,
  evidence: ["visible smile"],
};
const request = { channelId: "channel", emotion: "happy", contentType: "image/png", dataBase64: png, visualAffect, prompt: "native portrait" };

describe("native asset registration", () => {
  let db: ServiceDatabase;
  let root: string;
  beforeEach(() => {
    db = new ServiceDatabase();
    root = mkdtempSync(join(tmpdir(), "hent-native-test-"));
    db.upsertAssetSet({ id: "mapped", name: "Mapped" });
    db.setChannelMapping("channel", { assetSetId: "mapped", enabled: true });
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists bytes and computed tags that immediately rank in affect-v2", () => {
    const tags = parseVisualAffectV2(visualAffect);
    if (!tags) throw new Error("Invalid fixture");
    const baseline = { ...tags, dimensions: { ...tags.dimensions, joy: 0 } };
    const storageObjectId = db.upsertStorageObject({ storageKey: "old.png", objectUrl: "/static/old.png", contentHash: "old", contentType: "image/png", sizeBytes: 1, provenance: "imported" });
    db.upsertAsset({ id: "old", assetSetId: "mapped", emotion: "happy", filename: "old.png", storageObjectId, contentHash: "old", semanticTags: baseline, semanticVector: affectVectorFromDimensions(baseline.dimensions) });
    const router = new DeterministicSemanticAssetRouter(new ServiceDatabaseSemanticAssetRepository(db));
    const query = { channelId: "channel", text: "hello", affect: { ...tags, schemaVersion: "ResponseAffectV2" as const } };
    expect(router.route(query)?.media.filename).toBe("old.png");

    const result = registerNativeAsset(db, root, { ...request, semanticVector: [999] });

    expect(result.status).toBe(201);
    expect(result.body.asset.id).toBe(`native_${sha256Bytes(Buffer.from(png, "base64")).slice(0, 12)}`);
    expect(readFileSync(join(root, result.body.media.url.slice("/static/".length)))).toEqual(Buffer.from(png, "base64"));
    expect(router.route(query)).toMatchObject({ mode: "affect-v2", distance: 0, media: { filename: result.body.asset.filename } });
    expect(db.listAssetsForSet("mapped").find((asset) => asset.id === result.body.asset.id)).toMatchObject({ semanticTags: tags, semanticVector: affectVectorFromDimensions(tags.dimensions) });
    const stored = db.db.prepare("SELECT provenance, metadata_json FROM storage_objects WHERE provenance = 'native'").get();
    expect(stored).toEqual({ provenance: "native", metadata_json: JSON.stringify({ source: "hent-brain-native", prompt: request.prompt }) });
  });

  it("returns the original asset without changing rows or bytes on duplicate content", () => {
    const first = registerNativeAsset(db, root, request);
    const rows = db.db.prepare("SELECT * FROM assets").all();
    const objects = db.db.prepare("SELECT * FROM storage_objects").all();
    const path = join(root, first.body.media.url.slice("/static/".length));

    const repeated = registerNativeAsset(db, root, { ...request, emotion: "neutral", prompt: "changed", visualAffect: { ...visualAffect, confidence: 0.1 } });

    expect(repeated).toEqual({ status: 200, body: first.body });
    expect(db.db.prepare("SELECT * FROM assets").all()).toEqual(rows);
    expect(db.db.prepare("SELECT * FROM storage_objects").all()).toEqual(objects);
    expect(readFileSync(path)).toEqual(Buffer.from(png, "base64"));
  });

  it.each([
    null, [], {}, { ...request, channelId: "" }, { ...request, channelId: 123 },
    { ...request, emotion: "angry" }, { ...request, prompt: 123 },
    { ...request, dataBase64: "" }, { ...request, dataBase64: "%%%" },
    { ...request, dataBase64: `${png}!` }, { ...request, dataBase64: "aGVsbG8=" },
    { ...request, contentType: "image/jpeg" }, { ...request, contentType: "image/gif" },
    { ...request, visualAffect: null },
    { ...request, visualAffect: { ...visualAffect, schemaVersion: "VisualAffectV1" } },
    { ...request, visualAffect: { ...visualAffect, dimensions: { joy: 1 } } },
    { ...request, visualAffect: { ...visualAffect, dimensions: { ...visualAffect.dimensions, joy: 2 } } },
    { ...request, visualAffect: { ...visualAffect, dimensions: { ...visualAffect.dimensions, extra: 0 } } },
    { ...request, visualAffect: { ...visualAffect, confidence: -1 } },
    { ...request, visualAffect: { ...visualAffect, evidence: [] } },
  ])("rejects malformed input without writing files or rows (%#)", (body) => {
    expect(() => registerNativeAsset(db, root, body)).toThrow(expect.objectContaining({ status: 400 }));
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM storage_objects").get()).toEqual({ count: 0 });
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(["unknown", "disabled", "unmapped", "dangling"])("rejects %s channels", (channelId) => {
    db.setChannelMapping("disabled", { assetSetId: "mapped", enabled: false });
    db.setChannelMapping("unmapped", {});
    db.setChannelMapping("dangling", { assetSetId: "missing" });
    expect(() => registerNativeAsset(db, root, { ...request, channelId })).toThrow(expect.objectContaining({ status: 404 }));
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([["image/jpeg", "ffd8ffe000104a4649460001", "jpg"], ["image/webp", "524946460400000057454250", "webp"]])("accepts matching %s magic", (contentType, hex, extension) => {
    const result = registerNativeAsset(db, root, { ...request, contentType, dataBase64: Buffer.from(hex, "hex").toString("base64") });
    expect(result.status).toBe(201);
    expect(result.body.asset.filename).toMatch(new RegExp(`\\.${extension}$`));
  });

  it("refuses cross-set duplicate hashes rather than moving existing assets", () => {
    const first = registerNativeAsset(db, root, request);
    db.upsertAssetSet({ id: "other", name: "Other" });
    db.setChannelMapping("other", { assetSetId: "other" });
    expect(() => registerNativeAsset(db, root, { ...request, channelId: "other" })).toThrow(expect.objectContaining({ status: 409 }));
    expect(db.listAssetsForSet("mapped")[0]?.id).toBe(first.body.asset.id);
    expect(db.listAssetsForSet("other")).toEqual([]);
  });

  it("never overwrites an existing file even without a database row", () => {
    const hash = sha256Bytes(Buffer.from(png, "base64")).slice(0, 12);
    const path = join(root, `native/mapped/happy/${hash}.png`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "existing");
    expect(() => registerNativeAsset(db, root, request)).toThrow(expect.objectContaining({ status: 409 }));
    expect(readFileSync(path, "utf8")).toBe("existing");
    expect(db.listAssetsForSet("mapped")).toEqual([]);
  });

  it("rolls back storage and removes new bytes when asset insertion fails", () => {
    db.db.exec("CREATE TRIGGER reject_native BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    expect(() => registerNativeAsset(db, root, request)).toThrow("fixture failure");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM storage_objects").get()).toEqual({ count: 0 });
    expect(readdirSync(join(root, "native/mapped/happy"))).toEqual([]);
  });

  it("authenticates registration and serves the resulting static media", async () => {
    const server = await listen(createHentAiServer({ db, token: "test-token", assetRoot: root }));
    try {
      const unauthenticated = await fetch(`${server.url}/v1/assets`, { method: "POST" });
      expect(unauthenticated.status).toBe(401);
      const response = await fetch(`${server.url}/v1/assets`, { method: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(request) });
      expect(response.status).toBe(201);
      const body = await response.json();
      const media = await fetch(`${server.url}${body.media.url}`);
      expect(media.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await media.arrayBuffer())).toEqual(Buffer.from(png, "base64"));
      const invalid = await fetch(`${server.url}/v1/assets`, { method: "POST", headers: { authorization: "Bearer test-token" }, body: "{}" });
      expect(invalid.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
