import { randomUUID } from "node:crypto";
import type { ServiceDatabase } from "./db.js";
import type { ConversationDeliveryPlanResponse } from "./conversation-delivery-plan.js";

// Claims may be recovered only between host sends. An interrupted send without
// a receipt has an unknown outcome and must not be blindly sent a second time.
export const DELIVERY_CLAIM_MS = 60_000;
type DispatchRow = {
  plan_id: string;
  scope_id: string;
  plan_json: string;
  claim_id: string;
  expires_at_ms: number;
  in_flight_chunk_id: string | null;
  receipts_json: string;
};
export type DeliveryProgressInput = {
  readonly planId: string;
  readonly claimId: string;
  readonly action: "begin" | "receipt" | "release";
  readonly chunkId?: string;
  readonly messageId?: string;
};

export class ConversationDeliveryDispatch {
  constructor(private readonly database: ServiceDatabase) {}

  claim(planId: string, scopeId: string, now: number, create: () => ConversationDeliveryPlanResponse, cooldown?: { key: string; ms: number }): ConversationDeliveryPlanResponse | undefined {
    return this.database.db.transaction(() => {
      if (cooldown && this.database.db.prepare(`SELECT 1 FROM conversation_gate_state
        WHERE scope_id=? AND state_key=? AND updated_at>?`).get(scopeId, cooldown.key, new Date(now - cooldown.ms).toISOString())) return undefined;
      const busy = this.database.db.prepare(`SELECT 1 FROM conversation_delivery_dispatch d
        JOIN conversation_delivery_ledger l ON l.plan_id=d.plan_id
        WHERE d.scope_id=? AND l.status='planned'
          AND (d.expires_at_ms>? OR d.in_flight_chunk_id IS NOT NULL) LIMIT 1`).get(scopeId, now);
      if (busy) return undefined;
      const existing = this.row(planId);
      const ledger = this.database.db.prepare("SELECT status FROM conversation_delivery_ledger WHERE plan_id=?").get(planId) as { status: string } | undefined;
      if (ledger?.status === "committed") return undefined;
      // Pre-upgrade planned rows have unknown delivery history. Do not replay them.
      if (ledger && !existing) return undefined;
      const plan = existing ? JSON.parse(existing.plan_json) as ConversationDeliveryPlanResponse : create();
      const claimId = randomUUID();
      const expiresAtMs = now + DELIVERY_CLAIM_MS + plan.chunks.reduce((sum, chunk) => sum + chunk.delayMs, 0);
      this.database.db.prepare(`INSERT INTO conversation_delivery_dispatch
        (plan_id, scope_id, plan_json, claim_id, expires_at_ms, receipts_json) VALUES (?, ?, ?, ?, ?, '{}')
        ON CONFLICT(plan_id) DO UPDATE SET claim_id=excluded.claim_id, expires_at_ms=excluded.expires_at_ms`)
        .run(planId, scopeId, JSON.stringify(plan), claimId, expiresAtMs);
      return { ...plan, dispatch: { claimId, expiresAtMs, deliveryMessageIds: existing ? JSON.parse(existing.receipts_json) as Record<string, string> : {} } };
    }).immediate();
  }

  progress(input: DeliveryProgressInput, now: number): boolean {
    return this.database.db.transaction(() => {
      const row = this.row(input.planId);
      if (!row || row.claim_id !== input.claimId) return false;
      const plan = JSON.parse(row.plan_json) as ConversationDeliveryPlanResponse;
      const receipts = JSON.parse(row.receipts_json) as Record<string, string>;
      if (input.action === "release") {
        if (row.in_flight_chunk_id) return false;
        this.database.db.prepare("UPDATE conversation_delivery_dispatch SET expires_at_ms=0 WHERE plan_id=?").run(input.planId);
        return true;
      }
      if (!input.chunkId || !plan.commit.requiredChunkIds.includes(input.chunkId)) return false;
      if (input.action === "receipt") {
        if (!input.messageId) return false;
        if (receipts[input.chunkId]) return receipts[input.chunkId] === input.messageId;
        // Late receipts resolve an uncertain send even after its timer expired.
        if (row.in_flight_chunk_id !== input.chunkId) return false;
        receipts[input.chunkId] = input.messageId;
        const remainingDelayMs = plan.chunks.filter((chunk) => !receipts[chunk.chunkId])
          .reduce((sum, chunk) => sum + chunk.delayMs, 0);
        this.database.db.prepare(`UPDATE conversation_delivery_dispatch
          SET receipts_json=?, in_flight_chunk_id=NULL, expires_at_ms=? WHERE plan_id=?`)
          .run(JSON.stringify(receipts), now + DELIVERY_CLAIM_MS + remainingDelayMs, input.planId);
        return true;
      }
      const ledger = this.database.db.prepare("SELECT status FROM conversation_delivery_ledger WHERE plan_id=?").get(input.planId) as { status: string } | undefined;
      if (ledger?.status !== "planned") return false;
      if (row.expires_at_ms <= now || row.in_flight_chunk_id || receipts[input.chunkId]) return false;
      const next = plan.commit.requiredChunkIds.find((chunkId) => !receipts[chunkId]);
      if (next !== input.chunkId) return false;
      this.database.db.prepare(`UPDATE conversation_delivery_dispatch SET in_flight_chunk_id=?, expires_at_ms=? WHERE plan_id=?`)
        .run(input.chunkId, now + DELIVERY_CLAIM_MS, input.planId);
      return true;
    }).immediate();
  }

  private row(planId: string): DispatchRow | undefined {
    return this.database.db.prepare("SELECT * FROM conversation_delivery_dispatch WHERE plan_id=?").get(planId) as DispatchRow | undefined;
  }
}
