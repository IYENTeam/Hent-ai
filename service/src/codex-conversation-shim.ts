import { timingSafeEqual } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_BODY_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;

export type CodexCompletionRunner = (prompt: string, options: { readonly signal: AbortSignal }) => Promise<string>;

export type CodexConversationShimOptions = {
  readonly token: string;
  readonly complete: CodexCompletionRunner;
  readonly maxBodyBytes?: number;
  readonly maxConcurrent?: number;
};

export type CodexExecRunnerConfig = {
  readonly model: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly temporaryRoot?: string;
  readonly buildArguments?: (prompt: string, outputPath: string) => readonly string[];
};

export function createCodexConversationShimServer(options: CodexConversationShimOptions): Server {
  const token = required(options.token, "Codex shim token");
  const maxBodyBytes = positive(options.maxBodyBytes ?? DEFAULT_BODY_BYTES, "Codex shim body limit");
  const maxConcurrent = positive(options.maxConcurrent ?? 1, "Codex shim concurrency");
  let active = 0;

  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      send(response, 404, { error: { type: "not_found" } });
      return;
    }
    if (!authorized(request.headers.authorization, token)) {
      send(response, 401, { error: { type: "unauthorized" } });
      return;
    }
    if (active >= maxConcurrent) {
      response.setHeader("retry-after", "1");
      send(response, 503, { error: { type: "busy" } });
      return;
    }

    active += 1;
    let prompt: string;
    try {
      prompt = parsePrompt(await readBody(request, maxBodyBytes));
    } catch (error) {
      active -= 1;
      send(response, error instanceof PayloadTooLargeError ? 413 : 400, {
        error: { type: error instanceof PayloadTooLargeError ? "payload_too_large" : "invalid_request" },
      });
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortOnClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    if (request.destroyed && !request.complete) controller.abort();
    request.once("aborted", abort);
    response.once("close", abortOnClose);
    try {
      const content = await options.complete(prompt, { signal: controller.signal });
      if (!response.destroyed) send(response, 200, { choices: [{ message: { content } }] });
    } catch {
      if (!response.destroyed) send(response, 503, { error: { type: "service_unavailable" } });
    } finally {
      active -= 1;
      request.removeListener("aborted", abort);
      response.removeListener("close", abortOnClose);
    }
  });
}

export function createCodexExecRunner(config: CodexExecRunnerConfig): CodexCompletionRunner {
  const model = required(config.model, "Codex model");
  const executable = config.executable ?? "/opt/homebrew/bin/codex";
  const timeoutMs = positive(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Codex timeout");
  const temporaryRoot = config.temporaryRoot ?? tmpdir();
  const buildArguments = config.buildArguments ?? ((prompt, outputPath) => [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    ...disabledToolArguments(),
    "-m",
    model,
    "-o",
    outputPath,
    prompt,
  ]);

  return async (prompt, { signal }) => {
    const directory = await mkdtemp(join(temporaryRoot, "codex-shim-"));
    const outputPath = join(directory, "last.txt");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
      await runProcess(executable, [...buildArguments(prompt, outputPath)], directory, controller.signal);
      const content = (await readFile(outputPath, "utf8")).trim();
      if (!content) throw new Error("Codex produced no output");
      return content;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function runProcess(executable: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const child = spawn(executable, args, { cwd, signal, stdio: "ignore" });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, exitSignal) => {
      if (code === 0) finish();
      else finish(new Error(`Codex exited with ${code ?? exitSignal ?? "unknown status"}`));
    });
  });
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        cleanup();
        request.resume();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onAborted = () => {
      cleanup();
      reject(new Error("request aborted"));
    };
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onAborted);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
  });
}

function parsePrompt(body: Buffer): string {
  const payload: unknown = JSON.parse(body.toString("utf8"));
  if (!isRecord(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0 || payload.messages.length > 100) {
    throw new Error("messages are required");
  }
  return payload.messages.map((message) => {
    if (!isRecord(message) || typeof message.role !== "string" || !message.role.trim() || typeof message.content !== "string") {
      throw new Error("invalid message");
    }
    return `${message.role.toUpperCase()}:\n${message.content}`;
  }).join("\n\n");
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function disabledToolArguments(): readonly string[] {
  return [
    "shell_tool", "unified_exec", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
    "computer_use", "apps", "in_app_browser", "image_generation", "multi_agent", "plugins", "workspace_dependencies",
  ].flatMap((feature) => ["--disable", feature]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class PayloadTooLargeError extends Error {}
