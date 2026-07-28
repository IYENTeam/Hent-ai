import { describe, expect, it, vi } from "vitest";
import * as service from "./index.js";

type ConversationPrompt = { readonly system: string; readonly user: string };
type CompletionResult = { readonly kind: "ok"; readonly content: string } | { readonly kind: "invalid"; readonly diagnostic: string };
type ConversationProviderClient = { readonly complete: (prompt: ConversationPrompt, options?: { readonly model?: string; readonly signal?: AbortSignal }) => Promise<CompletionResult> };
type ConversationProviderClientApi = {
  readonly createOpenAiConversationProviderClient: (config: {
    readonly endpoint: URL | string; readonly token: string; readonly model: string; readonly timeoutMs: number;
    readonly extraHeaders?: Record<string, string>; readonly extraBody?: Record<string, unknown>; readonly fetchImpl?: typeof fetch;
  }) => ConversationProviderClient;
};

const prompt: ConversationPrompt = { system: "Return the required JSON only.", user: JSON.stringify({ room: "engineering", transcript: [{ author: "member", content: "hello" }] }) };

function conversationProviderClientApi(): ConversationProviderClientApi | null {
  const candidate = service as object;
  if (!("createOpenAiConversationProviderClient" in candidate)) return null;
  return typeof Reflect.get(candidate, "createOpenAiConversationProviderClient") === "function" ? candidate as ConversationProviderClientApi : null;
}

function createClient(fetchImpl: typeof fetch, overrides: Partial<Parameters<ConversationProviderClientApi["createOpenAiConversationProviderClient"]>[0]> = {}): ConversationProviderClient {
  const api = conversationProviderClientApi();
  if (api === null) throw new Error("conversation provider public API was unavailable");
  return api.createOpenAiConversationProviderClient({ endpoint: "https://provider.invalid/v1/chat/completions", token: "test-provider-token-must-not-leak", model: "ambient-test-model", timeoutMs: 1_000, fetchImpl, ...overrides });
}

describe("OpenAI-compatible conversation provider client", () => {
  it("uses the configured endpoint and only accepts choices[0].message.content", async () => {
    let url: URL | RequestInfo | undefined;
    let request: RequestInit | undefined;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      url = input;
      request = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"accepted\":true}" } }] }));
    }) as typeof fetch;

    expect(conversationProviderClientApi()).not.toBeNull();
    const completion = await createClient(fetchImpl).complete(prompt, { model: "ambient-override" });
    expect(url?.toString()).toBe("https://provider.invalid/v1/chat/completions");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({ "content-type": "application/json", authorization: "Bearer test-provider-token-must-not-leak" });
    expect(JSON.parse(String(request?.body))).toEqual({ model: "ambient-override", messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }] });
    expect(completion).toEqual({ kind: "ok", content: "{\"accepted\":true}" });
  });

  it("fails closed for HTTP, network, non-JSON, and malformed responses without leaking secrets", async () => {
    const responses: Array<typeof fetch> = [
      (async () => new Response("upstream failure", { status: 500 })) as typeof fetch,
      (async () => { throw new Error("network disconnected"); }) as typeof fetch,
      (async () => new Response("not json")) as typeof fetch,
      (async () => new Response(JSON.stringify({ choices: [{ message: { content: ["not a string"] } }] }))) as typeof fetch,
      (async () => new Response(JSON.stringify({ choices: [{ text: "legacy fallback is forbidden" }] }))) as typeof fetch,
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const outcomes = await Promise.all(responses.map(async (fetchImpl) => createClient(fetchImpl).complete(prompt)));
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({ kind: "invalid" });
        expect(outcome.kind === "invalid" ? outcome.diagnostic : "").not.toContain("test-provider-token-must-not-leak");
      }
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("propagates caller abort and timeout abort as typed invalid input", async () => {
    const signals: AbortSignal[] = [];
    const waitingFetch = ((_: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("missing provider abort signal");
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;
    const caller = new AbortController();
    expect(conversationProviderClientApi()).not.toBeNull();
    const callerCompletion = createClient(waitingFetch).complete(prompt, { signal: caller.signal });
    caller.abort();
    const callerOutcome = await callerCompletion;
    const timeoutOutcome = await createClient(waitingFetch, { timeoutMs: 1 }).complete(prompt);
    expect(callerOutcome).toMatchObject({ kind: "invalid" });
    expect(timeoutOutcome).toMatchObject({ kind: "invalid" });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
