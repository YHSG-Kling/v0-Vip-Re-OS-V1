// lib/intelligence/dual-transaction-timing-runner.ts
//
// Live side of DUAL-TRANSACTION TIMING — for a move-up contact (contact_type='both', linked by
// dual-intent-linker), gather the SELLER side (their current listing's stage + sale close date) and
// the BUYER side (recent tours + offers), decide the timing play (pure planDualTransactionTiming), and
// publish the manager-to-manager coordination on the bus so the Listing Concierge and Shopping Agent
// never drift out of sync. Idempotent per (contact, play). Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { planDualTransactionTiming, type DualSellerStage } from "./dual-transaction-timing"

type Svc = ReturnType<typeof createServiceClient>
const DAY = 86_400_000

function sellerStageFromListing(status: string | null, lifecycleStage: string | null): DualSellerStage {
  const s = `${status ?? ""} ${lifecycleStage ?? ""}`.toLowerCase()
  if (/closing|clear.?to.?close/.test(s)) return "closing_soon"
  if (/under.?contract|pending/.test(s)) return "under_contract"
  if (/sold|closed/.test(s)) return "sold"
  if (/active|coming_soon|mls/.test(s)) return "listing_active"
  return "none"
}

export interface DualTimingArgs { brokerageId: string; contactId: string; now?: string }

export async function coordinateDualTransaction(args: DualTimingArgs, client?: Svc): Promise<{ coordinated: boolean; play: string | null }> {
  const svc = client ?? createServiceClient()
  const nowMs = new Date(args.now ?? new Date().toISOString()).getTime()

  // SELLER side — the contact's own listing (they're the seller_contact_id).
  const { data: listing } = await svc.from("listings")
    .select("id, status, lifecycle_stage").eq("seller_contact_id", args.contactId)
    .not("status", "in", '("sold","closed","withdrawn","expired","cancelled")')
    .order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (!listing) return { coordinated: false, play: null } // not a seller (yet) — nothing dual to coordinate
  const sellerStage = sellerStageFromListing((listing as any).status, (listing as any).lifecycle_stage)

  // Sale close date — from a transaction tied to that listing.
  let sellerCloseInDays: number | null = null
  const { data: txn } = await svc.from("transactions")
    .select("estimated_close_date").eq("listing_id", (listing as any).id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle()
  const close = (txn as any)?.estimated_close_date
  if (close) { const t = new Date(close).getTime(); if (Number.isFinite(t)) sellerCloseInDays = Math.floor((t - nowMs) / DAY) }

  // BUYER side — recent tours + any offers this contact wrote.
  const { count: recentTours } = await svc.from("showings").select("id", { count: "exact", head: true })
    .eq("contact_id", args.contactId).gte("scheduled_at", new Date(nowMs - 30 * DAY).toISOString())
  const { count: offers } = await svc.from("offers").select("id", { count: "exact", head: true })
    .eq("contact_id", args.contactId)

  const timing = planDualTransactionTiming({
    sellerStage, sellerCloseInDays,
    buyerActivelyShopping: (recentTours ?? 0) > 0,
    buyerHasOffer: (offers ?? 0) > 0,
  })
  if (!timing.coordinate || !timing.play || !timing.from || !timing.to) return { coordinated: false, play: timing.play }

  // Idempotent — one coordination per (contact, play) within the window.
  const since = new Date(nowMs - 14 * DAY).toISOString()
  const { data: prior } = await svc.from("manager_signals")
    .select("id").eq("brokerage_id", args.brokerageId).eq("signal_type", "dual_transaction_timing")
    .eq("contact_id", args.contactId).gte("created_at", since).ilike("message", `%${timing.play}%`).limit(1).maybeSingle()
  if (prior) return { coordinated: false, play: timing.play }

  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const r = await publishManagerSignal({
      brokerageId: args.brokerageId, fromManager: timing.from as any, toManager: timing.to as any,
      signalType: "dual_transaction_timing",
      message: `Move-up coordination (${timing.play}): ${timing.reason}.`,
      entityType: "contact", entityId: args.contactId, contactId: args.contactId,
      payload: { play: timing.play, sellerStage, sellerCloseInDays, reason: timing.reason },
    }, svc)
    return { coordinated: !!(r as any).ok, play: timing.play }
  } catch {
    return { coordinated: false, play: timing.play }
  }
}
