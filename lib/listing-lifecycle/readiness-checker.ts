/**
 * System 5.2: Listing Lifecycle Core - Readiness Checker
 * 
 * Evaluates readiness checks before stage transitions.
 * Examples:
 * - LISTING_AGREEMENT_SIGNED requires dotloop signatures verified
 * - MLS_READY requires media approved + MLS data complete
 * - OFFERS_RECEIVED requires showings active
 * 
 * This module queries existing tables to determine readiness.
 * NO new tables, NO state persistence.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { ReadinessCheckType } from "./lifecycle-definitions"

export interface ReadinessCheckResult {
  check: ReadinessCheckType
  passed: boolean
  reason?: string
  details?: Record<string, any>
}

export interface ReadinessEvaluation {
  allPassed: boolean
  results: ReadinessCheckResult[]
  passedChecks: string[]
  failedChecks: string[]
}

/**
 * Evaluate all readiness checks for a listing
 */
export async function evaluateReadinessChecks(
  supabase: SupabaseClient,
  listingId: string,
  requiredChecks: ReadinessCheckType[]
): Promise<ReadinessEvaluation> {
  const results: ReadinessCheckResult[] = []
  
  for (const check of requiredChecks) {
    const result = await evaluateSingleCheck(supabase, listingId, check)
    results.push(result)
  }
  
  const passedChecks = results.filter((r) => r.passed).map((r) => r.check)
  const failedChecks = results.filter((r) => !r.passed).map((r) => r.check)
  
  return {
    allPassed: failedChecks.length === 0,
    results,
    passedChecks,
    failedChecks,
  }
}

/**
 * Evaluate a single readiness check
 */
async function evaluateSingleCheck(
  supabase: SupabaseClient,
  listingId: string,
  check: ReadinessCheckType
): Promise<ReadinessCheckResult> {
  switch (check) {
    case "documents_verified":
      return await checkDocumentsVerified(supabase, listingId)
    
    case "provider_signatures":
      return await checkProviderSignatures(supabase, listingId)
    
    case "dotloop_signatures":
      // Legacy alias for provider_signatures
      return await checkProviderSignatures(supabase, listingId)
    
    case "media_approved":
      return await checkMediaApproved(supabase, listingId)
    
    case "repairs_completed":
      return await checkRepairsCompleted(supabase, listingId)
    
    case "mls_data_complete":
      return await checkMLSDataComplete(supabase, listingId)
    
    case "showings_enabled":
      return await checkShowingsEnabled(supabase, listingId)
    
    case "offer_exists":
      return await checkOfferExists(supabase, listingId)
    
    case "contract_signed":
      return await checkContractSigned(supabase, listingId)
    
    case "inspection_completed":
      return await checkInspectionCompleted(supabase, listingId)
    
    case "appraisal_completed":
      return await checkAppraisalCompleted(supabase, listingId)
    
    case "financing_approved":
      return await checkFinancingApproved(supabase, listingId)
    
    case "closing_docs_ready":
      return await checkClosingDocsReady(supabase, listingId)
    
    default:
      return {
        check,
        passed: false,
        reason: `Unknown readiness check: ${check}`,
      }
  }
}

/**
 * Check: documents_verified
 * Verifies all required documents are uploaded
 */
/**
 * "Are the required documents on file, and are the ones on file finished?"
 *
 * THE BUG THIS REPLACES WAS A COMPLIANCE BYPASS, not a rough edge. The previous
 * version read the documents ATTACHED to the listing and asked whether any were
 * in a non-terminal status. With ZERO documents attached, the filter is empty,
 * `unverified === 0`, and the gate returned passed:true — verified live against
 * a real listing. A seller listing with no paperwork whatsoever satisfied
 * "documents verified" and could be advanced to LISTING_AGREEMENT_SIGNED.
 *
 * The owner's rule is explicit: all signed documents from both sides, all
 * required brokerage/team/agent docs, where required-vs-warning is a setting,
 * and any missing item notifies the TC and/or the listing agent.
 *
 * auditListingDocuments is that rule, and it already existed — it resolves the
 * REQUIRED checklist for the brokerage/team/agent/state and reports what is
 * missing, split into blocking and warning. It was reachable only through
 * markAgreementSigned, which nothing called, so the one path an agent actually
 * has ran the weaker check. Both halves are now enforced here:
 *
 *   1. every BLOCKING required document is present  (was not checked at all)
 *   2. every attached document has reached a terminal status  (the old check)
 */
async function checkDocumentsVerified(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Listing-stage documents live in `documents` (keyed by listing_id), not
  // transaction_documents (keyed by transaction_id, no listing_id/is_required).
  const { data, error } = await supabase
    .from("documents")
    .select("id, document_type, status")
    .eq("listing_id", listingId)

  if (error) {
    return {
      check: "documents_verified",
      passed: false,
      reason: `Error checking documents: ${error.message}`,
    }
  }

  // documents.status terminal/verified states are 'complete' and 'signed'.
  const unverifiedDocs = data?.filter((d) => !["complete", "signed"].includes(d.status)) || []

  // ─── The required-checklist half ──────────────────────────────────────────
  // Same columns and the same identity resolution markAgreementSigned uses, so
  // the readiness gate and the execution checkpoint cannot disagree about what
  // "required" means for this listing.
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("brokerage_id, agent_id, seller_contact_id, contact_id, state")
    .eq("id", listingId)
    .maybeSingle()

  if (listingError) {
    return {
      check: "documents_verified",
      passed: false,
      reason: `Error reading the listing: ${listingError.message}`,
    }
  }
  if (!listing?.brokerage_id) {
    // No tenant anchor means the required-docs checklist cannot be resolved.
    // REFUSE rather than fall through to the weaker check — an unresolvable
    // compliance gate is a blocked transition, not a passed one.
    return {
      check: "documents_verified",
      passed: false,
      reason: "Listing has no brokerage on file, so its required-document checklist cannot be resolved",
    }
  }

  const { auditListingDocuments } = await import("@/lib/compliance/required-documents")

  // listings.agent_id is agents.id. auditListingDocuments wants users.id, so it
  // is RESOLVED — never substituted. A wrong id here would silently resolve the
  // wrong agent's document requirements.
  const listingAgentUserId = listing.agent_id
    ? ((await supabase.from("agents").select("user_id").eq("id", listing.agent_id).maybeSingle())
        .data?.user_id as string | null) ?? null
    : null

  const teamId = listingAgentUserId
    ? ((await supabase.from("users").select("team_id").eq("id", listingAgentUserId).maybeSingle())
        .data?.team_id as string | null) ?? null
    : null

  const audit = await auditListingDocuments(supabase, {
    brokerageId:     listing.brokerage_id,
    listingId,
    // THE SELLER IS IN seller_contact_id. listings.contact_id exists but is not
    // populated — 0 of 3 rows live — so reading it made sellerContactId always
    // null and the audit silently skipped every document filed against the
    // seller's CONTACT record rather than the listing. Raised in review on the
    // neighborhood-report fallback; the same column mistake was here and in
    // markAgreementSigned, so both were corrected together. contact_id is kept
    // as a fallback for any legacy row that used it.
    sellerContactId: ((listing.seller_contact_id ?? listing.contact_id) as string | null) ?? null,
    agentUserId:     listingAgentUserId,
    teamId,
    stateCode:       (listing.state as string | null) ?? null,
  })

  // ─── The EXECUTION half ───────────────────────────────────────────────────
  //
  // "documents_verified" CLAIMED MORE THAN IT CHECKED. Presence plus a terminal
  // `documents.status` is not verification: `status` is a workflow label a
  // caller writes, while whether every required party actually SIGNED and
  // INITIALED lives in `documents.signature_completeness`, which this check
  // never opened. A document could sit at status 'complete' with the seller's
  // initials blank and this gate called it verified.
  //
  // The owner's 2026-09-04 ruling — "same compliance gate when a listing becomes
  // an active listing" — is what closes it. findUnexecutedDocuments is the SAME
  // pure function the offer-side transaction gate and the listing-activation
  // gate run (§6: one vocabulary), so a check named `documents_verified` and the
  // gate that guards MLS_ACTIVE can no longer disagree about what a verified
  // document is.
  //
  // LISTING_AGREEMENT_PARTIES (agent + seller) is passed explicitly: this is
  // seller-side paperwork and there is no buyer at this point in the lifecycle.
  // The default is the purchase-contract pair and would refuse every listing.
  const { findUnexecutedDocuments } = await import("@/lib/transactions/transaction-creation-gate")
  const { LISTING_AGREEMENT_PARTIES } = await import("@/lib/compliance/signature-completeness")
  const unexecuted = audit.unavailable_reason
    ? []
    : findUnexecutedDocuments(
        audit.deal_file,
        audit.required_breakdown.map((r) => r.classification),
        LISTING_AGREEMENT_PARTIES,
      )
  const signatureGaps = unexecuted.filter((u) => u.missingSignatures.length > 0)
  const initialGaps   = unexecuted.filter((u) => u.missingInitials.length > 0)

  const reasons: string[] = []
  // AN AUDIT THAT COULD NOT RUN IS NOT A CLEAN AUDIT. This check is the exact
  // surface finding #105 named ("documents_verified passes with zero
  // documents"), and the settings end of it had the same shape: a REFUSED
  // checklist or deal-file read used to come back as the all-zero result of a
  // clean file. auditListingDocuments now says so, and it BLOCKS here.
  if (audit.unavailable_reason) {
    reasons.push(`required-document check could not run: ${audit.unavailable_reason}`)
  }
  if (audit.missing_blocking.length > 0) {
    reasons.push(`${audit.missing_blocking.length} required document(s) missing: ${audit.missing_blocking.join(", ")}`)
  }
  // Signatures and initials are reported SEPARATELY, because the owner names
  // them separately and fixing one is not fixing the other.
  if (signatureGaps.length > 0) {
    reasons.push(`${signatureGaps.length} required document(s) not fully signed: ${signatureGaps.map((u) => u.label).join(", ")}`)
  }
  if (initialGaps.length > 0) {
    reasons.push(`initials outstanding on ${initialGaps.length} required document(s): ${initialGaps.map((u) => u.label).join(", ")}`)
  }
  if (unverifiedDocs.length > 0) {
    reasons.push(`${unverifiedDocs.length} attached document(s) not yet complete or signed`)
  }

  return {
    check: "documents_verified",
    passed:
      !audit.unavailable_reason &&
      audit.missing_blocking.length === 0 &&
      unexecuted.length === 0 &&
      unverifiedDocs.length === 0,
    reason: reasons.length > 0 ? reasons.join("; ") : undefined,
    details: {
      attached: data?.length || 0,
      unverified: unverifiedDocs.length,
      required_total: audit.required_total,
      missing_blocking: audit.missing_blocking,
      // Warnings never block, but the surface should still show them so the
      // agent knows what the TC is about to ask for.
      missing_warning: audit.missing_warning,
      // The execution half, split the way the refusal is, so a surface can tell
      // an agent WHICH job is outstanding rather than only that one is.
      missing_signatures: signatureGaps.map((u) => ({ label: u.label, missing: u.missingSignatures, unscanned: u.unscanned })),
      missing_initials:   initialGaps.map((u) => ({ label: u.label, missing: u.missingInitials, unscanned: u.unscanned })),
    },
  }
}

/**
 * Check: provider_signatures (provider-agnostic)
 * Verifies transaction provider signatures are complete
 * 
 * Looks for normalized event: provider.signatures.complete
 * NO checking dotloop_loop_id anymore
 */
async function checkProviderSignatures(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Check activities table for normalized signature completion event
  const { data: activities } = await supabase
    .from("activities")
    .select("activity_type, metadata")
    .eq("listing_id", listingId)
    .eq("activity_type", "provider.signatures.complete")
    .order("created_at", { ascending: false })
    .limit(1)
  
  const signatureComplete = activities && activities.length > 0
  
  return {
    check: "provider_signatures",
    passed: signatureComplete ?? false,
    reason: signatureComplete ? undefined : "Provider signatures not complete",
    details: signatureComplete ? { provider: activities[0]?.metadata?.provider } : {},
  }
}

/**
 * Check: media_approved
 * Verifies photos/videos are approved
 */
async function checkMediaApproved(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Photo approval state lives on listing_media.is_approved. That approval
  // governance is precisely why listing_media survived the m368/m369
  // consolidation and the duplicate listing_photos table was dropped.
  // media_type is pinned so the 10-photo minimum counts photos, not documents.
  const { data: photos } = await supabase
    .from("listing_media")
    .select("id, is_approved")
    .eq("listing_id", listingId)
    .eq("media_type", "photo")
    .eq("is_approved", true)
  
  const hasApprovedPhotos = (photos?.length || 0) >= 10 // Minimum 10 photos
  
  return {
    check: "media_approved",
    passed: hasApprovedPhotos,
    reason: hasApprovedPhotos
      ? undefined
      : `Only ${photos?.length || 0} photo(s) approved. Minimum 10 required.`,
    details: { approvedPhotos: photos?.length || 0 },
  }
}

/**
 * Check: repairs_completed
 * Verifies pre-listing repairs are done
 */
async function checkRepairsCompleted(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Check activities for repair completion
  const { data: repairs } = await supabase
    .from("activities")
    .select("id, activity_type, status")
    .eq("listing_id", listingId)
    .eq("activity_type", "repair")
    .neq("status", "completed")
  
  const incompleteRepairs = repairs?.length || 0
  
  return {
    check: "repairs_completed",
    passed: incompleteRepairs === 0,
    reason: incompleteRepairs > 0
      ? `${incompleteRepairs} repair(s) not completed`
      : undefined,
    details: { incompleteRepairs },
  }
}

/**
 * Check: mls_data_complete
 * Verifies MLS data is ready
 */
async function checkMLSDataComplete(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  const { data: listing } = await supabase
    .from("listings")
    .select("address, city, state, zip, list_price, bedrooms, bathrooms, sqft")
    .eq("id", listingId)
    .single()
  
  if (!listing) {
    return {
      check: "mls_data_complete",
      passed: false,
      reason: "Listing not found",
    }
  }
  
  const requiredFields = ["address", "city", "state", "zip", "list_price", "bedrooms", "bathrooms", "sqft"]
  const missingFields = requiredFields.filter((field) => !listing[field as keyof typeof listing])
  
  return {
    check: "mls_data_complete",
    passed: missingFields.length === 0,
    reason: missingFields.length > 0
      ? `Missing required MLS fields: ${missingFields.join(", ")}`
      : undefined,
    details: { missingFields },
  }
}

/**
 * Check: showings_enabled
 * Verifies showing management is active
 */
async function checkShowingsEnabled(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  const { data: listing } = await supabase
    .from("listings")
    .select("showing_instructions, status")
    .eq("id", listingId)
    .single()
  
  const showingsEnabled = listing?.showing_instructions !== null && listing?.status === "active"
  
  return {
    check: "showings_enabled",
    passed: showingsEnabled,
    reason: showingsEnabled ? undefined : "Showing instructions not set or listing not active",
  }
}

/**
 * Check: offer_exists
 * Verifies at least one offer received
 */
async function checkOfferExists(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  const { data: offers, error } = await supabase
    .from("offers")
    .select("id")
    .eq("listing_id", listingId)
    .limit(1)
  
  if (error) {
    return {
      check: "offer_exists",
      passed: false,
      reason: `Error checking offers: ${error.message}`,
    }
  }
  
  const hasOffer = (offers?.length || 0) > 0
  
  return {
    check: "offer_exists",
    passed: hasOffer,
    reason: hasOffer ? undefined : "No offers received yet",
  }
}

/**
 * Check: contract_signed
 * Verifies contract is fully executed
 */
async function checkContractSigned(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Check for accepted offer
  const { data: offers } = await supabase
    .from("offers")
    .select("id, status")
    .eq("listing_id", listingId)
    .eq("status", "accepted")
    .limit(1)
  
  const hasAcceptedOffer = (offers?.length || 0) > 0
  
  // Check for transaction record
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, status")
    .eq("listing_id", listingId)
    .limit(1)
  
  const hasTransaction = (transactions?.length || 0) > 0
  
  return {
    check: "contract_signed",
    passed: hasAcceptedOffer && hasTransaction,
    reason: !hasAcceptedOffer
      ? "No accepted offer"
      : !hasTransaction
      ? "Transaction record not created"
      : undefined,
    details: { hasAcceptedOffer, hasTransaction },
  }
}

/**
 * Check: inspection_completed
 * Verifies inspection is done
 */
async function checkInspectionCompleted(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, stage")
    .eq("listing_id", listingId)
    .single()
  
  if (!transactions) {
    return {
      check: "inspection_completed",
      passed: false,
      reason: "No transaction found",
    }
  }
  
  // Check activities for inspection completion
  const { data: activities } = await supabase
    .from("activities")
    .select("id, activity_type, status")
    .eq("transaction_id", transactions.id)
    .eq("activity_type", "inspection")
    .eq("status", "completed")
    .limit(1)
  
  const inspectionComplete = (activities?.length || 0) > 0
  
  return {
    check: "inspection_completed",
    passed: inspectionComplete,
    reason: inspectionComplete ? undefined : "Inspection not completed",
  }
}

/**
 * Check: appraisal_completed
 * Verifies appraisal is done
 */
async function checkAppraisalCompleted(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id")
    .eq("listing_id", listingId)
    .single()
  
  if (!transactions) {
    return {
      check: "appraisal_completed",
      passed: false,
      reason: "No transaction found",
    }
  }
  
  // Check activities for appraisal completion
  const { data: activities } = await supabase
    .from("activities")
    .select("id, activity_type, status")
    .eq("transaction_id", transactions.id)
    .eq("activity_type", "appraisal")
    .eq("status", "completed")
    .limit(1)
  
  const appraisalComplete = (activities?.length || 0) > 0
  
  return {
    check: "appraisal_completed",
    passed: appraisalComplete,
    reason: appraisalComplete ? undefined : "Appraisal not completed",
  }
}

/**
 * Check: financing_approved
 * Verifies buyer financing is approved
 */
async function checkFinancingApproved(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id")
    .eq("listing_id", listingId)
    .single()
  
  if (!transactions) {
    return {
      check: "financing_approved",
      passed: false,
      reason: "No transaction found",
    }
  }
  
  // Check activities for financing approval
  const { data: activities } = await supabase
    .from("activities")
    .select("id, activity_type, status")
    .eq("transaction_id", transactions.id)
    .eq("activity_type", "financing_approval")
    .eq("status", "completed")
    .limit(1)
  
  const financingApproved = (activities?.length || 0) > 0
  
  return {
    check: "financing_approved",
    passed: financingApproved,
    reason: financingApproved ? undefined : "Financing not approved",
  }
}

/**
 * Check: closing_docs_ready
 * Verifies closing documents are ready
 */
async function checkClosingDocsReady(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id")
    .eq("listing_id", listingId)
    .single()
  
  if (!transactions) {
    return {
      check: "closing_docs_ready",
      passed: false,
      reason: "No transaction found",
    }
  }
  
  // Check for closing disclosure — CDs are FILED as transaction_documents with
  // doc_type='closing_disclosure' (lender portal + auto-filer both write that
  // shape); the thin closing_disclosure table was a writer-less twin (repointed).
  const { data: closingDocs } = await supabase
    .from("transaction_documents")
    .select("id")
    .eq("transaction_id", transactions.id)
    .eq("doc_type", "closing_disclosure")
    .limit(1)
  
  const docsReady = (closingDocs?.length || 0) > 0
  
  return {
    check: "closing_docs_ready",
    passed: docsReady,
    reason: docsReady ? undefined : "Closing disclosure not created",
  }
}
