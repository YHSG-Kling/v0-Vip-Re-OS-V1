/**
 * lib/crm/contacts/contact-brief.ts
 *
 * Pre-call briefing — pulls a 10-second intel summary for any contact:
 *   • last interaction (date + channel + summary)
 *   • engagement / momentum
 *   • active deal stage
 *   • open tasks
 *   • last 3 activities
 *   • do-not-contact + opt-out flags (so the caller doesn't violate consent)
 *
 * Used by:
 *   • VapiCallPanel  — shown when a contact is selected
 *   • D-ID streaming avatar widget — passed via session context
 *   • Quick-actions on contact cards
 */

import "server-only"
import { createClient } from "@/lib/supabase/server"
import { resolveAddressing } from "@/lib/kernel/addressing"

export interface ContactBrief {
  contactId: string
  fullName: string
  /** ADDRESSING MEMORY — what to actually call them ("Bill", never "William"). */
  addressAs: string
  /** pronunciation cue, surfaced the moment it matters most: right before a call. */
  pronunciationNote: string | null
  contactType: string | null
  contactPersona: string | null
  buyerStage: string | null
  city: string | null
  state: string | null
  engagementScore: number | null
  momentumScore: number | null
  momentumTrend: "rising" | "steady" | "declining" | "cold"
  lastContactedAt: string | null
  lastContactDays: number | null
  doNotContact: boolean
  emailOptOut: boolean
  smsOptOut: boolean
  phoneOptOut: boolean
  activeDealStage: string | null
  openTaskCount: number
  recentActivities: Array<{
    type: string
    description: string | null
    occurredAt: string
  }>
  talkingPoints: string[]
}

/**
 * Computes a normalised momentum score (0-100) and a trend bucket from the
 * raw engagement_score and the contact's recent activity cadence. Pure
 * function — no side effects, can also be reused by deal-card badges.
 */
export function computeMomentum(input: {
  engagementScore: number | null
  lastContactedAt: string | null
  recentActivityCount: number
}): { momentumScore: number; momentumTrend: ContactBrief["momentumTrend"] } {
  const base = Math.max(0, Math.min(100, input.engagementScore ?? 0))
  const daysSince = input.lastContactedAt
    ? Math.floor((Date.now() - new Date(input.lastContactedAt).getTime()) / 86_400_000)
    : 90

  // Recency: full credit within 7 days, linear decay to 0 by day 30, then floor.
  const recencyFactor = daysSince <= 7 ? 1 : daysSince >= 30 ? 0.2 : 1 - (daysSince - 7) / 23
  const activityFactor = Math.min(1, input.recentActivityCount / 5)

  const momentum = Math.round(
    base * 0.5 + base * 0.25 * recencyFactor + 100 * 0.25 * activityFactor,
  )
  const momentumScore = Math.max(0, Math.min(100, momentum))

  let momentumTrend: ContactBrief["momentumTrend"]
  if (momentumScore >= 65 && daysSince <= 7) momentumTrend = "rising"
  else if (momentumScore >= 45) momentumTrend = "steady"
  else if (daysSince > 30) momentumTrend = "cold"
  else momentumTrend = "declining"

  return { momentumScore, momentumTrend }
}

export async function getContactBrief(contactId: string): Promise<ContactBrief | null> {
  const supabase = await createClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select(
      `id, first_name, last_name, preferred_name, name_pronunciation, salutation_style,
       legal_first_name, legal_last_name, legal_name_source,
       contact_type, contact_persona, buyer_stage, city, state,
       engagement_score, last_contacted_at,
       dnc_status, email_opt_out, sms_opt_out, phone_opt_out`,
    )
    .eq("id", contactId)
    .maybeSingle()

  if (!contact) return null

  const [{ data: activities }, { data: openTasks }, { data: txn }, { data: closedTxn }, { data: lastFrontierRow }] = await Promise.all([
    supabase
      .from("activities")
      .select("activity_type, description, completed_at, scheduled_at, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("tasks")
      .select("id", { count: "exact" })
      .eq("contact_id", contactId)
      .neq("status", "completed"),
    supabase
      .from("transactions")
      .select("id, status, stage")
      .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
      .not("status", "in", "(closed,cancelled)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Journey snapshot inputs: the most recent CLOSED deal (post-close journey window)…
    supabase
      .from("transactions")
      .select("close_date")
      .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
      .eq("status", "closed")
      .not("close_date", "is", null)
      .order("close_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // …and the last frontier that touched this contact (the tags ARE journey memory).
    supabase
      .from("agent_client_messages")
      .select("rationale, created_at")
      .eq("recipient_contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const recentActivities = (activities ?? []).map((a) => ({
    type: a.activity_type as string,
    description: a.description as string | null,
    occurredAt: (a.completed_at as string | null) ?? (a.scheduled_at as string | null) ?? (a.created_at as string),
  }))

  const lastContactDays = contact.last_contacted_at
    ? Math.floor((Date.now() - new Date(contact.last_contacted_at).getTime()) / 86_400_000)
    : null

  const { momentumScore, momentumTrend } = computeMomentum({
    engagementScore: contact.engagement_score,
    lastContactedAt: contact.last_contacted_at,
    recentActivityCount: recentActivities.length,
  })

  const fullName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Unknown"

  // Addressing memory leads the brief — the seconds before a call are exactly
  // when "call them Bill" and the pronunciation cue matter (l48-s01).
  const addressing = resolveAddressing({
    firstName: (contact as any).first_name ?? null,
    lastName: (contact as any).last_name ?? null,
    preferredName: (contact as any).preferred_name ?? null,
    namePronunciation: (contact as any).name_pronunciation ?? null,
    salutationStyle: (contact as any).salutation_style ?? null,
  })

  // Build short, agent-actionable talking points the call panel can show inline.
  const talkingPoints: string[] = []

  // JOURNEY SNAPSHOT leads (the spec's "expose visible status" rule): which
  // journey, what stage, the last frontier that fired, what's next — composed
  // from state already loaded, no new writes.
  try {
    const { composeJourneySnapshot, parseFrontierKind } = await import("@/lib/kernel/journey-snapshot")
    const frontierKind = parseFrontierKind((lastFrontierRow as any)?.rationale)
    const snapshot = composeJourneySnapshot({
      contactType: (contact as any).contact_type ?? null,
      buyerStage: (contact as any).buyer_stage ?? null,
      activeDealStage: (txn as any)?.stage ?? null,
      closedDaysAgo: (closedTxn as any)?.close_date
        ? Math.max(0, Math.floor((Date.now() - new Date((closedTxn as any).close_date).getTime()) / 86_400_000))
        : null,
      lastFrontier: frontierKind && (lastFrontierRow as any)?.created_at
        ? { kind: frontierKind, at: (lastFrontierRow as any).created_at }
        : null,
    })
    talkingPoints.push(snapshot.line)
  } catch { /* the brief still renders without the journey line */ }
  if ((contact as any).preferred_name || (contact as any).name_pronunciation) {
    talkingPoints.push(
      [`Call them "${addressing.addressAs}".`, addressing.pronunciationNote].filter(Boolean).join(" "),
    )
  }
  if (lastContactDays != null) {
    talkingPoints.push(
      lastContactDays === 0
        ? "Last contact was today."
        : `Last contact ${lastContactDays} day${lastContactDays === 1 ? "" : "s"} ago.`,
    )
  }
  if (txn?.stage) {
    talkingPoints.push(`Active deal stage: ${String(txn.stage).replace(/_/g, " ")}.`)
  }
  if (recentActivities[0]?.description) {
    talkingPoints.push(`Last activity: ${recentActivities[0].description.slice(0, 120)}`)
  }
  if (contact.dnc_status || contact.phone_opt_out) {
    talkingPoints.push("⚠ Phone contact is restricted — confirm before dialing.")
  }

  // TWIN PROVENANCE — what we KNOW vs what the OS INFERS, so the agent never
  // opens a call asserting a guess as a fact.
  try {
    const { classifyTwinFields, composeProvenanceNote } = await import("@/lib/contacts/twin-provenance")
    const provenanceNote = composeProvenanceNote(classifyTwinFields(contact as any))
    if (provenanceNote) talkingPoints.push(provenanceNote)
  } catch { /* provenance is additive — the brief stands without it */ }

  return {
    contactId: contact.id,
    fullName,
    addressAs: addressing.addressAs,
    pronunciationNote: addressing.pronunciationNote,
    contactType: contact.contact_type ?? null,
    contactPersona: contact.contact_persona ?? null,
    buyerStage: contact.buyer_stage ?? null,
    city: contact.city ?? null,
    state: contact.state ?? null,
    engagementScore: contact.engagement_score,
    momentumScore,
    momentumTrend,
    lastContactedAt: contact.last_contacted_at,
    lastContactDays,
    doNotContact: !!contact.dnc_status,
    emailOptOut: !!contact.email_opt_out,
    smsOptOut: !!contact.sms_opt_out,
    phoneOptOut: !!contact.phone_opt_out,
    activeDealStage: (txn?.stage as string | null) ?? null,
    openTaskCount: (openTasks as any)?.length ?? 0,
    recentActivities,
    talkingPoints,
  }
}
