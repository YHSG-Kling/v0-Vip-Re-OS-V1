/**
 * lib/documents/listing-agreement-gate.ts
 *
 * THE ONE PLACE THAT DECIDES A LISTING MAY BE TAKEN ON.
 *
 * Owner's rule, verbatim: "that is a draft, once the agreement is signed and
 * compliance check reviews all required docs, initials, signatures before
 * creating a new listing."
 *
 * So there are three conditions, and all three must hold:
 *   1. the document IS a listing agreement;
 *   2. BOTH the listing agent and the seller have SIGNED and INITIALED it;
 *   3. every required seller-side document is present for this file.
 *
 * Only then does the pass event fire, and only the compliance-listing-auto-create
 * chain acts on it — adopting the agent's draft, or creating the listing if the
 * signed agreement arrived with no draft ahead of it.
 *
 * WHY THIS MODULE EXISTS AT ALL. The rule was already written, once, inside
 * app/actions/documents.ts's processDocumentWithAI — and it could never run:
 *
 *   · that path's classifier prompt offers a fixed enum that does not contain
 *     `listing_agreement`, so the branch guarding on it was unreachable;
 *   · that path writes to `client_documents`, while auditListingDocuments reads
 *     `documents` — so even a correctly-typed document was invisible to the
 *     required-document audit that gates the same decision.
 *
 * The uploads that matter go through lib/documents/upload-document.ts into
 * `documents`, and are classified by scanUploadedDocument against the canonical
 * taxonomy. That is where the gate belongs, so that is where it now lives.
 *
 * This module NEVER promotes a listing itself. It emits; the chain decides.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { evaluateExecution } from "@/lib/compliance/signature-completeness"

export interface ListingAgreementGateResult {
  /** Did the pass event fire? */
  passed: boolean
  /** Why not — for the agent-facing surface and the logs. Empty when passed. */
  blockers: string[]
  /** The listing the document was matched to, when one was resolvable. */
  listingId: string | null
}

/**
 * Run the gate for a freshly scanned document. Safe to call for ANY
 * classification — it returns immediately for anything that is not a listing
 * agreement, so the scanner can call it unconditionally.
 */
export async function runListingAgreementGate(
  supabase: SupabaseClient,
  params: {
    documentId:     string
    brokerageId:    string
    classification: string
    extractedFields: Record<string, unknown>
    signatureCompleteness: unknown
    contactId:  string | null
    listingId:  string | null
    agentUserId: string | null
  },
): Promise<ListingAgreementGateResult> {
  if (params.classification !== "listing_agreement") {
    return { passed: false, blockers: [], listingId: params.listingId }
  }

  const fields = params.extractedFields ?? {}
  const stateCode = (fields.state as string | null) ?? null

  // ── 1. Both parties executed it ──────────────────────────────────────────
  const execution = evaluateExecution(params.signatureCompleteness)
  if (!execution.executed) {
    return {
      passed: false,
      blockers: [`Not fully executed — missing: ${execution.missing.join(", ")}`],
      listingId: params.listingId,
    }
  }

  // ── 2. Resolve the seller this agreement belongs to ──────────────────────
  // The agent uploads on the listing, so the listing is usually what we have and
  // the seller comes off it. A document filed against the contact gives us the
  // seller directly. Without a seller we cannot audit the file OR match a draft,
  // and guessing one would attach a signed agreement to the wrong person.
  let sellerContactId = params.contactId
  if (!sellerContactId && params.listingId) {
    const { data: listing } = await supabase
      .from("listings")
      .select("seller_contact_id")
      .eq("id", params.listingId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()
    sellerContactId = (listing?.seller_contact_id as string | null) ?? null
  }
  if (!sellerContactId) {
    return {
      passed: false,
      blockers: ["No seller on file for this agreement — attach it to the seller contact or the listing."],
      listingId: params.listingId,
    }
  }

  // ── 3. Every required seller-side document present ───────────────────────
  const { auditListingDocuments } = await import("@/lib/compliance/required-documents")
  const audit = await auditListingDocuments(supabase, {
    brokerageId:     params.brokerageId,
    sellerContactId,
    listingId:       params.listingId,
    stateCode,
  })

  if (audit.missing_blocking.length > 0) {
    const { documentClassificationLabel } = await import("@/lib/compliance/document-classifications")
    return {
      passed: false,
      blockers: [
        `Required documents missing: ${audit.missing_blocking.map(documentClassificationLabel).join(", ")}`,
      ],
      listingId: params.listingId,
    }
  }

  // ── 4. All three conditions hold — emit ──────────────────────────────────
  // The engine is called directly rather than through the `use server` action:
  // this runs in a fire-and-forget scan after the upload has already returned,
  // where there is no request session left for the action's auth gate to read.
  // brokerageId comes from the document row, not from a caller.
  const { startRun } = await import("@/lib/workflow-orchestrator/engine")
  const { getChainsByTrigger } = await import("@/lib/workflow-orchestrator/chains")

  const eventType = "compliance.listing_agreement_passed"
  const chains = getChainsByTrigger(eventType)
  for (const chain of chains) {
    await startRun({
      chainKey:     chain.key,
      brokerageId:  params.brokerageId,
      contactId:    sellerContactId,
      listingId:    params.listingId,
      agentUserId:  params.agentUserId,
      triggerEvent: eventType,
      // The chain's own idempotency key is (chain, brokerage, entity) — a
      // re-scan of the same agreement therefore reuses the run rather than
      // promoting twice. The draft-state re-assertion in the chain is the
      // second belt on the same trousers.
      triggerEventId: params.documentId,
      metadata: {
        document_id:     params.documentId,
        extracted:       fields,
        signature_scan:  { signatureCompleteness: params.signatureCompleteness },
        required_docs_audit: {
          present:         audit.present,
          missing_warning: audit.missing_warning,
        },
      },
    })
  }

  return { passed: true, blockers: [], listingId: params.listingId }
}
