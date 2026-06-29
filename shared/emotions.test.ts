import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_EMOTIONS,
  DEFAULT_EMOTION,
  DEFAULT_EMOTION_MAP,
  EMOTION_CONTRACT_VERSION,
  EMOTION_RULES,
  VALID_EMOTIONS,
} from "./emotions.js";

const fixture = JSON.parse(
  readFileSync(new URL("../tests/fixtures/emotion-contract-v1.json", import.meta.url), "utf-8"),
) as {
  version: string;
  emotions: readonly string[];
  defaultEmotion: string;
  defaultFiles: Record<string, string>;
  cases: ReadonlyArray<{ text: string; emotion: string }>;
};

describe("emotion contract", () => {
  it("matches the checked-in V1 canonical fixture", () => {
    expect(EMOTION_CONTRACT_VERSION).toBe(fixture.version);
    expect(CANONICAL_EMOTIONS).toEqual(fixture.emotions);
    expect(VALID_EMOTIONS).toEqual(fixture.emotions);
    expect(DEFAULT_EMOTION).toBe(fixture.defaultEmotion);
    expect(DEFAULT_EMOTION_MAP).toEqual(fixture.defaultFiles);
  });

  it("keeps Korean and English rules in the shared service-owned contract", () => {
    for (const testCase of fixture.cases) {
      const detected = EMOTION_RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(testCase.text)))?.emotion ?? DEFAULT_EMOTION;
      expect(detected).toBe(testCase.emotion);
    }
  });
});
