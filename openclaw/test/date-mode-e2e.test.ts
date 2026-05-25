import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "../index.js";

const DATE_MODE_CHANNEL = "888888888888888888";
const NORMAL_CHANNEL = "999999999999999999";

function setupPlugin(opts: {
  dateMode?: { enabled: boolean; channels: string[]; excludeEmotions?: string[] };
  classifierModel?: string;
} = {}) {
  const imageDir = mkdtempSync(join(tmpdir(), "hent-date-mode-e2e-"));
  // Create emotion image files
  writeFileSync(join(imageDir, "focused.png"), "FOCUSED_IMG");
  writeFileSync(join(imageDir, "neutral.png"), "NEUTRAL_IMG");
  writeFileSync(join(imageDir, "happy.png"), "HAPPY_IMG");
  writeFileSync(join(imageDir, "sorry.png"), "SORRY_IMG");
  writeFileSync(join(imageDir, "confused.png"), "CONFUSED_IMG");

  const events = new Map<string, (event: unknown) => Promise<void>>();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  plugin.register({
    pluginConfig: {
      imageDir,
      discordToken: "test-token",
      cheer: { enabled: false },
      dateMode: opts.dateMode ?? { enabled: true, channels: [DATE_MODE_CHANNEL] },
      classifierModel: opts.classifierModel,
    },
    runtime: {
      config: {
        current: () => ({
          models: {
            providers: {
              openai: { baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
            },
          },
        }),
      },
      modelAuth: {
        resolveApiKeyForProvider: vi.fn().mockResolvedValue({ apiKey: "sk-test" }),
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    on(name: string, handler: (event: unknown) => Promise<void>) {
      events.set(name, handler);
    },
  });

  return { imageDir, events, fetchMock };
}

describe("date mode E2E: Phase 1 (message_received)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does NOT send focused/thinking image for date mode channels", async () => {
    const { events, fetchMock } = setupPlugin();

    const handler = events.get("message_received");
    expect(handler).toBeDefined();

    await handler?.({
      content: "안녕! 오늘 어떤 하루였어?",
      metadata: { to: `channel:${DATE_MODE_CHANNEL}` },
    });

    // No fetch calls = no focused image sent
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DOES send focused/thinking image for non-date-mode channels", async () => {
    const { events, fetchMock } = setupPlugin();

    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ id: "msg-1" }),
    });

    const handler = events.get("message_received");
    expect(handler).toBeDefined();

    await handler?.({
      content: "이 버그 좀 봐줘",
      metadata: { to: `channel:${NORMAL_CHANNEL}` },
    });

    // Should have made a POST to send focused image
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(`/channels/${NORMAL_CHANNEL}/messages`);
    expect(opts.method).toBe("POST");
    expect(opts.body.toString()).toContain("focused.png");
  });
});

describe("date mode E2E: Phase 2 (message_sent)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("DOES attach LLM-classified emotion image in date mode (rule-based fallback)", async () => {
    const { events, fetchMock } = setupPlugin();

    // Mock: GET message (to preserve content) + PATCH message (to append image)
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/messages/") && !url.endsWith("/messages")) {
        // GET existing message
        return {
          ok: true,
          json: async () => ({
            content: "오늘 정말 좋은 하루였어!",
            attachments: [],
          }),
          text: async () => "",
        };
      }
      // PATCH
      return { ok: true, text: async () => "", json: async () => ({}) };
    });

    const handler = events.get("message_sent");
    expect(handler).toBeDefined();

    await handler?.({
      to: `channel:${DATE_MODE_CHANNEL}`,
      content: "오늘 정말 좋은 하루였어!",
      success: true,
      messageId: "msg-123",
      metadata: {},
    });

    // Wait for async queue
    await new Promise((r) => setTimeout(r, 50));

    // Should have made GET + PATCH (appendImageToMessage)
    expect(fetchMock).toHaveBeenCalled();
    const patchCall = fetchMock.mock.calls.find(
      ([url, opts]: [string, { method?: string }]) =>
        url.includes(`/channels/${DATE_MODE_CHANNEL}/messages/msg-123`) && opts?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    // Should NOT be focused.png (date mode replaces focused→neutral)
    const patchBody = patchCall?.[1]?.body?.toString() ?? "";
    expect(patchBody).not.toContain("focused.png");
  });

  it("replaces focused emotion with neutral in date mode", async () => {
    const { events, fetchMock } = setupPlugin();

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/messages/") && !url.endsWith("/messages")) {
        return {
          ok: true,
          json: async () => ({ content: "지금 코드 분석 중이에요", attachments: [] }),
          text: async () => "",
        };
      }
      return { ok: true, text: async () => "", json: async () => ({}) };
    });

    const handler = events.get("message_sent");
    expect(handler).toBeDefined();

    // This text matches "focused" rule patterns: "analyzing", "in progress"
    await handler?.({
      to: `channel:${DATE_MODE_CHANNEL}`,
      content: "지금 코드 analyzing 중이에요. Testing in progress",
      success: true,
      messageId: "msg-456",
      metadata: {},
    });

    await new Promise((r) => setTimeout(r, 50));

    const patchCall = fetchMock.mock.calls.find(
      ([url, opts]: [string, { method?: string }]) =>
        url.includes(`/channels/${DATE_MODE_CHANNEL}/messages/msg-456`) && opts?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    // Should attach neutral.png, NOT focused.png
    const patchBody = patchCall?.[1]?.body?.toString() ?? "";
    expect(patchBody).toContain("neutral.png");
    expect(patchBody).not.toContain("focused.png");
  });

  it("attaches emotion image normally on non-date-mode channels", async () => {
    const { events, fetchMock } = setupPlugin();

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/messages/") && !url.endsWith("/messages")) {
        return {
          ok: true,
          json: async () => ({ content: "Currently debugging the code", attachments: [] }),
          text: async () => "",
        };
      }
      return { ok: true, text: async () => "", json: async () => ({}) };
    });

    const handler = events.get("message_sent");
    expect(handler).toBeDefined();

    await handler?.({
      to: `channel:${NORMAL_CHANNEL}`,
      content: "Currently debugging the code",
      success: true,
      messageId: "msg-789",
      metadata: {},
    });

    await new Promise((r) => setTimeout(r, 50));

    const patchCall = fetchMock.mock.calls.find(
      ([url, opts]: [string, { method?: string }]) =>
        url.includes(`/channels/${NORMAL_CHANNEL}/messages/msg-789`) && opts?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    // Non-date-mode should allow focused.png
    const patchBody = patchCall?.[1]?.body?.toString() ?? "";
    expect(patchBody).toContain("focused.png");
  });

  it("works with LLM classifier in date mode (LLM returns happy)", async () => {
    const { events, fetchMock } = setupPlugin({
      classifierModel: "openai/gpt-5.4-mini",
    });

    let callCount = 0;
    fetchMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
      callCount++;
      // LLM classification call
      if (url.includes("/chat/completions")) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "happy" } }],
          }),
          text: async () => "",
        };
      }
      // GET message
      if (url.includes("/messages/") && opts?.method !== "PATCH") {
        return {
          ok: true,
          json: async () => ({ content: "오늘 너무 재밌었어!", attachments: [] }),
          text: async () => "",
        };
      }
      // PATCH message
      return { ok: true, text: async () => "", json: async () => ({}) };
    });

    const handler = events.get("message_sent");
    expect(handler).toBeDefined();

    await handler?.({
      to: `channel:${DATE_MODE_CHANNEL}`,
      content: "오늘 너무 재밌었어!",
      success: true,
      messageId: "msg-llm-1",
      metadata: {},
    });

    await new Promise((r) => setTimeout(r, 100));

    // Should have: LLM call + GET message + PATCH message
    const patchCall = fetchMock.mock.calls.find(
      ([url, opts2]: [string, { method?: string }]) =>
        url.includes(`/channels/${DATE_MODE_CHANNEL}/messages/msg-llm-1`) && opts2?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const patchBody = patchCall?.[1]?.body?.toString() ?? "";
    expect(patchBody).toContain("happy.png");
  });

  it("LLM returns focused in date mode → replaced with neutral", async () => {
    const { events, fetchMock } = setupPlugin({
      classifierModel: "openai/gpt-5.4-mini",
    });

    fetchMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url.includes("/chat/completions")) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "focused" } }],
          }),
          text: async () => "",
        };
      }
      if (url.includes("/messages/") && opts?.method !== "PATCH") {
        return {
          ok: true,
          json: async () => ({ content: "코드 분석 중...", attachments: [] }),
          text: async () => "",
        };
      }
      return { ok: true, text: async () => "", json: async () => ({}) };
    });

    const handler = events.get("message_sent");
    expect(handler).toBeDefined();

    await handler?.({
      to: `channel:${DATE_MODE_CHANNEL}`,
      content: "코드 분석 중...",
      success: true,
      messageId: "msg-llm-2",
      metadata: {},
    });

    await new Promise((r) => setTimeout(r, 100));

    const patchCall = fetchMock.mock.calls.find(
      ([url, opts2]: [string, { method?: string }]) =>
        url.includes(`/channels/${DATE_MODE_CHANNEL}/messages/msg-llm-2`) && opts2?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const patchBody = patchCall?.[1]?.body?.toString() ?? "";
    // Focused should be replaced with neutral in date mode
    expect(patchBody).toContain("neutral.png");
    expect(patchBody).not.toContain("focused.png");
  });

  it("skips NO_REPLY messages in date mode", async () => {
    const { events, fetchMock } = setupPlugin();

    const handler = events.get("message_sent");
    await handler?.({
      to: `channel:${DATE_MODE_CHANNEL}`,
      content: "NO_REPLY",
      success: true,
      messageId: "msg-noreply",
      metadata: {},
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
