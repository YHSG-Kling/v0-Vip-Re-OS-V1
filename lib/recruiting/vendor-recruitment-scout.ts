// lib/recruiting/vendor-recruitment-scout.ts
//
// VENDOR RECRUITMENT SCOUT (recruiting_manager) — the live side of the marketplace-growth play and the
// exact mirror of the switch-propensity scout. Weekly it finds the vendors the brokerage already relies
// on but that are still OFF-PLATFORM (no portal account, no pending invite), scores each by
// recruitment-propensity (reliance + quality + spend), and proposes ONE gated "invite these vendors"
// brief to the broker — so the marketplace grows toward the vendors it already depends on FIRST, and
// their bookings/payments/SLA/reviews become tracked and monetizable. Reuses the gated proposal rail
// (nothing auto-sends) and the existing inviteVendorToPlatformAction handshake. Idempotent per
// (brokerage, ISO week). Best-effort; never throws into a caller.

import { createServiceClient } from "@/lib/supabase/service"
import { rankVendorsByRecruitmentPropensity, type ScoredVendor, type VendorRecruitSignals } from "@/lib/recruiting/vendor-recruitment-propensity"
import { isoWeekKey } from "@/lib/recruiting/switch-propensity-scout"

type Svc = ReturnType<typeof createServiceClient>

/** PURE: the broker brief body from the ranked vendors (top N hot/warm invite targets). */
export function buildVendorInviteBrief(ranked: ScoredVendor[], topN = 5): { subject: string; body: string } | null {
  const targets = ranked.filter((v) => v.tier !== "cool").slice(0, topN)
  if (targets.length === 0) return null
  const lines = [
    `Vendors you already rely on but who aren't on your marketplace yet — worth inviting first:`,
    ...targets.map((t, i) => `${i + 1}. ${t.name}${t.category ? ` (${t.category})` : ""} — ${Math.round(t.score * 100)}% (${t.tier}). ${t.reasons[0] ?? ""}`),
    `Inviting them onto the platform makes every booking, payment, SLA and review tracked — and opens a marketplace revenue share. I've left the outreach in your queue; approve to send.`,
  ]
  return { subject: `Top ${targets.length} vendors to recruit onto your marketplace`, body: lines.join("\n\n") }
}

export interface VendorScoutResult { scored: number; hot: number; briefProposed: boolean }

/** Aggregate the real reliance/quality/spend signals for a brokerage's vendors (best-effort). */
async function gatherVendorSignals(svc: Svc, brokerageId: string): Promise<Map<string, VendorRecruitSignals>> {
  const sig = new Map<string, VendorRecruitSignals>()
  const bump = (id: string): VendorRecruitSignals => {
    let s = sig.get(id)
    if (!s) { s = { totalBookings: null, totalSpend: null, avgRating: null, fiveStarRatio: null }; sig.set(id, s) }
    return s
  }

  // Rating aggregates (authoritative bookings count + rating live here).
  const { data: ratings } = await svc.from("vendor_ratings")
    .select("vendor_id, avg_agent_rating, avg_client_rating, five_star_count, total_bookings")
    .eq("brokerage_id", brokerageId).limit(2000)
  for (const r of (ratings ?? []) as any[]) {
    const s = bump(r.vendor_id)
    const rs = [r.avg_agent_rating, r.avg_client_rating].filter((x) => typeof x === "number" && x > 0)
    s.avgRating = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null
    s.totalBookings = typeof r.total_bookings === "number" ? r.total_bookings : null
    s.fiveStarRatio = r.total_bookings > 0 && typeof r.five_star_count === "number" ? r.five_star_count / r.total_bookings : null
  }

  // Booking spend (and a booking-count fallback where no rating row exists).
  const { data: bookings } = await svc.from("vendor_bookings")
    .select("vendor_id, cost").eq("brokerage_id", brokerageId).limit(5000)
  const bookCount = new Map<string, number>()
  for (const b of (bookings ?? []) as any[]) {
    const s = bump(b.vendor_id)
    if (typeof b.cost === "number" && b.cost > 0) s.totalSpend = (s.totalSpend ?? 0) + b.cost
    bookCount.set(b.vendor_id, (bookCount.get(b.vendor_id) ?? 0) + 1)
  }
  for (const [id, n] of bookCount) { const s = bump(id); if (s.totalBookings == null) s.totalBookings = n }

  return sig
}

/** Score a brokerage's OFF-PLATFORM vendors and propose one gated weekly invite brief. Best-effort. */
export async function runVendorRecruitmentScout(
  svc: Svc, params: { brokerageId: string; now?: Date },
): Promise<VendorScoutResult> {
  const out: VendorScoutResult = { scored: 0, hot: 0, briefProposed: false }
  const now = params.now ?? new Date()

  const { data: vendors } = await svc.from("vendors")
    .select("id, name, category, rating, status")
    .eq("brokerage_id", params.brokerageId).limit(1000)
  if (!vendors || vendors.length === 0) return out

  // OFF-PLATFORM = no portal account (user_role_assignments.vendor_id) and no pending invitation.
  const [{ data: onPlatform }, { data: pending }] = await Promise.all([
    svc.from("user_role_assignments").select("vendor_id").eq("brokerage_id", params.brokerageId).not("vendor_id", "is", null).limit(5000),
    svc.from("vendor_invitations").select("vendor_id").eq("brokerage_id", params.brokerageId).eq("status", "pending").limit(5000),
  ])
  const excluded = new Set<string>()
  for (const r of (onPlatform ?? []) as any[]) if (r.vendor_id) excluded.add(r.vendor_id)
  for (const r of (pending ?? []) as any[]) if (r.vendor_id) excluded.add(r.vendor_id)

  const candidates = (vendors as any[]).filter((v) => !excluded.has(v.id))
  if (candidates.length === 0) return out

  const signals = await gatherVendorSignals(svc, params.brokerageId)
  const enriched = candidates.map((v) => {
    const s = signals.get(v.id) ?? { totalBookings: null, totalSpend: null, avgRating: null, fiveStarRatio: null }
    // Fall back to the vendor's own directory rating when no review aggregates exist (honest: still may be null).
    if (s.avgRating == null && typeof v.rating === "number" && v.rating > 0) s.avgRating = v.rating
    return { id: v.id, name: v.name, category: v.category, ...s }
  })

  const ranked = rankVendorsByRecruitmentPropensity(enriched)
  out.scored = ranked.length
  out.hot = ranked.filter((v) => v.tier === "hot").length

  const brief = buildVendorInviteBrief(ranked)
  if (!brief) return out

  const dedupeTag = `VENDOR RECRUITMENT BRIEF — ${isoWeekKey(now)}`
  const { data: prior } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", params.brokerageId).eq("entity_type", "brokerage").eq("entity_id", params.brokerageId)
    .eq("agent_kind", "recruiting_manager").ilike("rationale", `${dedupeTag}%`).limit(1).maybeSingle()
  if (prior) return out

  try {
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: params.brokerageId, agentKind: "recruiting_manager", entityType: "brokerage", entityId: params.brokerageId,
      recipientContactId: null, audience: "agent",
      subject: brief.subject, body: brief.body,
      rationale: `${dedupeTag} — ${out.hot} hot / ${out.scored} scored; review before it reaches the broker.`,
      channel: "portal",
    }, svc)
    out.briefProposed = res.ok
  } catch { /* best-effort */ }
  return out
}

/** Autonomous: score every brokerage's off-platform vendors (rides the weekly recruit-outreach cron). */
export async function runVendorRecruitmentScoutAll(svc: Svc, now?: Date): Promise<{ brokerages: number; briefs: number; hot: number }> {
  const out = { brokerages: 0, briefs: 0, hot: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runVendorRecruitmentScout(svc, { brokerageId: b.id, now }); if (r.briefProposed) out.briefs++; out.hot += r.hot } catch { /* keep going */ }
  }
  return out
}
