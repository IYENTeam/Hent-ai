import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  E2E_CHANNEL_ID,
  sha256,
  startHentE2eRuntime,
  type HentE2eRuntime,
} from "../../tests/e2e/hent-runtime.js";

type Hook = (event: unknown, ctx?: unknown) => Promise<unknown> | unknown;

describe("OpenClaw adapter real-service loopback E2E", () => {
  let runtime: HentE2eRuntime | undefined;
  let adapterHome: string | undefined;

  afterEach(async () => {
    await runtime?.stop();
    if (adapterHome) await rm(adapterHome, { recursive: true, force: true });
    runtime = undefined;
    adapterHome = undefined;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("hydrates exact media, routes only final payloads, sends chunks, and commits host receipts", async () => {
    adapterHome = await mkdtemp(join(tmpdir(), "hent-openclaw-adapter-e2e-"));
    vi.stubEnv("HOME", adapterHome);
    vi.resetModules();
    const { default: adapter } = await import("../index.js");
    runtime = await startHentE2eRuntime();
    const hooks = new Map<string, Hook>();
    const sentMedia: Array<{ to: string; bytes: Buffer }> = [];
    const sentTexts: Array<{ to: string; text: string; messageId: string }> = [];
    let outboundSequence = 0;
    adapter.register({
      pluginConfig: {
        hentAiService: {
          url: runtime.baseUrl,
          token: runtime.token,
          timeoutMs: 5_000,
          preReplyMedia: true,
          watcher: true,
          conversation: { enabled: true, watcherCompatibility: true },
        },
      },
      config: {},
      runtime: {
        channel: { outbound: { loadAdapter: async (id: string) => {
          expect(id).toBe("loopback");
          return {
            sendText: async ({ to, text }: { to: string; text: string }) => {
              const messageId = `loopback-text-${++outboundSequence}`;
              sentTexts.push({ to, text, messageId });
              return { messageId };
            },
            sendMedia: async ({ to, mediaUrl }: { to: string; mediaUrl: string }) => {
              sentMedia.push({ to, bytes: await readFile(mediaUrl) });
              return { messageId: `loopback-media-${++outboundSequence}` };
            },
          };
        } } },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      supportsHook: () => true,
      on: (name: string, handler: Hook) => hooks.set(name, handler),
    });

    const ctx = {
      channelId: "loopback",
      conversationId: `channel:${E2E_CHANNEL_ID}`,
      accountId: "isolated",
      sessionKey: "agent:e2e:loopback",
    };
    const inbound = {
      content: "Repeat the same stale deployment plan with rollback risk",
      messageId: "user-1",
      metadata: { to: `channel:${E2E_CHANNEL_ID}` },
    };
    await hooks.get("message_received")?.(inbound, ctx);
    await hooks.get("message_received")?.({ ...inbound, messageId: "user-2" }, ctx);
    expect(sentMedia).toHaveLength(2);
    expect(sentMedia.every((entry) => sha256(entry.bytes) === sha256(runtime!.preReplyBytes))).toBe(true);
    expect(sentTexts.length).toBeGreaterThanOrEqual(2);
    expect(sentTexts.every((entry) => entry.to === `channel:${E2E_CHANNEL_ID}`)).toBe(true);

    const ledger = runtime.db.db.prepare(
      "SELECT status, required_chunk_ids_json, delivery_message_ids_json FROM conversation_delivery_ledger ORDER BY created_at DESC LIMIT 1",
    ).get() as { status: string; required_chunk_ids_json: string; delivery_message_ids_json: string };
    expect(ledger.status).toBe("committed");
    expect(Object.keys(JSON.parse(ledger.delivery_message_ids_json))).toEqual(
      expect.arrayContaining(JSON.parse(ledger.required_chunk_ids_json)),
    );

    await expect(hooks.get("reply_payload_sending")?.(
      { kind: "block", payload: { text: "not final" } },
      ctx,
    )).resolves.toBeUndefined();
    const finalResult = await hooks.get("reply_payload_sending")?.(
      {
        kind: "final",
        payload: { text: "The task is complete with a bright successful result." },
        sessionKey: "agent:e2e:loopback",
        runId: "run-e2e-final",
      },
      ctx,
    ) as { payload?: { mediaUrl?: string; text?: string } } | undefined;
    expect(finalResult?.payload?.text).toContain("task is complete");
    const finalBytes = await readFile(finalResult!.payload!.mediaUrl!);
    expect(sha256(finalBytes)).toBe(sha256(runtime.finalBytes));
    expect(sha256(finalBytes)).not.toBe(sha256(runtime.preReplyBytes));
  }, 30_000);
});
