import { once } from "node:events";
import { pathToFileURL } from "node:url";
import {
  createCodexConversationShimServer,
  createCodexExecRunner,
} from "./codex-conversation-shim.js";

type Env = Readonly<Record<string, string | undefined>>;

export type CodexConversationShimRuntimeConfig = {
  readonly token: string;
  readonly model: string;
  readonly executable: string;
  readonly timeoutMs: number;
  readonly maxConcurrent: number;
  readonly port: number;
};

export function loadCodexConversationShimRuntimeConfig(env: Env = process.env): CodexConversationShimRuntimeConfig {
  return {
    token: required(env.HENT_AI_CODEX_SHIM_TOKEN, "HENT_AI_CODEX_SHIM_TOKEN"),
    model: required(env.HENT_AI_CODEX_SHIM_MODEL, "HENT_AI_CODEX_SHIM_MODEL"),
    executable: env.HENT_AI_CODEX_EXECUTABLE?.trim() || "/opt/homebrew/bin/codex",
    timeoutMs: positive(env.HENT_AI_CODEX_SHIM_TIMEOUT_MS, 25_000, "HENT_AI_CODEX_SHIM_TIMEOUT_MS"),
    maxConcurrent: positive(env.HENT_AI_CODEX_SHIM_MAX_CONCURRENT, 1, "HENT_AI_CODEX_SHIM_MAX_CONCURRENT"),
    port: positive(env.HENT_AI_CODEX_SHIM_PORT, 9_742, "HENT_AI_CODEX_SHIM_PORT"),
  };
}

export async function startCodexConversationShim(env: Env = process.env): Promise<void> {
  const config = loadCodexConversationShimRuntimeConfig(env);
  const server = createCodexConversationShimServer({
    token: config.token,
    maxConcurrent: config.maxConcurrent,
    complete: createCodexExecRunner({
      model: config.model,
      executable: config.executable,
      timeoutMs: config.timeoutMs,
    }),
  });
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.listen(config.port, "127.0.0.1");
  await once(server, "listening");
  console.log(JSON.stringify({
    event: "codex_shim_started",
    endpoint: `http://127.0.0.1:${config.port}/v1/chat/completions`,
  }));
}

function required(value: string | undefined, key: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${key} is required`);
  return normalized;
}

function positive(value: string | undefined, fallback: number, key: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void startCodexConversationShim().catch(() => {
    console.error(JSON.stringify({ event: "codex_shim_startup_failed" }));
    process.exitCode = 1;
  });
}
