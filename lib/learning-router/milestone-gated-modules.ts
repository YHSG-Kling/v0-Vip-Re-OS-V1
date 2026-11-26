/**
 * Milestone-gated learning_modules resolver.
 *
 * Customer education is stage-gated: a lesson unlocks only when the
 * contact has reached the gating milestone AND any prerequisite modules
 * are completed. This is the kernel-side counterpart to the customer
 * /learn feed — surfaces authored learning_modules (Sprint 7) with hard
 * gates applied.
 *
 *   gated_until_milestone IS NULL              → always visible
 *   gated_until_milestone matches a milestone the contact has reached OR is on
 *                                              → unlocked
 *   prerequisite_module_ids all completed      → unlocked
 *
 * Returns three buckets:
 *   unlocked  — visible now (top of feed)
 *   upcoming  — gated by the contact's NEXT milestone (visible as preview)
 *   locked    — gated by milestones the contact hasn't reached yet
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveMilestoneIdentity } from "@/lib/transactions/milestone-identity"

export interface GatedModule {
  id:                   string
  title:                string
  summary:              string | null
  coverImageUrl:        string | null
  estimatedMinutes:     number | null
  milestoneKey:         string | null
  gatedUntilMilestone:  string | null
  prerequisiteModuleIds: string[]
  isCompleted:          boolean
  unlockReason:         "always" | "milestone_reached" | "prereq_met"
  lockReason:           string | null   // human-readable for the UI
}

export interface MilestoneGatedFeed {
  currentMilestone: string | null
  unlocked:         GatedModule[]
  upcoming:         GatedModule[]
  locked:           GatedModule[]
}

/**
 * Returns the contact's milestone-gated lesson view.
 *
 * Milestone progression model: a milestone is "reached" if it's the
 * contact's current pending milestone OR any earlier-stage milestone has
 * already completed. We treat "current milestone" as inclusive — the
 * customer should see the lesson teaching the milestone they're on.
 */
export async function resolveMilestoneGatedFeed(
  supabase:   SupabaseClient,
  contactId:  string,
): Promise<MilestoneGatedFeed> {
  // 1. Contact basics + brokerage
  const { data: contact } = await supabase
    .from("contacts")
    .select("brokerage_id, contact_persona")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact?.brokerage_id) {
    return { currentMilestone: null, unlocked: [], upcoming: [], locked: [] }
  }
  const brokerageId = contact.brokerage_id as string
  const persona     = (contact.contact_persona as string | null) ?? null

  // 2. Resolve current + completed milestones for this contact's active transaction
  let currentMilestone: string | null = null
  const completedMilestones = new Set<string>()
  const { data: txns } = await supabase
    .from("transactions")
    .select("id")
    .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId},contact_id.eq.${contactId}`)
    .not("status", "in", "(closed,completed,cancelled)")
    .order("created_at", { ascending: false })
    .limit(1)
  const txnId = (txns as Array<{ id: string }> | null)?.[0]?.id
  if (txnId) {
    const { data: milestones } = await supabase
      .from("transaction_milestones")
      .select("milestone_name, milestone_type, status, target_date")
      .eq("transaction_id", txnId)
      .eq("is_client_visible", true)

    // Gate on the canonical identity (gated_until_milestone is authored in the
    // canonical vocabulary) — the free-text milestone_name never matched.
    for (const m of (milestones ?? []) as Array<{ milestone_name: string; milestone_type: string | null; status: string }>) {
      if (m.status === "completed") {
        const id = resolveMilestoneIdentity(m)
        if (id) completedMilestones.add(id)
      }
    }
    // Earliest pending = the customer's current milestone
    const { data: cur } = await supabase
      .from("transaction_milestones")
      .select("milestone_name, milestone_type")
      .eq("transaction_id", txnId)
      .eq("is_client_visible", true)
      .eq("status", "pending")
      .order("target_date", { ascending: true })
      .limit(1)
      .maybeSingle()
    currentMilestone = cur ? resolveMilestoneIdentity(cur) : null
  }

  // 3. Completed learning_modules for this contact (post-Sprint-7 collapse)
  const { data: doneAssignments } = await supabase
    .from("learning_assignments")
    .select("module_id")
    .eq("contact_id", contactId)
    .eq("status", "completed")
  const completedModuleIds = new Set(
    ((doneAssignments ?? []) as Array<{ module_id: string }>).map(a => a.module_id),
  )

  // 4. All published customer-audience modules in this brokerage
  const { data: modules } = await supabase
    .from("learning_modules")
    .select(`
      id, title, summary, cover_image_url, estimated_minutes,
      milestone_key, gated_until_milestone, prerequisite_module_ids,
      audience_roles, audience_personas, stage_tags, gap_tags
    `)
    .eq("brokerage_id", brokerageId)
    .eq("status", "published")
    // Exclude bridged static lessons — they render on /learn (their origin), not
    // in the portal-home education panel, so a lesson never appears in two places.
    .not("gap_tags", "cs", '{static_bridge}')
    .order("display_priority", { ascending: false })
    .limit(100)

  const unlocked: GatedModule[] = []
  const upcoming: GatedModule[] = []
  const locked:   GatedModule[] = []

  for (const m of (modules ?? []) as Array<{
    id: string; title: string; summary: string | null; cover_image_url: string | null;
    estimated_minutes: number | null; milestone_key: string | null;
    gated_until_milestone: string | null; prerequisite_module_ids: string[] | null;
    audience_roles: string[] | null; audience_personas: string[] | null;
    stage_tags: string[] | null;
  }>) {
    // Filter: customer-audience or universal
    const roles = m.audience_roles ?? []
    if (roles.length > 0 && !roles.includes("customer")) continue
    // Filter: persona overlap if module is persona-targeted
    const personas = m.audience_personas ?? []
    if (personas.length > 0 && (!persona || !personas.includes(persona))) continue

    const prereqIds  = m.prerequisite_module_ids ?? []
    const prereqsMet = prereqIds.every(p => completedModuleIds.has(p))
    const milestoneGate = m.gated_until_milestone

    // Gate logic
    let gateState: "unlocked" | "upcoming" | "locked" = "unlocked"
    let lockReason: string | null = null
    let unlockReason: GatedModule["unlockReason"] = "always"

    if (!prereqsMet) {
      gateState  = "locked"
      lockReason = `Complete ${prereqIds.length} earlier lesson${prereqIds.length === 1 ? "" : "s"} first`
    } else if (milestoneGate) {
      if (completedMilestones.has(milestoneGate)) {
        gateState    = "unlocked"
        unlockReason = "milestone_reached"
      } else if (currentMilestone === milestoneGate) {
        gateState    = "unlocked"
        unlockReason = "milestone_reached"
      } else if (currentMilestone && m.milestone_key === currentMilestone) {
        // The lesson teaches the milestone the customer is currently on
        gateState    = "unlocked"
        unlockReason = "milestone_reached"
      } else {
        gateState  = currentMilestone ? "upcoming" : "locked"
        lockReason = `Unlocks at ${milestoneGate.replace(/_/g, " ")}`
      }
    } else {
      unlockReason = prereqIds.length > 0 ? "prereq_met" : "always"
    }

    const item: GatedModule = {
      id:                    m.id,
      title:                 m.title,
      summary:               m.summary,
      coverImageUrl:         m.cover_image_url,
      estimatedMinutes:      m.estimated_minutes,
      milestoneKey:          m.milestone_key,
      gatedUntilMilestone:   m.gated_until_milestone,
      prerequisiteModuleIds: prereqIds,
      isCompleted:           completedModuleIds.has(m.id),
      unlockReason,
      lockReason,
    }

    if (gateState === "unlocked")      unlocked.push(item)
    else if (gateState === "upcoming") upcoming.push(item)
    else                                locked.push(item)
  }

  return { currentMilestone, unlocked, upcoming, locked }
}
