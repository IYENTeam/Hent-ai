import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as service from "./index.js";

const scope = { guildId: "100000000000000001", channelId: "100000000000000002" };
const botId = "100000000000000003";
const humanA = "100000000000000004";
const humanB = "100000000000000005";
const seedId = "100000000000000100";
const silenceId = "100000000000000111";
const failedProviderId = "100000000000000115";
const evidenceRoot = join(process.cwd(), "..", ".omo", "evidence", "adaptive-ambient-discord-participant");

type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void };
type WireState = {
  readonly providerBodies: unknown[];
  readonly discordRequests: string[];
  readonly sent: { readonly nonce: string; readonly content: string }[];
  provider500: boolean;
  sendAttempts: number;
  archiveRequests: number;
};

function deferred(): Deferred {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("wire server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function message(id: string, content: string, authorId: string, timestamp: string) {
  return { id, channel_id: scope.channelId, content, timestamp, author: { id: authorId, username: authorId === botId ? "ambient-bot" : "human", bot: authorId === botId } };
}

function writeWireEvidence(value: { readonly cleanup: Record<string, unknown>; readonly [key: string]: unknown }): void {
  const cleanupPath = join(evidenceRoot, "cleanup.json");
  const existing = existsSync(cleanupPath) ? JSON.parse(readFileSync(cleanupPath, "utf8")) as Record<string, unknown> : {};
  writeFileSync(join(evidenceRoot, "task-13-transcript.json"), `${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(cleanupPath, `${JSON.stringify({ ...existing, ...value.cleanup }, null, 2)}\n`);
}

describe("Discord ambient worker localhost wire QA", () => {
  it("ingests human loopback Discord message end to end", async () => {
    const root = mkdtempSync(join(tmpdir(), "hent-ambient-wire-"));
    const dbPath = join(root, "service.sqlite");
    let now = Date.parse("2026-07-25T12:00:00.000Z");
    const state: WireState = { providerBodies: [], discordRequests: [], sent: [], provider500: false, sendAttempts: 0, archiveRequests: 0 };
    const providerReceived = deferred();
    const archiveReceived = deferred();
    const typingReceived = deferred();
    let discord: Server | undefined;
    let provider: Server | undefined;
    let worker: service.DiscordAmbientWorker | undefined;
    let cleanup: Record<string, boolean> = { serversClosed: false, tempPathsRemoved: false, leaseReleased: false, qaMessages: true };

    try {
      const seedDb = new service.ServiceDatabase(dbPath);
      seedDb.createProfile({ id: "wire-profile", name: "Wire", soulSnippet: "Resist social silence naturally." });
      seedDb.setChannelMapping(scope.channelId, { profileId: "wire-profile", enabled: true });
      seedDb.close();

      const messages = [
        message(seedId, "existing baseline", humanA, new Date(now - 1_000).toISOString()),
        message(silenceId, "조용히 해", humanA, new Date(now).toISOString()),
      ];
      discord = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        state.discordRequests.push(`${request.method} ${url.pathname}${url.search}`);
        if (request.method === "GET" && url.pathname === "/users/@me") return json(response, 200, { id: botId, username: "ambient-bot", bot: true });
        if (request.method === "GET" && url.pathname === `/channels/${scope.channelId}`) return json(response, 200, { id: scope.channelId, guild_id: scope.guildId });
        if (request.method === "GET" && url.pathname === `/channels/${scope.channelId}/messages`) {
          const after = url.searchParams.get("after");
          return json(response, 200, after === null ? [messages[0]] : messages.filter((entry) => BigInt(entry.id) > BigInt(after)));
        }
        if (request.method === "GET" && url.pathname === `/guilds/${scope.guildId}/members`) {
          expect(url.searchParams.get("limit")).toBe("1000");
          return json(response, 200, [{ user: { id: humanA, bot: false } }, { user: { id: humanB, bot: false } }]);
        }
        if (request.method === "POST" && url.pathname === `/channels/${scope.channelId}/typing`) { typingReceived.resolve(); response.writeHead(204); return response.end(); }
        if (request.method === "POST" && url.pathname === `/channels/${scope.channelId}/messages`) {
          const input = await body(request) as { content: string; nonce: string; enforce_nonce: boolean };
          expect(input.enforce_nonce).toBe(true);
          state.sent.push({ nonce: input.nonce, content: input.content });
          state.sendAttempts += 1;
          if (state.sendAttempts === 2) return json(response, 429, { retry_after: 0.001 });
          return json(response, 200, { ...message(`1000000000000002${state.sendAttempts}`, input.content, botId, new Date(now).toISOString()), nonce: input.nonce });
        }
        response.writeHead(404); response.end();
      });
      const discordUrl = await listen(discord);

      provider = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/chat/completions") { response.writeHead(404); return response.end(); }
        const input = await body(request) as { messages: { content: string }[] };
        state.providerBodies.push(input);
        const system = input.messages[0]?.content ?? "";
        if (system.includes("memory_compaction")) {
          state.archiveRequests += 1;
          archiveReceived.resolve();
          return json(response, 200, { choices: [{ message: { content: JSON.stringify({ schema: service.CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction, scopeId: `discord:${scope.guildId}:${scope.channelId}`, sourceMessageIds: ["archive-old-1"], summary: "retained archive summary", durableFacts: ["raw retained"], confidence: 0.9 }) } }] });
        }
        providerReceived.resolve();
        if (state.provider500) { state.provider500 = false; response.writeHead(500); return response.end(); }
        return json(response, 200, { choices: [{ message: { content: JSON.stringify({ schema: service.ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal, decision: "speak", desiredDrive: 1, confidence: 1, chunks: ["아니야.", "내가 정할게."], relationshipProposals: [{ userId: humanA, rapportDelta: 0.1, familiarityDelta: 0.1, notes: ["Asked for silence."] }] }) } }] });
      });
      const providerUrl = await listen(provider);

      const timers = new Set<() => void>();
      const archiveTimers: (() => void)[] = [];
      worker = await service.startDiscordAmbientWorker({
        HENT_AI_DISCORD_PARTICIPANT_ENABLED: "true", HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST: `${scope.guildId}:${scope.channelId}`,
        HENT_AI_SERVICE_DB_PATH: dbPath, HENT_AI_DISCORD_BOT_TOKEN: "redacted-bot-token", HENT_AI_CONVERSATION_PROVIDER_ENDPOINT: "https://provider.invalid/chat/completions",
        HENT_AI_CONVERSATION_PROVIDER_TOKEN: "redacted-provider-token", HENT_AI_CONVERSATION_PROVIDER_MODEL: "wire-model",
      }, {
        createClient: (token) => service.createDiscordParticipantClient({ token, apiBaseUrl: discordUrl }),
        createProviderClient: () => service.createOpenAiConversationProviderClient({ endpoint: `${providerUrl}/chat/completions`, token: "redacted-provider-token", model: "wire-model", timeoutMs: 1_000 }),
        createDelivery: (options) => service.createDiscordAmbientDelivery({ ...options, delay: async () => undefined }),
        createScheduler: (options) => service.createConversationArchiveScheduler({ ...options, timer: { setInterval: (callback) => { archiveTimers.push(callback); return callback; }, clearInterval: () => undefined } }),
        timer: { setInterval: (callback) => { timers.add(callback); return callback; }, clearInterval: (handle) => timers.delete(handle as () => void) },
        clock: () => now, holderId: "wire-worker",
      });
      expect(worker.status).toBe("running");
      await expect(worker.runOnce()).resolves.toBeUndefined();
      expect(state.providerBodies).toHaveLength(0); // The first Discord cursor pass seeds without an appraisal or send.
      expect(state.sent).toEqual([]);

      const archiveDb = new service.ServiceDatabase(dbPath);
      new service.ConversationStore(archiveDb).recordRawEvent({
        scopeId: `discord:${scope.guildId}:${scope.channelId}`, channelId: scope.channelId, messageId: "archive-old-1", authorRole: "user", authorSource: "discord-participant",
        text: "old raw transcript stays retained", eventTs: "2026-07-01T00:00:00.000Z", observedAt: "2026-07-01T00:00:00.000Z",
      });
      archiveDb.close();
      archiveTimers[0]!();
      await archiveReceived.promise;

      const providerWait = providerReceived.promise;
      await expect(worker.runOnce()).resolves.toBeUndefined();
      await providerWait;
      await typingReceived.promise;
      expect(state.sent).toHaveLength(2);
      const firstNonce = state.sent[0]!.nonce;
      const retryNonce = state.sent[1]!.nonce;
      expect(state.sent.map((entry) => entry.content)).toEqual(["아니야.", "내가 정할게."]);

      // A no-ingress cycle must drain the durable retryable plan before evaluating new work.
      await expect(worker.runOnce()).resolves.toBeUndefined();
      expect(state.sent.filter((entry) => entry.nonce === firstNonce)).toHaveLength(1);
      expect(state.sent.filter((entry) => entry.nonce === retryNonce)).toHaveLength(2);

      const liveDb = new service.ServiceDatabase(dbPath);
      const plan = liveDb.db.prepare("SELECT status FROM participant_delivery_plans").get();
      expect(plan).toEqual({ status: "delivered" });
      expect(liveDb.db.prepare("SELECT COUNT(*) AS count FROM participant_delivery_receipts").get()).toEqual({ count: 2 });
      expect(liveDb.db.prepare("SELECT drive,version FROM adaptive_ambient_state").get()).toEqual({ drive: 0.625, version: 1 });
      expect(liveDb.db.prepare("SELECT COUNT(*) AS count FROM conversation_raw_events WHERE message_id='archive-old-1' AND archived_at_ms IS NOT NULL").get()).toEqual({ count: 1 });
      expect(liveDb.db.prepare("SELECT COUNT(*) AS count FROM conversation_archive_summaries").get()).toEqual({ count: 1 });
      liveDb.close();

      messages.push(message(failedProviderId, "provider failure should be retried", humanB, new Date(now + 1).toISOString()));
      state.provider500 = true;
      await expect(worker.runOnce()).resolves.toBeUndefined();
      const unavailableDb = new service.ServiceDatabase(dbPath);
      expect(unavailableDb.db.prepare("SELECT COUNT(*) AS count FROM adaptive_ambient_audits WHERE event_id=?").get(failedProviderId)).toEqual({ count: 0 });
      expect(unavailableDb.db.prepare("SELECT status FROM participant_event_work WHERE event_id=?").get(failedProviderId)).toEqual({ status: "claimed" });
      expect(unavailableDb.db.prepare("SELECT COUNT(*) AS count FROM participant_delivery_plans").get()).toEqual({ count: 1 });
      unavailableDb.close();

      for (const step of [10_000, 10_000, 10_001]) {
        now += step;
        for (const tick of [...timers]) tick();
        await expect(worker.runOnce()).resolves.toBeUndefined();
      }
      const retriedDb = new service.ServiceDatabase(dbPath);
      expect(retriedDb.db.prepare("SELECT COUNT(*) AS count FROM adaptive_ambient_audits WHERE event_id=?").get(failedProviderId)).toEqual({ count: 1 });
      retriedDb.close();

      const appraisalRequest = state.providerBodies.find((value) => (value as { messages?: { content?: string }[] }).messages?.[0]?.content?.includes("social input")) as { messages: { content: string }[] } | undefined;
      expect(appraisalRequest?.messages[0]?.content).toContain("silence is social input");
      expect(appraisalRequest?.messages[1]?.content).toContain("조용히 해");
      expect(state.archiveRequests).toBe(1);
    } finally {
      if (worker) await worker.stop();
      if (discord) await close(discord);
      if (provider) await close(provider);
      cleanup = { serversClosed: discord?.listening === false && provider?.listening === false, tempPathsRemoved: false, leaseReleased: false, qaMessages: true };
      if (existsSync(dbPath)) {
        const cleanupDb = new service.ServiceDatabase(dbPath);
        cleanup.leaseReleased = (cleanupDb.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases").get() as { count: number }).count === 0;
        cleanupDb.close();
      }
      rmSync(root, { recursive: true, force: true });
      cleanup.tempPathsRemoved = !existsSync(root);
      writeWireEvidence({
        task: 13,
        transport: "localhost node:http only",
        assertions: ["seed cursor skipped", "human ingress", "fresh complete two-human roster", "silence-resistant provider", "two nonce chunks", "429 durable retry", "provider 500 retried without burning the event", "raw archive retained"],
        requestCounts: { discord: state.discordRequests.length, provider: state.providerBodies.length, sends: state.sent.length },
        cleanup: { ...cleanup, qaMessages: "not-created" },
      });
    }
  });

  it("accumulates silence pressure over a fake clock without suppressing an explicit mention", async () => {
    const root = mkdtempSync(join(tmpdir(), "hent-ambient-pressure-wire-"));
    const dbPath = join(root, "service.sqlite");
    let now = Date.parse("2026-07-25T12:00:00.000Z");
    const sent: { readonly content: string; readonly nonce: string }[] = [];
    const messages = [message(seedId, "existing baseline", humanA, new Date(now - 1_000).toISOString())] as Array<ReturnType<typeof message> & { mentions?: unknown }>;
    let discord: Server | undefined;
    let provider: Server | undefined;
    let worker: service.DiscordAmbientWorker | undefined;

    try {
      const seedDb = new service.ServiceDatabase(dbPath);
      seedDb.createProfile({ id: "pressure-wire-profile", name: "Pressure Wire", soulSnippet: "Treat repeated silence requests as social pressure." });
      seedDb.setChannelMapping(scope.channelId, { profileId: "pressure-wire-profile", enabled: true });
      seedDb.close();

      discord = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method === "GET" && url.pathname === "/users/@me") return json(response, 200, { id: botId, username: "ambient-bot", bot: true });
        if (request.method === "GET" && url.pathname === `/channels/${scope.channelId}`) return json(response, 200, { id: scope.channelId, guild_id: scope.guildId });
        if (request.method === "GET" && url.pathname === `/channels/${scope.channelId}/messages`) {
          const after = url.searchParams.get("after");
          return json(response, 200, after === null ? [messages[0]] : messages.filter((entry) => BigInt(entry.id) > BigInt(after)));
        }
        if (request.method === "GET" && url.pathname === `/guilds/${scope.guildId}/members`) {
          return json(response, 200, [{ user: { id: humanA, bot: false } }, { user: { id: humanB, bot: false } }]);
        }
        if (request.method === "POST" && url.pathname === `/channels/${scope.channelId}/typing`) { response.writeHead(204); return response.end(); }
        if (request.method === "POST" && url.pathname === `/channels/${scope.channelId}/messages`) {
          const input = await body(request) as { content: string; nonce: string; enforce_nonce: boolean };
          expect(input.enforce_nonce).toBe(true);
          sent.push({ content: input.content, nonce: input.nonce });
          return json(response, 200, { ...message(`10000000000000030${sent.length}`, input.content, botId, new Date(now).toISOString()), nonce: input.nonce });
        }
        response.writeHead(404); response.end();
      });
      const discordUrl = await listen(discord);

      provider = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/chat/completions") { response.writeHead(404); return response.end(); }
        const input = await body(request) as { messages: { content: string }[] };
        const transcript = JSON.parse(input.messages[1]?.content ?? "{}") as { transcript?: { content?: string }[] };
        const content = transcript.transcript?.at(-1)?.content;
        const appraisal = content === "조용히 해"
          ? { schema: service.ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal, decision: "observe", desiredDrive: 1, confidence: 1, chunks: [], relationshipProposals: [], silenceRequest: { present: true, intensity: "mild" } }
          : { schema: service.ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal, decision: "speak", desiredDrive: 1, confidence: 1, chunks: [content?.includes(botId) ? "mention reply" : "ambient reply"], relationshipProposals: [] };
        return json(response, 200, { choices: [{ message: { content: JSON.stringify(appraisal) } }] });
      });
      const providerUrl = await listen(provider);

      const timers = new Set<() => void>();
      const archiveTimers: (() => void)[] = [];
      const advanceClock = (milliseconds: number): void => {
        for (let elapsed = 0; elapsed < milliseconds; elapsed += 10_000) {
          now += Math.min(10_000, milliseconds - elapsed);
          for (const timer of timers) timer();
        }
      };
      worker = await service.startDiscordAmbientWorker({
        HENT_AI_DISCORD_PARTICIPANT_ENABLED: "true", HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST: `${scope.guildId}:${scope.channelId}`,
        HENT_AI_SERVICE_DB_PATH: dbPath, HENT_AI_DISCORD_BOT_TOKEN: "redacted-bot-token", HENT_AI_CONVERSATION_PROVIDER_ENDPOINT: "https://provider.invalid/chat/completions",
        HENT_AI_CONVERSATION_PROVIDER_TOKEN: "redacted-provider-token", HENT_AI_CONVERSATION_PROVIDER_MODEL: "wire-model",
      }, {
        createClient: (token) => service.createDiscordParticipantClient({ token, apiBaseUrl: discordUrl }),
        createProviderClient: () => service.createOpenAiConversationProviderClient({ endpoint: `${providerUrl}/chat/completions`, token: "redacted-provider-token", model: "wire-model", timeoutMs: 1_000 }),
        createDelivery: (options) => service.createDiscordAmbientDelivery({ ...options, delay: async () => undefined }),
        createScheduler: (options) => service.createConversationArchiveScheduler({ ...options, timer: { setInterval: (callback) => { archiveTimers.push(callback); return callback; }, clearInterval: () => undefined } }),
        timer: { setInterval: (callback) => { timers.add(callback); return callback; }, clearInterval: (handle) => timers.delete(handle as () => void) },
        clock: () => now, holderId: "pressure-wire-worker",
      });
      await worker.runOnce(); // Seed only; the baseline message never reaches the provider.

      const addAndRun = async (id: string, content: string, authorId: string, mentions: unknown = undefined): Promise<void> => {
        advanceClock(60_000);
        messages.push({ ...message(id, content, authorId, new Date(now).toISOString()), ...(mentions === undefined ? {} : { mentions }) });
        await worker!.runOnce();
      };
      for (const id of ["100000000000000200", "100000000000000201", "100000000000000202", "100000000000000203", "100000000000000204"]) {
        await addAndRun(id, "조용히 해", humanA);
      }
      await addAndRun("100000000000000205", "ordinary ambient conversation", humanB);
      await addAndRun("100000000000000234", `<@${botId}> answer this`, humanB, [{ id: botId, username: "ambient-bot", bot: true }]);

      const liveDb = new service.ServiceDatabase(dbPath);
      const pressure = liveDb.db.prepare("SELECT pressure FROM adaptive_ambient_state WHERE guild_id=? AND channel_id=?").get(scope.guildId, scope.channelId) as { pressure: number };
      const ambientAudit = liveDb.db.prepare("SELECT outcome,probability FROM adaptive_ambient_audits WHERE event_id=?").get("100000000000000205") as { outcome: string; probability: number };
      const mentionAudit = liveDb.db.prepare("SELECT outcome,evidence_weight FROM adaptive_ambient_audits WHERE event_id=?").get("100000000000000234") as { outcome: string; evidence_weight: number };
      liveDb.close();

      expect(pressure.pressure).toBeGreaterThan(0.9);
      expect(ambientAudit).toMatchObject({ outcome: "observe" });
      expect(ambientAudit.probability).toBeLessThan(0.1);
      expect(mentionAudit).toEqual({ outcome: "planned", evidence_weight: 1 });
      expect(sent.map((entry) => entry.content)).toEqual(["mention reply"]);
    } finally {
      if (worker) await worker.stop();
      if (discord) await close(discord);
      if (provider) await close(provider);
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);
    }
  });
});
