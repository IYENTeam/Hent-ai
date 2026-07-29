import { parseConversationParticipationPrimary } from "../src/adaptive-ambient-proposal-parser.js";
import {
  canonicalUtf8Bytes,
  materializeConversationParticipantContext,
  sha256Utf8,
  type ConversationParticipantRawEvent,
} from "../src/conversation-participant-context.js";

const scopeId = "discord:calibration-guild:calibration-channel";
const rows: readonly ConversationParticipantRawEvent[] = [
  raw(1, "m1", "human-a", "첫 메시지", "2026-07-25T12:00:00.000Z"),
  raw(2, "m2", "human-b", "앞 메시지에 답해요", "2026-07-25T12:01:00.000Z", "m1"),
  raw(3, "m3", "human-a", "이번 틱의 앵커", "2026-07-25T12:02:00.000Z"),
  raw(4, "m4", "human-b", "판단 뒤에 들어온 메시지", "2026-07-25T12:03:00.000Z"),
];

function main(): void {
  const first = materializeConversationParticipantContext(scopeId, rows.slice(0, 3), "m3");
  invariant(first.kind === "valid", "a canonical V2 snapshot materializes");
  if (first.kind !== "valid") return;

  const replay = materializeConversationParticipantContext(scopeId, rows, "m3");
  invariant(replay.kind === "valid", "the same selected anchor remains materializable after later ingress");
  if (replay.kind !== "valid") return;

  invariant(first.snapshot.turns.some((turn) => turn.messageId === "m3"), "the selected eligible work item is included as the immutable anchor");
  invariant(first.snapshot.highWatermarkId === 3, "the high-watermark is frozen at bind time");
  invariant(!first.snapshot.turns.some((turn) => turn.messageId === "m4"), "post-high-watermark ingress is deferred to a later tick");
  invariant(replay.snapshot.highWatermarkId === 4, "later ingress is visible only to a later materialization");
  invariant(first.snapshot.highWatermarkId === 3, "later materialization cannot mutate the already-bound high-watermark");
  invariant(canonicalUtf8Bytes(first.snapshot.canonicalJson) === first.snapshot.utf8Bytes, "snapshot UTF-8 bytes are canonical");
  invariant(sha256Utf8(first.snapshot.canonicalJson) === first.snapshot.digest, "snapshot digest matches canonical bytes");
  invariant(first.snapshot.turns.some((turn) => turn.messageId === "m1"), "reply ancestors are retained in bounded context");

  const multibyteChunk = "가".repeat(500);
  const primary = (chunks: readonly string[]) => JSON.stringify({
    schema: "hent_ai.conversation_participation.primary.v2",
    decision: "speak",
    baselineDecision: "speak",
    judgmentClass: "definitive",
    semanticMargin: 0.2,
    priorApplied: false,
    confidence: 0.8,
    chunks,
  });
  invariant(parseConversationParticipationPrimary(primary([multibyteChunk])).kind === "valid", "a multibyte chunk below the byte cap is accepted");
  invariant(parseConversationParticipationPrimary(primary(["가".repeat(601)])).kind === "invalid", "a multibyte chunk above the byte cap is rejected by bytes, not code points");

  console.log(JSON.stringify({
    schema: "hent_ai.conversation_participant_calibration.v2",
    deterministic: true,
    anchorMessageId: "m3",
    highWatermarkId: first.snapshot.highWatermarkId,
    turnCount: first.snapshot.turns.length,
    snapshotUtf8Bytes: first.snapshot.utf8Bytes,
    snapshotDigest: first.snapshot.digest,
    postHighWatermarkDeferred: true,
    replyAncestorRetained: true,
    multibyteBoundaryEnforced: true,
  }, null, 2));
}

function raw(id: number, messageId: string, authorId: string, text: string, eventTs: string, replyMessageId?: string): ConversationParticipantRawEvent {
  return {
    id,
    scopeId,
    messageId,
    authorSource: "discord-participant",
    authorRole: "user",
    text,
    eventTs,
    metadataJson: JSON.stringify({ discordAuthorId: authorId, discordAuthorBot: false, ...(replyMessageId ? { replyTo: { messageId: replyMessageId, authorId: "human-a" } } : {}) }),
  };
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`calibration invariant failed: ${message}`);
}

main();
