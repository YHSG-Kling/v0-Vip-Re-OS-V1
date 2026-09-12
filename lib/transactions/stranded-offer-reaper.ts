// lib/transactions/stranded-offer-reaper.ts
// ─────────────────────────────────────────────────────────────────────────────
// STRANDED-OFFER REAPER (server) — closes the offer→under-contract blind spot. An offer accepted in the
// agent workspace (kernel offer path) does NOT create a transaction when none exists yet, and
// createTransactionFromOffer is compliance-gated — so an accepted offer can sit with no transaction, no
// milestones, no Deal Coordinator pickup, and nothing watched for it. This sweeps accepted-but-stranded
// offers past the grace window and ESCALATES each to the responsible agent so the deal isn't silently
// lost (it does not force the transaction — the compliance gate is real). Idempotent (one alert per
// offer). Best-effort; never throws. Mirrors the manager-signals / video / workflow-run reapers.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { classifyStrandedOffer, STRANDED_OFFER_GRACE_HOURS } from "./stranded-offer-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface StrandedOfferReapResult { scanned: number; escalated: number }

export async function reapStrandedAcceptedOffers(
  brokerageId: string, client?: Svc, opts?: { limit?: number },
): Promise<StrandedOfferReapResult> {
  const svc = client ?? createServiceClient()
  const result: StrandedOfferReapResult = { scanned: 0, escalated: 0 }
  if (!brokerageId) return result

  const now = Date.now()
  const sinceIso = new Date(now - STRANDED_OFFER_GRACE_HOURS * 3_600_000).toISOString()

  const { data } = await svc
    .from("offers")
    .select("id, listing_id, contact_id, status, transaction_id, responded_at, created_at")
    .eq("brokerage_id", brokerageId)
    .eq("status", "accepted")
    .is("transaction_id", null)
    .lt("responded_at", sinceIso)
    .order("responded_at", { ascending: true })
    .limit(opts?.limit ?? 200)

  for (const row of (data ?? []) as Array<{
    id: string; listing_id: string | null; contact_id: string | null
    status: string; transaction_id: string | null; responded_at: string | null; created_at: string
  }>) {
    result.scanned += 1
    const action = classifyStrandedOffer({
      status: row.status, transactionId: row.transaction_id,
      respondedAt: row.responded_at, createdAt: row.created_at, now,
    })
    if (action !== "escalate") continue

    // Idempotent — one alert per stranded offer.
    //
    // Fails CLOSED, and `error` is destructured for the reason this whole wave
    // exists: supabase-js RESOLVES a refused query, so `{ data }` alone turns
    // "the suppression check was refused" into "no prior alert" and re-alerts.
    // That is the same outcome an UNSTAMPED prior alert produces, since
    // `.eq("brokerage_id", …)` can never match NULL — the writer below stamps,
    // and this reader can now tell the two apart.
    const { data: prior, error: priorError } = await svc
      .from("notifications").select("id")
      .eq("brokerage_id", brokerageId).eq("type", "accepted_offer_stranded").eq("entity_id", row.id)
      .limit(1).maybeSingle()
    if (priorError) {
      console.error(`[stranded-offer-reaper] suppression read refused for offer ${row.id}:`, priorError.message)
      continue
    }
    if (prior) continue

    try {
      const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
      const agentUserId = await resolveResponsibleAgentUserId(svc, {
        recipient_contact_id: row.contact_id, entity_type: "listing", entity_id: row.listing_id,
      })
      if (!agentUserId) continue
      await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: brokerageId, type: "accepted_offer_stranded",
        title: "⚠️ An accepted offer isn't a tracked deal yet",
        body: "You accepted an offer but it hasn't become a transaction — finish the executed contract and compliance so the Deal Coordinator opens the deal and starts the milestone clock.",
        entity_type: "offer", entity_id: row.id, priority: "high", is_read: false,
      })
      result.escalated += 1
    } catch (e) {
      console.error("[stranded-offer-reaper] escalation failed:", e)
    }
  }

  return result
}
