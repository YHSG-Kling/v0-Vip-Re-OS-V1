"use server"

/**
 * Smart Queue — replaces 5 separate contact-urgency widgets with one
 * segmented list. Single mental model: pick a chip, see the right contacts.
 *
 * Segments:
 *   🔥 Hot         — high-intent contacts ready to transact
 *   ⚠ At-risk     — relationships drifting; need re-engagement
 *   🆕 New        — recently created contacts not yet worked
 *   💎 Likely seller — predicted to list within ~90 days (PLS engine)
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { createServiceClient } from "@/lib/supabase/service"

export type SmartSegment = "hot" | "at_risk" | "new" | "likely_seller"

export interface SmartQueueRow {
  contactId: string
  fullName: string
  segment: SmartSegment
  signal: string
  /** Optional secondary line (e.g. last interaction date) */
  signalDetail?: string
  /** Suggested action key — links to a deep link in the CRM */
  suggestedAction: "draft_followup" | "schedule_appointment" | "open_contact"
}

export interface SmartQueueData {
  rows: SmartQueueRow[]
  counts: Record<SmartSegment, number>
}

const PER_SEGMENT_LIMIT = 25

export async function getSmartQueue(): Promise<SmartQueueData> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) {
    return EMPTY
  }
  const svc = createServiceClient()

  // Get THIS agent's contacts only (one base set, then segment them)
  const { data: contactRows } = await svc
    .from("contacts")
    .select("id, first_name, last_name, contact_type, lifecycle_state, engagement_score, created_at")
    .eq("agent_id", ctx.agentId)
    .limit(500)

  const contacts = contactRows ?? []
  if (contacts.length === 0) return EMPTY
  const contactIds = contacts.map((c: any) => c.id)

  // Pull supporting signals in parallel
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString()

  const [hotResult, sphereResult, plsResult] = await Promise.all([
    // Hot: contacts with intent_score from lead_score_history in past 7 days
    svc
      .from("lead_score_history")
      .select("contact_id, overall_score, intent_score, scored_at")
      .in("contact_id", contactIds)
      .gte("scored_at", sevenDaysAgo)
      .order("overall_score", { ascending: false })
      .limit(PER_SEGMENT_LIMIT),

    // At-risk: low sphere engagement scores
    svc
      .from("sphere_engagement_scores")
      .select("contact_id, score, last_interaction")
      .eq("agent_id", ctx.agentId)
      .lt("score", 40)
      .order("score", { ascending: true })
      .limit(PER_SEGMENT_LIMIT),

    // Likely seller: top predictive listing scores
    svc
      .from("predictive_listing_scores")
      .select("contact_id, listing_likelihood_score, top_signal")
      .eq("agent_id", ctx.agentId)
      .order("listing_likelihood_score", { ascending: false })
      .limit(PER_SEGMENT_LIMIT),
  ])

  const nameById = new Map(
    contacts.map((c: any) => [
      c.id,
      [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact",
    ])
  )

  const rows: SmartQueueRow[] = []
  const seen = new Set<string>()

  // 🔥 Hot
  for (const r of hotResult.data ?? []) {
    if (seen.has(r.contact_id)) continue
    if (!nameById.has(r.contact_id)) continue
    if ((r.overall_score ?? 0) < 70) continue
    rows.push({
      contactId: r.contact_id,
      fullName: nameById.get(r.contact_id)!,
      segment: "hot",
      signal: `Lead score ${Math.round(r.overall_score)} · high intent`,
      signalDetail: r.scored_at ? `Scored ${new Date(r.scored_at).toLocaleDateString()}` : undefined,
      suggestedAction: "draft_followup",
    })
    seen.add(r.contact_id)
  }

  // ⚠ At-risk
  for (const r of sphereResult.data ?? []) {
    if (seen.has(r.contact_id)) continue
    if (!nameById.has(r.contact_id)) continue
    const days = r.last_interaction
      ? Math.floor((Date.now() - new Date(r.last_interaction).getTime()) / 86_400_000)
      : 9999
    rows.push({
      contactId: r.contact_id,
      fullName: nameById.get(r.contact_id)!,
      segment: "at_risk",
      signal: `Engagement ${Math.round(Number(r.score ?? 0))}% · ${days}d quiet`,
      signalDetail: "Sphere score dropping",
      suggestedAction: "draft_followup",
    })
    seen.add(r.contact_id)
  }

  // 🆕 New (created in last 7 days, no high score yet)
  for (const c of contacts as any[]) {
    if (seen.has(c.id)) continue
    if (!c.created_at) continue
    if (new Date(c.created_at).getTime() < Date.now() - 7 * 86_400_000) continue
    rows.push({
      contactId: c.id,
      fullName: nameById.get(c.id)!,
      segment: "new",
      signal: `New ${c.contact_type ?? "contact"}`,
      signalDetail: `Added ${new Date(c.created_at).toLocaleDateString()}`,
      suggestedAction: "open_contact",
    })
    seen.add(c.id)
  }

  // 💎 Likely seller
  for (const r of plsResult.data ?? []) {
    if (seen.has(r.contact_id)) continue
    if (!nameById.has(r.contact_id)) continue
    const score = Number(r.listing_likelihood_score ?? 0)
    if (score < 60) continue
    rows.push({
      contactId: r.contact_id,
      fullName: nameById.get(r.contact_id)!,
      segment: "likely_seller",
      signal: `${Math.round(score)}% likely to list`,
      signalDetail: r.top_signal ?? undefined,
      suggestedAction: "schedule_appointment",
    })
    seen.add(r.contact_id)
  }

  const counts: Record<SmartSegment, number> = {
    hot: rows.filter((r) => r.segment === "hot").length,
    at_risk: rows.filter((r) => r.segment === "at_risk").length,
    new: rows.filter((r) => r.segment === "new").length,
    likely_seller: rows.filter((r) => r.segment === "likely_seller").length,
  }

  return { rows, counts }
}

const EMPTY: SmartQueueData = {
  rows: [],
  counts: { hot: 0, at_risk: 0, new: 0, likely_seller: 0 },
}
