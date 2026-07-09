// lib/intelligence/roi-ledger.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ROI LEDGER — "what your AI team earned", live on the Command Center
// instead of buried in a monthly artifact. Every number traces to a ledger row
// in the trailing window (the SAME counting rules as the board packet — no
// second formula): marketing-attributed closed volume from the attribution
// engine, calls the AI answered, appointments it booked live, drafts agents
// actually sent, opt-outs honored. This is the renewal conversation and the
// anti-churn weapon in one tile: competitors show brokers their agents'
// numbers — we show brokers the SOFTWARE's numbers, measured, not claimed.

export interface RoiLedger {
  periodDays: number
  sinceIso: string
  /** Attribution-weighted closed volume credited to AI marketing (cents). */
  attributedGciCents: number
  /** Distinct closed transactions carrying attribution credits. */
  attributedDeals: number
  /** Inbound calls the AI answered. */
  callsAnswered: number
  /** Appointments booked live on AI calls. */
  appointmentsBooked: number
  /** AI reply drafts agents accepted/sent. */
  draftsSent: number
  /** Opt-outs honored immediately (compliance is a feature). */
  optOutsHonored: number
  /** The one-line headline for the tile (empty when there is nothing earned). */
  headline: string
}

const money = (cents: number) => {
  const v = Math.round(Math.max(0, cents) / 100)
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (v >= 10_000) return `$${Math.round(v / 1000).toLocaleString("en-US")}K`
  return `$${v.toLocaleString("en-US")}`
}

/** PURE: the headline sentence — earned lines only, silence when nothing earned. */
export function composeRoiHeadline(l: Omit<RoiLedger, "headline">): string {
  const parts: string[] = []
  if (l.attributedGciCents > 0) parts.push(`${money(l.attributedGciCents)} closed volume attributed to AI marketing across ${l.attributedDeals} deal${l.attributedDeals === 1 ? "" : "s"}`)
  if (l.callsAnswered > 0) parts.push(`${l.callsAnswered} call${l.callsAnswered === 1 ? "" : "s"} answered${l.appointmentsBooked > 0 ? ` (${l.appointmentsBooked} booked live)` : ""}`)
  if (l.draftsSent > 0) parts.push(`${l.draftsSent} AI draft${l.draftsSent === 1 ? "" : "s"} your agents sent`)
  if (parts.length === 0) return ""
  return `Last ${l.periodDays} days: ${parts.join(" · ")} — measured by the attribution engine, not claimed.`
}

/** Trailing-window ROI from the live ledgers (board-packet counting rules). */
export async function generateRoiLedger(svc: any, brokerageId: string, periodDays = 90): Promise<RoiLedger> {
  const sinceIso = new Date(Date.now() - periodDays * 86_400_000).toISOString()
  const cnt = async (q: any) => ((await q) as any)?.count ?? 0
  const [credits, calls, bookings, drafts, optOuts] = await Promise.all([
    svc.from("marketing_attribution_credits").select("credit_dollars, transaction_id")
      .eq("brokerage_id", brokerageId).gte("created_at", sinceIso).limit(2000),
    cnt(svc.from("voice_calls").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("direction", "inbound").gte("started_at", sinceIso)),
    cnt(svc.from("showings").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).ilike("notes", "%AI receptionist%").gte("created_at", sinceIso)),
    cnt(svc.from("ai_message_drafts").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).in("status", ["accepted", "sent", "edited"]).gte("created_at", sinceIso)),
    cnt(svc.from("voice_calls").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("outcome", "opt_out").gte("started_at", sinceIso)),
  ])
  const rows = ((credits as any)?.data ?? []) as Array<{ credit_dollars: number | null; transaction_id: string | null }>
  const base = {
    periodDays, sinceIso,
    attributedGciCents: rows.reduce((a, c) => a + Math.round(Number(c.credit_dollars ?? 0) * 100), 0),
    attributedDeals: new Set(rows.map((c) => c.transaction_id).filter(Boolean)).size,
    callsAnswered: calls, appointmentsBooked: bookings, draftsSent: drafts, optOutsHonored: optOuts,
  }
  return { ...base, headline: composeRoiHeadline(base) }
}
