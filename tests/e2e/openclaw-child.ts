import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_CHANNEL_ID, sha256, startHentE2eRuntime } from "./hent-runtime.js";

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const openclawEntry = "/opt/homebrew/lib/node_modules/openclaw/dist/index.js";
const externalCredentialKeys = [
  "DISCORD_TOKEN", "DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN", "WHATSAPP_TOKEN", "SIGNAL_TOKEN", "LINE_CHANNEL_ACCESS_TOKEN",
  "GOOGLE_CHAT_CREDENTIALS", "MSTEAMS_APP_PASSWORD",
];

type Delivery = {
  messageId: string;
  kind: "text" | "media";
  to: string;
  text: string;
  mediaUrl?: string;
  mediaBytes?: Buffer;
};

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function waitForGateway(port: number, logs: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (logs().includes("[gateway] ready")) return;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`gateway did not become ready on ${port}\n${logs()}`);
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return runExecutable(process.execPath, [openclawEntry, ...args], env);
}

async function runExecutable(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd: checkoutRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolveRun({ stdout, stderr });
      reject(new Error(`${executable} ${args.join(" ")} failed (${signal ?? code})\n${stdout}\n${stderr}`));
    });
  });
}

function parseFirstJson(text: string): any {
  const start = [...text].findIndex((char) => char === "{" || char === "[");
  if (start < 0) throw new Error(`no JSON value in CLI output: ${text}`);
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      stack.pop();
      if (stack.length === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  throw new Error(`unterminated JSON value in CLI output: ${text}`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForExistingGateway(env: NodeJS.ProcessEnv): Promise<{ pid: number; output: string }> {
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const status = await runCli(["gateway", "status"], env);
      last = `${status.stdout}\n${status.stderr}`;
      const pid = Number(/Runtime: running \(pid (\d+)/.exec(last)?.[1]);
      if (pid > 0 && last.includes("Connectivity probe: ok")) return { pid, output: last };
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`existing gateway did not recover: ${last}`);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function stateInventory(openclawHome: string): Promise<{ hash: string; files: number; directories: number; bytes: number }> {
  const roots = ["agents", "state", "memory", "workspace-attestations", "media/hent-ai-service-adapter"];
  const records: Array<{ path: string; kind: string; mode: number; size: number; hash?: string; target?: string }> = [];
  async function walk(path: string): Promise<void> {
    const info = await lstat(path).catch(() => undefined);
    if (!info) return;
    const key = relative(openclawHome, path);
    if (info.isDirectory()) {
      records.push({ path: key, kind: "directory", mode: info.mode & 0o777, size: 0 });
      for (const entry of await readdir(path)) await walk(join(path, entry));
      return;
    }
    if (info.isSymbolicLink()) {
      records.push({ path: key, kind: "symlink", mode: info.mode & 0o777, size: info.size, target: await readlink(path) });
      return;
    }
    records.push({ path: key, kind: info.isFile() ? "file" : "other", mode: info.mode & 0o777, size: info.size });
  }
  for (const root of roots) await walk(join(openclawHome, root));
  const files = records.filter((record) => record.kind === "file");
  for (let offset = 0; offset < files.length; offset += 16) {
    await Promise.all(files.slice(offset, offset + 16).map(async (record) => { record.hash = await hashFile(join(openclawHome, record.path)); }));
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = records.map((record) => JSON.stringify(record)).join("\n");
  return {
    hash: createHash("sha256").update(manifest).digest("hex"),
    files: files.length,
    directories: records.filter((record) => record.kind === "directory").length,
    bytes: files.reduce((sum, record) => sum + record.size, 0),
  };
}

function scrubExternalCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const key of Object.keys(scrubbed)) {
    if (/(?:TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|MCP|LINEAR|DISCORD|SLACK|TELEGRAM|WHATSAPP|SIGNAL)/i.test(key)) delete scrubbed[key];
  }
  return scrubbed;
}

async function smokeExistingGateway(input: {
  tempRoot: string;
  capturePort: number;
  providerPort: number;
  service: Awaited<ReturnType<typeof startHentE2eRuntime>>;
  deliveries: Delivery[];
  inboundEvents: any[];
  providerRequests: any[];
}): Promise<any> {
  const originalEnv = { ...process.env };
  const openclawHome = join(homedir(), ".openclaw");
  const configPath = join(openclawHome, "openclaw.json");
  const plistPath = join(homedir(), "Library/LaunchAgents/ai.openclaw.gateway.plist");
  const originalBytes = await readFile(configPath);
  const originalMode = (await stat(configPath)).mode & 0o777;
  const originalHash = sha256(originalBytes);
  const plistHash = await hashFile(plistPath);
  const before = await waitForExistingGateway(originalEnv);
  const uid = process.getuid?.() ?? 501;
  const launchDomain = `gui/${uid}`;
  const launchLabel = `${launchDomain}/ai.openclaw.gateway`;
  const smokeRoot = join(input.tempRoot, "same-port-smoke");
  const smokeHome = join(smokeRoot, "home");
  const smokeState = join(smokeRoot, "state");
  const smokeWorkspace = join(smokeRoot, "workspace");
  const smokeConfigPath = join(smokeRoot, "openclaw.json");
  await Promise.all([mkdir(smokeHome, { recursive: true }), mkdir(smokeState, { recursive: true }), mkdir(smokeWorkspace, { recursive: true })]);
  const token = `same-port-${randomUUID()}`;
  const smokeConfig = {
    gateway: { mode: "local", bind: "loopback", port: 18789, auth: { mode: "token", token }, controlUi: { enabled: false } },
    agents: { defaults: { workspace: smokeWorkspace, model: { primary: "hent-e2e/gpt-5.5" }, thinkingDefault: "off" } },
    models: { mode: "replace", providers: { "hent-e2e": {
      baseUrl: `http://127.0.0.1:${input.providerPort}/v1`, apiKey: "local-e2e-only", api: "openai-responses", request: { allowPrivateNetwork: true },
      models: [{ id: "gpt-5.5", name: "Hent E2E", api: "openai-responses", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    } } },
    hooks: { enabled: false },
    channels: { "qa-channel": { enabled: true, baseUrl: `http://127.0.0.1:${input.capturePort}`, defaultTo: `channel:${E2E_CHANNEL_ID}` } },
    plugins: {
      allow: ["hent-ai-service-adapter", "hent-e2e-loopback"], bundledDiscovery: "allowlist",
      load: { paths: [join(checkoutRoot, "openclaw"), join(checkoutRoot, "openclaw/test/e2e-loopback-plugin")] },
      entries: {
        "hent-e2e-loopback": { enabled: true },
        "hent-ai-service-adapter": { enabled: true, config: { hentAiService: { url: input.service.baseUrl, token: input.service.token, timeoutMs: 5000, preReplyMedia: false, watcher: false, conversation: { enabled: false, watcherCompatibility: false } } } },
      },
    },
  };
  assert.equal("mcp" in smokeConfig, false);
  await writeFile(smokeConfigPath, `${JSON.stringify(smokeConfig, null, 2)}\n`, { mode: 0o600 });
  const smokeEnv = scrubExternalCredentials(originalEnv);
  Object.assign(smokeEnv, { HOME: smokeHome, OPENCLAW_HOME: smokeHome, OPENCLAW_STATE_DIR: smokeState, OPENCLAW_CONFIG_PATH: smokeConfigPath, OPENCLAW_GATEWAY_TOKEN: token });
  let bootedOut = false;
  let foreground: ChildProcess | undefined;
  let foregroundLogs = "";
  let evidence: any;
  try {
    await runExecutable("/bin/launchctl", ["bootout", launchDomain, plistPath], originalEnv);
    bootedOut = true;
    const stopDeadline = Date.now() + 20_000;
    while (Date.now() < stopDeadline) {
      const printed = await runExecutable("/bin/launchctl", ["print", launchLabel], originalEnv).then(() => true, () => false);
      if (!printed) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    // Prior A01 residues were removed once after byte/path provenance validation.
    // The repeatable harness never deletes user state; it only proves isolation by inventory hash.
    const removedResidue: Array<{ path: string; sha256: string; reason: string }> = [];
    const stateBefore = await stateInventory(openclawHome);
    assert.equal(sha256(await readFile(configPath)), originalHash);
    assert.equal((await stat(configPath)).mode & 0o777, originalMode);

    input.inboundEvents.length = 0;
    input.deliveries.length = 0;
    const providerBaseline = input.providerRequests.length;
    foreground = spawn(process.execPath, [openclawEntry, "gateway", "run", "--port", "18789", "--bind", "loopback", "--token", token, "--verbose"], { cwd: checkoutRoot, env: smokeEnv, stdio: ["ignore", "pipe", "pipe"] });
    foreground.stdout?.on("data", (chunk) => { foregroundLogs += chunk.toString(); });
    foreground.stderr?.on("data", (chunk) => { foregroundLogs += chunk.toString(); });
    await waitForGateway(18789, () => foregroundLogs);
    const smokePid = foreground.pid;
    const plugins = parseFirstJson((await runCli(["plugins", "list", "--json"], smokeEnv)).stdout);
    const pluginRows = Array.isArray(plugins) ? plugins : plugins.plugins;
    const adapter = pluginRows.find((plugin: any) => plugin.id === "hent-ai-service-adapter");
    assert.equal(adapter?.status, "loaded");
    assert.equal(resolve(adapter.source), join(checkoutRoot, "openclaw", "index.ts"));

    const response = await fetch(`http://127.0.0.1:${input.capturePort}/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "existing-inbound-1", conversationId: E2E_CHANNEL_ID, senderId: "isolated-existing-user", senderName: "Isolated Existing User", timestamp: Date.now(), text: "Return exactly FINAL-HAPPY-ROUTE. Do not call tools." }),
    });
    assert.equal(response.status, 200);
    const deadline = Date.now() + 30_000;
    while (input.providerRequests.length < providerBaseline + 1 && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    while (!input.deliveries.some((delivery) => delivery.mediaBytes && sha256(delivery.mediaBytes) === sha256(input.service.finalBytes)) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const finalMedia = input.deliveries.filter((delivery) => delivery.mediaBytes && sha256(delivery.mediaBytes) === sha256(input.service.finalBytes));
    const preReplyMedia = input.deliveries.filter((delivery) => delivery.mediaBytes && sha256(delivery.mediaBytes) === sha256(input.service.preReplyBytes));
    assert.equal(input.providerRequests.length, providerBaseline + 1);
    assert.equal(finalMedia.length, 1);
    assert.equal(preReplyMedia.length, 0);
    assert.equal(input.deliveries.filter((delivery) => delivery.kind === "text" && delivery.text !== "FINAL-HAPPY-ROUTE").length, 0);
    await stopChild(foreground);
    foreground = undefined;
    const stateAfter = await stateInventory(openclawHome);
    assert.deepEqual(stateAfter, stateBefore, "disposable same-port smoke mutated original OpenClaw state");
    assert.equal(sha256(await readFile(configPath)), originalHash);
    assert.equal((await stat(configPath)).mode & 0o777, originalMode);
    assert.equal(await hashFile(plistPath), plistHash);
    const urls = foregroundLogs.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
    const externalUrls = urls.filter((url) => !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:[/?#]|$)/i.test(url));
    assert.deepEqual(externalUrls, [], `foreground smoke attempted external endpoints: ${externalUrls.join(", ")}`);
    assert.doesNotMatch(foregroundLogs, /mcp\.linear|linear\.app|\bmcp\b/i);
    evidence = {
      beforePid: before.pid,
      activeSmokePid: smokePid,
      port: 18789,
      adapterSource: adapter.source,
      configHashBefore: originalHash,
      configModeBefore: originalMode.toString(8),
      configuredChannels: ["qa-channel"],
      watcher: false,
      conversation: false,
      preReplyMedia: false,
      externalChannelDelivery: false,
      ambientHooks: false,
      providerRequests: 1,
      finalMediaSha256: sha256(finalMedia[0].mediaBytes!),
      finalMediaExactBytes: true,
      preReplyDeliveries: 0,
      watcherChunkDeliveries: 0,
      mcpConfigured: false,
      mcpObservedInLogs: false,
      observedHttpUrls: [...new Set(urls)],
      externalHttpUrls: externalUrls,
      stoppedOriginalStateBefore: stateBefore,
      stoppedOriginalStateAfter: stateAfter,
      originalStateUnchangedDuringSmoke: true,
      removedPriorResidue: removedResidue,
    };
  } finally {
    await stopChild(foreground);
    if (bootedOut) {
      await runExecutable("/bin/launchctl", ["bootstrap", launchDomain, plistPath], originalEnv);
      const restored = await waitForExistingGateway(originalEnv);
      const restoredHash = sha256(await readFile(configPath));
      const restoredMode = (await stat(configPath)).mode & 0o777;
      if (restoredHash !== originalHash || restoredMode !== originalMode) throw new Error("original OpenClaw config bytes or mode changed");
      if (await hashFile(plistPath) !== plistHash) throw new Error("OpenClaw LaunchAgent plist changed");
      const restoredPlugins = parseFirstJson((await runCli(["plugins", "list", "--json"], originalEnv)).stdout);
      const rows = Array.isArray(restoredPlugins) ? restoredPlugins : restoredPlugins.plugins;
      const adapter = rows.find((plugin: any) => plugin.id === "hent-ai-service-adapter");
      if (adapter?.status !== "loaded" || resolve(adapter.source) !== join(checkoutRoot, "openclaw", "index.ts")) throw new Error("restored gateway did not load checkout Hent adapter");
      if (evidence) {
        evidence.restoredPid = restored.pid;
        evidence.configHashRestored = restoredHash;
        evidence.configModeRestored = restoredMode.toString(8);
        evidence.configNeverChanged = restoredHash === originalHash && restoredMode === originalMode;
        evidence.restoredAdapterSource = adapter.source;
      }
    }
  }
  return evidence;
}

async function main(): Promise<void> {
  const service = await startHentE2eRuntime();
  const tempRoot = await mkdtemp(join(tmpdir(), "hent-openclaw-e2e-"));
  let captureServer: Server | undefined;
  let providerServer: Server | undefined;
  let gateway: ChildProcess | undefined;
  const deliveries: Delivery[] = [];
  const inboundEvents: any[] = [];
  const providerRequests: any[] = [];
  let gatewayLogs = "";

  try {
    captureServer = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/poll") {
          const cursor = Number(url.searchParams.get("cursor") ?? 0);
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ cursor: inboundEvents.length, events: inboundEvents.slice(cursor) }));
        }
        if (req.method === "POST" && url.pathname === "/inbound") {
          const body = await readJsonBody(req);
          inboundEvents.push(body);
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ accepted: true, cursor: inboundEvents.length }));
        }
        if (req.method !== "POST" || url.pathname !== "/deliver") return void res.writeHead(404).end();
        const body = await readJsonBody(req);
        const messageId = `loopback-${deliveries.length + 1}`;
        deliveries.push({ messageId, kind: body.kind, to: body.to, text: body.text ?? "", mediaUrl: body.mediaUrl, mediaBytes: body.mediaBase64 ? Buffer.from(body.mediaBase64, "base64") : undefined });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ messageId }));
      })().catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
    const capturePort = await listen(captureServer);

    providerServer = createServer((req, res) => {
      void (async () => {
        if (req.method === "GET" && req.url === "/v1/models") {
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ data: [{ id: "gpt-5.5", object: "model" }] }));
        }
        if (req.method !== "POST" || req.url !== "/v1/responses") return void res.writeHead(404).end();
        const body = await readJsonBody(req);
        providerRequests.push(body);
        const text = "FINAL-HAPPY-ROUTE";
        const item = { type: "message", id: `msg_e2e_${providerRequests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
        const events: any[] = [
          { type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
          { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
          { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
          { type: "response.output_item.done", item },
          { type: "response.completed", response: { id: `resp_e2e_${providerRequests.length}`, status: "completed", output: [item], usage: { input_tokens: 32, output_tokens: 6, total_tokens: 38 } } },
        ];
        if (body.stream === false) {
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end(JSON.stringify(events.at(-1).response));
        }
        const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
      })().catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
    const providerPort = await listen(providerServer);
    const gatewayPort = await freePort();
    const stateDir = join(tempRoot, "state");
    const homeDir = join(tempRoot, "home");
    const workspaceDir = join(tempRoot, "workspace");
    const configPath = join(tempRoot, "openclaw.json");
    await Promise.all([mkdir(stateDir), mkdir(homeDir), mkdir(workspaceDir)]);
    const token = `e2e-${randomUUID()}`;
    const config = {
      gateway: { mode: "local", bind: "loopback", port: gatewayPort, auth: { mode: "token", token }, controlUi: { enabled: false } },
      agents: { defaults: { workspace: workspaceDir, model: { primary: "hent-e2e/gpt-5.5" }, thinkingDefault: "off" } },
      models: { mode: "replace", providers: { "hent-e2e": {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "local-e2e-only", api: "openai-responses", request: { allowPrivateNetwork: true },
        models: [{ id: "gpt-5.5", name: "Hent E2E", api: "openai-responses", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
      } } },
      channels: { "qa-channel": { enabled: true, baseUrl: `http://127.0.0.1:${capturePort}`, defaultTo: `channel:${E2E_CHANNEL_ID}` } },
      plugins: {
        allow: ["hent-ai-service-adapter", "hent-e2e-loopback"],
        load: { paths: [join(checkoutRoot, "openclaw"), join(checkoutRoot, "openclaw/test/e2e-loopback-plugin")] },
        entries: {
          "hent-e2e-loopback": { enabled: true },
          "hent-ai-service-adapter": { enabled: true, config: { hentAiService: { url: service.baseUrl, token: service.token, timeoutMs: 5000, preReplyMedia: true, watcher: true, conversation: { enabled: true, watcherCompatibility: true } } } },
        },
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, OPENCLAW_HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_GATEWAY_TOKEN: token, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" };
    for (const key of externalCredentialKeys) delete env[key];

    gateway = spawn(process.execPath, [openclawEntry, "gateway", "run", "--port", String(gatewayPort), "--bind", "loopback", "--token", token, "--verbose"], { cwd: checkoutRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    gateway.stdout?.on("data", (chunk) => { gatewayLogs += chunk.toString(); });
    gateway.stderr?.on("data", (chunk) => { gatewayLogs += chunk.toString(); });
    await waitForGateway(gatewayPort, () => gatewayLogs);

    const health = await runCli(["gateway", "call", "health", "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", token, "--json"], env);
    assert.match(health.stdout, /"ok"\s*:\s*true/);
    const pluginList = await runCli(["plugins", "list", "--json"], env);
    const pluginOutput = parseFirstJson(pluginList.stdout);
    const pluginJson = Array.isArray(pluginOutput) ? pluginOutput : pluginOutput.plugins;
    assert(Array.isArray(pluginJson), `unexpected plugin list output: ${pluginList.stdout}`);
    const hentPlugin = pluginJson.find((plugin: any) => plugin.id === "hent-ai-service-adapter");
    assert.equal(hentPlugin?.status, "loaded");
    assert.equal(resolve(hentPlugin.source), join(checkoutRoot, "openclaw", "index.ts"));
    assert.equal(pluginJson.find((plugin: any) => plugin.id === "hent-e2e-loopback")?.status, "loaded");

    for (let index = 1; index <= 2; index += 1) {
      const response = await fetch(`http://127.0.0.1:${capturePort}/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: `inbound-${index}`, conversationId: E2E_CHANNEL_ID, senderId: "isolated-user", senderName: "Isolated User", timestamp: Date.now(), text: "Return exactly FINAL-HAPPY-ROUTE. Do not call tools." }),
      });
      assert.equal(response.status, 200);
      const deadline = Date.now() + 30_000;
      while (deliveries.filter((delivery) => delivery.text === "FINAL-HAPPY-ROUTE").length < index && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    const ledgerDeadline = Date.now() + 20_000;
    let ledger: any;
    while (Date.now() < ledgerDeadline) {
      ledger = service.db.db.prepare("SELECT status, required_chunk_ids_json, delivery_message_ids_json FROM conversation_delivery_ledger ORDER BY created_at DESC LIMIT 1").get();
      if (ledger?.status === "committed") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.equal(providerRequests.length, 2);
    assert.equal(deliveries.filter((delivery) => delivery.text === "FINAL-HAPPY-ROUTE").length, 2);
    const preReplyMedia = deliveries.filter((delivery) => delivery.kind === "media" && delivery.mediaBytes && sha256(delivery.mediaBytes) === sha256(service.preReplyBytes));
    const finalMedia = deliveries.filter((delivery) => delivery.kind === "media" && delivery.mediaBytes && sha256(delivery.mediaBytes) === sha256(service.finalBytes));
    assert.equal(preReplyMedia.length, 2, "gateway did not deliver exact static pre-reply media twice");
    assert.equal(finalMedia.length, 2, `gateway did not deliver exact semantically routed final media twice; deliveries=${JSON.stringify(deliveries.map((delivery) => ({ ...delivery, mediaBytes: delivery.mediaBytes ? sha256(delivery.mediaBytes) : undefined })), null, 2)}; verifierCalls=${service.verifierCalls()}; logs=${gatewayLogs}`);
    assert.equal(ledger?.status, "committed", "watcher delivery ledger did not commit");
    const requiredChunkIds = JSON.parse(ledger.required_chunk_ids_json);
    const deliveryMessageIds = JSON.parse(ledger.delivery_message_ids_json);
    assert(requiredChunkIds.length >= 2);
    assert.equal(requiredChunkIds.length, Object.keys(deliveryMessageIds).length);

    const isolatedEvidence = {
      child: { pid: gateway.pid, port: gatewayPort, stateRoot: tempRoot, disposableState: tempRoot.startsWith(tmpdir()), externalChannelCredentials: false, configuredChannels: ["qa-channel"], adapterSource: hentPlugin.source },
      service: { port: Number(new URL(service.baseUrl).port), health: (await (await fetch(`${service.baseUrl}/health`)).json()).ok, mappingEnabled: service.db.getChannelMapping(E2E_CHANNEL_ID)?.enabled, verifierCalls: service.verifierCalls() },
      provider: { port: providerPort, requests: providerRequests.length, credential: "local dummy only" },
      media: { preReplySha256: sha256(service.preReplyBytes), finalSha256: sha256(service.finalBytes), distinct: sha256(service.preReplyBytes) !== sha256(service.finalBytes), preReplyDeliveriesWithExactBytes: preReplyMedia.length, finalDeliveriesWithExactBytes: finalMedia.length },
      delivery: { loopbackPort: capturePort, total: deliveries.length, finalReplies: deliveries.filter((delivery) => delivery.text === "FINAL-HAPPY-ROUTE").length, watcherChunks: deliveries.filter((delivery) => delivery.kind === "text" && delivery.text !== "FINAL-HAPPY-ROUTE").map((delivery) => delivery.messageId), ledgerStatus: ledger.status, requiredChunkIds, deliveryMessageIds },
    };
    await stopChild(gateway);
    gateway = undefined;
    const existingGateway = await smokeExistingGateway({ tempRoot, capturePort, providerPort, service, deliveries, inboundEvents, providerRequests });
    process.stdout.write(`${JSON.stringify({ isolated: isolatedEvidence, existingGateway }, null, 2)}\n`);
  } finally {
    await stopChild(gateway);
    await Promise.allSettled([closeServer(captureServer), closeServer(providerServer), service.stop()]);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
