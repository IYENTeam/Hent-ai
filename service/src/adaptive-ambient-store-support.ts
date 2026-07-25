import type Database from "better-sqlite3";
import type { Fence } from "./adaptive-ambient-store.js";

type Scope = { readonly guildId: string; readonly channelId: string };
type FencedWhere = (fence: Fence, now: number) => [string, string, number, number];

export function recordUnfencedDiagnostic(db: Database.Database, now: number, fence: Fence, diagnostic: string): void {
  db.prepare(`INSERT INTO participant_worker_diagnostics (lease_key,holder_id,fence_token,diagnostic,recorded_at_ms)
    VALUES (?, ?, ?, ?, ?)`).run(fence.key, fence.holderId, fence.fenceToken, diagnostic, now);
}

export function persistMembershipSnapshot(
  db: Database.Database,
  scope: Scope,
  memberIds: readonly string[],
  complete: boolean,
  observedAtMs: number,
  fence: Fence,
  now: number,
  fencedArgs: FencedWhere,
): boolean {
  return db.prepare(`INSERT INTO discord_membership_snapshots (guild_id,channel_id,member_ids_json,complete,observed_at_ms,holder_id,fence_token)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM adaptive_leases l WHERE l.lease_key=? AND l.holder_id=? AND l.fence_token=? AND l.expires_at_ms>?)
    ON CONFLICT(guild_id,channel_id) DO UPDATE SET member_ids_json=excluded.member_ids_json,complete=excluded.complete,observed_at_ms=excluded.observed_at_ms,holder_id=excluded.holder_id,fence_token=excluded.fence_token`)
    .run(scope.guildId, scope.channelId, JSON.stringify(memberIds), Number(complete), observedAtMs, fence.holderId, fence.fenceToken, ...fencedArgs(fence, now)).changes === 1;
}
