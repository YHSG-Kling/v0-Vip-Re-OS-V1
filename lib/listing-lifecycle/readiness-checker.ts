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
    
    case "dotloop_signatures":
      // Legacy name - redirect to provider_signatures
      return await checkProviderSignatures(supabase, listingId)
    
    case "provider_signatures":
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
async function checkDocumentsVerified(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  const { data, error } = await supabase
    .from("transaction_documents")
    .select("id, document_type, status")
    .eq("listing_id", listingId)
    .eq("is_required", true)
  
  if (error) {
    return {
      check: "documents_verified",
      passed: false,
      reason: `Error checking documents: ${error.message}`,
    }
  }
  
  const unverifiedDocs = data?.filter((d) => d.status !== "verified") || []
  
  return {
    check: "documents_verified",
    passed: unverifiedDocs.length === 0,
    reason: unverifiedDocs.length > 0
      ? `${unverifiedDocs.length} required document(s) not verified`
      : undefined,
    details: { totalRequired: data?.length || 0, unverified: unverifiedDocs.length },
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
    passed: signatureComplete,
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
  // Check for approved photos
  const { data: photos } = await supabase
    .from("listing_photos")
    .select("id, status")
    .eq("listing_id", listingId)
    .eq("status", "approved")
  
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
  
  // Check for closing disclosure
  const { data: closingDocs } = await supabase
    .from("closing_disclosure")
    .select("id")
    .eq("transaction_id", transactions.id)
    .limit(1)
  
  const docsReady = (closingDocs?.length || 0) > 0
  
  return {
    check: "closing_docs_ready",
    passed: docsReady,
    reason: docsReady ? undefined : "Closing disclosure not created",
  }
}
