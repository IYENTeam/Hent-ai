import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceDatabase } from "./db.js";
import { applyAmbientMemoryCleanup, inventoryAmbientMemoryCleanup } from "./ambient-memory-cleanup.js";

const scopes = [{ guildId: "1508658440736604230", channelId: "1508659103637966858" }, { guildId: "1483095221460799489", channelId: "1498703634098294976" }] as const;
const roots: string[] = [];
const scopeId = (scope: typeof scopes[number]) => `discord:${scope.guildId}:${scope.channelId}`;

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(): { db: ServiceDatabase; backup: string } {
  const root = mkdtempSync(join(tmpdir(), "ambient-cleanup-")); roots.push(root); const db = new ServiceDatabase(join(root, "service.sqlite"));
  for (const [scopeIndex, scope] of scopes.entries()) {
    db.createProfile({ id: `profile-${scopeIndex}`, name: `profile-${scopeIndex}` }); db.setChannelMapping(scope.channelId, { enabled: true, profileId: `profile-${scopeIndex}`, settings: { ambientMemoryMode: "external" } });
    for (let index = 1; index <= 24; index += 1) {
      const event = `${scopeIndex}-${index}`; db.db.prepare("INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at) VALUES (?,?,NULL,NULL,?,'user','discord-participant',?,?,?,0,'{}',?)").run(scopeId(scope), scope.channelId, event, event, `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      db.db.prepare("INSERT INTO participant_event_work (id,event_id,event_digest,guild_id,channel_id,status,observe_only,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'observe',0,1,1)").run(`work-${event}`, event, `digest-${event}`, scope.guildId, scope.channelId);
    }
  }
  const backup = join(root, "backup.sqlite"); db.db.pragma("wal_checkpoint(TRUNCATE)"); copyFileSync(join(root, "service.sqlite"), backup); return { db, backup };
}
function refreshBackup(item: { readonly db: ServiceDatabase; readonly backup: string }): void { item.db.db.pragma("wal_checkpoint(TRUNCATE)"); copyFileSync(join(roots.at(-1)!, "service.sqlite"), item.backup); }
describe("ambient memory cleanup V2 protection", () => {
  it("retains tick high-watermark and snapshot raw ingress while pruning only eligible terminal ingress", () => {
    const item = fixture(); const scope = scopes[0]; const raw = item.db.db.prepare("SELECT id FROM conversation_raw_events WHERE scope_id=? AND message_id='0-1'").get(scopeId(scope)) as { id: number };
    item.db.db.prepare("INSERT INTO conversation_participation_ticks (id,guild_id,channel_id,mode,primary_contract_version,status,anchor_work_id,snapshot_high_watermark_id,snapshot_json,snapshot_utf8_bytes,snapshot_digest,persona_source,persona_text,persona_utf8_bytes,persona_digest,persona_revision,created_at_ms,updated_at_ms) VALUES ('tick',? ,?,'apply','v2','bound','work-0-1',?,'{}',2,?,'generic','x',1,?,?,1,1)").run(scope.guildId, scope.channelId, raw.id, "0".repeat(64), "1".repeat(64), "2".repeat(64));
    item.db.db.prepare("INSERT INTO conversation_participation_snapshot_turns (tick_id,ordinal,raw_event_id,content,content_utf8_bytes,content_digest) VALUES ('tick',0,?,'x',1,?)").run(raw.id, "3".repeat(64));
    item.db.db.pragma("wal_checkpoint(TRUNCATE)"); copyFileSync(join(roots.at(-1)!, "service.sqlite"), item.backup);
    const result = applyAmbientMemoryCleanup({ db: item.db, backupPath: item.backup });
    expect(result.deleted.rawEvents).toBeGreaterThan(0); expect(result.deleted.skippedProtectedTickAnchorWork).toBe(1); expect(result.deleted.skippedProtectedTickHighWatermarkRaw).toBe(1); expect(result.deleted.skippedProtectedSnapshotRaw).toBe(1); expect(item.db.db.prepare("SELECT message_id FROM conversation_raw_events WHERE id=?").get(raw.id)).toEqual({ message_id: "0-1" }); expect(inventoryAmbientMemoryCleanup(item.db).scopes[0]!.protectedTickRawEventCount).toBe(1);
  });
  it("refuses claimed work before a transaction begins", () => {
    const item = fixture(); item.db.db.prepare("UPDATE participant_event_work SET status='claimed' WHERE id='work-0-1'").run();
    expect(inventoryAmbientMemoryCleanup(item.db).ready).toBe(false); expect(() => applyAmbientMemoryCleanup({ db: item.db, backupPath: item.backup })).toThrow("claimed work");
  });
  it("uses canonical source and exact scope pairs while preserving protected raw and deleting complete old FK phases", () => {
    const item = fixture(); const scope = scopes[0]; const otherScope = scopes[1]; const now = Date.parse("2026-02-01T00:00:00.000Z"); vi.spyOn(Date, "now").mockReturnValue(now);
    const insertRaw = item.db.db.prepare("INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at) VALUES (?,?,NULL,NULL,?,'user',?,?,?,?,0,?,?)");
    insertRaw.run(scopeId(scope), scope.channelId, "0-1", "web-import", "other", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "{}", "2025-01-01T00:00:00.000Z");
    insertRaw.run(scopeId(scope), scope.channelId, "cross-pair", "discord-participant", "cross", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "{}", "2025-01-01T00:00:00.000Z");
    item.db.db.prepare("INSERT INTO participant_event_work (id,event_id,event_digest,guild_id,channel_id,status,observe_only,created_at_ms,updated_at_ms) VALUES ('cross-work','cross-pair','cross',? ,?,'observe',0,1,1)").run(scope.guildId, otherScope.channelId);
    insertRaw.run(scopeId(scope), scope.channelId, "reply-parent", "discord-participant", "parent", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "{}", "2025-01-01T00:00:00.000Z");
    insertRaw.run(scopeId(scope), scope.channelId, "reply-child", "discord-participant", "child", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", JSON.stringify({ replyTo: { messageId: "reply-parent" } }), "2026-01-02T00:00:00.000Z");
    item.db.db.prepare("INSERT INTO participant_event_work (id,event_id,event_digest,guild_id,channel_id,status,observe_only,created_at_ms,updated_at_ms) VALUES ('reply-parent-work','reply-parent','parent',? ,?,'observe',0,1,1)").run(scope.guildId, scope.channelId);
    item.db.db.prepare("INSERT INTO participant_delivery_plans (id,work_id,guild_id,channel_id,status,created_at_ms,updated_at_ms,decision_version) VALUES ('retry-plan','work-0-3',? ,?,'retryable',1,1,'v2')").run(scope.guildId, scope.channelId);
    item.db.db.prepare("INSERT INTO participant_delivery_plans (id,work_id,guild_id,channel_id,status,created_at_ms,updated_at_ms,decision_version) VALUES ('pending-plan','work-0-7',? ,?,'pending',1,1,'v2')").run(scope.guildId, scope.channelId);
    const raw = item.db.db.prepare("SELECT id FROM conversation_raw_events WHERE scope_id=? AND message_id='0-4'").get(scopeId(scope)) as { id: number };
    const oldTickTime = now - 7 * 24 * 60 * 60 * 1000 - 1;
    const tickValues = [scope.guildId, scope.channelId, raw.id, "0".repeat(64), "1".repeat(64), "2".repeat(64), oldTickTime, oldTickTime];
    item.db.db.prepare("INSERT INTO conversation_participation_ticks (id,guild_id,channel_id,mode,primary_contract_version,status,anchor_work_id,snapshot_high_watermark_id,snapshot_json,snapshot_utf8_bytes,snapshot_digest,persona_source,persona_text,persona_utf8_bytes,persona_digest,persona_revision,created_at_ms,updated_at_ms) VALUES ('old-tick',? ,?,'apply','v2','validated','work-0-4',?,'{}',2,?,'generic','x',1,?,?,?,?)").run(...tickValues);
    item.db.db.prepare("INSERT INTO conversation_participation_validations (tick_id,status,schema_version,model,missed_opportunity,interruption,confidence,prior_delta,rationale,rationale_utf8_bytes,prior_before,prior_after,prior_version_before,prior_version_after,created_at_ms,updated_at_ms) VALUES ('old-tick','applied','v2','test',0,0,1,0,'ok',2,0,0,1,2,?,?)").run(tickValues.at(-1), tickValues.at(-1));
    item.db.db.prepare("INSERT INTO conversation_participation_primary_chunks (tick_id,chunk_index,content,content_utf8_bytes,content_digest) VALUES ('old-tick',0,'x',1,?)").run("3".repeat(64));
    item.db.db.prepare("INSERT INTO conversation_participation_snapshot_turns (tick_id,ordinal,raw_event_id,content,content_utf8_bytes,content_digest) VALUES ('old-tick',0,?,'x',1,?)").run(raw.id, "4".repeat(64));
    item.db.db.prepare("INSERT INTO conversation_participation_coverage (tick_id,work_id,coverage_kind) VALUES ('old-tick','work-0-4','apply')").run();
    item.db.db.prepare("INSERT INTO participant_delivery_plans (id,work_id,guild_id,channel_id,status,created_at_ms,updated_at_ms,decision_version,tick_id) VALUES ('old-plan','work-0-5',? ,?,'delivered',1,1,'v2','old-tick')").run(scope.guildId, scope.channelId);
    item.db.db.prepare("INSERT INTO participant_delivery_chunks (plan_id,chunk_index,content,nonce) VALUES ('old-plan',0,'x','old-nonce')").run();
    item.db.db.prepare("INSERT INTO participant_delivery_receipts (plan_id,chunk_index,nonce,discord_message_id,received_at_ms) VALUES ('old-plan',0,'old-nonce','receipt',1)").run();
    const boundaryRaw = item.db.db.prepare("SELECT id FROM conversation_raw_events WHERE scope_id=? AND message_id='0-6'").get(scopeId(scope)) as { id: number };
    item.db.db.prepare("INSERT INTO conversation_participation_ticks (id,guild_id,channel_id,mode,primary_contract_version,status,anchor_work_id,snapshot_high_watermark_id,snapshot_json,snapshot_utf8_bytes,snapshot_digest,persona_source,persona_text,persona_utf8_bytes,persona_digest,persona_revision,created_at_ms,updated_at_ms) VALUES ('boundary-tick',? ,?,'apply','v2','validated','work-0-6',?,'{}',2,?,'generic','x',1,?,?,?,?)").run(scope.guildId, scope.channelId, boundaryRaw.id, "5".repeat(64), "6".repeat(64), "7".repeat(64), now - 7 * 24 * 60 * 60 * 1000, now - 7 * 24 * 60 * 60 * 1000);
    item.db.db.prepare("INSERT INTO conversation_participation_validations (tick_id,status,schema_version,model,missed_opportunity,interruption,confidence,prior_delta,rationale,rationale_utf8_bytes,prior_before,prior_after,prior_version_before,prior_version_after,created_at_ms,updated_at_ms) VALUES ('boundary-tick','applied','v2','test',0,0,1,0,'ok',2,0,0,1,2,?,?)").run(now - 7 * 24 * 60 * 60 * 1000, now - 7 * 24 * 60 * 60 * 1000);
    expect(inventoryAmbientMemoryCleanup(item.db).scopes[0]!.rawEventCount).toBe(27);
    refreshBackup(item); const result = applyAmbientMemoryCleanup({ db: item.db, backupPath: item.backup });
    expect(item.db.db.prepare("SELECT COUNT(*) AS count FROM conversation_raw_events WHERE author_source='web-import'").get()).toEqual({ count: 1 });
    expect(item.db.db.prepare("SELECT COUNT(*) AS count FROM conversation_raw_events WHERE message_id IN ('cross-pair','reply-parent','0-3','0-7')").get()).toEqual({ count: 4 });
    expect(result.deleted.skippedProtectedReplyAncestor).toBe(1); expect(result.deleted.skippedProtectedPlan).toBe(3);
    expect(item.db.db.prepare("SELECT id FROM conversation_participation_ticks WHERE id='boundary-tick'").get()).toEqual({ id: "boundary-tick" });
    expect(result.deleted.receipts).toBe(1); expect(result.deleted.deliveryChunks).toBe(1); expect(result.deleted.plans).toBe(1); expect(result.deleted.validations).toBe(1); expect(result.deleted.primaryChunks).toBe(1); expect(result.deleted.snapshotTurns).toBe(1); expect(result.deleted.coverage).toBe(1); expect(result.deleted.ticks).toBe(1);
  });
});
