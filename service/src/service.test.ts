import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ServiceDatabase, SCHEMA_VERSION } from "./db.js";
import { initializeServiceSchema } from "./db-schema.js";
import { importAssets } from "./importer.js";
import { loadServiceConfig, redactBearerToken } from "./server.js";
import { SEMANTIC_ASSET_TAGS_SCHEMA_VERSION, type SemanticAssetTagsV1 } from "./semantic-assets/contracts.js";
import { semanticVectorForTags } from "./semantic-assets/vector.js";
import { request, responseAffect, tempDir, token, withServer, writeFixtureAssets } from "./service-test-helpers.js";

/** The generation queue table as schema 6 and earlier created it. */
const LEGACY_GENERATION_JOBS_DDL = `CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  request_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

describe("service auth, health, and config", () => {
  it("returns health without auth and protects v1 APIs with bearer auth", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, service: "@hent-ai/service" });

      const unauthorized = await fetch(`${baseUrl}/v1/profiles`);
      expect(unauthorized.status).toBe(401);

      const profiles = await request(baseUrl, "/v1/profiles");
      expect(profiles.status).toBe(200);
      expect(await profiles.json()).toEqual({ profiles: [] });
    });
  });

  it("validates service URL/token config and redacts tokens", () => {
    expect(loadServiceConfig({ HENT_AI_SERVICE_URL: "http://example.com", HENT_AI_SERVICE_TOKEN: "secret" }).disabled).toBe(true);
    expect(loadServiceConfig({ HENT_AI_SERVICE_URL: "http://127.0.0.1:8787", HENT_AI_SERVICE_TOKEN: "secret" }).disabled).toBe(false);
    expect(loadServiceConfig({ HENT_AI_SERVICE_URL: "https://example.com" }).diagnostics).toContain("Missing HENT_AI_SERVICE_TOKEN");
    expect(redactBearerToken("abcdefghijkl")).toBe("abcd…ijkl");
  });
});

describe("profiles and channels", () => {
  it("creates, lists, gets, updates profiles and gets/sets channel mappings", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const created = await request(baseUrl, "/v1/profiles", { method: "POST", body: JSON.stringify({ id: "gothic-v1", name: "Gothic", model: "m1" }) });
      expect(created.status).toBe(201);
      expect((await created.json()).profile).toMatchObject({ id: "gothic-v1", name: "Gothic" });

      const updated = await request(baseUrl, "/v1/profiles/gothic-v1", { method: "PATCH", body: JSON.stringify({ name: "Gothic 2", soulSnippet: "soul" }) });
      expect(updated.status).toBe(200);
      expect((await updated.json()).profile).toMatchObject({ name: "Gothic 2", soulSnippet: "soul" });

      const list = await request(baseUrl, "/v1/profiles");
      expect((await list.json()).profiles).toHaveLength(1);

      const setMapping = await request(baseUrl, "/v1/channels/c1/mapping", { method: "PUT", body: JSON.stringify({ profileId: "gothic-v1", mode: "date", enabled: true, cronEnabled: true, assetSetId: "gothic-v1" }) });
      expect(setMapping.status).toBe(200);
      expect((await setMapping.json()).mapping).toMatchObject({ channelId: "c1", profileId: "gothic-v1", enabled: true, cronEnabled: true, assetSetId: "gothic-v1" });

      const mapping = await request(baseUrl, "/v1/channels/c1/mapping");
      expect((await mapping.json()).mapping).toMatchObject({ mode: "date", cronEnabled: true });

      const cronEnabled = await request(baseUrl, "/v1/channels/cron-enabled");
      expect(cronEnabled.status).toBe(200);
      expect(await cronEnabled.json()).toMatchObject({ revision: expect.any(String), channels: [{ channelId: "c1", profileId: "gothic-v1", assetSetId: "gothic-v1", updatedAt: expect.any(String) }] });
    });
  });

  it("lists channel settings read-only behind bearer auth", async () => {
    const db = new ServiceDatabase();
    db.setChannelMapping("c2", { mode: "normal", enabled: false, settings: { ambientBudgetPerHour: 3 } });
    db.setChannelMapping("c1", { enabled: true, cronEnabled: true, assetSetId: "set" });
    await withServer(db, async (baseUrl) => {
      expect((await fetch(`${baseUrl}/v1/channels`)).status).toBe(401);

      const listed = await request(baseUrl, "/v1/channels");
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ channels: [
        { channelId: "c1", profileId: null, mode: null, enabled: true, cronEnabled: true, assetSetId: "set", settings: {}, updatedAt: expect.any(String) },
        { channelId: "c2", profileId: null, mode: "normal", enabled: false, cronEnabled: null, assetSetId: null, settings: { ambientBudgetPerHour: 3 }, updatedAt: expect.any(String) },
      ] });

      expect((await request(baseUrl, "/v1/channels", { method: "POST", body: "{}" })).status).toBe(404);
    });
  });
});

describe("schema and importer", () => {
  it("creates every first-release schema table", () => {
    const db = new ServiceDatabase();
    expect(db.tableNames()).toEqual(expect.arrayContaining([
      "profiles",
      "channel_mappings",
      "channel_settings",
      "asset_sets",
      "assets",
      "emotion_mappings",
      "storage_objects",
      "verifier_cache",
      "rate_limits",
      "schema_migrations",
      "import_runs",
    ]));
    expect(db.tableNames()).not.toContain("generation_jobs");
    db.close();
  });

  it("drops an empty legacy generation_jobs table and refuses to drop one that still has rows", () => {
    const empty = new Database(":memory:");
    empty.exec(LEGACY_GENERATION_JOBS_DDL);
    initializeServiceSchema(empty, new Date().toISOString());
    expect(empty.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generation_jobs'").all()).toEqual([]);
    expect(empty.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: SCHEMA_VERSION });
    empty.close();

    const populated = new Database(":memory:");
    populated.exec(LEGACY_GENERATION_JOBS_DDL);
    populated.prepare("INSERT INTO generation_jobs (id, status, request_json, created_at, updated_at) VALUES ('job_1', 'queued', '{}', ?, ?)")
      .run("2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    expect(() => initializeServiceSchema(populated, new Date().toISOString()))
      .toThrow(/Refusing to drop generation_jobs: 1 row\(s\) present/);
    expect(populated.prepare("SELECT COUNT(*) AS count FROM generation_jobs").get()).toEqual({ count: 1 });
    populated.close();
  });

  it("dry-runs without mutation and real imports are idempotent with storage metadata", () => {
    const root = tempDir();
    writeFixtureAssets(root);
    const db = new ServiceDatabase();

    const dryRun = importAssets({ db, assetRoot: root, dryRun: true });
    expect(dryRun).toMatchObject({ dryRun: true, mutations: false, counts: { assetSets: 1, assets: 1, storageObjects: 1, profiles: 1, channelMappings: 1 } });
    expect(db.listProfiles()).toEqual([]);

    const first = importAssets({ db, assetRoot: root });
    const second = importAssets({ db, assetRoot: root });
    expect(second.checksum).toBe(first.checksum);
    expect(db.listProfiles()).toHaveLength(1);
    expect(db.getChannelMapping("c1")).toMatchObject({ profileId: "gothic-v1", assetSetId: "gothic-v1" });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT storage_key, object_url, content_hash, content_type, size_bytes, provenance FROM storage_objects").get()).toMatchObject({
      storage_key: "sets/gothic-v1/neutral.png",
      object_url: "/static/sets/gothic-v1/neutral.png",
      content_type: "image/png",
      size_bytes: 8,
      provenance: "imported",
    });
    db.close();
  });

  it("selects channel media by requested emotion through the service database helper", () => {
    const db = new ServiceDatabase();
    db.upsertAssetSet({ id: "set", name: "Set" });
    const neutralObjectId = db.upsertStorageObject({
      storageKey: "sets/set/neutral.png",
      objectUrl: "/static/sets/set/neutral.png",
      contentHash: "neutral-hash",
      contentType: "image/png",
      sizeBytes: 1,
      provenance: "test",
    });
    const happyObjectId = db.upsertStorageObject({
      storageKey: "sets/set/happy.png",
      objectUrl: "/static/sets/set/happy.png",
      contentHash: "happy-hash",
      contentType: "image/png",
      sizeBytes: 1,
      provenance: "test",
    });
    db.upsertAsset({ id: "asset-neutral", assetSetId: "set", emotion: "neutral", filename: "neutral.png", storageObjectId: neutralObjectId, contentHash: "neutral-hash" });
    db.upsertAsset({ id: "asset-happy", assetSetId: "set", emotion: "happy", filename: "happy.png", storageObjectId: happyObjectId, contentHash: "happy-hash" });
    db.setChannelMapping("c1", { enabled: true, assetSetId: "set" });

    expect(db.firstAssetForChannelEmotion("c1", "happy")).toEqual({
      filename: "happy.png",
      contentType: "image/png",
      objectUrl: "/static/sets/set/happy.png",
      storageKey: "sets/set/happy.png",
    });
    expect(db.firstAssetForChannelEmotion("c1", "sorry")).toBeNull();
    db.close();
  });

  it("imports profile directories and legacy SQLite state in dry-run and apply reports", () => {
    const root = tempDir();
    mkdirSync(join(root, "profiles", "private"), { recursive: true });
    writeFileSync(join(root, "profiles", "private", "happy.png"), Buffer.from("private"));

    const legacy = new Database(join(root, "hentai.db"));
    legacy.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, character TEXT, soul_snippet TEXT, model TEXT);
      CREATE TABLE channel_profiles (channel_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL);
      CREATE TABLE channel_settings (channel_id TEXT PRIMARY KEY, enabled INTEGER, asset_set_id TEXT);
    `);
    legacy.prepare("INSERT INTO profiles (id, name, character, soul_snippet, model) VALUES (?, ?, ?, ?, ?)").run("private", "Private", "private character", "private soul", "legacy-model");
    legacy.prepare("INSERT INTO channel_profiles (channel_id, profile_id) VALUES (?, ?)").run("legacy-channel", "private");
    legacy.prepare("INSERT INTO channel_settings (channel_id, enabled, asset_set_id) VALUES (?, ?, ?)").run("legacy-channel", 1, "private");
    legacy.close();

    const db = new ServiceDatabase();
    const dryRun = importAssets({ db, assetRoot: root, dryRun: true });
    expect(dryRun).toMatchObject({ dryRun: true, mutations: false, counts: { assetSets: 1, assets: 1, storageObjects: 1, profiles: 1, channelMappings: 1 } });
    expect(db.listProfiles()).toEqual([]);

    const first = importAssets({ db, assetRoot: root });
    const second = importAssets({ db, assetRoot: root });
    expect(second.checksum).toBe(first.checksum);
    expect(db.getProfile("private")).toMatchObject({ name: "Private", character: "private character", soulSnippet: "private soul", model: "legacy-model" });
    expect(db.getChannelMapping("legacy-channel")).toMatchObject({ profileId: "private", enabled: true, assetSetId: "private" });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT storage_key, object_url, provenance FROM storage_objects").get()).toMatchObject({
      storage_key: "profiles/private/happy.png",
      object_url: "/static/profiles/private/happy.png",
      provenance: "imported",
    });
    db.close();
  });
});

describe("runtime APIs", () => {
  it("exposes no generation queue routes", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const generate = await request(baseUrl, "/v1/assets/generate", { method: "POST", body: JSON.stringify({ prompt: "queue is gone" }) });
      expect(generate.status).toBe(404);
      expect(await generate.json()).toEqual({ error: "not_found" });

      const job = await request(baseUrl, "/v1/jobs/job_1");
      expect(job.status).toBe(404);
    });
  });

  it("returns null media/verdict when policy has no result", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const preReply = await request(baseUrl, "/v1/pre-reply/media", { method: "POST", body: JSON.stringify({ context: { channelId: "missing" }, userMessage: "hi", preReplyText: "hello" }) });
      expect(preReply.status).toBe(200);
      expect(await preReply.json()).toEqual({ media: null, diagnostics: [{ skipped: true, reason: "no_policy_result" }] });

      const finalVerdict = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify({ context: { channelId: "missing", content: "neutral reply", validEmotions: ["neutral"] } }) });
      expect(finalVerdict.status).toBe(200);
      expect(await finalVerdict.json()).toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "missing_response_affect" }] });
    });
  });

  it("returns null verdict for invalid final-response requests", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const missingValidEmotions = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify({ context: { channelId: "c1", content: "happy" } }) });
      expect(missingValidEmotions.status).toBe(200);
      expect(await missingValidEmotions.json()).toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "no_final_text_or_valid_emotions" }] });

      const invalidJson = await fetch(`${baseUrl}/v1/final-response/verdict`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{",
      });
      expect(invalidJson.status).toBe(400);
      expect(await invalidJson.json()).toMatchObject({ error: "bad_request", message: "Invalid JSON body" });
    });
  });

  it("returns imported media through runtime endpoints without generating images", async () => {
    const root = tempDir();
    writeFixtureAssets(root);
    const db = new ServiceDatabase();
    importAssets({ db, assetRoot: root });
    await withServer(db, async (baseUrl) => {
      const response = await request(baseUrl, "/v1/pre-reply/media", { method: "POST", body: JSON.stringify({ context: { channelId: "c1" } }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ media: { filename: "neutral.png", contentType: "image/png", url: "/static/sets/gothic-v1/neutral.png" } });

      const affect = responseAffect();
      const verdict = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify({ context: { channelId: "c1", content: "I feel neutral about this.", responseAffect: affect } }) });
      expect(verdict.status).toBe(200);
      expect(await verdict.json()).toMatchObject({ verdict: { affect, media: { filename: "neutral.png", contentType: "image/png", url: "/static/sets/gothic-v1/neutral.png" } } });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get()).toEqual({ count: 1 });
    }, { assetRoot: root });
  });

  it("keeps a set without complete affect tags on deterministic legacy fallback", async () => {
    const db = new ServiceDatabase();
    db.upsertAssetSet({ id: "semantic", name: "Semantic" });
    const candidates: Array<{ filename: string; tags: SemanticAssetTagsV1 }> = [
      {
        filename: "a-quiet.png",
        tags: {
          schemaVersion: SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
          emotion: "neutral",
          gesture: "hands resting",
          expression: "calm gaze",
          background: "quiet library",
          clothing: "velvet dress",
          composition: "still portrait",
          lighting: "moonlight",
          mood: "contemplative",
        },
      },
      {
        filename: "b-rooftop.png",
        tags: {
          schemaVersion: SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
          emotion: "neutral",
          gesture: "waving",
          expression: "bright smile",
          background: "rooftop",
          clothing: "leather jacket",
          composition: "dynamic portrait",
          lighting: "daylight",
          mood: "celebratory",
        },
      },
    ];
    for (const candidate of candidates) {
      const storageKey = `sets/semantic/${candidate.filename}`;
      const storageObjectId = db.upsertStorageObject({
        storageKey,
        objectUrl: `/static/${storageKey}`,
        contentHash: `${candidate.filename}-hash`,
        contentType: "image/png",
        sizeBytes: 1,
        provenance: "test",
      });
      db.upsertAsset({
        id: candidate.filename,
        assetSetId: "semantic",
        emotion: "neutral",
        filename: candidate.filename,
        storageObjectId,
        contentHash: `${candidate.filename}-hash`,
        semanticTags: candidate.tags,
        semanticVector: semanticVectorForTags(candidate.tags),
      });
    }
    db.setChannelMapping("semantic-channel", { enabled: true, assetSetId: "semantic" });

    await withServer(db, async (baseUrl) => {
      const response = await request(baseUrl, "/v1/final-response/verdict", {
        method: "POST",
        body: JSON.stringify({ context: { channelId: "semantic-channel", content: "Waving with a bright smile on the rooftop in a leather jacket, dynamic daylight and celebratory.", responseAffect: responseAffect({ joy: 0.9 }) } }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ verdict: { media: { filename: "a-quiet.png" } } });
    });
  });

  it("serves only DB-registered static image objects from the asset root", async () => {
    const root = tempDir();
    writeFixtureAssets(root);
    writeFileSync(join(root, "hentai.db"), Buffer.from("sqlite"));
    const db = new ServiceDatabase();
    importAssets({ db, assetRoot: root });
    writeFileSync(join(root, "manifest.json"), Buffer.from("{}"));

    await withServer(db, async (baseUrl) => {
      const image = await fetch(`${baseUrl}/static/sets/gothic-v1/neutral.png`);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/png");

      const manifest = await fetch(`${baseUrl}/static/manifest.json`);
      expect(manifest.status).toBe(404);
      const overrides = await fetch(`${baseUrl}/static/channel-overrides.json`);
      expect(overrides.status).toBe(404);
      const legacyDb = await fetch(`${baseUrl}/static/hentai.db`);
      expect(legacyDb.status).toBe(404);
    }, { assetRoot: root });
  });
});
