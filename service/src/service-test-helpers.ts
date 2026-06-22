import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG, type ConversationServiceConfig } from "./conversation-config.js";
import type { ServiceDatabase } from "./db.js";
import { createHentAiServer, listen } from "./server.js";
import type { FinalResponseVerifier } from "./verifier.js";

export const token = "test-token";
export const nullVerifier: FinalResponseVerifier = { verify: async () => null };
export const enabledConversationConfig: ConversationServiceConfig = { ...DEFAULT_CONVERSATION_CONFIG, enabled: true };

type TestServerOptions = {
  readonly assetRoot?: string;
  readonly verifier?: FinalResponseVerifier;
  readonly conversationConfig?: ConversationServiceConfig;
};

const tempRoots: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hent-service-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export async function withServer<T>(
  db: ServiceDatabase,
  fn: (baseUrl: string) => Promise<T>,
  options: TestServerOptions = {},
): Promise<T> {
  const verifier = options.verifier ?? nullVerifier;
  const binding = await listen(createHentAiServer({
    db,
    token,
    assetRoot: options.assetRoot,
    verifier,
    ...(options.conversationConfig ? { conversationConfig: options.conversationConfig } : {}),
  }));
  try {
    return await fn(binding.url);
  } finally {
    await binding.close();
    db.close();
  }
}

export async function request(baseUrl: string, path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

export function writeFixtureAssets(root: string): void {
  mkdirSync(join(root, "sets", "gothic-v1"), { recursive: true });
  writeFileSync(join(root, "sets", "gothic-v1", "neutral.png"), Buffer.from("fake png"));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    activeSet: "gothic-v1",
    sets: {
      "gothic-v1": {
        name: "Dark Gothic Girl v1",
        character: "character",
        model: "test-model",
        emotions: { neutral: ["neutral.png"] },
      },
    },
  }));
  writeFileSync(join(root, "channel-overrides.json"), JSON.stringify({ c1: { enabled: true } }));
}
