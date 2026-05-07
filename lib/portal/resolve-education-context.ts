// lib/portal/resolve-education-context.ts
// Resolves education context for portal lesson feed.
// Uses kernel functions for portal view determination.

import type { SupabaseClient } from "@supabase/supabase-js"
import { determinePortalView, type PortalView } from "@/lib/kernel/portal"
import type { AgeSegment } from "@/lib/kernel/education"

// ─── MILESTONE LABEL MAPS ─────────────────────────────────────────────────────

/** Human-readable labels for BUYER milestones */
export const BUYER_MILESTONE_LABELS: Record<string, string> = {
  offer_submitted: "Offer Submitted",
  offer_accepted: "Offer Accepted",
  earnest_money_due: "Earnest Money Due",
  inspection_scheduled: "Inspection Scheduled",
  inspection_deadline: "Inspection Deadline",
  inspection_completed: "Inspection Completed",
  appraisal_ordered: "Appraisal Ordered",
  appraisal_deadline: "Appraisal Deadline",
  appraisal_completed: "Appraisal Completed",
  financing_deadline: "Financing Deadline",
  loan_approved: "Loan Approved",
  clear_to_close_received: "Clear to Close!",
  final_walkthrough_scheduled: "Final Walkthrough Scheduled",
  closing_scheduled: "Closing Scheduled",
  closing_date: "Closing Day",
  closed: "You're a Homeowner!",
}

/** Human-readable labels for SELLER milestones */
export const SELLER_MILESTONE_LABELS: Record<string, string> = {
  listing_live: "Home is Listed",
  first_showing: "First Showing Scheduled",
  offer_received: "Offer Received",
  under_contract: "Under Contract",
  inspection_period: "Inspection Period",
  inspection_deadline: "Inspection Deadline",
  inspection_completed: "Inspection Completed",
  appraisal: "Appraisal",
  appraisal_deadline: "Appraisal Deadline",
  appraisal_completed: "Appraisal Completed",
  closing_prep: "Preparing to Close",
  clear_to_close_received: "Clear to Close!",
  final_walkthrough_scheduled: "Final Walkthrough",
  closing_date: "Closing Day",
  closed: "Home Sold!",
}

/** Combined milestone label map - buyer labels take precedence */
export const MILESTONE_LABEL_MAP: Record<string, string> = {
  ...SELLER_MILESTONE_LABELS,
  ...BUYER_MILESTONE_LABELS,
}

/** Responsible party for each milestone type */
export const MILESTONE_RESPONSIBLE_PARTY: Record<string, string> = {
  offer_submitted: "Your Agent",
  offer_accepted: "Your Agent",
  earnest_money_due: "You",
  inspection_scheduled: "Transaction Coordinator",
  inspection_deadline: "Inspector",
  inspection_completed: "Inspector",
  appraisal_ordered: "Lender",
  appraisal_deadline: "Appraiser",
  appraisal_completed: "Appraiser",
  financing_deadline: "Lender",
  loan_approved: "Lender",
  clear_to_close_received: "Lender",
  final_walkthrough_scheduled: "Your Agent",
  closing_scheduled: "Title Company",
  closing_date: "Title Company",
  closed: "Everyone!",
  listing_live: "Your Agent",
  first_showing: "Your Agent",
  offer_received: "Your Agent",
  under_contract: "Your Agent",
  inspection_period: "Transaction Coordinator",
  appraisal: "Appraiser",
  closing_prep: "Transaction Coordinator",
}

/** "What happens next" explanations for each milestone */
export const MILESTONE_EXPLANATIONS: Record<string, string> = {
  offer_submitted: "Your agent has submitted your offer. The seller's agent will present it, and you'll typically hear back within 24-48 hours. Be ready to negotiate if needed.",
  offer_accepted: "Congratulations! Your offer is accepted. Next, you'll need to submit earnest money and begin your due diligence period with inspections.",
  earnest_money_due: "Your good-faith deposit shows the seller you're serious. This money goes toward your down payment at closing.",
  inspection_scheduled: "A professional inspector will examine the property for any issues. Make sure to attend if possible so you can ask questions directly.",
  inspection_deadline: "By this date, you must complete inspections and request any repairs or credits. Your agent will help negotiate with the seller.",
  inspection_completed: "The inspection is done. Review the report with your agent and decide if you want to request repairs or negotiate credits.",
  appraisal_ordered: "Your lender has ordered the appraisal. A licensed appraiser will visit the property to confirm it's worth the purchase price.",
  appraisal_deadline: "The appraisal must be completed by this date. If the home appraises low, you may need to renegotiate or make up the difference.",
  appraisal_completed: "The appraisal is done. If it came in at or above purchase price, you're on track. Your lender will review the results.",
  financing_deadline: "By this date, your loan must be fully approved. Stay in close contact with your lender and provide any requested documents quickly.",
  loan_approved: "Your mortgage is approved! You're almost there. The lender will prepare final documents for closing.",
  clear_to_close_received: "The lender has signed off on everything. You're cleared to close! Title will schedule your final signing appointment.",
  final_walkthrough_scheduled: "Walk through the property one last time to make sure everything is as expected before you sign closing documents.",
  closing_scheduled: "Your closing appointment is set. Bring your ID and be ready to sign documents. The title company will guide you through everything.",
  closing_date: "Today's the day! Sign your documents, receive your keys, and celebrate becoming a homeowner.",
  closed: "You did it! The home is officially yours. Time to celebrate and start making it your own.",
  listing_live: "Your home is now on the market! Buyers and their agents can see your listing and schedule showings.",
  first_showing: "Your first showing is scheduled. Make sure the home is clean and ready for buyers to view.",
  offer_received: "An offer has come in! Your agent will review the terms with you and help you decide whether to accept, counter, or decline.",
  under_contract: "You've accepted an offer and are now under contract. The buyer will begin their inspections and loan process.",
  inspection_period: "The buyer is conducting inspections. Be prepared for possible repair requests or credit negotiations.",
  appraisal: "The buyer's lender has ordered an appraisal to confirm the home's value supports the loan amount.",
  closing_prep: "Everything is on track for closing. Your agent and title company are preparing final documents.",
}

/** Maps milestones to related education lesson keys */
export const MILESTONE_LESSON_MAP: Record<string, string> = {
  earnest_money_due: "earnest_money_101",
  inspection_scheduled: "home_inspection_guide",
  inspection_deadline: "inspection_negotiation",
  appraisal_ordered: "appraisal_explained",
  financing_deadline: "mortgage_approval_timeline",
  clear_to_close_received: "closing_day_prep",
  closing_date: "closing_day_checklist",
}

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
  const portalViewOutput = await determinePortalView(supabase, { contactId })
  const portalView: PortalView = portalViewOutput.view

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
      .order("target_date", { ascending: true })
      .maybeSingle()

    if (milestone) {
      currentMilestone = milestone.milestone_name
    }
  }

  // Get completed lesson keys from contact_education_progress (correct table)
  let completedLessonKeys: string[] = []
  try {
    const { data: completedProgress } = await supabase
      .from("contact_education_progress")
      .select("lesson_key, completed_at")
      .eq("contact_id", contactId)
      .not("completed_at", "is", null)

    completedLessonKeys = completedProgress?.map(p => p.lesson_key) ?? []
  } catch {
    // Fail safely - return empty array if table/query fails
    completedLessonKeys = []
  }

  return {
    portalView,
    buyerStage,
    currentMilestone,
    ageSeg,
    completedLessonKeys,
  }
}
