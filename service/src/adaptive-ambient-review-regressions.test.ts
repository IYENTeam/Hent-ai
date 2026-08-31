import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as service from "./index.js";

const roots: string[] = [];
const scope = { guildId: "100000000000000001", channelId: "100000000000000002" };
const startup = { enabled: true, allowlist: [scope], diagnostics: [] };

function message(id: string): service.DiscordParticipantMessage {
  return { id, channelId: scope.channelId, content: `message-${id}`, timestamp: "2026-07-25T00:00:00.000Z", author: { id: "300000000000000001", username: "human", bot: false }, mentions: [], replyTo: null };
}

function core(fetchMessages: (after: string | undefined) => Promise<readonly service.DiscordParticipantMessage[]>) {
  const db = new service.ServiceDatabase();
  const store = service.createAdaptiveAmbientStore(db, () => Date.parse("2026-07-25T00:00:00.000Z"));
  return { db, worker: service.createDiscordAmbientWorkerCore({ store, scope, startup, channelMapping: () => ({ enabled: true }), holderId: "task15", client: { fetchMessages: (_channelId, page) => fetchMessages(page.after) } }) };
}

async function paginationAssertion(): Promise<void> {
  const calls: Array<string | undefined> = [];
  const fixture = core(async (after) => {
    calls.push(after);
    if (after === undefined) return Array.from({ length: 100 }, (_, index) => message(String(index + 1)));
    if (after === "100") return [message("101")];
    return [];
  });
  expect(await fixture.worker.runOnce()).toBe("seeded");
  expect(calls).toEqual([undefined, "100"]);
  expect(fixture.db.db.prepare("SELECT message_id FROM participant_poll_cursors").get()).toEqual({ message_id: "101" });
  await fixture.worker.stop(); fixture.db.close();
}

async function messageContractAssertion(): Promise<void> {
  const client = service.createDiscordParticipantClient({ token: "test", apiBaseUrl: "http://127.0.0.1:9876", fetchImpl: async () => new Response(JSON.stringify([{
    id: "400000000000000001", channel_id: scope.channelId, content: "hi", timestamp: "2026-07-25T00:00:00.000Z",
    author: { id: "300000000000000001", username: "human", bot: false }, mentions: [{ id: "500000000000000001", username: "bot", bot: true }],
    message_reference: { message_id: "600000000000000001" }, referenced_message: { id: "600000000000000001", author: { id: "500000000000000001", username: "bot", bot: true } },
  }]), { status: 200 }) });
  const [parsed] = await client.fetchMessages(scope.channelId, {});
  expect(parsed).toMatchObject({ mentions: ["500000000000000001"], replyTo: { messageId: "600000000000000001", authorId: "500000000000000001" } });
}

function terminalClaimAssertion(): void {
  const db = new service.ServiceDatabase(); let now = 0;
  const store = service.createAdaptiveAmbientStore(db, () => now);
  const fence = store.acquireLease("task15", "holder");
  if (!fence) throw new Error("failed to claim test fence");
  store.createWork({ id: "work", eventId: "event", eventDigest: "digest", scope });
  expect(store.claimWork("work", fence)).toBe(true);
  store.recordOutcome({ fence, eventId: "event", scope, outcome: "observe", workId: "work", state: { drive: 0.5, version: 1 } });
  now = 31_000;
  expect(store.claimNextWork(scope, fence)).toBeNull();
  expect(db.db.prepare("SELECT claim_holder_id,claim_fence_token,claim_expires_at_ms FROM participant_event_work WHERE id='work'").get()).toEqual({ claim_holder_id: null, claim_fence_token: null, claim_expires_at_ms: null });
  db.close();
}

function rosterAssertion(): void {
  const roster = { scope, memberIds: ["1", "2"], complete: true, observedAtMs: 600_000 };
  expect(service.deriveActiveHumanIds(roster, [{ authorId: "1", authorIsBot: false, createdAtMs: 0 }, { authorId: "2", authorIsBot: false, createdAtMs: 600_000 }], 600_000)).toEqual(["1", "2"]);
}

function filesystemAssertion(): void {
  const root = mkdtempSync(join(tmpdir(), "hent-task15-fs-")); roots.push(root);
  const privateDirectory = join(root, "private");
  const target = join(privateDirectory, "target.sqlite");
  const db = new service.ServiceDatabase(target);
  expect(statSync(privateDirectory).mode & 0o777).toBe(0o700);
  expect(statSync(target).mode & 0o777).toBe(0o600);
  expect(statSync(`${target}-wal`).mode & 0o777).toBe(0o600);
  expect(statSync(`${target}-shm`).mode & 0o777).toBe(0o600);
  db.close();
  const link = join(root, "link.sqlite"); symlinkSync(target, link);
  expect(() => new service.ServiceDatabase(link)).toThrow();
}

async function optionalDiscordMetadataAssertion(): Promise<void> {
  const replyId = "600000000000000001";
  const client = service.createDiscordParticipantClient({ token: "test", apiBaseUrl: "http://127.0.0.1:9876", fetchImpl: async () => new Response(JSON.stringify([{
    id: "400000000000000001", channel_id: scope.channelId, content: "hi", timestamp: "2026-07-25T00:00:00.000Z",
    author: { id: "300000000000000001", username: "human" }, mentions: [{ id: "500000000000000001", username: "bot" }],
    message_reference: { message_id: replyId }, referenced_message: null,
  }, {
    id: "400000000000000002", channel_id: scope.channelId, content: "hi", timestamp: "2026-07-25T00:00:00.000Z",
    author: { id: "300000000000000001", username: "human" }, mentions: [], message_reference: { message_id: replyId },
  }]), { status: 200 }) });
  const parsed = await client.fetchMessages(scope.channelId, {});
  expect(parsed).toHaveLength(2);
  for (const message of parsed) {
    expect(message).toMatchObject({ author: { bot: false }, replyTo: null });
    expect(message.replyTo?.messageId ?? "").toBe("");
  }
  expect(parsed[0]?.mentions).toEqual(["500000000000000001"]);
}

async function malformedDiscordMetadataAssertion(): Promise<void> {
  const client = service.createDiscordParticipantClient({ token: "test", apiBaseUrl: "http://127.0.0.1:9876", fetchImpl: async () => new Response(JSON.stringify([{
    id: "400000000000000001", channel_id: scope.channelId, content: "hi", timestamp: "2026-07-25T00:00:00.000Z",
    author: { id: "300000000000000001", username: "human", bot: "false" }, mentions: [],
  }]), { status: 200 }) });
  await expect(client.fetchMessages(scope.channelId, {})).rejects.toMatchObject({ kind: "malformed_response" });
  const malformedReply = service.createDiscordParticipantClient({ token: "test", apiBaseUrl: "http://127.0.0.1:9876", fetchImpl: async () => new Response(JSON.stringify([{
    id: "400000000000000001", channel_id: scope.channelId, content: "hi", timestamp: "2026-07-25T00:00:00.000Z",
    author: { id: "300000000000000001", username: "human", bot: false }, mentions: [], message_reference: { message_id: "600000000000000001" }, referenced_message: { id: "different", author: {} },
  }]), { status: 200 }) });
  await expect(malformedReply.fetchMessages(scope.channelId, {})).rejects.toMatchObject({ kind: "malformed_response" });
}

function archiveEligibilityAssertion(): void {
  let now = 1_000_000; const db = new service.ServiceDatabase(); const store = service.createAdaptiveAmbientStore(db, () => now);
  let fence = store.acquireLease("archive-review", "holder");
  if (!fence) throw new Error("failed to acquire archive fence");
  const keepAlive = (until: number): void => { while (now < until) { now += 10_000; const renewed = store.renewLease(fence!); if (!renewed) throw new Error("failed to renew archive fence"); fence = renewed; } };
  const completed = { batchKey: "completed", summaryKey: "summary:completed", scopeId: "scope", sourceStartId: 1, sourceEndId: 1, fence };
  expect(store.claimArchiveBatch(completed)).toBe(true);
  expect(store.completeArchiveBatch(completed.batchKey, "done", fence)).toBe(true);
  keepAlive(now + 120_000);
  expect(store.claimArchiveBatch({ ...completed, fence })).toBe(false);
  const retryable = { batchKey: "retryable", summaryKey: "summary:retryable", scopeId: "scope", sourceStartId: 2, sourceEndId: 2, fence };
  expect(store.claimArchiveBatch(retryable)).toBe(true);
  expect(store.retryArchiveBatch(retryable.batchKey, fence)).toBe(true);
  expect(store.claimArchiveBatch({ ...retryable, fence })).toBe(false);
  keepAlive(now + 120_000);
  expect(store.claimArchiveBatch({ ...retryable, fence })).toBe(true);
  db.close();
}

async function streamingProviderAssertion(): Promise<void> {
  let bytesRead = 0; let cancelled = false; const chunks = [new Uint8Array(600_000), new Uint8Array(600_000), new Uint8Array(600_000)];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { const chunk = chunks.shift(); if (!chunk) { controller.close(); return; } bytesRead += chunk.byteLength; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const client = service.createOpenAiConversationProviderClient({ endpoint: "https://provider.invalid/v1", token: "test", model: "test", timeoutMs: 1_000, fetchImpl: async () => new Response(body) });
  const result = await client.complete({ system: "system", user: "user" });
  expect(result).toMatchObject({ kind: "invalid" });
  expect(cancelled).toBe(true);
  expect(bytesRead).toBeLessThanOrEqual(1_200_000);
}

function danglingSymlinkAssertion(): void {
  const root = mkdtempSync(join(tmpdir(), "hent-task15-links-")); roots.push(root);
  const mainTarget = join(root, "missing-main.sqlite"); const mainLink = join(root, "main.sqlite");
  symlinkSync(mainTarget, mainLink);
  expect(() => new service.ServiceDatabase(mainLink)).toThrow();
  expect(existsSync(mainTarget)).toBe(false);
  const dbPath = join(root, "sidecar.sqlite"); const db = new service.ServiceDatabase(dbPath); db.close();
  const sidecarTarget = join(root, "missing-wal.sqlite"); symlinkSync(sidecarTarget, `${dbPath}-wal`);
  expect(() => new service.ServiceDatabase(dbPath)).toThrow();
  expect(existsSync(sidecarTarget)).toBe(false);
}

const independentAssertions: readonly [string, () => Promise<void> | void][] = [
  ["paginates cursor-forward Discord messages without skipping", paginationAssertion],
  ["preserves Discord mentions and replies through ingress", messageContractAssertion],
  ["never reclaims terminal work after claim expiry", terminalClaimAssertion],
  ["derives active humans from the exact ten-minute window", rosterAssertion],
  ["secures SQLite transcript paths and files", filesystemAssertion],
  ["accepts absent Discord bot metadata and unavailable replies", optionalDiscordMetadataAssertion],
  ["rejects malformed present Discord bot metadata", malformedDiscordMetadataAssertion],
  ["claims only eligible archive batches at the exact retry boundary", archiveEligibilityAssertion],
  ["caps streamed provider response reads before buffering", streamingProviderAssertion],
  ["rejects dangling SQLite main and sidecar symlinks before open", danglingSymlinkAssertion],
];

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("task 15 independent heavy-review regressions", () => {
  for (const [name, assertion] of independentAssertions) it(name, assertion);
  it("closes independent review blockers", async () => { for (const [, assertion] of independentAssertions) await assertion(); });
  it("closes second-pass review blockers", async () => { for (const [, assertion] of independentAssertions) await assertion(); });
});
