import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as service from "./index.js";

const scope = { guildId: "1483095221460799489", channelId: "1498703634098294976" };
const evidenceRoot = fileURLToPath(new URL("../../.omo/evidence/adaptive-ambient-discord-participant/", import.meta.url));
const liveLog = join(evidenceRoot, "task-14.log");

type LiveConfig = { readonly token: string };
type Cleanup = { readonly serversClosed: boolean; readonly tempPathsRemoved: boolean; readonly leaseReleased: boolean; readonly qaMessages: string };

function liveConfig(env: NodeJS.ProcessEnv): LiveConfig | null {
  const token = env.HENT_AI_DISCORD_BOT_TOKEN?.trim();
  return env.HENT_AI_DISCORD_PARTICIPANT_LIVE_QA === "1" && token ? { token } : null;
}

function skipReasons(env: NodeJS.ProcessEnv): string {
  const reasons: string[] = [];
  if (env.HENT_AI_DISCORD_PARTICIPANT_LIVE_QA !== "1") reasons.push("absent_flag");
  if (!env.HENT_AI_DISCORD_BOT_TOKEN?.trim()) reasons.push("absent_token");
  return reasons.join(",");
}

function writeCleanup(cleanup: Cleanup): void {
  const cleanupPath = join(evidenceRoot, "cleanup.json");
  const existing = existsSync(cleanupPath) ? JSON.parse(readFileSync(cleanupPath, "utf8")) as Record<string, unknown> : {};
  writeFileSync(cleanupPath, `${JSON.stringify({ ...existing, ...cleanup }, null, 2)}\n`);
}

function appendLiveReceipt(receipt: string): void {
  appendFileSync(liveLog, `${receipt}\n`);
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
  if (!address || typeof address === "string") throw new Error("live QA provider has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function findSyntheticEventId(): string {
  const scopeId = `${scope.guildId}:${scope.channelId}`;
  for (let index = 0; index < 100; index += 1) {
    const eventId = `synthetic-live-qa-human-work-${index}`;
    if (service.stableAmbientDraw(scopeId, eventId) < 0.625) return eventId;
  }
  throw new Error("could not create deterministic synthetic live QA work");
}

describe("Discord ambient worker conditional live QA", () => {
  it("performs no network work without the explicit flag and bot token", async () => {
    const config = liveConfig(process.env);
    if (!config) {
      const reasons = skipReasons(process.env);
      writeCleanup({ serversClosed: true, tempPathsRemoved: true, leaseReleased: true, qaMessages: "not-created" });
      appendLiveReceipt(`LIVE_QA_SKIPPED reasons=${reasons}`);
      expect(reasons.length).toBeGreaterThan(0);
      return;
    }

    expect(service.DISCORD_PARTICIPANT_API_BASE_URL).toBe("https://discord.com/api/v10");
    const root = mkdtempSync(join(tmpdir(), "hent-ambient-live-"));
    const dbPath = join(root, "live.sqlite");
    const createdMessageIds = new Set<string>();
    const deletedMessageIds = new Set<string>();
    const timers = new Set<() => void>();
    const timer = {
      setInterval: (callback: () => void) => { timers.add(callback); return callback; },
      clearInterval: (callback: unknown) => { if (typeof callback === "function") timers.delete(callback as () => void); },
    };
    let provider: Server | undefined;
    let worker: service.DiscordAmbientWorker | undefined;
    let client: service.DiscordParticipantClient | undefined;
    let cleanupFailure: unknown;
    let cleanup: Cleanup = { serversClosed: false, tempPathsRemoved: false, leaseReleased: false, qaMessages: "not-created" };

    try {
      const seed = new service.ServiceDatabase(dbPath);
      seed.createProfile({ id: "live-qa-profile", name: "Live QA", soulSnippet: "Respond naturally to direct social input." });
      seed.setChannelMapping(scope.channelId, { profileId: "live-qa-profile", enabled: true });
      seed.close();

      provider = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/chat/completions") { response.writeHead(404); return response.end(); }
        await body(request);
        return json(response, 200, { choices: [{ message: { content: JSON.stringify({
          schema: service.ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal,
          decision: "speak",
          desiredDrive: 1,
          confidence: 1,
          chunks: ["Live QA delivery receipt."],
          relationshipProposals: [],
        }) } }] });
      });
      const providerUrl = await listen(provider);

      const realClient = service.createDiscordParticipantClient({ token: config.token });
      client = {
        getCurrentUser: (signal) => realClient.getCurrentUser(signal),
        verifyChannelGuild: (channelId, guildId, signal) => realClient.verifyChannelGuild(channelId, guildId, signal),
        fetchMessages: (channelId, page, signal) => realClient.fetchMessages(channelId, page, signal),
        fetchGuildMembers: (guildId, after, signal) => realClient.fetchGuildMembers(guildId, after, signal),
        sendTyping: (channelId, signal) => realClient.sendTyping(channelId, signal),
        createMessage: async (channelId, content, nonce, signal) => {
          const message = await realClient.createMessage(channelId, content, nonce, signal);
          createdMessageIds.add(message.id);
          return message;
        },
        deleteMessage: (channelId, messageId, signal) => realClient.deleteMessage(channelId, messageId, signal),
      };

      worker = await service.startDiscordAmbientWorker({
        HENT_AI_DISCORD_PARTICIPANT_ENABLED: "true",
        HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST: `${scope.guildId}:${scope.channelId}`,
        HENT_AI_SERVICE_DB_PATH: dbPath,
        HENT_AI_DISCORD_BOT_TOKEN: config.token,
        HENT_AI_CONVERSATION_PROVIDER_ENDPOINT: "https://live-qa-provider.invalid/chat/completions",
        HENT_AI_CONVERSATION_PROVIDER_TOKEN: "local-live-qa-provider-token",
        HENT_AI_CONVERSATION_PROVIDER_MODEL: "live-qa-local-model",
      }, {
        createClient: () => client!,
        createProviderClient: () => service.createOpenAiConversationProviderClient({ endpoint: `${providerUrl}/chat/completions`, token: "local-live-qa-provider-token", model: "live-qa-local-model", timeoutMs: 1_000 }),
        createDelivery: (options) => service.createDiscordAmbientDelivery({ ...options, delay: async () => undefined }),
        createScheduler: (options) => service.createConversationArchiveScheduler({ ...options, timer }),
        timer,
        holderId: `live-qa-${randomUUID()}`,
      });
      expect(worker.status).toBe("running");

      const marker = await client.createMessage(scope.channelId, `live-qa-self-marker-${randomUUID()}`, `live-marker-${randomUUID().replaceAll("-", "")}`);
      const markerReadback = await client.fetchMessages(scope.channelId, { limit: 100 });
      expect(markerReadback.some((message) => message.id === marker.id)).toBe(true);
      await expect(worker.runOnce()).resolves.toBeUndefined();
      expect(createdMessageIds).toEqual(new Set([marker.id]));

      const syntheticEventId = findSyntheticEventId();
      const now = new Date().toISOString();
      const qaDb = new service.ServiceDatabase(dbPath);
      // Do not let an unrelated live message race this synthetic-only exercise into a response.
      qaDb.db.prepare("UPDATE participant_poll_cursors SET message_id=? WHERE guild_id=? AND channel_id=?")
        .run("18446744073709551615", scope.guildId, scope.channelId);
      qaDb.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
        VALUES (?, ?, NULL, NULL, ?, 'user', 'discord-participant', ?, ?, ?, 0, ?, ?)`)
        .run(`discord:${scope.guildId}:${scope.channelId}`, scope.channelId, syntheticEventId, "synthetic-live-qa-human-work", now, now,
          JSON.stringify({ discordAuthorId: "synthetic-live-qa-user", discordAuthorBot: false, mentions: [markerReadback.find((message) => message.id === marker.id)?.author.id ?? ""], syntheticLiveQa: true }), now);
      const store = service.createAdaptiveAmbientStore(qaDb);
      expect(store.createWork({ id: `live-work-${randomUUID()}`, eventId: syntheticEventId, eventDigest: randomUUID(), scope })).toBe("created");
      expect(qaDb.db.prepare("SELECT text FROM conversation_raw_events WHERE message_id=?").get(syntheticEventId)).toEqual({ text: "synthetic-live-qa-human-work" });
      qaDb.close();

      await expect(worker.runOnce()).resolves.toBeUndefined();
      const persisted = new service.ServiceDatabase(dbPath);
      const plan = persisted.db.prepare("SELECT status FROM participant_delivery_plans").get() as { status: string } | undefined;
      const receipts = persisted.db.prepare("SELECT discord_message_id FROM participant_delivery_receipts ORDER BY chunk_index").all() as { discord_message_id: string }[];
      expect(plan).toEqual({ status: "delivered" });
      expect(receipts.length).toBeGreaterThan(0);
      for (const receipt of receipts) createdMessageIds.add(receipt.discord_message_id);
      persisted.close();

      const sendReadback = await client.fetchMessages(scope.channelId, { limit: 100 });
      for (const messageId of createdMessageIds) expect(sendReadback.some((message) => message.id === messageId)).toBe(true);

      await worker.stop();
      worker = undefined;
      let mismatchSendAttempts = 0;
      const mismatchedClient: service.DiscordParticipantClient = {
        getCurrentUser: async () => markerReadback.find((message) => message.id === marker.id)!.author,
        verifyChannelGuild: async () => { throw new Error("mismatched live QA allowlist"); },
        fetchMessages: async () => { throw new Error("mismatched allowlist reached poll"); },
        fetchGuildMembers: async () => { throw new Error("mismatched allowlist reached roster"); },
        sendTyping: async () => { throw new Error("mismatched allowlist reached typing"); },
        createMessage: async () => { mismatchSendAttempts += 1; throw new Error("mismatched allowlist reached send"); },
        deleteMessage: async () => undefined,
      };
      const mismatched = await service.startDiscordAmbientWorker({
        HENT_AI_DISCORD_PARTICIPANT_ENABLED: "true",
        HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST: `1483095221460799490:${scope.channelId}`,
        HENT_AI_SERVICE_DB_PATH: dbPath,
        HENT_AI_DISCORD_BOT_TOKEN: config.token,
        HENT_AI_CONVERSATION_PROVIDER_ENDPOINT: "https://live-qa-provider.invalid/chat/completions",
        HENT_AI_CONVERSATION_PROVIDER_TOKEN: "local-live-qa-provider-token",
        HENT_AI_CONVERSATION_PROVIDER_MODEL: "live-qa-local-model",
      }, { createClient: () => mismatchedClient, timer });
      expect(mismatched.status).toBe("disabled");
      expect(mismatchSendAttempts).toBe(0);
      await mismatched.stop();
    } finally {
      if (worker) {
        try { await worker.stop(); } catch (error) { cleanupFailure ??= error; }
      }
      if (client) {
        for (const messageId of createdMessageIds) {
          try { await client.deleteMessage(scope.channelId, messageId); deletedMessageIds.add(messageId); } catch (error) { cleanupFailure ??= error; }
        }
      }
      try { await close(provider); } catch (error) { cleanupFailure ??= error; }
      let leaseReleased = false;
      try {
        if (existsSync(dbPath)) {
          const db = new service.ServiceDatabase(dbPath);
          leaseReleased = (db.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases").get() as { count: number }).count === 0;
          db.close();
        }
      } catch (error) { cleanupFailure ??= error; }
      try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupFailure ??= error; }
      cleanup = {
        serversClosed: provider?.listening === false,
        tempPathsRemoved: !existsSync(root),
        leaseReleased,
        qaMessages: createdMessageIds.size === 0 ? "not-created" : createdMessageIds.size === deletedMessageIds.size ? "deleted" : "delete-failed",
      };
      writeCleanup(cleanup);
      expect(cleanup.serversClosed && cleanup.tempPathsRemoved && cleanup.leaseReleased && cleanup.qaMessages === "deleted").toBe(true);
      if (cleanupFailure) throw cleanupFailure;
    }

    appendLiveReceipt("LIVE_QA_PASS identity=verified allowlist=pinned self-marker=polled-no-reply synthetic-db-work=delivery-only typing=sent readback=persisted cleanup=complete human-ingress=local-wire-only");
  });
});
