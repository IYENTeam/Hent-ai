import { describe, it, expect } from "vitest";
import { buildBasePrompt, buildEmotionPrompt } from "./prompts.js";

describe("buildBasePrompt", () => {
  it("includes the character description", () => {
    const prompt = buildBasePrompt("cute orange cat");
    expect(prompt).toContain("cute orange cat");
  });

  it("returns a non-empty string", () => {
    const prompt = buildBasePrompt("robot");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("incorporates feedback when provided", () => {
    const prompt = buildBasePrompt("cat", ["make it cuter", "add stars"]);
    expect(prompt).toContain("make it cuter");
    expect(prompt).toContain("add stars");
  });

  it("works without feedback", () => {
    const prompt = buildBasePrompt("cat", []);
    expect(prompt).not.toContain("Feedback");
  });
});

describe("buildEmotionPrompt", () => {
  it("includes the character description", () => {
    const prompt = buildEmotionPrompt("pixel art robot", "happy");
    expect(prompt).toContain("pixel art robot");
  });

  it("includes emotion-specific keywords for known emotions", () => {
    expect(buildEmotionPrompt("cat", "happy")).toContain("smiling");
    expect(buildEmotionPrompt("cat", "neutral")).toContain("calm");
    expect(buildEmotionPrompt("cat", "loyalty")).toContain("salut");
    expect(buildEmotionPrompt("cat", "sorry")).toContain("apologetic");
    expect(buildEmotionPrompt("cat", "confused")).toContain("puzzled");
    expect(buildEmotionPrompt("cat", "focused")).toContain("concentrat");
  });

  it("falls back to emotion name for unknown emotions", () => {
    const prompt = buildEmotionPrompt("cat", "excited");
    expect(prompt).toContain("excited");
  });

  it("incorporates feedback when provided", () => {
    const prompt = buildEmotionPrompt("cat", "happy", ["more playful"]);
    expect(prompt).toContain("more playful");
  });

  it("works without feedback", () => {
    const prompt = buildEmotionPrompt("cat", "happy", []);
    expect(prompt).not.toContain("Feedback");
  });
});
