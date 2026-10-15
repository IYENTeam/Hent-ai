import { afterEach, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { CodexRpc, CodexRpcError } from "../src/bridge/codex-rpc.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "rpc-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function event<T>(events: EventEmitter, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const listener = (value: T): void => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      events.off(name, listener);
      reject(new Error(`Missing event: ${name}`));
    }, 2_000);
    events.once(name, listener);
  });
}

type Message = { id?: number; method: string; params?: unknown };
type Peer = ServerWebSocket<undefined>;

function endpoint(handle?: (ws: Peer, message: Message) => void, socketPath = join(directory(), "rpc.sock")) {
  const events = new EventEmitter();
  const received: Message[] = [];
  const server = Bun.serve<undefined>({
    unix: socketPath,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        const message: Message = JSON.parse(String(data));
        received.push(message);
        events.emit(message.method, message);
        if (message.method === "initialize") ws.send(JSON.stringify({ id: message.id, result: {} }));
        else if (message.method !== "initialized") {
          if (handle) handle(ws, message);
          else ws.send(JSON.stringify({ id: message.id, result: message.params }));
        }
      },
      pong(_ws, data) { events.emit("pong", String(data)); },
      close() { events.emit("close"); },
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
    rmSync(socketPath, { force: true });
    expect(existsSync(socketPath)).toBe(false);
  });
  return { socketPath, events, received };
}

async function connect(socketPath: string, timeoutMs = 1_000): Promise<CodexRpc> {
  const rpc = await CodexRpc.connect({ socketPath, timeoutMs });
  cleanups.push(() => rpc.close());
  return rpc;
}

test("initialize, request, and notification roundtrip over a real Unix WebSocket", async () => {
  // Given a real server and notification subscription before the trigger.
  const server = endpoint((ws, message) => {
    ws.send(JSON.stringify({ method: "turn/completed", params: { turnId: "t1" } }));
    ws.send(JSON.stringify({ id: message.id, result: { threadId: "thread1" } }));
  });
  const initialized = event<Message>(server.events, "initialized");
  const rpc = await connect(server.socketPath);
  const notifications: unknown[] = [];
  const unsubscribe = rpc.subscribe((method, params) => notifications.push({ method, params }));
  // When a request crosses the initialized connection.
  const result = await rpc.request("thread/start", {});
  await initialized;
  // Then the machine-consumed initialization and response contract match.
  expect(server.received[0]).toEqual({
    id: 1, method: "initialize",
    params: { clientInfo: { name: "hent-bridge", version: "1" }, capabilities: { experimentalApi: true } },
  });
  expect(server.received[1]).toEqual({ method: "initialized" });
  expect(result).toEqual({ threadId: "thread1" });
  expect(notifications).toEqual([{ method: "turn/completed", params: { turnId: "t1" } }]);
  unsubscribe();
  await rpc.request("thread/start", {});
  expect(notifications).toHaveLength(1);
});

test.each([200, 70_000])("masked frames and server text roundtrip with %i byte values", async (length) => {
  // Given payloads requiring 16-bit and 64-bit WebSocket length encodings.
  const server = endpoint();
  const rpc = await connect(server.socketPath);
  const payload = "x".repeat(length);
  // When the real WebSocket server echoes the request.
  const result = await rpc.request("echo", { payload });
  // Then both client masking and extended lengths were accepted end to end.
  expect(result).toEqual({ payload });
  expect(rpc["pending"].size).toBe(0);
});

test("server RPC errors preserve numeric code and message", async () => {
  // Given a server returning a structured RPC error.
  const server = endpoint((ws, message) => ws.send(JSON.stringify({ id: message.id, error: { code: -32002, message: "Busy" } })));
  const rpc = await connect(server.socketPath);
  // When the request is rejected.
  const error = await rpc.request("turn/start", {}).catch((error: unknown) => error);
  // Then callers can reconcile using the typed server error.
  expect(error).toBeInstanceOf(CodexRpcError);
  expect(error).toMatchObject({ code: -32002, message: "Busy" });
  expect(rpc["pending"].size).toBe(0);
});

test("server requests, non-object notifications, and unknown responses cannot complete a pending request", async () => {
  // Given misleading messages sent before the actual result.
  const server = endpoint((ws, message) => {
    for (const value of [
      { id: message.id, method: "approval/request", params: {}, result: "wrong" },
      { method: "invalid", params: [] }, { method: "missing" }, { method: "null", params: null },
      { id: 9999, result: "unknown" }, { result: "missing id" },
      { method: "valid", params: {} }, { id: message.id, result: "actual" },
    ]) ws.send(JSON.stringify(value));
  });
  const rpc = await connect(server.socketPath);
  const notifications: string[] = [];
  rpc.subscribe((method) => notifications.push(method));
  // When the server sends all messages in wire order.
  const result = await rpc.request("trigger", {});
  // Then only the matching response and object notification are delivered.
  expect(result).toBe("actual");
  expect(notifications).toEqual(["valid"]);
  expect(rpc["pending"].size).toBe(0);
});

test("ping receives a masked pong without disrupting a pending request", async () => {
  // Given a server sending a ping before its response.
  const server = endpoint((ws, message) => {
    ws.ping("probe");
    ws.send(JSON.stringify({ id: message.id, result: true }));
  });
  const rpc = await connect(server.socketPath);
  const pong = event<string>(server.events, "pong");
  // When a request triggers the ping.
  expect(await rpc.request("probe", {})).toBe(true);
  // Then the real server accepts the pong payload.
  expect(await pong).toBe("probe");
});

test.each(["terminate", "close"] as const)("ambiguous %s rejects all requests and clears resources once", async (mode) => {
  // Given a peer that disconnects after receiving a request.
  let disconnected = false;
  const server = await rawEndpoint((socket, message) => {
    if (message.method === "initialize") {
      socket.write(serverFrame(Buffer.from(JSON.stringify({ id: message.id, result: {} }))));
    } else if (message.id !== undefined && !disconnected) {
      disconnected = true;
      if (mode === "terminate") socket.destroy();
      else socket.end(serverFrame(Buffer.alloc(0), 8));
    }
  });
  const rpc = await connect(server.socketPath);
  const peerClosed = event(server.events, "close");
  let calls = 0;
  let removedCalls = 0;
  rpc.onClose(() => { calls++; });
  rpc.onClose(() => { removedCalls++; })();
  const closed = new Promise<void>((resolve) => rpc.onClose(resolve));
  // When multiple requests are in flight at disconnect.
  const results = await Promise.allSettled([rpc.request("first", {}), rpc.request("second", {})]);
  await closed;
  await peerClosed;
  rpc.close();
  // Then every promise rejects, pending timers disappear, and later requests fail immediately.
  expect(results.every((result) => result.status === "rejected" && result.reason instanceof CodexRpcError)).toBe(true);
  expect(rpc["pending"].size).toBe(0);
  expect(rpc["listeners"].size).toBe(0);
  expect(rpc["closeListeners"].size).toBe(0);
  expect(calls).toBe(1);
  expect(removedCalls).toBe(0);
  await expect(rpc.request("late", {})).rejects.toBeInstanceOf(CodexRpcError);
  let lateClose = 0;
  rpc.onClose(() => { lateClose++; });
  expect(lateClose).toBe(1);
});

test("per-request timeout cleans the pending map and ignores a late response", async () => {
  // Given a peer that holds exactly one request; time is the behavior under test.
  let late: (() => void) | undefined;
  const server = endpoint((ws, message) => {
    if (message.method === "hold") late = () => ws.send(JSON.stringify({ id: message.id, result: "too late" }));
    else ws.send(JSON.stringify({ id: message.id, result: "next" }));
  });
  const rpc = await connect(server.socketPath, 100);
  // When the request's own deadline expires.
  await expect(rpc.request("hold", {})).rejects.toMatchObject({ name: "CodexRpcError", message: "Codex request timeout: hold" });
  // Then no pending request remains and a late response cannot consume the next request.
  expect(rpc["pending"].size).toBe(0);
  expect(late).toBeDefined();
  late?.();
  expect(await rpc.request("next", {})).toBe("next");
  expect(rpc["pending"].size).toBe(0);
});

test("explicit close rejects pending work and releases the server connection", async () => {
  // Given a held request and close subscriptions installed before close.
  const server = endpoint(() => {});
  const rpc = await connect(server.socketPath);
  const accepted = event(server.events, "hold");
  const peerClosed = event(server.events, "close");
  const result = rpc.request("hold", {}).catch((error: unknown) => error);
  await accepted;
  // When the owner closes the transport.
  rpc.close();
  // Then the peer observes closure and all resources are released.
  expect(await result).toBeInstanceOf(CodexRpcError);
  await peerClosed;
  expect(rpc["pending"].size).toBe(0);
  expect(rpc["socket"].destroyed).toBe(true);
});

test("malformed matching response fails closed rather than orphaning pending work", async () => {
  // Given a response with an ID but neither result nor error.
  const server = endpoint((ws, message) => ws.send(JSON.stringify({ id: message.id })));
  const rpc = await connect(server.socketPath);
  const closed = new Promise<void>((resolve) => rpc.onClose(resolve));
  // When the malformed response arrives.
  await expect(rpc.request("bad", {})).rejects.toBeInstanceOf(CodexRpcError);
  // Then the connection and its pending timers are gone.
  await closed;
  expect(rpc["pending"].size).toBe(0);
});

test("outbound encoding failures do not leave timers or pending requests", async () => {
  // Given a live connection and parameters JSON cannot encode.
  const server = endpoint();
  const rpc = await connect(server.socketPath);
  // When encoding fails synchronously inside request.
  await expect(rpc.request("invalid", 1n)).rejects.toBeInstanceOf(CodexRpcError);
  // Then only that request fails and the connection remains usable.
  expect(rpc["pending"].size).toBe(0);
  expect(await rpc.request("echo", {})).toEqual({});
});

test("CODEX_HOME default socket connects without creating a daemon process", async () => {
  // Given a private default socket and process creation guards.
  const home = directory();
  mkdirSync(join(home, "app-server-control"));
  endpoint(undefined, join(home, "app-server-control/app-server-control.sock"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  const forbidden = (): never => { throw new Error("Transport must not create processes"); };
  const guards = [
    spyOn(Bun, "spawn").mockImplementation(forbidden),
    spyOn(Bun, "spawnSync").mockImplementation(forbidden),
    spyOn(childProcess, "spawn").mockImplementation(forbidden),
    spyOn(childProcess, "spawnSync").mockImplementation(forbidden),
    spyOn(childProcess, "exec").mockImplementation(Object.assign(forbidden, { __promisify__: childProcess.exec.__promisify__ })),
    spyOn(childProcess, "execSync").mockImplementation(forbidden),
    spyOn(childProcess, "execFile").mockImplementation(Object.assign(forbidden, { __promisify__: childProcess.execFile.__promisify__ })),
    spyOn(childProcess, "execFileSync").mockImplementation(forbidden),
    spyOn(childProcess, "fork").mockImplementation(forbidden),
  ];
  cleanups.push(() => { for (const guard of guards) guard.mockRestore(); });
  // When default discovery succeeds and a different socket is absent.
  const rpc = await CodexRpc.connect();
  cleanups.push(() => rpc.close());
  expect(await rpc.request("echo", { ok: true })).toEqual({ ok: true });
  await expect(CodexRpc.connect({ socketPath: join(home, "absent.sock") })).rejects.toBeInstanceOf(CodexRpcError);
  // Then neither path starts or falls back to a daemon.
  for (const guard of guards) expect(guard).not.toHaveBeenCalled();
});

// A raw HTTP peer complements Bun.serve for frame sequences its public API
// cannot emit (fragmentation, malformed frames, and invalid upgrade headers).
function serverFrame(payload: Buffer, opcode = 1, final = true): Buffer {
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
  header[0] = (final ? 0x80 : 0) | opcode;
  header[1] = payload.length < 126 ? payload.length : payload.length < 65536 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(payload.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

async function rawEndpoint(
  handle: (socket: Duplex, message: Message) => void,
  accept = true,
) {
  const socketPath = join(directory(), "raw.sock");
  const events = new EventEmitter();
  const sockets = new Set<Duplex>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); events.emit("close"); });
    let buffered: Buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = /^Sec-WebSocket-Key: ([^\r]+)$/mi.exec(buffered.subarray(0, end).toString("latin1"))?.[1];
        if (!key) throw new Error("Missing upgrade key");
        const digest = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept ? digest : "invalid"}\r\n\r\n`);
        buffered = buffered.subarray(end + 4);
        upgraded = true;
      }
      while (buffered.length >= 2) {
        const marker = buffered.readUInt8(1) & 127;
        const header = marker === 126 ? 4 : marker === 127 ? 10 : 2;
        if (buffered.length < header + 4) return;
        const length = marker === 126 ? buffered.readUInt16BE(2) : marker === 127 ? Number(buffered.readBigUInt64BE(2)) : marker;
        if (buffered.length < header + 4 + length) return;
        expect(buffered.readUInt8(1) & 128).toBe(128);
        const opcode = buffered.readUInt8(0) & 15;
        const payload = Buffer.from(buffered.subarray(header + 4, header + 4 + length));
        for (let i = 0; i < length; i++) payload[i] = payload.readUInt8(i) ^ buffered.readUInt8(header + i % 4);
        buffered = buffered.subarray(header + 4 + length);
        if (opcode !== 1) continue;
        const message: Message = JSON.parse(payload.toString());
        handle(socket, message);
      }
    });
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(socketPath, { force: true });
    expect(existsSync(socketPath)).toBe(false);
  });
  await listening;
  return { socketPath, events };
}

test("fragmented text with interleaved ping preserves UTF-8 and RPC response", async () => {
  // Given a raw peer splitting a UTF-8 character across text/continuation frames.
  const server = await rawEndpoint((socket, message) => {
    if (message.id === undefined) return;
    if (message.method === "initialize") socket.write(serverFrame(Buffer.from(JSON.stringify({ id: message.id, result: {} }))));
    else {
      const payload = Buffer.from(JSON.stringify({ id: message.id, result: "a\u20acb" }));
      const split = payload.indexOf(Buffer.from("\u20ac")) + 1;
      socket.write(Buffer.concat([
        serverFrame(payload.subarray(0, split), 1, false),
        serverFrame(Buffer.from("ping"), 9),
        serverFrame(payload.subarray(split), 0),
      ]));
    }
  });
  const rpc = await connect(server.socketPath);
  // When the response arrives as fragmented text.
  const result = await rpc.request("fragment", {});
  // Then decoding happens once per complete message, not per frame.
  expect(result).toBe("a\u20acb");
});

test.each(["error", "timeout"] as const)("initialization %s closes the upgraded socket", async (mode) => {
  // Given a peer refusing or withholding initialization.
  const server = await rawEndpoint((socket, message) => {
    if (mode === "error") socket.write(serverFrame(Buffer.from(JSON.stringify({ id: message.id, error: { code: -1, message: "Rejected" } }))));
  });
  const peerClosed = event(server.events, "close");
  // When initialization cannot complete.
  await expect(CodexRpc.connect({ socketPath: server.socketPath, timeoutMs: 100 })).rejects.toBeInstanceOf(CodexRpcError);
  // Then the peer observes resource cleanup before the test ends.
  await peerClosed;
});

test("invalid WebSocket accept hash rejects and closes the upgrade socket", async () => {
  // Given an invalid server upgrade response.
  const server = await rawEndpoint(() => {}, false);
  const peerClosed = event(server.events, "close");
  // When connect validates the handshake.
  await expect(CodexRpc.connect({ socketPath: server.socketPath })).rejects.toMatchObject({ message: "Invalid Codex WebSocket handshake" });
  // Then the failed connection is closed.
  await peerClosed;
});

test.each([
  ["oversized frame", Buffer.from([0x81, 127, 0, 0, 0, 0, 1, 0, 0, 1])],
  ["unsafe 64-bit length", Buffer.from([0x81, 127, 0x80, 0, 0, 0, 0, 0, 0, 0])],
  ["unexpected continuation", serverFrame(Buffer.from("{}"), 0)],
  ["interleaved text", Buffer.concat([serverFrame(Buffer.from("{"), 1, false), serverFrame(Buffer.from("}"), 1)])],
  ["fragmented control", serverFrame(Buffer.from("x"), 9, false)],
  ["masked server frame", Buffer.from([0x81, 0x80, 0, 0, 0, 0])],
  ["reserved flags", Buffer.from([0xc1, 0])],
  ["non-canonical length", Buffer.from([0x81, 126, 0, 1, 32])],
  ["oversized control", serverFrame(Buffer.alloc(126), 9)],
  ["invalid close", serverFrame(Buffer.from([0]), 8)],
  ["invalid UTF-8", serverFrame(Buffer.from([0xff]))],
  ["invalid JSON", serverFrame(Buffer.from("{"))],
  ["binary message", serverFrame(Buffer.from("{}"), 2)],
] as const)("protocol failure %s rejects pending work without leaks", async (_name, bytes) => {
  // Given a peer that can emit invalid WebSocket bytes.
  const server = await rawEndpoint((socket, message) => {
    if (message.method === "initialize") socket.write(serverFrame(Buffer.from(JSON.stringify({ id: message.id, result: {} }))));
    else if (message.id !== undefined) socket.write(bytes);
  });
  const rpc = await connect(server.socketPath);
  const peerClosed = event(server.events, "close");
  // When the protocol violation arrives.
  await expect(rpc.request("invalid", {})).rejects.toBeInstanceOf(CodexRpcError);
  // Then rejection does not rely on timeout and all pending resources are gone.
  await peerClosed;
  expect(rpc["pending"].size).toBe(0);
  expect(rpc["socket"].destroyed).toBe(true);
});

test("fragmented messages have a cumulative bound, not just a per-frame bound", async () => {
  // Given individually valid frames whose combined text exceeds 16 MiB.
  const server = await rawEndpoint((socket, message) => {
    if (message.method === "initialize") socket.write(serverFrame(Buffer.from(JSON.stringify({ id: message.id, result: {} }))));
    else if (message.id !== undefined) {
      socket.write(serverFrame(Buffer.alloc(9 * 1024 * 1024, 32), 1, false));
      socket.write(serverFrame(Buffer.alloc(8 * 1024 * 1024, 32), 0));
    }
  });
  const rpc = await connect(server.socketPath);
  // When the cumulative size crosses the bound.
  await expect(rpc.request("large", {})).rejects.toMatchObject({ message: "Codex message exceeds 16 MiB" });
  // Then retained frame/message memory and pending work are released.
  expect(rpc["pending"].size).toBe(0);
  expect(rpc["fragments"]).toHaveLength(0);
  expect(rpc["buffered"].length).toBe(0);
});
