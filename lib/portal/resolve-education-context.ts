// lib/portal/resolve-education-context.ts
// Resolves education context for portal lesson feed.
// Uses kernel functions for portal view determination.

import type { SupabaseClient } from "@supabase/supabase-js"
import { determinePortalView, type PortalView } from "@/lib/kernel/portal"
import {
  generationalCohortFromAge,
  ageFromBirthday,
  ageSegmentFromAge,
  ageSegmentFromAgeRange,
  ageMidpointFromAgeRange,
  type AgeSegment,
  type GenerationalCohort,
} from "@/lib/kernel/education"
import { resolveMilestoneIdentity } from "@/lib/transactions/milestone-identity"
import {
  readSellerSignalEducationContext,
  type SellerSignalEducationContext,
} from "@/lib/education/seller-signal-education-context"
import type { ProtectedClassBasis } from "@/lib/lead-governance/protected-class-signals"
import type { Persona } from "@/lib/kernel/types"

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
  /**
   * WHERE `ageSeg` CAME FROM. Published beside the value because a DEFAULT and
   * a MEASUREMENT are not the same fact and used to be indistinguishable here:
   * a contact with no birthday silently became "30-50", and every downstream
   * scorer then treated a guess as an observation (CLAUDE.md §2).
   *   · "birthday"      — computed from contacts.birthday
   *   · "age_range"     — collapsed from the enrichment lane's contacts.age_range
   *   · "seller_signal" — collapsed from motivated_seller_signals' senior_owner
   *                       observation (owner_age, or the provider's coarse
   *                       owner_age_band). MEASURED, and protected-class-derived:
   *                       whenever this is the source, `protectedClassBasis` is
   *                       non-empty and names the grounds.
   *   · "default"       — NOT MEASURED. Treat as unknown, not as 30-50.
   */
  ageSegSource: "birthday" | "age_range" | "seller_signal" | "default"
  /** Generational cohort derived from date_of_birth alongside ageSeg.
   *  Education + marketing modules tag against this for tone routing
   *  (e.g. boomer downsizer vs millennial first-time-buyer). */
  generationalCohort: GenerationalCohort
  completedLessonKeys: string[]
  /**
   * EXISTING `Persona` values the seller-signal lane implies for this contact —
   * "senior", "probate", "divorce", "upsize". Scored against
   * `learning_modules.audience_personas` by the ONE scorer in
   * lib/learning-router/composer.ts; never a second tag vocabulary.
   * Empty when the contact has no such signal.
   */
  personaHints: Persona[]
  /** Which seller-signal types contributed, for the record. */
  sellerSignalTypes: string[]
  /**
   * THE HONESTY RECORD. When a band or a persona hint above came from
   * protected-class-derived data, these are the classifier's reason sentences,
   * carried VERBATIM off the stored `motivated_seller_signals` rows. Callers that
   * PERSIST a selection are expected to write it down: the owner's position is
   * that this data picks the right EDUCATION and never the housing, and that is
   * only defensible if the record shows which is which. Empty when nothing
   * protected-class-derived was involved.
   */
  protectedClassBasis: ProtectedClassBasis[]
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
  // `age_range` joins the select under the wave-15 owner ruling. It is the column
  // the ENRICHMENT lane actually writes; `birthday` is filled in by a human and is
  // null on most rows, so reading only `birthday` meant the age band was a default
  // dressed as a measurement for nearly every contact.
  const { data: contact } = await supabase
    .from("contacts")
    .select("buyer_stage, contact_type, birthday, age_range")
    .eq("id", contactId)
    .single()

  const buyerStage = contact?.buyer_stage ?? null

  // Age band + generational cohort. Bands come from lib/kernel/education.ts —
  // ONE definition, derived here rather than re-spelled (CLAUDE.md §6); the
  // boundaries used to be open-coded in this block and drifted from nothing only
  // because nothing else had asked for them yet.
  let ageSegSource: EducationContext["ageSegSource"] = "default"
  const enrichedRange = (contact as { age_range?: string | null } | null)?.age_range ?? null
  let effectiveAge: number | null = ageFromBirthday(contact?.birthday ?? null)
  let ageSeg: AgeSegment | null = ageSegmentFromAge(effectiveAge)
  if (ageSeg) {
    ageSegSource = "birthday"
  } else {
    ageSeg = ageSegmentFromAgeRange(enrichedRange)
    if (ageSeg) {
      ageSegSource = "age_range"
      // The cohort follows the same signal the band did. Leaving it on `birthday`
      // alone is how a contact ended up with a real age band and cohort "unknown".
      effectiveAge = ageMidpointFromAgeRange(enrichedRange)
    }
  }

  // ── THE THIRD SOURCE — the seller-signal lane the wave-15 ruling unlocked ────
  //
  // Read UNCONDITIONALLY, not only when the band is still missing, because the
  // persona hints and the basis sentences are wanted whatever produced the band.
  // The BAND is taken from it only as the LAST source: a birthday is precise and
  // the person confirmed it, the enrichment `age_range` is the provider's read of
  // THIS PERSON, and the seller signal is the provider's read of the OWNER OF A
  // PARCEL that this contact is linked to — the same person on a live row, but one
  // inference further out, so it loses every tie it is in.
  //
  // Live counts on 2026-08-22 (project hrvaqgvukzxfskkcrwbt): contacts with a
  // birthday = 0, with an age_range = 0. Today this third source is the ONLY one
  // that can produce a measured band at all, which is the whole point of wiring
  // it — before this, "routed by age group" was a capability with no input.
  const sellerSignals: SellerSignalEducationContext =
    await readSellerSignalEducationContext(supabase, contactId)
  if (!ageSeg && sellerSignals.ageSegment) {
    ageSeg = sellerSignals.ageSegment
    ageSegSource = "seller_signal"
    // effectiveAge is deliberately LEFT NULL, so `generationalCohort` stays
    // "unknown" on this path. The cohort axis is FINER than the band — a person
    // in 50-65 is boomer or gen_x depending on which side of 1965 they were born,
    // and 65+ splits boomer/silent — so manufacturing a cohort from a band would
    // publish precision the band does not carry, which is the defect §2 forbids.
    // A band routes the channel and scores audience_age_segs; it does not license
    // a tone claim.
  }
  // The historical default is KEPT for API stability — callers type `ageSeg` as a
  // non-null AgeSegment — but `ageSegSource: "default"` now says out loud that it
  // is a placeholder, and selection paths are expected to read the source, not
  // just the band.
  if (!ageSeg) ageSeg = "30-50"
  const generationalCohort: GenerationalCohort = generationalCohortFromAge(effectiveAge)

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
      // Anchor on the canonical identity so the lesson/explanation maps resolve
      // regardless of the tier's free-text milestone_name.
      currentMilestone = resolveMilestoneIdentity(milestone) ?? milestone.milestone_name
    }
  }

  // Post-1043: completed customer modules come from learning_assignments.
  // The field name is kept as `completedLessonKeys` for API stability but
  // now returns module_id values (uuids).
  let completedLessonKeys: string[] = []
  try {
    const { data: completedAssignments } = await supabase
      .from("learning_assignments")
      .select("module_id")
      .eq("contact_id", contactId)
      .eq("status", "completed")

    completedLessonKeys = (completedAssignments as Array<{ module_id: string }> | null)?.map(p => p.module_id) ?? []
  } catch {
    completedLessonKeys = []
  }

  return {
    portalView,
    buyerStage,
    currentMilestone,
    ageSeg,
    ageSegSource,
    generationalCohort,
    completedLessonKeys,
    personaHints: sellerSignals.personaHints,
    sellerSignalTypes: sellerSignals.signalTypes,
    protectedClassBasis: sellerSignals.protectedClassBasis,
  }
}
