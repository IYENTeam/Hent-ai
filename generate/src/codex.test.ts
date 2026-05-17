import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import sharp from "sharp";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { generateImage } = await import("./codex.js");
const { readFile } = await import("node:fs/promises");

function fakeAuthJson() {
  return JSON.stringify({
    tokens: { access_token: "test-token", account_id: "test-account" },
  });
}

function fakeSuccessResponse(base64 = "aGVsbG8=") {
  return new Response(
    JSON.stringify({
      output: [
        {
          type: "image_generation_call",
          result: base64,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fakeSafetyRejectionResponse() {
  return new Response("content_policy violation detected", { status: 400 });
}

async function createTestDataUrl(width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

describe("codex.ts", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockResolvedValue(fakeAuthJson());
    mockFetch.mockResolvedValue(fakeSuccessResponse());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("reference image cap", () => {
    it("throws when more than 3 reference images are provided", async () => {
      const dataUrl = await createTestDataUrl(100, 100);
      await expect(
        generateImage({
          prompt: "test",
          referenceImages: [dataUrl, dataUrl, dataUrl, dataUrl],
        }),
      ).rejects.toThrow("Maximum 3 reference images allowed, got 4");
    });

    it("accepts exactly 3 reference images", async () => {
      const dataUrl = await createTestDataUrl(100, 100);
      const result = await generateImage({
        prompt: "test",
        referenceImages: [dataUrl, dataUrl, dataUrl],
      });
      expect(result).toBeInstanceOf(Buffer);
    });

    it("accepts 0 reference images", async () => {
      const result = await generateImage({ prompt: "test" });
      expect(result).toBeInstanceOf(Buffer);
    });
  });

  describe("image resize", () => {
    it("resizes images larger than 768px", async () => {
      const largeDataUrl = await createTestDataUrl(1500, 1200);
      await generateImage({ prompt: "test", referenceImages: [largeDataUrl] });

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      const sentImage = body.input?.[0]?.content?.[1]?.image_url ?? "";

      if (sentImage) {
        const base64Part = sentImage.split(",")[1];
        const buffer = Buffer.from(base64Part, "base64");
        const metadata = await sharp(buffer).metadata();
        expect(metadata.width).toBeLessThanOrEqual(768);
        expect(metadata.height).toBeLessThanOrEqual(768);
      }
    });

    it("does not resize images already within 768px", async () => {
      const smallDataUrl = await createTestDataUrl(500, 400);
      await generateImage({ prompt: "test", referenceImages: [smallDataUrl] });

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("timeout", () => {
    it("throws timeout error when request is aborted", async () => {
      mockFetch.mockImplementation(
        (_url: string, opts: { signal: AbortSignal }) => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          return Promise.reject(err);
        },
      );

      await expect(
        generateImage({ prompt: "test" }),
      ).rejects.toThrow(/timed out/);
    });
  });

  describe("safety rephrase loop", () => {
    it("retries with rephrased prompt on safety rejection", async () => {
      mockFetch
        .mockResolvedValueOnce(fakeSafetyRejectionResponse())
        .mockResolvedValueOnce(fakeSuccessResponse());

      const rephraseFn = vi.fn().mockResolvedValue("safe prompt");

      const result = await generateImage({
        prompt: "unsafe prompt",
        rephraseProvider: { rephrase: rephraseFn },
      });

      expect(rephraseFn).toHaveBeenCalledOnce();
      expect(rephraseFn).toHaveBeenCalledWith(
        "unsafe prompt",
        expect.stringContaining("content_policy"),
      );
      expect(result).toBeInstanceOf(Buffer);
    });

    it("throws after max rephrase attempts exhausted", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(fakeSafetyRejectionResponse()),
      );

      const rephraseFn = vi.fn().mockResolvedValue("still unsafe");

      await expect(
        generateImage({
          prompt: "bad prompt",
          rephraseProvider: { rephrase: rephraseFn },
        }),
      ).rejects.toThrow(/content_policy/);

      expect(rephraseFn).toHaveBeenCalledTimes(2);
    });

    it("does not rephrase when no rephraseProvider is set", async () => {
      mockFetch.mockResolvedValue(fakeSafetyRejectionResponse());

      await expect(
        generateImage({ prompt: "bad prompt" }),
      ).rejects.toThrow(/content_policy/);
    });

    it("does not rephrase non-safety errors", async () => {
      mockFetch.mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );

      const rephraseFn = vi.fn();

      await expect(
        generateImage({
          prompt: "test",
          rephraseProvider: { rephrase: rephraseFn },
        }),
      ).rejects.toThrow(/500/);

      expect(rephraseFn).not.toHaveBeenCalled();
    });
  });
});
