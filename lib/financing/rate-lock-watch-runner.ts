// lib/financing/rate-lock-watch-runner.ts
//
// Live side of the RATE-LOCK EXPIRATION WATCH. Scans active deals whose lender row carries a
// rate-lock expiration, computes the lock-vs-closing risk, and on an at_risk/expired verdict
// fires ONE gated Deal-Coordinator alert + an inter-manager bus signal (deal_coordinator →
// campaign_orchestrator) so the agent extends the lock BEFORE it lapses. Idempotent per
// (lender row, lock-expiration, status) within a window — never re-pings a standing state.
// Read-only on the deal; never throws into the caller. HONEST: a lender with no lock date is
// skipped (the pure engine returns not_applicable).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { computeRateLockRisk, type RateLockVerdict } from "./rate-lock-watch"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

export interface RateLockRunInput {
  brokerageId: string
  today?: string
  copyGenerator?: CopyGenerator
  escalate?: boolean
}

export interface RateLockRunResult { scanned: number; flagged: number; escalated: number }

const RECENT_ALERT_HOURS = 72

export async function runRateLockWatch(input: RateLockRunInput, client?: Svc): Promise<RateLockRunResult> {
  const svc = client ?? createServiceClient()
  const today = input.today ?? new Date().toISOString().slice(0, 10)
  const out: RateLockRunResult = { scanned: 0, flagged: 0, escalated: 0 }

  // Active deals with a lender rate-lock on file. Pull the deal's close target alongside.
  const { data: lenders } = await svc
    .from("transaction_lenders")
    .select("id, transaction_id, lender_name, rate_lock_expiration_date, transactions(brokerage_id, agent_id, status, estimated_close_date, close_date, property_address)")
    .not("rate_lock_expiration_date", "is", null)
    .limit(500)

  for (const row of (lenders ?? []) as any[]) {
    const txn = row.transactions
    if (!txn || txn.brokerage_id !== input.brokerageId) continue
    if (txn.status && ["closed", "cancelled", "lost", "dead"].includes(txn.status)) continue
    out.scanned++

    const scheduledCloseDate: string | null = txn.estimated_close_date ?? txn.close_date ?? null
    const verdict = computeRateLockRisk({
      today,
      rateLockExpirationDate: row.rate_lock_expiration_date,
      scheduledCloseDate,
    })
    if (!verdict.flagged || input.escalate === false) continue
    out.flagged++

    // IDEMPOTENCY: one alert per (transaction, lock-expiration, status) within the window.
    const dedupeKey = `RATE_LOCK:${row.rate_lock_expiration_date}:${verdict.status}`
    const sinceIso = new Date(Date.now() - RECENT_ALERT_HOURS * 3_600_000).toISOString()
    const { data: prior } = await svc
      .from("notifications")
      .select("id")
      .eq("entity_id", row.transaction_id)
      .eq("type", "rate_lock_watch")
      .ilike("body", `%${dedupeKey}%`)
      .gte("created_at", sinceIso)
      .limit(1)
      .maybeSingle()
    if (prior) continue

    const escalated = await escalate(svc, {
      brokerageId: input.brokerageId,
      transactionId: row.transaction_id,
      agentUserId: txn.agent_id ?? null,
      propertyAddress: txn.property_address ?? "this deal",
      verdict,
      dedupeKey,
      copyGenerator: input.copyGenerator,
    })
    if (escalated) out.escalated++
  }

  return out
}

async function escalate(
  svc: Svc,
  args: {
    brokerageId: string; transactionId: string; agentUserId: string | null; propertyAddress: string
    verdict: RateLockVerdict; dedupeKey: string; copyGenerator?: CopyGenerator
  },
): Promise<boolean> {
  const { verdict } = args
  const draft = await generatePersonaCopy(
    {
      goal: "a short internal alert to the deal coordinator that a buyer's mortgage rate lock is about to expire (or has) relative to the closing date, so they extend the lock before the buyer loses their rate",
      facts: [verdict.message],
      channel: "portal",
      persona: { audience: "agent", situation: "mortgage rate lock expiring vs closing date" },
      words: 50,
    },
    { body: verdict.message },
    { generator: args.copyGenerator },
  )

  let escalated = false
  try {
    if (args.agentUserId) {
      await svc.from("notifications").insert({
        user_id: args.agentUserId, brokerage_id: args.brokerageId, type: "rate_lock_watch",
        title: verdict.status === "expired" ? "⛔ Rate lock expired — buyer's rate at risk" : "⏳ Rate lock expiring vs closing date",
        // Carry the dedupe key in the body so the idempotency probe can find it.
        body: `${draft.body}\n\n[${args.dedupeKey}]`,
        entity_type: "transaction", entity_id: args.transactionId,
        priority: verdict.status === "expired" ? "critical" : "high",
      }).then(() => {}, () => {})
    }
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const sig = await publishManagerSignal({
      brokerageId: args.brokerageId, fromManager: "deal_coordinator", toManager: "campaign_orchestrator",
      signalType: "rate_lock_watch", message: draft.body,
      entityType: "transaction", entityId: args.transactionId,
      payload: { status: verdict.status, bufferDays: verdict.bufferDays, daysToExpiry: verdict.daysToExpiry },
    }, svc)
    escalated = sig.ok || !!args.agentUserId
  } catch { /* best-effort */ }
  return escalated
}
