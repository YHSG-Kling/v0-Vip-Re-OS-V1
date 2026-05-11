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

  // Get THIS agent's contacts only (one base set, then segment them).
  // last_contacted_at drives the stale fallback for at_risk so the segment
  // works even when sphere_engagement_scores hasn't yet scored a contact.
  const { data: contactRows } = await svc
    .from("contacts")
    .select(
      "id, first_name, last_name, contact_type, lifecycle_state, engagement_score, created_at, last_contacted_at",
    )
    .eq("agent_id", ctx.agentId)
    .limit(500)

  const contacts = contactRows ?? []
  if (contacts.length === 0) return EMPTY
  const contactIds = contacts.map((c: any) => c.id)

  // Pull supporting signals in parallel
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const twentyOneDaysAgo = new Date(Date.now() - 21 * 86_400_000).toISOString()

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

    // Likely seller — schema-verified live: pls_score (NOT
    // listing_likelihood_score) and top_signals jsonb (NOT top_signal).
    // The previous query silently returned empty; this is the bug-fix.
    svc
      .from("predictive_listing_scores")
      .select("contact_id, pls_score, top_signals, scored_at")
      .eq("agent_id", ctx.agentId)
      .gte("scored_at", twentyOneDaysAgo)
      .order("pls_score", { ascending: false })
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

  // ⚠ At-risk — first pass: contacts with low sphere-engagement score
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

  // ⚠ At-risk — second pass: contacts not contacted in 21+ days. This
  // replaces the standalone AgentStaleContactsPanel which queried
  // contacts.last_contacted_at directly. Combined here so SmartQueue
  // truly is the single mental model for "needs re-engagement".
  for (const c of contacts as any[]) {
    if (seen.has(c.id)) continue
    if (rows.filter((row) => row.segment === "at_risk").length >= PER_SEGMENT_LIMIT) break
    const lastContact = c.last_contacted_at
    if (!lastContact) continue
    const lastTs = new Date(lastContact).getTime()
    if (Number.isNaN(lastTs)) continue
    const days = Math.floor((Date.now() - lastTs) / 86_400_000)
    if (days < 21) continue
    rows.push({
      contactId: c.id,
      fullName: nameById.get(c.id)!,
      segment: "at_risk",
      signal: `${days}d since last contact`,
      signalDetail: "No touch in 3+ weeks",
      suggestedAction: "draft_followup",
    })
    seen.add(c.id)
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

  // 💎 Likely seller — pls_score and top_signals[0] (jsonb) per live schema
  for (const r of plsResult.data ?? []) {
    if (seen.has(r.contact_id)) continue
    if (!nameById.has(r.contact_id)) continue
    const score = Number(r.pls_score ?? 0)
    if (score < 60) continue
    const signals = Array.isArray(r.top_signals) ? r.top_signals : null
    const topSignal =
      signals && signals.length > 0
        ? typeof signals[0] === "string"
          ? signals[0]
          : (signals[0] as { label?: string; signal?: string }).label ??
            (signals[0] as { signal?: string }).signal ??
            null
        : null
    rows.push({
      contactId: r.contact_id,
      fullName: nameById.get(r.contact_id)!,
      segment: "likely_seller",
      signal: `${Math.round(score)}% likely to list`,
      signalDetail: topSignal ?? undefined,
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
