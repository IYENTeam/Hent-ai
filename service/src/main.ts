import { pathToFileURL } from "node:url";
import { ServiceDatabase } from "./db.js";
import { createHentAiServer, listen, type HentAiServerOptions } from "./server.js";
import { createFinalResponseVerifierFromConfig, loadVerifierProviderConfigFromEnv } from "./verifier.js";

export type ApiServiceConfig = {
  readonly dbPath: string;
  readonly token: string;
  readonly port: number;
  readonly hostname: string;
};

export type ApiService = {
  readonly start: () => Promise<{ readonly url: string; readonly stop: () => Promise<void> }>;
};

type Env = Readonly<Record<string, string | undefined>>;

export function loadApiServiceConfig(env: Env = process.env): ApiServiceConfig {
  const dbPath = required(env.HENT_AI_SERVICE_DB_PATH, "HENT_AI_SERVICE_DB_PATH");
  const token = required(env.HENT_AI_SERVICE_TOKEN, "HENT_AI_SERVICE_TOKEN");
  const port = positivePort(env.HENT_AI_SERVICE_PORT);
  const hostname = env.HENT_AI_SERVICE_HOST?.trim() || "127.0.0.1";
  return { dbPath, token, port, hostname };
}

/** API-only composition. It never imports or starts the Discord participant worker. */
export function createApiService(options: {
  readonly config: ApiServiceConfig;
  readonly verifier: HentAiServerOptions["verifier"];
  readonly createDatabase?: (path: string) => ServiceDatabase;
  readonly createServer?: typeof createHentAiServer;
  readonly listenServer?: typeof listen;
}): ApiService {
  const createDatabase = options.createDatabase ?? ((path) => new ServiceDatabase(path));
  const createServer = options.createServer ?? createHentAiServer;
  const listenServer = options.listenServer ?? listen;
  return {
    async start() {
      const db = createDatabase(options.config.dbPath);
      const server = createServer({ db, token: options.config.token, verifier: options.verifier });
      try {
        const binding = await listenServer(server, options.config.port, options.config.hostname);
        return {
          url: binding.url,
          stop: async () => {
            await binding.close();
            db.close();
          },
        };
      } catch (error) {
        db.close();
        throw error;
      }
    },
  };
}

export async function main(env: Env = process.env): Promise<void> {
  const config = loadApiServiceConfig(env);
  const verifier = createFinalResponseVerifierFromConfig(loadVerifierProviderConfigFromEnv(env));
  const service = createApiService({ config, verifier });
  const binding = await service.start();
  console.info(JSON.stringify({ event: "hent_ai_api_listening", url: binding.url }));
}

function required(value: string | undefined, key: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Missing ${key}`);
  return normalized;
}

function positivePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("HENT_AI_SERVICE_PORT must be a valid TCP port");
  return port;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "API startup failed");
    process.exitCode = 1;
  });
}
