import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG } from "./conversation-config.js";
import { delayForChunkByLength, splitDeliveryChunks } from "./conversation-delivery-timing.js";

describe("conversation delivery timing", () => {
  it("uses length-proportional delay with clamp boundaries and deterministic jitter", () => {
    // Given: a delivery config and deterministic jitter.
    const config = {
      ...DEFAULT_CONVERSATION_CONFIG,
      minDelayMs: 650,
      maxDelayMs: 6500,
      basePauseMs: 400,
      perCharMs: 55,
    };

    // When: delays are calculated for short and long chunks.
    const shortDelay = delayForChunkByLength("짧아", config, () => 0.42857142857142855);
    const longDelay = delayForChunkByLength("긴 문장".repeat(40), config, () => 0.42857142857142855);
    const clampedDelay = delayForChunkByLength("아주 긴 문장".repeat(400), config, () => 1);

    // Then: longer text waits longer, and the clamp is respected.
    expect(shortDelay).toBe(650);
    expect(longDelay).toBeGreaterThan(shortDelay);
    expect(clampedDelay).toBe(6500);
  });

  it("splits provider chunks by service chat-bubble limits without exceeding hard Discord limits", () => {
    // Given: provider output includes an overlong chat bubble.
    const overlong = `첫 문장 ${"가".repeat(160)} 두 번째 문장`;

    // When: the service normalizes chunks for delivery.
    const chunks = splitDeliveryChunks([overlong, "  ", "짧은 말"], {
      ...DEFAULT_CONVERSATION_CONFIG,
      maxChunkChars: 40,
      maxChunks: 5,
    });

    // Then: empty chunks disappear and every delivered bubble respects the configured cap.
    expect(chunks).toHaveLength(5);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(chunks.at(-1)).not.toBe("");
  });
});
