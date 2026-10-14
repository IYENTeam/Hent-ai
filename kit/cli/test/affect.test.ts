import { describe, expect, it } from "bun:test";
import { AFFECT_DIMENSIONS, parseResponseAffectV2 } from "../../../shared/affect.ts";
import { parseAffectArg } from "../src/affect.ts";

const values = AFFECT_DIMENSIONS.map((_, index) => String(index * 4));
const validArg = `${values.join(",")}|80`;

describe("parseAffectArg", () => {
  it("parses 24 values and confidence into a ResponseAffectV2 that passes the shared parser", () => {
    const result = parseAffectArg(validArg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.affect.dimensions.valence).toBe(0);
    expect(result.affect.dimensions.bodyOpenness).toBeCloseTo(92 / 100);
    expect(result.affect.confidence).toBe(0.8);
    expect(parseResponseAffectV2(result.affect)).not.toBeNull();
  });

  it("rejects 23 values", () => {
    const short = values.slice(0, 23).join(",");
    const result = parseAffectArg(`${short}|80`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("expected 24 comma-separated dimension values, got 23");
  });

  it("rejects a value above 100", () => {
    const bad = [...values];
    bad[0] = "101";
    const result = parseAffectArg(`${bad.join(",")}|80`);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer value", () => {
    const bad = [...values];
    bad[5] = "50.5";
    const result = parseAffectArg(`${bad.join(",")}|80`);
    expect(result.ok).toBe(false);
  });
});
