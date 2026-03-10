// lib/portal/resolve-education-context.ts
// Resolves education context for portal lesson feed.
// Uses kernel functions for portal view determination.

import type { SupabaseClient } from "@supabase/supabase-js"
import { determinePortalView, type PortalView } from "@/lib/kernel/portal"
import type { AgeSegment } from "@/lib/kernel/education"

export interface EducationContext {
  portalView: PortalView
  buyerStage: string | null
  currentMilestone: string | null
  ageSeg: AgeSegment
  completedLessonKeys: string[]
}

/**
 * Resolves the education context for a contact.
 * Gathers portal view, buyer stage, current milestone, age segment,
 * and completed lesson keys for lesson feed filtering.
 */
export async function resolveEducationContext(
  supabase: SupabaseClient,
  contactId: string
): Promise<EducationContext> {
  // Get portal view from kernel
  const portalView = await determinePortalView(supabase, contactId)

  // Get contact details
  const { data: contact } = await supabase
    .from("contacts")
    .select("buyer_stage, contact_type, date_of_birth")
    .eq("id", contactId)
    .single()

  const buyerStage = contact?.buyer_stage ?? null

  // Calculate age segment from date_of_birth
  let ageSeg: AgeSegment = "30-50" // Default
  if (contact?.date_of_birth) {
    const birthDate = new Date(contact.date_of_birth)
    const today = new Date()
    const age = today.getFullYear() - birthDate.getFullYear()
    
    if (age < 30) ageSeg = "18-30"
    else if (age < 50) ageSeg = "30-50"
    else if (age < 65) ageSeg = "50-65"
    else ageSeg = "65+"
  }

  // Get current milestone from active transaction
  let currentMilestone: string | null = null
  
  // Find active transaction for this contact
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, status")
    .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .not("status", "in", "(closed,completed,cancelled)")
    .order("created_at", { ascending: false })
    .limit(1)

  if (transactions && transactions.length > 0) {
    const txId = transactions[0].id

    // Get earliest incomplete CLIENT_VISIBLE milestone
    const { data: milestone } = await supabase
      .from("transaction_milestones")
      .select("milestone_name, milestone_type")
      .eq("transaction_id", txId)
      .eq("status", "pending")
      .eq("is_client_visible", true)
      .order("milestone_date", { ascending: true })
      .limit(1)

    if (milestone) {
      currentMilestone = milestone.milestone_name
    }
  }

  // Get completed lesson keys from educational_moments
  const { data: completedMoments } = await supabase
    .from("educational_moments")
    .select("lesson_key")
    .eq("contact_id", contactId)
    .not("read_at", "is", null)

  const completedLessonKeys = completedMoments?.map(m => m.lesson_key) ?? []

  return {
    portalView,
    buyerStage,
    currentMilestone,
    ageSeg,
    completedLessonKeys,
  }
}
