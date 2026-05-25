import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sendTextMessage,
  sendImageBufferMessage,
  editTextMessage,
  getMessageAttachments,
  downloadUrl,
} from "../discord-utils.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendTextMessage", () => {
  it("uses OpenClaw sender before Discord REST when available", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sender = { sendText: vi.fn().mockResolvedValue("openclaw-msg") };
    const result = await sendTextMessage("token", "ch1", "hello", mockLogger, sender);
    expect(result).toBe("openclaw-msg");
    expect(sender.sendText).toHaveBeenCalledWith("ch1", "hello");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("falls back to Discord REST when OpenClaw sender returns null", async () => {
    const sender = { sendText: vi.fn().mockResolvedValue(null) };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "rest-msg" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendTextMessage("token", "ch1", "hello", mockLogger, sender);
    expect(result).toBe("rest-msg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("OpenClaw text send unavailable"));
    vi.unstubAllGlobals();
  });

  it("returns message id on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "msg123" }),
    }));
    const result = await sendTextMessage("token", "ch1", "hello", mockLogger);
    expect(result).toBe("msg123");
    vi.unstubAllGlobals();
  });

  it("returns null and warns on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    }));
    const result = await sendTextMessage("token", "ch1", "hello", mockLogger);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("403"));
    vi.unstubAllGlobals();
  });

  it("returns null and logs error on exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const result = await sendTextMessage("token", "ch1", "hello", mockLogger);
    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("network"));
    vi.unstubAllGlobals();
  });
});

describe("sendImageBufferMessage", () => {
  it("uses OpenClaw sender before Discord REST when available", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sender = { sendImageBuffer: vi.fn().mockResolvedValue("openclaw-img") };
    const buf = Buffer.from("PNG");
    const result = await sendImageBufferMessage("token", "ch1", buf, "test.png", "caption", mockLogger, sender);
    expect(result).toBe("openclaw-img");
    expect(sender.sendImageBuffer).toHaveBeenCalledWith("ch1", buf, "test.png", "caption");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("falls back to Discord REST when OpenClaw image sender returns null", async () => {
    const sender = { sendImageBuffer: vi.fn().mockResolvedValue(null) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "rest-img" }),
    }));
    const buf = Buffer.from("PNG");
    const result = await sendImageBufferMessage("token", "ch1", buf, "test.png", "caption", mockLogger, sender);
    expect(result).toBe("rest-img");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("OpenClaw image send unavailable"));
    vi.unstubAllGlobals();
  });

  it("returns message id on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "img456" }),
    }));
    const buf = Buffer.from("PNG");
    const result = await sendImageBufferMessage("token", "ch1", buf, "test.png", "caption", mockLogger);
    expect(result).toBe("img456");
    vi.unstubAllGlobals();
  });

  it("returns null and warns on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    }));
    const buf = Buffer.from("PNG");
    const result = await sendImageBufferMessage("token", "ch1", buf, "test.png", "text", mockLogger);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("429"));
    vi.unstubAllGlobals();
  });

  it("returns null and logs error on exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net fail")));
    const buf = Buffer.from("PNG");
    const result = await sendImageBufferMessage("token", "ch1", buf, "test.png", "text", mockLogger);
    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("net fail"));
    vi.unstubAllGlobals();
  });
});

describe("editTextMessage", () => {
  it("does not throw on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
    }));
    await expect(editTextMessage("token", "ch1", "msg1", "edited", mockLogger)).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("warns on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    }));
    await editTextMessage("token", "ch1", "msg1", "edited", mockLogger);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("404"));
    vi.unstubAllGlobals();
  });

  it("logs error on exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await editTextMessage("token", "ch1", "msg1", "edited", mockLogger);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    vi.unstubAllGlobals();
  });
});

describe("getMessageAttachments", () => {
  it("returns empty array for undefined messageId", async () => {
    const result = await getMessageAttachments("token", "ch1", undefined, mockLogger);
    expect(result).toEqual([]);
  });

  it("returns attachments on success", async () => {
    const attachments = [{ id: "a1", url: "https://cdn.discord.com/a1.png", filename: "a1.png", size: 1234 }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ attachments }),
    }));
    const result = await getMessageAttachments("token", "ch1", "msg1", mockLogger);
    expect(result).toEqual(attachments);
    vi.unstubAllGlobals();
  });

  it("returns empty array on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    }));
    const result = await getMessageAttachments("token", "ch1", "msg1", mockLogger);
    expect(result).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("403"));
    vi.unstubAllGlobals();
  });

  it("returns empty array on exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const result = await getMessageAttachments("token", "ch1", "msg1", mockLogger);
    expect(result).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("down"));
    vi.unstubAllGlobals();
  });

  it("returns empty array when no attachments field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }));
    const result = await getMessageAttachments("token", "ch1", "msg1", mockLogger);
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe("downloadUrl", () => {
  it("returns buffer on success", async () => {
    const data = new Uint8Array([1, 2, 3]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => data.buffer,
    }));
    const result = await downloadUrl("https://example.com/img.png", mockLogger);
    expect(result).toBeInstanceOf(Buffer);
    expect(result?.length).toBe(3);
    vi.unstubAllGlobals();
  });

  it("returns null and warns on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }));
    const result = await downloadUrl("https://example.com/missing.png", mockLogger);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("404"));
    vi.unstubAllGlobals();
  });

  it("returns null and logs error on exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await downloadUrl("https://example.com/img.png", mockLogger);
    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("network error"));
    vi.unstubAllGlobals();
  });
});
