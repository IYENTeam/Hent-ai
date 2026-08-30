import { afterEach, describe, expect, it } from "vitest";
import {
  E2E_CHANNEL_ID,
  FINAL_STORAGE_KEY,
  PRE_REPLY_STORAGE_KEY,
  sha256,
  startHentE2eRuntime,
  type HentE2eRuntime,
} from "../../tests/e2e/hent-runtime.js";

async function serviceRequest(runtime: HentE2eRuntime, pathname: string, init: RequestInit = {}) {
  return fetch(`${runtime.baseUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${runtime.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

describe("OpenClaw-facing Hent service E2E", () => {
  let runtime: HentE2eRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  it("serves authenticated mappings, exact static media, semantic verdicts, and committed delivery plans", async () => {
    runtime = await startHentE2eRuntime();
    const health = await fetch(`${runtime.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "@hent-ai/service" });
    expect((await fetch(`${runtime.baseUrl}/v1/channels/${E2E_CHANNEL_ID}/mapping`)).status).toBe(401);

    const mapping = await serviceRequest(runtime, `/v1/channels/${E2E_CHANNEL_ID}/mapping`);
    expect(mapping.status).toBe(200);
    expect(await mapping.json()).toMatchObject({
      mapping: { channelId: E2E_CHANNEL_ID, enabled: true, assetSetId: "e2e-affect" },
    });

    const preReply = await serviceRequest(runtime, "/v1/pre-reply/media", {
      method: "POST",
      body: JSON.stringify({ context: { channelId: E2E_CHANNEL_ID }, userMessage: "hello" }),
    });
    expect(preReply.status).toBe(200);
    expect(await preReply.json()).toMatchObject({ media: { url: `/static/${PRE_REPLY_STORAGE_KEY}` } });
    const preStatic = await fetch(`${runtime.baseUrl}/static/${PRE_REPLY_STORAGE_KEY}`);
    expect(preStatic.status).toBe(200);
    expect(sha256(Buffer.from(await preStatic.arrayBuffer()))).toBe(sha256(runtime.preReplyBytes));

    const finalVerdict = await serviceRequest(runtime, "/v1/final-response/verdict", {
      method: "POST",
      body: JSON.stringify({
        context: { channelId: E2E_CHANNEL_ID, content: "The task is complete with a bright successful result." },
      }),
    });
    expect(finalVerdict.status).toBe(200);
    expect(await finalVerdict.json()).toMatchObject({
      verdict: {
        emotion: "happy",
        confidence: 0.99,
        media: { url: `/static/${FINAL_STORAGE_KEY}`, filename: "happy-final.png" },
      },
    });
    const finalStatic = await fetch(`${runtime.baseUrl}/static/${FINAL_STORAGE_KEY}`);
    expect(finalStatic.status).toBe(200);
    const finalBytes = Buffer.from(await finalStatic.arrayBuffer());
    expect(sha256(finalBytes)).toBe(sha256(runtime.finalBytes));
    expect(sha256(finalBytes)).not.toBe(sha256(runtime.preReplyBytes));
    expect(runtime.verifierCalls()).toBe(1);

    const scopeId = `channel:${E2E_CHANNEL_ID}:session:service-e2e`;
    const repeated = "Repeat the same stale deployment plan with rollback risk";
    for (const [index, id] of ["assistant-1", "assistant-2"].entries()) {
      const response = await serviceRequest(runtime, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId, channelId: E2E_CHANNEL_ID, text: repeated, messageId: id }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      if (index === 0) expect(body).toMatchObject({ decision: "no_reply" });
      if (index !== 1) continue;
      const plan = body.deliveryPlan as {
        planId: string;
        scopeId: string;
        commit: { cooldownKey: string; signalId: string; requiredChunkIds: string[] };
        chunks: Array<{ chunkId: string; text: string }>;
      };
      expect(body).toMatchObject({ decision: "nudge" });
      expect(plan.chunks.length).toBeGreaterThanOrEqual(2);
      const deliveryMessageIds = Object.fromEntries(
        plan.commit.requiredChunkIds.map((chunkId, chunkIndex) => [chunkId, `loopback-${chunkIndex + 1}`]),
      );
      const committed = await serviceRequest(runtime, "/v1/watcher/commit-delivery", {
        method: "POST",
        body: JSON.stringify({
          planId: plan.planId,
          cooldownKey: plan.commit.cooldownKey,
          scopeId: plan.scopeId,
          signalId: plan.commit.signalId,
          deliveryMessageIds,
        }),
      });
      expect(committed.status).toBe(200);
      expect(await committed.json()).toEqual({ ok: true, status: "committed" });
    }
    expect(runtime.db.db.prepare(
      "SELECT status FROM conversation_delivery_ledger ORDER BY created_at DESC LIMIT 1",
    ).get()).toEqual({ status: "committed" });
  }, 30_000);
});
