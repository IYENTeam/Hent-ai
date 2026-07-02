import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG } from "./conversation-config.js";
import { createConversationPersonaResolver, resolvePersonaText } from "./conversation-persona.js";
import { ServiceDatabase } from "./db.js";

describe("conversation persona bridge", () => {
  it("resolves channel profile soul before config and generic persona", () => {
    // Given: a channel is mapped to a profile with a soul snippet.
    const db = new ServiceDatabase();
    db.createProfile({
      id: "gothic",
      name: "Gothic",
      soulSnippet: "I am a real human, not a bot. Answer like a calm launch partner.",
    });
    db.setChannelMapping("c1", { profileId: "gothic", enabled: true });
    const resolvePersonaFor = createConversationPersonaResolver(db, {
      ...DEFAULT_CONVERSATION_CONFIG,
      persona: "Config persona should not win.",
    });

    // When: the decision provider asks for persona text for the channel.
    const persona = resolvePersonaFor("c1");

    // Then: the DB soul wins and identity claims are stripped.
    expect(persona).toEqual({
      source: "channel_profile",
      text: "You are HentAI, a concise bot presence. Never claim to be human. Persona notes: Answer like a calm launch partner.",
    });
    db.close();
  });

  it("falls back from config persona to generic persona with the same sanitizing boundary", () => {
    // Given: profile soul is absent but a config persona exists.
    const configPersona = resolvePersonaText({ soulSnippet: null, configPersona: "Prefer short Korean chat bubbles." });

    // When: neither profile nor config persona exists.
    const genericPersona = resolvePersonaText({ soulSnippet: null });

    // Then: config wins when present and generic remains bounded.
    expect(configPersona).toMatchObject({ source: "config" });
    expect(configPersona.text).toContain("Prefer short Korean chat bubbles.");
    expect(genericPersona).toMatchObject({ source: "generic" });
    expect(genericPersona.text).toContain("Never claim to be human");
  });
});
