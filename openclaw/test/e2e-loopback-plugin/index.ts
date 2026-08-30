import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";

const CHANNEL_ID = "qa-channel";

function channelConfig(cfg: any): { enabled?: boolean; baseUrl?: string; defaultTo?: string } {
  return cfg?.channels?.[CHANNEL_ID] ?? {};
}

function resolveAccount(cfg: any, accountId?: string | null) {
  const config = channelConfig(cfg);
  return {
    accountId: accountId || "default",
    enabled: config.enabled !== false,
    configured: typeof config.baseUrl === "string" && config.baseUrl.length > 0,
    baseUrl: config.baseUrl ?? "",
    defaultTo: config.defaultTo ?? "channel:e2e-room",
  };
}

async function mediaBytes(mediaUrl: string | undefined): Promise<Buffer | undefined> {
  if (!mediaUrl) return undefined;
  if (mediaUrl.startsWith("file://")) return readFile(fileURLToPath(mediaUrl));
  if (/^https?:\/\//i.test(mediaUrl)) {
    const response = await fetch(mediaUrl);
    if (!response.ok) throw new Error(`loopback media fetch failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(mediaUrl);
}

async function deliver(ctx: any, kind: "text" | "media") {
  const account = resolveAccount(ctx.cfg, ctx.accountId);
  if (!account.configured) throw new Error("qa-channel loopback baseUrl is missing");
  const bytes = await mediaBytes(ctx.mediaUrl);
  const response = await fetch(`${account.baseUrl}/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, to: ctx.to, text: ctx.text, mediaUrl: ctx.mediaUrl, mediaBase64: bytes?.toString("base64"), accountId: account.accountId }),
  });
  if (!response.ok) throw new Error(`loopback delivery failed: HTTP ${response.status}`);
  const result = (await response.json()) as { messageId: string };
  return { channel: CHANNEL_ID, messageId: result.messageId, conversationId: ctx.to };
}

async function deliverPayload(cfg: any, accountId: string, to: string, payload: any) {
  const mediaUrls = Array.isArray(payload?.mediaUrls)
    ? payload.mediaUrls
    : typeof payload?.mediaUrl === "string"
      ? [payload.mediaUrl]
      : [];
  if (mediaUrls.length > 0) {
    for (const mediaUrl of mediaUrls) {
      await deliver({ cfg, accountId, to, text: payload?.text ?? "", mediaUrl }, "media");
    }
    return;
  }
  if (typeof payload?.text === "string" && payload.text.trim()) {
    await deliver({ cfg, accountId, to, text: payload.text }, "text");
  }
}

async function dispatchInbound(api: any, cfg: any, account: any, inbound: any) {
  const target = `channel:${inbound.conversationId}`;
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "group", id: target },
    runtime: api.runtime.channel,
    sessionStore: cfg.session?.store,
  });
  const { storePath, body } = buildEnvelope({
    channel: "Hent E2E Loopback",
    from: inbound.senderName,
    timestamp: inbound.timestamp,
    body: inbound.text,
  });
  const ctxPayload = api.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: inbound.text,
    RawBody: inbound.text,
    CommandBody: inbound.text,
    From: target,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: account.accountId,
    ChatType: "group",
    ConversationLabel: inbound.conversationId,
    GroupSubject: inbound.conversationId,
    GroupChannel: inbound.conversationId,
    NativeChannelId: inbound.conversationId,
    SenderName: inbound.senderName,
    SenderId: inbound.senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: inbound.id,
    MessageSidFull: inbound.id,
    Timestamp: inbound.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: target,
    CommandAuthorized: true,
  });
  await api.runtime.channel.inbound.dispatchReply({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: api.runtime.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      deliver: async (payload: any) => deliverPayload(cfg, account.accountId, target, payload),
      onError: (error: unknown) => { throw error instanceof Error ? error : new Error(String(error)); },
    },
    replyOptions: {},
    replyPipeline: {},
    record: { onRecordError: (error: unknown) => { throw error instanceof Error ? error : new Error(String(error)); } },
  });
}

export default definePluginEntry({
  id: "hent-e2e-loopback",
  name: "Hent E2E Loopback",
  description: "Test-only isolated outbound loopback channel.",
  register(api: any) {
    api.registerChannel({
      plugin: {
        id: CHANNEL_ID,
        meta: { id: CHANNEL_ID, label: "Hent E2E Loopback", selectionLabel: "Hent E2E Loopback", docsPath: "/channels/qa-channel", docsLabel: "hent-e2e-loopback", blurb: "Test-only isolated outbound loopback channel.", order: 999 },
        capabilities: { chatTypes: ["direct", "group"] },
        reload: { configPrefixes: ["channels.qa-channel"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount,
          defaultAccountId: () => "default",
          isConfigured: (account: any) => account.configured,
          isEnabled: (account: any) => account.enabled,
          resolveDefaultTo: ({ cfg, accountId }: any) => resolveAccount(cfg, accountId).defaultTo,
          describeAccount: (account: any) => ({ accountId: account.accountId, enabled: account.enabled, configured: account.configured }),
        },
        outbound: {
          deliveryMode: "direct",
          sendText: async (ctx: any) => deliver(ctx, "text"),
          sendMedia: async (ctx: any) => deliver(ctx, "media"),
        },
        gateway: {
          startAccount: async (ctx: any) => {
            const account = ctx.account;
            let cursor = 0;
            ctx.setStatus({ accountId: account.accountId, running: true, configured: true, enabled: true });
            try {
              while (!ctx.abortSignal.aborted) {
                const response = await fetch(`${account.baseUrl}/poll?cursor=${cursor}`, { signal: ctx.abortSignal });
                if (!response.ok) throw new Error(`loopback poll failed: HTTP ${response.status}`);
                const result = (await response.json()) as { cursor: number; events: any[] };
                cursor = result.cursor;
                for (const event of result.events) await dispatchInbound(api, ctx.cfg, account, event);
                await new Promise((resolveWait) => setTimeout(resolveWait, 50));
              }
            } catch (error) {
              if (!(error instanceof Error) || error.name !== "AbortError") throw error;
            } finally {
              ctx.setStatus({ accountId: account.accountId, running: false });
            }
          },
        },
      },
    });
  },
});
