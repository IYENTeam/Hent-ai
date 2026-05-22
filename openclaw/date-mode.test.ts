import { describe, it, expect } from "vitest";
import { buildDateModePrompt, DATE_MODE_DEFAULTS } from "./date-mode.js";

describe("buildDateModePrompt", () => {
  it("builds prompt with full profile (character + soulSnippet)", () => {
    const prompt = buildDateModePrompt({
      name: "Luna",
      character: "A dreamy artist who loves stargazing",
      soulSnippet: "Speak softly, use metaphors about the night sky",
    });

    expect(prompt).toContain("Date Mode");
    expect(prompt).toContain("Luna");
    expect(prompt).toContain("dreamy artist");
    expect(prompt).toContain("night sky");
    // The prompt frame says "Never mention tools" which is fine —
    // we just verify it doesn't contain tool-calling instructions
    expect(prompt).not.toContain("tool_call");
    expect(prompt).not.toContain("function_call");
  });

  it("builds prompt with character only (no soulSnippet)", () => {
    const prompt = buildDateModePrompt({
      name: "Kai",
      character: "A confident barista with a sharp wit",
      soulSnippet: null,
    });

    expect(prompt).toContain("Kai");
    expect(prompt).toContain("barista");
    expect(prompt).not.toContain("Personality ---");
    expect(prompt).not.toContain(DATE_MODE_DEFAULTS.persona);
  });

  it("builds prompt with soulSnippet only (no character)", () => {
    const prompt = buildDateModePrompt({
      name: "Mika",
      character: null,
      soulSnippet: "Always cheerful, ends sentences with ~",
    });

    expect(prompt).toContain("Mika");
    expect(prompt).toContain("cheerful");
    expect(prompt).toContain("Personality ---");
    expect(prompt).not.toContain(DATE_MODE_DEFAULTS.persona);
  });

  it("uses defaults when profile has no character or soulSnippet", () => {
    const prompt = buildDateModePrompt({
      name: "Default",
      character: null,
      soulSnippet: null,
    });

    expect(prompt).toContain(DATE_MODE_DEFAULTS.persona);
    expect(prompt).toContain("Date Mode");
  });

  it("uses defaults when profile is null", () => {
    const prompt = buildDateModePrompt(null);
    expect(prompt).toContain(DATE_MODE_DEFAULTS.persona);
  });

  it("uses defaults when profile is undefined", () => {
    const prompt = buildDateModePrompt();
    expect(prompt).toContain(DATE_MODE_DEFAULTS.persona);
  });

  it("trims whitespace from character and soulSnippet", () => {
    const prompt = buildDateModePrompt({
      name: "Test",
      character: "  padded character  ",
      soulSnippet: "  padded soul  ",
    });

    expect(prompt).toContain("padded character");
    expect(prompt).toContain("padded soul");
    expect(prompt).not.toContain("  padded");
  });

  it("never contains tool-related instructions", () => {
    const toolKeywords = [
      "tool_call",
      "function_call",
      "toolsAllow",
      "available tools",
      "you have access to",
      "use the following tools",
    ];

    const prompts = [
      buildDateModePrompt({ name: "A", character: "test", soulSnippet: "test" }),
      buildDateModePrompt({ name: "B" }),
      buildDateModePrompt(null),
      buildDateModePrompt(),
    ];

    for (const prompt of prompts) {
      for (const keyword of toolKeywords) {
        expect(prompt.toLowerCase()).not.toContain(keyword.toLowerCase());
      }
    }
  });

  it("handles empty string character and soulSnippet as absent", () => {
    const prompt = buildDateModePrompt({
      name: "Empty",
      character: "   ",
      soulSnippet: "   ",
    });

    expect(prompt).toContain(DATE_MODE_DEFAULTS.persona);
  });
});
