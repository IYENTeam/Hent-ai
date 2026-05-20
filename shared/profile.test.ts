import { describe, it, expect } from "vitest";
import { validateProfileId } from "./profile.js";

describe("validateProfileId", () => {
  it("accepts simple lowercase slug", () => {
    expect(validateProfileId("gothic")).toBe(true);
  });

  it("accepts slug with hyphens and digits", () => {
    expect(validateProfileId("my-profile-123")).toBe(true);
  });

  it("accepts slug with underscores", () => {
    expect(validateProfileId("dark_theme_v2")).toBe(true);
  });

  it("accepts single character", () => {
    expect(validateProfileId("a")).toBe(true);
  });

  it("accepts 'default'", () => {
    expect(validateProfileId("default")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateProfileId("")).toBe(false);
  });

  it("rejects path traversal with ..", () => {
    expect(validateProfileId("../escape")).toBe(false);
  });

  it("rejects forward slash", () => {
    expect(validateProfileId("foo/bar")).toBe(false);
  });

  it("rejects backslash", () => {
    expect(validateProfileId("foo\\bar")).toBe(false);
  });

  it("rejects IDs exceeding max length", () => {
    expect(validateProfileId("a".repeat(65))).toBe(false);
  });

  it("accepts ID at max length boundary", () => {
    expect(validateProfileId("a".repeat(64))).toBe(true);
  });

  it("rejects uppercase letters", () => {
    expect(validateProfileId("Gothic")).toBe(false);
  });

  it("rejects ID starting with hyphen", () => {
    expect(validateProfileId("-gothic")).toBe(false);
  });

  it("rejects ID starting with underscore", () => {
    expect(validateProfileId("_gothic")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(validateProfileId("my profile")).toBe(false);
  });

  it("rejects special characters", () => {
    expect(validateProfileId("gothic!")).toBe(false);
    expect(validateProfileId("gothic@home")).toBe(false);
  });
});
