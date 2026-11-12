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

  // An audit that could not RUN is not a clean audit. auditListingDocuments now
  // reports `unavailable_reason` when the settings checklist or the deal file
  // could not be read; before that, both refusals looked exactly like "nothing
  // required, nothing missing" and this gate PASSED on them.
  if (audit.unavailable_reason) {
    return {
      passed: false,
      blockers: [`Required-document check could not run: ${audit.unavailable_reason}. Nothing was verified, so the listing was not taken on.`],
      listingId: params.listingId,
    }
  }

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
  // THE EVENT IS RECORDED, AND THE ORCHESTRATOR STARTS THE CHAIN FROM IT (lane 88D).
  // This called engine startRun directly with triggerEventId = the DOCUMENT id.
  // workflow_runs.trigger_event_id is a uuid FK to lifecycle_events(id)
  // (workflow_runs_trigger_event_id_fkey, live hrvaqgvukzxfskkcrwbt 2026-09-28), so
  // every such insert was a 23503: startRun returned { success: false }, the result
  // was not read, and compliance-listing-auto-create NEVER started — a fully
  // executed, fully documented agreement was reported `passed` and no listing was
  // taken on. Same shape as the listing-appointment prep
  // (lib/workflow-orchestrator/chains/listing-appt-prep.ts::fireListingAppointmentSetForBooking):
  // ONE compliance.listing_agreement_passed event per agreement through the
  // server-only lifecycle-event core (service client — the scanner's; tenant = the
  // document row's brokerageId, never a caller's), and lib/orchestrator/internal.ts
  // orchestrateEvent starts every chain registered for it with triggerEventId =
  // event.id. Sessionless: this runs in a fire-and-forget scan after the upload has
  // returned. A re-scan of the same agreement finds the SAME event (dedupe key on the
  // document, no time window) and does not promote twice; the chain's draft-state
  // re-assertion is the second belt.
  const { recordLifecycleEvent } = await import("@/lib/events/lifecycle-event-core")
  const emitted = await recordLifecycleEvent(supabase, params.brokerageId, {
    // Literal, not a variable: test:vocabulary-drift proves every chain trigger has an emitter
    // by reading the event_type literal at the emit site.
    event_type: "compliance.listing_agreement_passed",
    user_id: params.agentUserId ?? undefined,
    source: "system",
    dedupe_key: `compliance.listing_agreement_passed:${params.documentId}`,
    entity_type: "document",
    entity_id: params.documentId,
    payload: {
      contact_id:      sellerContactId,
      listing_id:      params.listingId,
      agent_user_id:   params.agentUserId,
      document_id:     params.documentId,
      extracted:       fields,
      signature_scan:  { signatureCompleteness: params.signatureCompleteness },
      required_docs_audit: {
        present:         audit.present,
        missing_warning: audit.missing_warning,
      },
    },
  }, { dedupeWindowHours: null })
  if (!emitted.ok) {
    // The gate PASSED; the event that starts the listing could not be recorded.
    // Said, never swallowed — the scanner surfaces the blocker on the document.
    return {
      passed: false,
      blockers: [`The agreement passed compliance, but the listing could not be started: ${emitted.error}`],
      listingId: params.listingId,
    }
  }
  if (!emitted.deduped && !emitted.dispatched) {
    console.error(`[listing-agreement-gate] compliance.listing_agreement_passed ${emitted.event.id} recorded but NOT dispatched — no listing chain started for document ${params.documentId}`)
  }

  return { passed: true, blockers: [], listingId: params.listingId }
}
