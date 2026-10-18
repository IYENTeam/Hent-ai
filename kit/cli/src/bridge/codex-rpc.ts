import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

const MAX_MESSAGE = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30_000;

export class CodexRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "CodexRpcError";
  }
}

function rpcError(error: unknown): CodexRpcError {
  return error instanceof CodexRpcError ? error : new CodexRpcError(error instanceof Error ? error.message : String(error));
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frame(payload: Buffer, opcode = 1): Buffer {
  const size = payload.length;
  if (size > MAX_MESSAGE) throw new CodexRpcError("Codex message exceeds 16 MiB");
  const header = Buffer.alloc(size < 126 ? 2 : size < 65536 ? 4 : 10);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (size < 126 ? size : size < 65536 ? 126 : 127);
  if (size >= 65536) header.writeBigUInt64BE(BigInt(size), 2);
  else if (size >= 126) header.writeUInt16BE(size, 2);
  const mask = randomBytes(4);
  const encoded = Buffer.from(payload);
  for (let i = 0; i < size; i++) encoded[i] = encoded.readUInt8(i) ^ mask.readUInt8(i % 4);
  return Buffer.concat([header, mask, encoded]);
}

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: CodexRpcError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** One connection only: a disconnected request is ambiguous and is never retried. */
export class CodexRpc {
  private sequence = 0;
  private closed = false;
  private buffered: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentSize = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private readonly closeListeners = new Set<() => void>();

  private constructor(private readonly socket: Duplex, private readonly timeoutMs: number) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => this.finish(rpcError(error)));
    socket.on("end", () => this.finish(new CodexRpcError("Codex connection ended")));
    socket.on("close", () => this.finish(new CodexRpcError("Codex connection closed")));
  }

  static async connect(options: { socketPath?: string; timeoutMs?: number } = {}): Promise<CodexRpc> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new CodexRpcError("timeoutMs must be a positive timer duration");
    }
    const socketPath = options.socketPath ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control/app-server-control.sock");
    const key = randomBytes(16).toString("base64");
    const rpc = await new Promise<CodexRpc>((resolve, reject) => {
      const socket = createConnection({ path: socketPath });
      let headers = Buffer.alloc(0);
      const failed = (error: Error): void => {
        clearTimeout(timer);
        socket.off("data", upgrade);
        socket.off("close", closed);
        socket.destroy();
        reject(rpcError(error));
      };
      const closed = (): void => failed(new CodexRpcError("Codex connection closed during upgrade"));
      const timer = setTimeout(() => failed(new CodexRpcError("Codex upgrade timeout")), timeoutMs);
      const upgrade = (chunk: Buffer): void => {
        try {
          headers = Buffer.concat([headers, chunk]);
          const end = headers.indexOf("\r\n\r\n");
          if (end < 0 && headers.length <= 16_384) return;
          if (end < 0 || end > 16_384) throw new CodexRpcError("Codex upgrade headers exceed 16 KiB");
          const lines = headers.subarray(0, end).toString("latin1").split("\r\n");
          if (!/^HTTP\/1\.1 101(?: |$)/.test(lines.shift() ?? "")) throw new CodexRpcError("Codex refused WebSocket upgrade");
          const fields = new Map<string, string>();
          for (const line of lines) {
            const colon = line.indexOf(":");
            if (colon <= 0) throw new CodexRpcError("Invalid Codex WebSocket handshake");
            const name = line.slice(0, colon).toLowerCase();
            if (fields.has(name)) throw new CodexRpcError("Invalid Codex WebSocket handshake");
            fields.set(name, line.slice(colon + 1).trim());
          }
          const expected = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          if (fields.get("upgrade")?.toLowerCase() !== "websocket"
            || !fields.get("connection")?.toLowerCase().split(",").map((token) => token.trim()).includes("upgrade")
            || fields.get("sec-websocket-accept") !== expected || fields.has("sec-websocket-extensions") || fields.has("sec-websocket-protocol")) {
            throw new CodexRpcError("Invalid Codex WebSocket handshake");
          }
          clearTimeout(timer);
          socket.off("data", upgrade);
          socket.off("error", failed);
          socket.off("close", closed);
          const client = new CodexRpc(socket, timeoutMs);
          if (headers.length > end + 4) client.receive(headers.subarray(end + 4));
          resolve(client);
        } catch (error) {
          failed(rpcError(error));
        }
      };
      socket.once("error", failed);
      socket.once("close", closed);
      socket.on("data", upgrade);
      socket.once("connect", () => {
        socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
      });
    });
    try {
      await rpc.request("initialize", { clientInfo: { name: "hent-bridge", version: "1" }, capabilities: { experimentalApi: true } });
      rpc.send({ method: "initialized" });
      return rpc;
    } catch (error) {
      rpc.close();
      throw rpcError(error);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexRpcError("Codex connection closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(`Codex request timeout: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(rpcError(error));
      }
    });
  }

  subscribe(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    if (!this.closed) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onClose(listener: () => void): () => void {
    if (this.closed) listener();
    else this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  close(): void {
    this.finish(new CodexRpcError("Codex connection closed"));
  }

  private send(message: unknown): void {
    if (this.closed) throw new CodexRpcError("Codex connection closed");
    this.socket.write(frame(Buffer.from(JSON.stringify(message))));
  }

  private finish(error: CodexRpcError): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.buffered = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentSize = 0;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.listeners.clear();
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) listener();
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    try {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      while (!this.closed && this.buffered.length >= 2) {
        const first = this.buffered.readUInt8(0);
        const second = this.buffered.readUInt8(1);
        const opcode = first & 0x0f;
        const final = Boolean(first & 0x80);
        if (first & 0x70 || second & 0x80) throw new CodexRpcError("Invalid server WebSocket flags");
        const marker = second & 0x7f;
        const header = marker === 126 ? 4 : marker === 127 ? 10 : 2;
        if (this.buffered.length < header) return;
        const length = marker === 127 ? this.buffered.readBigUInt64BE(2)
          : BigInt(marker === 126 ? this.buffered.readUInt16BE(2) : marker);
        if (length > BigInt(MAX_MESSAGE)) throw new CodexRpcError("Codex frame exceeds 16 MiB");
        if ((marker === 126 && length < 126n) || (marker === 127 && length < 65536n)) {
          throw new CodexRpcError("Non-canonical WebSocket length");
        }
        if (opcode >= 8 && (!final || length > 125n)) throw new CodexRpcError("Invalid WebSocket control frame");
        const size = Number(length);
        if (this.buffered.length < header + size) return;
        const payload = this.buffered.subarray(header, header + size);
        this.buffered = this.buffered.subarray(header + size);
        switch (opcode) {
          case 8: {
            if (size === 1) throw new CodexRpcError("Invalid WebSocket close payload");
            if (size >= 2) {
              const code = payload.readUInt16BE(0);
              if (code < 1000 || code >= 5000 || [1004, 1005, 1006, 1015].includes(code)) {
                throw new CodexRpcError("Invalid WebSocket close code");
              }
              new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
            }
            this.socket.write(frame(payload, 8));
            this.finish(new CodexRpcError("Codex connection closed"));
            return;
          }
          case 9:
            this.socket.write(frame(payload, 10));
            continue;
          case 10:
            continue;
          case 0:
            if (!this.fragments.length) throw new CodexRpcError("Unexpected WebSocket continuation");
            break;
          case 1:
            if (this.fragments.length) throw new CodexRpcError("Interleaved WebSocket text messages");
            break;
          default:
            throw new CodexRpcError("Expected text WebSocket message");
        }
        this.fragmentSize += size;
        if (this.fragmentSize > MAX_MESSAGE) throw new CodexRpcError("Codex message exceeds 16 MiB");
        if (this.fragments.length >= 16_384) throw new CodexRpcError("Codex message exceeds fragment limit");
        this.fragments.push(payload);
        if (!final) continue;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.fragments, this.fragmentSize));
        this.fragments = [];
        this.fragmentSize = 0;
        this.dispatch(JSON.parse(text));
      }
    } catch (error) {
      this.finish(rpcError(error));
    }
  }

  private dispatch(message: unknown): void {
    if (!object(message)) throw new CodexRpcError("Expected Codex RPC object");
    if (typeof message.method === "string") {
      // Server requests have their own IDs; they are not responses or notifications.
      if (!Object.hasOwn(message, "id") && object(message.params)) {
        for (const listener of this.listeners) listener(message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    const hasError = Object.hasOwn(message, "error");
    if (hasError === Object.hasOwn(message, "result")) throw new CodexRpcError("Invalid Codex RPC response");
    if (hasError && (!object(message.error) || typeof message.error.message !== "string"
      || (message.error.code !== undefined && typeof message.error.code !== "number"))) {
      throw new CodexRpcError("Invalid Codex RPC error");
    }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (hasError && object(message.error) && typeof message.error.message === "string") {
      entry.reject(new CodexRpcError(message.error.message, typeof message.error.code === "number" ? message.error.code : undefined));
    } else entry.resolve(message.result);
  }
}
