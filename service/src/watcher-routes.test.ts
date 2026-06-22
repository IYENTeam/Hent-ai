import { describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { createHentAiServer, listen } from "./server.js";
import { enabledConversationConfig, nullVerifier, request, token, withServer } from "./service-test-helpers.js";

describe("service-owned watcher API", () => {
  it("conversation records user turns with context checkpoint diagnostics through service endpoints", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const record = await request(baseUrl, "/v1/watcher/record-user", {
        method: "POST",
        body: JSON.stringify({
          scopeId: "channel:c1:thread:t1:session:s1",
          channelId: "c1",
          sourceThreadId: "t1",
          sessionId: "s1",
          text: "Please switch to deploy risk",
          id: "u1",
        }),
      });
      expect(record.status).toBe(200);
      expect(await record.json()).toMatchObject({
        ok: true,
        context: {
          status: "updated",
          scopeId: "channel:c1:thread:t1:session:s1",
          channelId: "c1",
          recentEventCount: 1,
          checkpointEventIds: [expect.any(Number)],
        },
      });
      expect(db.db.prepare("SELECT message_id, channel_id, thread_id, session_id, author_role, text FROM conversation_raw_events WHERE scope_id = ?").all("channel:c1:thread:t1:session:s1")).toMatchObject([
        { message_id: "u1", channel_id: "c1", thread_id: "t1", session_id: "s1", author_role: "user", text: "Please switch to deploy risk" },
      ]);
      expect(db.db.prepare("SELECT scope_id, channel_id, summary, recent_event_ids_json FROM conversation_checkpoints WHERE scope_id = ?").get("channel:c1:thread:t1:session:s1")).toMatchObject({
        scope_id: "channel:c1:thread:t1:session:s1",
        channel_id: "c1",
        summary: "Recent room context: user: Please switch to deploy risk",
        recent_event_ids_json: expect.stringMatching(/^\[\d+\]$/),
      });

      const first = await request(baseUrl, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "channel:c1:thread:t1:session:s1", channelId: "c1", text: "We should keep doing the same plan now", messageId: "a1", sessionId: "s1" }),
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ decision: "no_reply" });

      const second = await request(baseUrl, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "channel:c1:thread:t1:session:s1", channelId: "c1", text: "We should keep doing the same plan now", messageId: "a2", sessionId: "s1" }),
      });
      expect(second.status).toBe(200);
      const body = await second.json();
      expect(body).toMatchObject({ decision: "nudge", audit: { schema: "conversation_watcher.host_policy_gate_audit.v1", allowed: true } });
      expect(body.nudgeText).toContain("같은 프레임");
      expect(db.db.prepare("SELECT message_id, author_role FROM conversation_raw_events WHERE scope_id = ? ORDER BY event_ts, id").all("channel:c1:thread:t1:session:s1")).toMatchObject([
        { message_id: "u1", author_role: "user" },
        { message_id: "a1", author_role: "assistant" },
        { message_id: "a2", author_role: "assistant" },
      ]);
    }, { conversationConfig: enabledConversationConfig });
  });

  it("suppresses duplicate/cooldown after committed watcher nudge delivery", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      await request(baseUrl, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "scope-cool", channelId: "c1", text: "Repeat the same stale deployment plan", messageId: "a1" }),
      });
      const first = await request(baseUrl, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "scope-cool", channelId: "c1", text: "Repeat the same stale deployment plan", messageId: "a2" }),
      });
      const firstBody = await first.json();
      expect(firstBody).toMatchObject({ decision: "nudge", audit: { allowed: true, cooldownKey: "scope-cool:stale_expression_repeated", internalSignalId: "sig-stale-a2" } });

      const commit = await request(baseUrl, "/v1/watcher/commit-delivery", {
        method: "POST",
        body: JSON.stringify({ cooldownKey: firstBody.audit.cooldownKey, scopeId: "scope-cool", signalId: firstBody.audit.internalSignalId, deliveryMessageId: "nudge-1" }),
      });
      expect(commit.status).toBe(200);
      expect(await commit.json()).toEqual({ ok: true });

      const second = await request(baseUrl, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "scope-cool", channelId: "c1", text: "Repeat the same stale deployment plan", messageId: "a3" }),
      });
      expect(await second.json()).toMatchObject({ decision: "no_reply", audit: { allowed: false, suppressedReason: "cooldown" } });
    }, { conversationConfig: enabledConversationConfig });
  });

  it("persists committed watcher cooldown across service handler restarts", async () => {
    const db = new ServiceDatabase();
    const firstBinding = await listen(createHentAiServer({ db, token, verifier: nullVerifier, conversationConfig: enabledConversationConfig }));
    try {
      await request(firstBinding.url, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "scope-restart", channelId: "c1", text: "Repeat the same stale deployment plan", messageId: "a1" }),
      });
      const first = await request(firstBinding.url, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "scope-restart", channelId: "c1", text: "Repeat the same stale deployment plan", messageId: "a2" }),
      });
      const firstBody = await first.json();
      expect(firstBody).toMatchObject({ decision: "nudge", audit: { allowed: true, cooldownKey: "scope-restart:stale_expression_repeated", internalSignalId: "sig-stale-a2" } });

      const commit = await request(firstBinding.url, "/v1/watcher/commit-delivery", {
        method: "POST",
        body: JSON.stringify({ cooldownKey: firstBody.audit.cooldownKey, scopeId: "scope-restart", signalId: firstBody.audit.internalSignalId, deliveryMessageId: "nudge-1" }),
      });
      expect(commit.status).toBe(200);
    } finally {
      await firstBinding.close();
    }

    const secondBinding = await listen(createHentAiServer({ db, token, verifier: nullVerifier, conversationConfig: enabledConversationConfig }));
    try {
      const second = await request(secondBinding.url, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "scope-restart", channelId: "c1", text: "Repeat the same stale deployment plan", messageId: "a3" }),
      });
      expect(await second.json()).toMatchObject({ decision: "no_reply", audit: { allowed: false, suppressedReason: "cooldown" } });
      expect(db.db.prepare("SELECT state_key, last_signal_id FROM conversation_gate_state WHERE scope_id = ?").all("scope-restart")).toMatchObject([
        { state_key: "scope-restart:stale_expression_repeated", last_signal_id: "sig-stale-a2" },
      ]);
    } finally {
      await secondBinding.close();
      db.close();
    }
  });

  it("honors cross-thread and privacy host policy suppression", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      await request(baseUrl, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "scope-policy", channelId: "c1", text: "Repeat the same stale deployment plan", messageId: "a1" }),
      });
      const crossThread = await request(baseUrl, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "scope-policy", channelId: "c1", text: "Repeat the same stale deployment plan", messageId: "a2", sourceThreadId: "t1", targetThreadId: "t2" }),
      });
      expect(await crossThread.json()).toMatchObject({ decision: "no_reply", audit: { allowed: false, suppressedReason: "thread_mismatch" } });

      const privacy = await request(baseUrl, "/v1/watcher/evaluate", {
        method: "POST",
        body: JSON.stringify({ scopeId: "scope-policy", channelId: "c1", text: "Repeat the same stale deployment plan", messageId: "a3", privacyRisk: true }),
      });
      expect(await privacy.json()).toMatchObject({ decision: "no_reply", audit: { allowed: false, suppressedReason: "privacy" } });
    }, { conversationConfig: enabledConversationConfig });
  });

  it("rejects malformed watcher delivery commits", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const badCommit = await request(baseUrl, "/v1/watcher/commit-delivery", { method: "POST", body: JSON.stringify({ cooldownKey: "k" }) });
      expect(badCommit.status).toBe(400);
      expect(await badCommit.json()).toMatchObject({ error: "bad_request", message: "cooldownKey, scopeId, signalId, and deliveryMessageId are required" });
    });
  });

  it("rejects malformed watcher requests without mutating normal APIs", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const before = db.db.prepare(`SELECT
        (SELECT COUNT(*) FROM conversation_raw_events) AS raw_events,
        (SELECT COUNT(*) FROM conversation_delivery_ledger) AS delivery_rows,
        (SELECT COUNT(*) FROM conversation_gate_state) AS gate_rows`).get();

      const badRecord = await request(baseUrl, "/v1/watcher/record-user", { method: "POST", body: JSON.stringify({ scopeId: "s" }) });
      expect(badRecord.status).toBe(400);
      expect(await badRecord.json()).toMatchObject({ error: "bad_request", message: "scopeId and text are required" });

      const badEval = await request(baseUrl, "/v1/watcher/evaluate", { method: "POST", body: JSON.stringify({ scopeId: "s", text: "x" }) });
      expect(badEval.status).toBe(400);
      expect(await badEval.json()).toMatchObject({ error: "bad_request", message: "scopeId, channelId, text, and messageId are required" });

      const after = db.db.prepare(`SELECT
        (SELECT COUNT(*) FROM conversation_raw_events) AS raw_events,
        (SELECT COUNT(*) FROM conversation_delivery_ledger) AS delivery_rows,
        (SELECT COUNT(*) FROM conversation_gate_state) AS gate_rows`).get();
      expect(after).toEqual(before);
    });
  });

  it("conversation record rejects disabled or malformed input without mutating conversation state", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      const disabled = await request(baseUrl, "/v1/watcher/record-user", {
        method: "POST",
        body: JSON.stringify({ scopeId: "channel:c1:session:s1", channelId: "c1", text: "disabled collection should not persist", id: "u-disabled" }),
      });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toEqual({
        ok: true,
        context: {
          status: "disabled",
          diagnostics: ["conversation_disabled"],
        },
      });

      const badRecord = await request(baseUrl, "/v1/watcher/record-user", { method: "POST", body: JSON.stringify({ scopeId: "channel:c1:session:s1" }) });
      expect(badRecord.status).toBe(400);
      expect(await badRecord.json()).toMatchObject({ error: "bad_request", message: "scopeId and text are required" });

      expect(db.db.prepare(`SELECT
        (SELECT COUNT(*) FROM conversation_raw_events) AS raw_events,
        (SELECT COUNT(*) FROM conversation_checkpoints) AS checkpoints`).get()).toEqual({ raw_events: 0, checkpoints: 0 });
    });
  });

});
