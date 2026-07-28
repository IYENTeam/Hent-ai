import type Database from "better-sqlite3";
import type { Fence } from "./adaptive-ambient-store.js";

const CLAIM_TTL_MS = 30_000;

type Clock = () => number;
type FenceSql = (fence: Fence, now: number) => [string, string, number, number];

export function claimParticipantWork(
  db: Database.Database,
  clock: Clock,
  workId: string,
  fence: Fence,
  fencedWhere: string,
  fencedArgs: FenceSql,
): boolean {
  const now = clock();
  return db.prepare(`UPDATE participant_event_work SET status='claimed',claim_holder_id=?,claim_fence_token=?,claim_expires_at_ms=?,updated_at_ms=?
    WHERE id=? AND (status IN ('pending','retryable') OR (status='claimed' AND claim_expires_at_ms<=?)) AND ${fencedWhere}`)
    .run(fence.holderId, fence.fenceToken, now + CLAIM_TTL_MS, now, workId, now, ...fencedArgs(fence, now)).changes === 1;
}

export function renewParticipantWorkClaim(
  db: Database.Database,
  clock: Clock,
  workId: string,
  fence: Fence,
  fencedWhere: string,
  fencedArgs: FenceSql,
): boolean {
  const now = clock();
  return db.prepare(`UPDATE participant_event_work SET claim_expires_at_ms=?,updated_at_ms=?
    WHERE id=? AND status='claimed' AND claim_holder_id=? AND claim_fence_token=? AND claim_expires_at_ms>? AND ${fencedWhere}`)
    .run(now + CLAIM_TTL_MS, now, workId, fence.holderId, fence.fenceToken, now, ...fencedArgs(fence, now)).changes === 1;
}

export function isParticipantWorkClaimCurrent(db: Database.Database, clock: Clock, workId: string, fence: Fence): boolean {
  const now = clock();
  return db.prepare(`SELECT 1 FROM participant_event_work WHERE id=? AND status='claimed' AND claim_holder_id=?
    AND claim_fence_token=? AND claim_expires_at_ms>?`).get(workId, fence.holderId, fence.fenceToken, now) !== undefined;
}
