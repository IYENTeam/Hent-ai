import { describe, expect, it, vi, afterEach } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("existing behavior (characterization)", () => {
    it("parses a basic --character", () => {
      const r = parseArgs(["-c", "cute cat"]);
      expect(r).not.toBeNull();
      expect(r?.character).toBe("cute cat");
      expect(r?.keepBase).toBe(true);
    });

    it("returns null with no args", () => {
      expect(parseArgs([])).toBeNull();
    });

    it("returns null for --help", () => {
      expect(parseArgs(["--help"])).toBeNull();
    });

    it("returns null when character is missing", () => {
      expect(parseArgs(["--size", "1024x1024"])).toBeNull();
    });

    it("parses --only into an emotion list", () => {
      expect(parseArgs(["-c", "cat", "--only", "sorry,confused"])?.only).toEqual([
        "sorry",
        "confused",
      ]);
    });

    it("rejects invalid --only emotions", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(parseArgs(["-c", "cat", "--only", "bogus"])).toBeNull();
    });

    it("honors --no-keep-base", () => {
      expect(parseArgs(["-c", "cat", "--no-keep-base"])?.keepBase).toBe(false);
    });

    it("parses --concurrency and -j", () => {
      expect(parseArgs(["-c", "cat", "--concurrency", "6"])?.concurrency).toBe(6);
      expect(parseArgs(["-c", "cat", "-j", "8"])?.concurrency).toBe(8);
    });

    it("parses auto concurrency mode", () => {
      expect(parseArgs(["-c", "cat", "--concurrency", "auto"])?.concurrency).toBe("auto");
    });
  });

  describe("input validation (#52)", () => {
    it("rejects a malformed --size", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(parseArgs(["-c", "cat", "--size", "big"])).toBeNull();
      expect(err).toHaveBeenCalledWith(expect.stringContaining("Invalid --size"));
    });

    it("accepts a well-formed --size", () => {
      expect(parseArgs(["-c", "cat", "--size", "1024x1024"])?.size).toBe("1024x1024");
      expect(parseArgs(["-c", "cat", "-s", "800x600"])?.size).toBe("800x600");
    });

    it("rejects an over-long --character", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(parseArgs(["-c", "a".repeat(1001)])).toBeNull();
      expect(err).toHaveBeenCalledWith(expect.stringContaining("too long"));
    });

    it("accepts a --character at the length limit", () => {
      expect(parseArgs(["-c", "a".repeat(1000)])).not.toBeNull();
    });

    it("rejects malformed or out-of-range --concurrency", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(parseArgs(["-c", "cat", "--concurrency", "0"])).toBeNull();
      expect(parseArgs(["-c", "cat", "--concurrency", "9"])).toBeNull();
      expect(parseArgs(["-c", "cat", "--concurrency", "many"])).toBeNull();
      expect(err).toHaveBeenCalledWith(expect.stringContaining("Invalid --concurrency"));
    });
  });
});
