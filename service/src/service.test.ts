import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { importAssets } from "./importer.js";
import { createHentAiServer, listen, loadServiceConfig, redactBearerToken } from "./server.js";
import type { FinalResponseVerifier } from "./verifier.js";
import { runNextGenerationJob } from "./generation-worker.js";

const token = "test-token";
const tempRoots: string[] = [];
const nullVerifier: FinalResponseVerifier = { verify: async () => null };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hent-service-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function withServer<T>(
  db: ServiceDatabase,
  fn: (baseUrl: string) => Promise<T>,
  assetRoot?: string,
  verifier: FinalResponseVerifier = nullVerifier,
): Promise<T> {
  const binding = await listen(createHentAiServer({ db, token, assetRoot, verifier }));
  try {
    return await fn(binding.url);
  } finally {
    await binding.close();
    db.close();
  }
}

async function request(baseUrl: string, path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

function writeFixtureAssets(root: string): void {
  mkdirSync(join(root, "sets", "gothic-v1"), { recursive: true });
  writeFileSync(join(root, "sets", "gothic-v1", "neutral.png"), Buffer.from("fake png"));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    activeSet: "gothic-v1",
    sets: {
      "gothic-v1": {
        name: "Dark Gothic Girl v1",
        character: "character",
        model: "test-model",
        emotions: { neutral: ["neutral.png"] },
      },
    },
  }));
  writeFileSync(join(root, "channel-overrides.json"), JSON.stringify({ c1: { enabled: true } }));
}

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

      const setMapping = await request(baseUrl, "/v1/channels/c1/mapping", { method: "PUT", body: JSON.stringify({ profileId: "gothic-v1", mode: "date", enabled: true, assetSetId: "gothic-v1" }) });
      expect(setMapping.status).toBe(200);
      expect((await setMapping.json()).mapping).toMatchObject({ channelId: "c1", profileId: "gothic-v1", enabled: true, assetSetId: "gothic-v1" });

      const mapping = await request(baseUrl, "/v1/channels/c1/mapping");
      expect((await mapping.json()).mapping).toMatchObject({ mode: "date" });
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
      "generation_jobs",
      "verifier_cache",
      "rate_limits",
      "schema_migrations",
      "import_runs",
    ]));
    db.close();
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

describe("runtime and job APIs", () => {
  it("returns null media/verdict when policy has no result", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const preReply = await request(baseUrl, "/v1/pre-reply/media", { method: "POST", body: JSON.stringify({ context: { channelId: "missing" }, userMessage: "hi", preReplyText: "hello" }) });
      expect(preReply.status).toBe(200);
      expect(await preReply.json()).toEqual({ media: null, diagnostics: [{ skipped: true, reason: "no_policy_result" }] });

      const finalVerdict = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify({ context: { channelId: "missing", content: "neutral reply", validEmotions: ["neutral"] } }) });
      expect(finalVerdict.status).toBe(200);
      expect(await finalVerdict.json()).toEqual({ verdict: null });
    });
  });

  it("returns null verdict for invalid final-response requests", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const missingValidEmotions = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify({ context: { channelId: "c1", content: "happy" } }) });
      expect(missingValidEmotions.status).toBe(200);
      expect(await missingValidEmotions.json()).toEqual({ verdict: null });

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

      const verdict = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify({ context: { channelId: "c1", content: "I feel neutral about this." } }) });
      expect(verdict.status).toBe(200);
      expect(await verdict.json()).toMatchObject({ verdict: { emotion: "neutral", confidence: 0.9, reason: "remote_test_verdict", media: { filename: "neutral.png", contentType: "image/png", url: "/static/sets/gothic-v1/neutral.png" } } });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get()).toEqual({ count: 1 });
    }, root, { verify: async () => ({ emotion: "neutral", confidence: 0.9, reason: "remote_test_verdict" }) });
  });

  it("persists async generation jobs and exposes runner-processed status", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const created = await request(baseUrl, "/v1/assets/generate", { method: "POST", body: JSON.stringify({ prompt: "no external generation" }) });
      expect(created.status).toBe(202);
      const { jobId } = await created.json() as { jobId: string };
      expect(jobId).toMatch(/^job_/);

      const processed = await runNextGenerationJob(db, { generate: async (request) => ({ provider: "mock", request }) });
      expect(processed).toMatchObject({ id: jobId, status: "succeeded", result: { provider: "mock", request: { prompt: "no external generation" } } });

      const status = await request(baseUrl, `/v1/jobs/${jobId}`);
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ jobId, id: jobId, status: "succeeded", result: { provider: "mock", request: { prompt: "no external generation" } } });
    });
  });
});
