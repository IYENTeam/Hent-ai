import { createHash } from "node:crypto";
import { GENERIC_CONVERSATION_PERSONA } from "./conversation-speech-policy.js";

export const CONVERSATION_PARTICIPANT_SELECTOR_VERSION = "hent_ai.conversation_participant.selector.v2";
export const CONVERSATION_PARTICIPANT_PERSONA_VERSION = "hent_ai.conversation_participation.persona.v1";
export const MAX_PARTICIPANT_TURNS = 120;
export const MAX_PARTICIPANT_SNAPSHOT_BYTES = 49_152;
export const MAX_PARTICIPANT_TURN_BYTES = 8_192;

export type ConversationParticipantRawEvent = {
  readonly id: number;
  readonly scopeId: string;
  readonly messageId: string;
  readonly authorSource: string;
  readonly authorRole: "user" | "assistant" | "system";
  readonly text: string;
  readonly eventTs: string;
  readonly metadataJson: string;
};
export type ConversationParticipantTurn = {
  readonly id: number;
  readonly scopeId: string;
  readonly messageId: string;
  readonly authorSource: "discord-participant";
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly text: string;
  readonly eventTs: string;
  readonly replyTo: { readonly messageId: string; readonly authorId: string } | null;
};
export type ConversationParticipantSnapshot = {
  readonly selectorVersion: typeof CONVERSATION_PARTICIPANT_SELECTOR_VERSION;
  readonly highWatermarkId: number;
  readonly turns: readonly ConversationParticipantTurn[];
  readonly canonicalJson: string;
  readonly utf8Bytes: number;
  readonly digest: string;
};
export type ConversationParticipantContextResult =
  | { readonly kind: "valid"; readonly snapshot: ConversationParticipantSnapshot }
  | { readonly kind: "context_truncated"; readonly diagnostic: string }
  | { readonly kind: "snapshot_corrupt"; readonly diagnostic: string };
export type ParticipantPersonaSource = "channel_profile" | "configured_global" | "generic";
export type ConversationParticipantPersona = {
  readonly source: ParticipantPersonaSource;
  readonly text: string;
  readonly utf8Bytes: number;
  readonly digest: string;
  readonly revision: string;
};
export type ConversationParticipantPersonaInput = {
  readonly profile: { readonly id: string; readonly updatedAt: string | number | null; readonly soulSnippet: string | null | undefined } | null;
  readonly configuredGlobalPersona: string | null | undefined;
  readonly genericPersona?: string;
};

export function canonicalUtf8Bytes(value: string): number | null {
  return validUnicodeScalars(value) ? Buffer.byteLength(value, "utf8") : null;
}
export function sha256Utf8(value: string): string | null {
  return canonicalUtf8Bytes(value) === null ? null : createHash("sha256").update(value, "utf8").digest("hex");
}
export function stableCanonicalJson(value: unknown): string | null {
  try { return JSON.stringify(canonicalize(value)); } catch { return null; }
}
export function validUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) return false; index += 1; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function resolveConversationParticipantPersona(input: ConversationParticipantPersonaInput): ConversationParticipantPersona | null {
  const profileText = normalizedNonempty(input.profile?.soulSnippet);
  const globalText = normalizedNonempty(input.configuredGlobalPersona);
  const genericText = normalizedNonempty(input.genericPersona ?? GENERIC_CONVERSATION_PERSONA);
  const source: ParticipantPersonaSource = profileText ? "channel_profile" : globalText ? "configured_global" : "generic";
  const text = profileText ?? globalText ?? genericText;
  if (!text) return null;
  const utf8Bytes = canonicalUtf8Bytes(text);
  const digest = sha256Utf8(text);
  if (utf8Bytes === null || digest === null || utf8Bytes < 1 || utf8Bytes > 8_192) return null;
  const revisionJson = stableCanonicalJson({ version: CONVERSATION_PARTICIPANT_PERSONA_VERSION, source, profileId: source === "channel_profile" ? input.profile?.id ?? null : null, profileUpdatedAt: source === "channel_profile" ? input.profile?.updatedAt ?? null : null, text });
  const revision = revisionJson === null ? null : sha256Utf8(revisionJson);
  return revision === null ? null : { source, text, utf8Bytes, digest, revision };
}

export function materializeConversationParticipantContext(scopeId: string, rows: readonly ConversationParticipantRawEvent[], anchorMessageId?: string): ConversationParticipantContextResult {
  const canonicalRows = rows.filter((row) => row.scopeId === scopeId && Number.isSafeInteger(row.id) && row.id >= 0 && row.authorSource === "discord-participant");
  if (canonicalRows.length === 0) return corrupt("scope has no canonical raw events");
  const highWatermarkId = Math.max(...canonicalRows.map((row) => row.id));
  const byIdentity = new Map<string, ConversationParticipantRawEvent>();
  for (const row of canonicalRows) {
    const key = identity(row);
    if (byIdentity.has(key)) return corrupt("duplicate canonical source-qualified identity");
    if (toTurn(row) === null) return corrupt("canonical row has malformed metadata or Unicode");
    byIdentity.set(key, row);
  }
  const orderedNewest = [...canonicalRows].sort((left, right) => right.id - left.id || right.messageId.localeCompare(left.messageId));
  const anchor = anchorMessageId === undefined
    ? orderedNewest.find(eligibleAnchor)
    : byIdentity.get(canonicalIdentity(scopeId, anchorMessageId));
  if (!anchor || !eligibleAnchor(anchor)) return corrupt("no eligible canonical anchor");
  const selected = new Map<string, ConversationParticipantRawEvent>([[identity(anchor), anchor]]);
  const queue: { row: ConversationParticipantRawEvent; depth: number }[] = [{ row: anchor, depth: 0 }];
  const temporal = orderedNewest.slice(0, 97);
  const repliesByParentId = new Map<string, ConversationParticipantRawEvent[]>();
  for (const row of canonicalRows) {
    const reply = replyMetadata(row.metadataJson);
    if (reply.kind === "valid") (repliesByParentId.get(reply.reply.messageId) ?? repliesByParentId.set(reply.reply.messageId, []).get(reply.reply.messageId)!).push(row);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { row, depth } = queue[cursor]!;
    if (depth >= 12) continue;
    const neighbors: ConversationParticipantRawEvent[] = [];
    const reply = replyMetadata(row.metadataJson);
    if (reply.kind === "malformed") return corrupt("reply metadata is malformed");
    if (reply.kind === "valid") {
      const parent = byIdentity.get(canonicalIdentity(scopeId, reply.reply.messageId));
      if (!parent || parent.scopeId !== scopeId) return corrupt("reply parent is not a canonical source");
      neighbors.push(parent);
    }
    neighbors.push(...(repliesByParentId.get(row.messageId) ?? []));
    for (const candidate of temporal) {
      if (candidate.id === row.id) continue;
      const candidateTurn = toTurn(candidate)!;
      const rowTurn = toTurn(row)!;
      const distanceMs = Math.abs(Date.parse(candidate.eventTs) - Date.parse(row.eventTs));
      if (distanceMs <= 15 * 60_000 || (candidateTurn.authorId === rowTurn.authorId && distanceMs <= 30 * 60_000)) neighbors.push(candidate);
    }
    for (const neighbor of neighbors.sort((left, right) => right.id - left.id || right.messageId.localeCompare(left.messageId))) {
      if (selected.has(identity(neighbor))) continue;
      if (selected.size >= MAX_PARTICIPANT_TURNS) return truncated("semantic graph exceeds turn cap");
      selected.set(identity(neighbor), neighbor);
      queue.push({ row: neighbor, depth: depth + 1 });
    }
  }
  const turns: ConversationParticipantTurn[] = [];
  for (const row of [...selected.values()].sort((left, right) => left.id - right.id || left.messageId.localeCompare(right.messageId))) {
    const turn = toTurn(row)!;
    if (canonicalUtf8Bytes(turn.text)! > MAX_PARTICIPANT_TURN_BYTES) return truncated("turn exceeds UTF-8 byte cap");
    turns.push(turn);
  }
  const canonicalJson = stableCanonicalJson({ selectorVersion: CONVERSATION_PARTICIPANT_SELECTOR_VERSION, highWatermarkId, turns });
  const utf8Bytes = canonicalJson === null ? null : canonicalUtf8Bytes(canonicalJson);
  const digest = canonicalJson === null ? null : sha256Utf8(canonicalJson);
  if (canonicalJson === null || utf8Bytes === null || digest === null) return corrupt("snapshot cannot be canonically encoded");
  if (utf8Bytes > MAX_PARTICIPANT_SNAPSHOT_BYTES) return truncated("snapshot exceeds UTF-8 byte cap");
  return { kind: "valid", snapshot: { selectorVersion: CONVERSATION_PARTICIPANT_SELECTOR_VERSION, highWatermarkId, turns, canonicalJson, utf8Bytes, digest } };
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") { if (typeof value === "string" && !validUnicodeScalars(value)) throw new Error("invalid Unicode"); return value; }
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite number"); return value; }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") { const record = value as Record<string, unknown>; return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])])); }
  throw new Error("unsupported canonical JSON value");
}
function identity(row: ConversationParticipantRawEvent): string { return `${row.scopeId}\u0000${row.messageId}\u0000${row.authorSource}`; }
function canonicalIdentity(scopeId: string, messageId: string): string { return `${scopeId}\u0000${messageId}\u0000discord-participant`; }
function normalizedNonempty(value: string | null | undefined): string | null { if (typeof value !== "string" || !validUnicodeScalars(value)) return null; const normalized = value.normalize("NFC").trim(); return normalized.length > 0 ? normalized : null; }
type ReplyMetadata = { readonly kind: "absent" } | { readonly kind: "malformed" } | { readonly kind: "valid"; readonly reply: { readonly messageId: string; readonly authorId: string } };
function replyMetadata(value: string): ReplyMetadata {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!record(parsed)) return { kind: "malformed" };
    if (!Object.hasOwn(parsed, "replyTo") || parsed.replyTo === null || parsed.replyTo === undefined) return { kind: "absent" };
    if (!record(parsed.replyTo) || typeof parsed.replyTo.messageId !== "string" || parsed.replyTo.messageId.length === 0 || typeof parsed.replyTo.authorId !== "string" || parsed.replyTo.authorId.length === 0) return { kind: "malformed" };
    return { kind: "valid", reply: { messageId: parsed.replyTo.messageId, authorId: parsed.replyTo.authorId } };
  } catch { return { kind: "malformed" }; }
}
function eligibleAnchor(row: ConversationParticipantRawEvent): boolean { const turn = toTurn(row); return turn !== null && !turn.authorIsBot && row.authorRole === "user"; }
function toTurn(row: ConversationParticipantRawEvent): ConversationParticipantTurn | null {
  try {
    const metadata: unknown = JSON.parse(row.metadataJson);
    const reply = replyMetadata(row.metadataJson);
    if (!record(metadata) || reply.kind === "malformed" || typeof metadata.discordAuthorId !== "string" || typeof metadata.discordAuthorBot !== "boolean" || !validUnicodeScalars(row.text) || !validUnicodeScalars(row.messageId) || !validUnicodeScalars(row.eventTs) || !Number.isFinite(Date.parse(row.eventTs))) return null;
    return { id: row.id, scopeId: row.scopeId, messageId: row.messageId, authorSource: "discord-participant", authorId: metadata.discordAuthorId, authorIsBot: metadata.discordAuthorBot, text: row.text, eventTs: row.eventTs, replyTo: reply.kind === "valid" ? reply.reply : null };
  } catch { return null; }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function corrupt(diagnostic: string): ConversationParticipantContextResult { return { kind: "snapshot_corrupt", diagnostic }; }
function truncated(diagnostic: string): ConversationParticipantContextResult { return { kind: "context_truncated", diagnostic }; }
