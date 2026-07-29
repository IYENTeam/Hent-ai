import { describe, expect, it } from "vitest";
import { GENERIC_CONVERSATION_PERSONA } from "./conversation-speech-policy.js";
import { materializeConversationParticipantContext, resolveConversationParticipantPersona } from "./conversation-participant-context.js";

const scopeId = "discord:1:2";
function row(id: number, messageId = String(id), overrides: Record<string, unknown> = {}) {
  return { id, scopeId, messageId, authorSource: "discord-participant", authorRole: "user" as const, text: `message ${id}`, eventTs: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(), metadataJson: JSON.stringify({ discordAuthorId: `author-${id}`, discordAuthorBot: false }), ...overrides };
}

describe("conversation participant V2 context", () => {
  it("uses source-qualified identities, deterministic ordering, and stable digests", () => {
    const input = [row(2), row(1), row(3, "2", { authorSource: "other-source" })];
    const first = materializeConversationParticipantContext(scopeId, input);
    const second = materializeConversationParticipantContext(scopeId, [...input].reverse());
    expect(first).toMatchObject({ kind: "valid" });
    expect(second).toMatchObject({ kind: "valid" });
    if (first.kind !== "valid" || second.kind !== "valid") throw new Error("expected valid context");
    expect(first.snapshot.highWatermarkId).toBe(2);
    expect(first.snapshot.turns.map((turn) => turn.messageId)).toEqual(["1", "2"]);
    expect(first.snapshot.digest).toBe(second.snapshot.digest);
  });
  it("keeps the newest 97 canonical rows despite other-source flooding and same message IDs", () => {
    const canonical = Array.from({ length: 98 }, (_, index) => row(index + 1, `canonical-${index + 1}`));
    const flood = Array.from({ length: 120 }, (_, index) => row(1_000 + index, `canonical-${index + 98}`, { authorSource: "other-source" }));
    const resolved = materializeConversationParticipantContext(scopeId, [...canonical, ...flood], "canonical-98");
    expect(resolved).toMatchObject({ kind: "valid" });
    if (resolved.kind !== "valid") throw new Error("expected valid context");
    expect(resolved.snapshot.highWatermarkId).toBe(98);
    expect(resolved.snapshot.turns).toHaveLength(97);
    expect(resolved.snapshot.turns.map((turn) => turn.messageId)).not.toContain("canonical-1");
  });

  it("fails closed on duplicate canonical identities and malformed metadata", () => {
    expect(materializeConversationParticipantContext(scopeId, [row(1), row(2, "1")])).toMatchObject({ kind: "snapshot_corrupt" });
    expect(materializeConversationParticipantContext(scopeId, [row(1, "1", { metadataJson: "{" })])).toMatchObject({ kind: "snapshot_corrupt" });
  });

  it("traverses reply ancestors and refuses byte-cap partial snapshots", () => {
    const parent = row(1);
    const child = row(2, "2", { metadataJson: JSON.stringify({ discordAuthorId: "author-2", discordAuthorBot: true, replyTo: { messageId: "1", authorId: "author-1" } }) });
    const resolved = materializeConversationParticipantContext(scopeId, [child, parent]);
    expect(resolved).toMatchObject({ kind: "valid" });
    if (resolved.kind !== "valid") throw new Error("expected valid context");
    expect(resolved.snapshot.turns.map((turn) => turn.messageId)).toEqual(["1", "2"]);
    expect(materializeConversationParticipantContext(scopeId, [row(1, "1", { text: "😀".repeat(2_049) })])).toMatchObject({ kind: "context_truncated" });
  });
  it("anchors to the selected eligible work event and closes reverse replies", () => {
    const anchor = row(1, "eligible");
    const newer = row(2, "newer");
    const reply = row(3, "reply", { authorRole: "assistant", metadataJson: JSON.stringify({ discordAuthorId: "bot", discordAuthorBot: true, replyTo: { messageId: "eligible", authorId: "author-1" } }) });
    const resolved = materializeConversationParticipantContext(scopeId, [anchor, newer, reply], "eligible");
    expect(resolved).toMatchObject({ kind: "valid" });
    if (resolved.kind !== "valid") throw new Error("expected valid context");
    expect(resolved.snapshot.turns.map((turn) => turn.messageId)).toContain("reply");
    expect(materializeConversationParticipantContext(scopeId, [anchor, newer], "missing")).toMatchObject({ kind: "snapshot_corrupt" });
  });

  it("distinguishes malformed reply metadata from an absent reply", () => {
    expect(materializeConversationParticipantContext(scopeId, [row(1, "1", { metadataJson: JSON.stringify({ discordAuthorId: "author-1", discordAuthorBot: false, replyTo: { messageId: "2" } }) })])).toMatchObject({ kind: "snapshot_corrupt" });
    expect(materializeConversationParticipantContext(scopeId, [row(1)])).toMatchObject({ kind: "valid" });
  });

  it("canonicalizes persona source, NFC text, and revision deterministically", () => {
    const profile = { id: "profile-1", updatedAt: "2026-01-01", soulSnippet: "  cafe\u0301  " };
    const first = resolveConversationParticipantPersona({ profile, configuredGlobalPersona: "global" });
    const second = resolveConversationParticipantPersona({ profile, configuredGlobalPersona: "global" });
    expect(first).toMatchObject({ source: "channel_profile", text: "café" });
    expect(first?.revision).toBe(second?.revision);
    expect(first?.revision).not.toBe(resolveConversationParticipantPersona({ profile: { ...profile, updatedAt: "2026-01-02" }, configuredGlobalPersona: "global" })?.revision);
  });
  it("uses the canonical generic persona fallback deterministically", () => {
    const input = { profile: null, configuredGlobalPersona: null };
    const first = resolveConversationParticipantPersona(input);
    const second = resolveConversationParticipantPersona(input);
    expect(first).toMatchObject({ source: "generic", text: GENERIC_CONVERSATION_PERSONA });
    expect(first).toEqual(second);
  });
});
