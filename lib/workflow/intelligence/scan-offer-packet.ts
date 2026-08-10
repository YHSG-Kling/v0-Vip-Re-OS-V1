"use server"

/**
 * Scan a staged offer's packet for completeness, then surface any findings as
 * compliance flags so the TC + agent get notified.
 *
 * The voice-cockpit and FormWizard both write the filled packet to
 * `documents.content` as JSON:
 *   { intake, filledPacket: { forms[], brokerageForms[], agentMustComplete[], audit } }
 *
 * For each FilledForm:
 *   - filledFields: { fieldName, value, confidence: high|medium|low, sourceField }
 *   - unfilled:     { fieldName, reason }
 *
 * What this scanner detects:
 *   1. Missing forms       — declared in `filledPacket.agentMustComplete` (the
 *                            form-fill engine couldn't auto-fill them)
 *   2. Missing fields      — every entry in `forms[].unfilled[]`
 *   3. Low-confidence fields — `confidence='low'` fields the agent should
 *                              verify before send (medium severity)
 *
 * Severity mapping:
 *   missing_form          → high     (whole document not in the packet)
 *   missing_signature     → critical (sig fields not placed)
 *   missing_initial       → high     (initial fields not placed)
 *   missing_field         → medium   (general unfilled field)
 *   low_confidence_field  → low      (filled but low-confidence — verify)
 *
 * Each finding is dispatched through flagOfferCompliance so the activity row
 * + notifications fan-out land together.
 *
 * Returns a summary suitable for showing the agent inline in the FormWizard
 * before they click "send for signature" (so they fix issues pre-dispatch).
 *
 * ── THIS SCANNER FAILS CLOSED ───────────────────────────────────────────────
 * A scan that could not RUN has not established completeness. Every exit that
 * did not walk a real packet returns `success:false` AND a real BLOCKER saying
 * so — never `blockers: []`. That is deliberate: `blockers` is the field every
 * consumer reads and the field that fans out to the TC and the agent, so a
 * caller that reads nothing else still refuses. The four such exits are an
 * invalid id, an unreadable documents table, no staged document, and a staged
 * document whose content carries no packet.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID }          from "@/lib/validations"
import { flagOfferCompliance }  from "@/app/actions/buyer-offer/flag-compliance"
import { notifyComplianceFlag } from "@/lib/notifications/notify-helpers"
import {
  analyzeFilledPacket,
  type PacketScanFinding,
  type PacketSide,
  type SideSignatureEvidence,
} from "./packet-analysis"

export type { PacketScanFinding } from "./packet-analysis"

export interface PacketScanSummary {
  success:           boolean
  offerId:           string
  documentId:        string | null
  completionPercent: number
  totalFields:       number
  filledFields:      number
  blockers:          PacketScanFinding[]
  warnings:          PacketScanFinding[]
  notifications_fired: number
  /** What the packet could SHOW about each side's signature blocks. */
  signatureSides:    Record<PacketSide, SideSignatureEvidence>
  error?:            string
  /**
   * WHY the scan ended as it did. `success` alone cannot carry this, and the
   * difference decides whether a submit is refused.
   *
   *  · "scanned"          — a packet was found and walked. `blockers` is the verdict.
   *  · "no_packet_staged" — this offer was never built through the packet
   *                         builder, so there is no packet to verify. NOT a
   *                         fault: the e-sign path (offer wizard → signature
   *                         request → executed contract) is a legitimate way to
   *                         reach an executed contract, and its signature
   *                         evidence lives on the OFFER row, which
   *                         submit-to-compliance already enforces
   *                         (buyer_signed_at + fully_signed_contract_received_at
   *                         + seller accepted/signed) before this scan is ever
   *                         called.
   *  · "fault"            — invalid ids, a refused read, or a packet that exists
   *                         but could not be parsed. Something IS there (or the
   *                         store could not be asked) and we could not verify it.
   *                         Always refuse.
   *
   * The distinction matters in both directions. Treating "fault" as benign is
   * the original bug. Treating "no_packet_staged" as a fault would refuse every
   * offer created through the wizard — `app/actions/buyer-offers.ts:createOffer`
   * writes no `documents` row at all — which is a product outage, not a
   * compliance improvement.
   */
  scanOutcome:       "scanned" | "no_packet_staged" | "fault"
}

/** Nothing was seen about either side. The honest starting point. */
const NO_SIDE_EVIDENCE = (): Record<PacketSide, SideSignatureEvidence> => ({
  buyer:       { evidenced: false, outstanding: 0 },
  seller:      { evidenced: false, outstanding: 0 },
  unspecified: { evidenced: false, outstanding: 0 },
})

/**
 * A scan that COULD NOT RUN.
 *
 * THE FIX FOR THE CLASS: the reason is returned as a real BLOCKER, not only as
 * `success:false` + `error`. Every consumer of this scanner reads `blockers` —
 * that is what refuses the submit and what fans out to the TC and the agent —
 * so a caller that reads nothing else still fails CLOSED. Returning
 * `blockers: []` here is what let "the packet is fully signed" and "there is no
 * packet at all" arrive at the gate looking identical, and both pass.
 *
 * `title` says what happened; `body` says what the agent must DO, because the
 * owner's step 4 sends the missing piece back to the TC and agent to finish.
 */
function unrunnableScan(params: {
  offerId:    string
  documentId: string | null
  error:      string
  title:      string
  remedy:     string
  /** See PacketScanSummary.scanOutcome — decides whether the gate refuses. */
  outcome:    "no_packet_staged" | "fault"
}): PacketScanSummary {
  return {
    success: false,
    offerId: params.offerId,
    documentId: params.documentId,
    // NOT 100. An unread packet is 0% verified, not a packet with nothing
    // outstanding — the two are only the same number when nobody looked.
    completionPercent: 0,
    totalFields: 0,
    filledFields: 0,
    blockers: [{
      flagType: "missing_form",
      severity: "critical",
      title:    params.title,
      body:     params.remedy,
    }],
    warnings: [],
    notifications_fired: 0,
    signatureSides: NO_SIDE_EVIDENCE(),
    error: params.error,
    scanOutcome: params.outcome,
  }
}

export async function scanOfferPacketCompleteness(params: {
  offerId: string
  raiserUserId: string
}): Promise<PacketScanSummary> {
  const { offerId, raiserUserId } = params

  if (!isValidUUID(offerId) || !isValidUUID(raiserUserId)) {
    return unrunnableScan({
      offerId, documentId: null, outcome: "fault",
      error: "Invalid IDs",
      title: "Offer packet could not be checked — the offer or user id is not valid",
      remedy: "Nothing was verified. Reopen the offer from the deal file and submit it again from there so the correct offer id is used.",
    })
  }

  const supabase = createServiceClient()

  // Find the staged offer document. The staging paths write
  // documents.metadata.linked_offer_id when they cross-link the packet to the
  // offers row.
  //
  // `error` is destructured: supabase-js RESOLVES a refused read, so
  // `const { data }` renders "the query was refused" and "there is no such
  // document" identically — and this is a GATE.
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("id, brokerage_id, contact_id, content, metadata, status")
    .eq("document_type", "offer")
    .filter("metadata->>linked_offer_id", "eq", offerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (docError) {
    return unrunnableScan({
      offerId, documentId: null, outcome: "fault",
      error: `Could not read the document store: ${docError.message}`,
      title: "Offer packet could not be checked — the document store could not be read",
      remedy: "No signature or initial was verified. This is a system fault, not a missing document: retry the submit, and if it repeats send this to support before the offer is submitted again.",
    })
  }

  if (!doc) {
    return unrunnableScan({
      // NOT a fault: this offer was never built through the packet builder.
      offerId, documentId: null, outcome: "no_packet_staged",
      error: "No staged document found for this offer",
      title: "No offer packet is staged against this offer",
      remedy: "Compliance has no paperwork to check, so ZERO signatures and initials were verified. Open the offer's packet in the Form Wizard so the completed forms are staged against this offer, then resubmit to compliance.",
    })
  }

  // Parse the filledPacket JSON from documents.content.
  //
  // A parse failure and a document that carries no packet are the SAME fault
  // as no document at all: the walk below would see `{}`, find nothing
  // outstanding and report 100% complete on a packet it never read.
  let parsed: any = null
  let parseFailed = false
  try { parsed = JSON.parse((doc.content as string | null) ?? "") } catch { parseFailed = true }
  const rawPacket = parsed?.filledPacket
  if (parseFailed || !rawPacket || typeof rawPacket !== "object") {
    return unrunnableScan({
      offerId, documentId: doc.id as string, outcome: "fault",
      error: parseFailed
        ? "The staged offer document's content is not readable JSON"
        : "The staged offer document carries no filled packet",
      title: "The staged offer packet could not be read",
      remedy: "A document is staged against this offer but it contains no completed forms, so no signature or initial was verified. Re-stage the packet from the Form Wizard (or re-run the offer draft) and resubmit to compliance.",
    })
  }
  const filledPacket = rawPacket as Record<string, any>
  // The field walk is shared with the listing-agreement checkpoint — see
  // packet-analysis.ts. One definition of "what counts as a missing signature".
  const analysis = analyzeFilledPacket(filledPacket)
  const { blockers, warnings, totalFields, completionPercent } = analysis
  const filledHighOrMedium = analysis.filledFields

  // Fan out each finding through flagOfferCompliance so the activity row
  // gets written AND the notifications go to agent + TC + compliance_officer
  // (high/critical fire multi-channel via NotificationService).
  let notifications_fired = 0
  const dispatch = async (f: PacketScanFinding) => {
    const r = await flagOfferCompliance({
      offerId,
      raiserUserId,
      flagType:  f.flagType,
      severity:  f.severity,
      title:     f.title,
      body:      f.body,
      documentId: doc.id,
    })
    if (r.success) notifications_fired += r.notified_count ?? 0
  }

  for (const f of blockers) await dispatch(f)
  // Warnings are typically too noisy to fan out per-field — collapse to one
  // summary if there are any. Critical/high blockers always fire individually.
  if (warnings.length > 0) {
    await dispatch({
      flagType: "missing_field",
      severity: "low",
      title:    `${warnings.length} low-confidence field${warnings.length === 1 ? "" : "s"} on packet`,
      body:     `Review fields: ${warnings.slice(0, 5).map(w => w.fieldName ?? w.formName).filter(Boolean).join(", ")}${warnings.length > 5 ? ` and ${warnings.length - 5} more` : ""}.`,
    })
  }

  return {
    success: true,
    offerId,
    documentId: doc.id as string,
    completionPercent,
    totalFields,
    filledFields: filledHighOrMedium,
    blockers,
    warnings,
    notifications_fired,
    signatureSides: analysis.signatureSides,
    scanOutcome: "scanned",
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTING-AGREEMENT PACKET SCAN
// ─────────────────────────────────────────────────────────────────────────────

export interface ListingPacketScanSummary {
  success:             boolean
  listingId:           string
  documentId:          string | null
  completionPercent:   number
  totalFields:         number
  filledFields:        number
  blockers:            PacketScanFinding[]
  warnings:            PacketScanFinding[]
  notifications_fired: number
  /**
   * What the packet could SHOW about each side's signature blocks. The
   * listing checkpoint's two sides are the SELLER and the listing broker, not
   * buyer/seller — the analyzer reports the evidence, each gate applies its
   * own rule to it.
   */
  signatureSides:      Record<PacketSide, SideSignatureEvidence>
  error?:              string
}

/**
 * The same completeness scan, for the LISTING side.
 *
 * The owner's compliance rule applies at two checkpoints, not one: an accepted
 * offer becoming a transaction, and a signed listing agreement becoming a live
 * listing. Only the offer side had a scanner, so markAgreementSigned wrote
 * `compliance_passed: true` as a literal — a compliance column that asserted a
 * check nobody had run.
 *
 * Shares analyzeFilledPacket with the offer path, so a missing signature means
 * the same thing on both. Differences are only where they must be:
 *   · the staged document is found by document_type='listing_agreement' +
 *     metadata.linked_listing_id
 *   · findings dispatch through notifyComplianceFlag (which reaches the TC and
 *     the listing agent) rather than flagOfferCompliance, which keys on an
 *     offer id this checkpoint does not have.
 */
export async function scanListingPacketCompleteness(params: {
  listingId:    string
  raiserUserId: string
  brokerageId:  string
  /** users.id of the listing agent + anyone else the caller wants told. */
  alsoNotifyUserIds?: (string | null | undefined)[]
}): Promise<ListingPacketScanSummary> {
  const { listingId, raiserUserId, brokerageId, alsoNotifyUserIds } = params

  const empty = {
    listingId, documentId: null, completionPercent: 0,
    totalFields: 0, filledFields: 0,
    blockers: [] as PacketScanFinding[], warnings: [] as PacketScanFinding[],
    notifications_fired: 0,
    signatureSides: NO_SIDE_EVIDENCE(),
  }

  /**
   * Same class-fix as the offer side: a scan that could not RUN carries a real
   * blocker, not an empty list. markAgreementSigned already refuses on
   * `!success`, so this changes no verdict here — it changes what the TC and
   * the listing agent are TOLD, and it stops the next consumer of this summary
   * from having to know that `blockers: []` can mean "nobody looked".
   */
  const unrunnable = (error: string, title: string, remedy: string): ListingPacketScanSummary => ({
    success: false, ...empty,
    blockers: [{ flagType: "missing_form", severity: "critical", title, body: remedy }],
    error,
  })

  if (!isValidUUID(listingId) || !isValidUUID(raiserUserId)) {
    return unrunnable(
      "Invalid IDs",
      "Listing packet could not be checked — the listing or user id is not valid",
      "Nothing was verified. Reopen the listing from the deal file and execute the agreement from there so the correct listing id is used.",
    )
  }

  const supabase = createServiceClient()

  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("id, brokerage_id, contact_id, content, metadata, status")
    .eq("document_type", "listing_agreement")
    .filter("metadata->>linked_listing_id", "eq", listingId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // An unreadable documents table is NOT "no packet staged". Saying so is the
  // difference between "attach the agreement" and "we could not look".
  if (docError) {
    return unrunnable(
      `Could not read the document store: ${docError.message}`,
      "Listing packet could not be checked — the document store could not be read",
      "No signature or initial was verified. This is a system fault, not a missing document: retry, and if it repeats send this to support before the agreement is executed again.",
    )
  }
  if (!doc) {
    // No staged packet is an honest, non-blocking observation: a brokerage that
    // signs on paper and uploads the executed PDF has no filledPacket at all.
    // The required-DOCUMENT audit is what covers that case; this scan only
    // speaks about a packet it can actually see.
    return { success: true, ...empty, completionPercent: 100 }
  }

  let parsed: any = {}
  try { parsed = JSON.parse((doc.content as string | null) ?? "{}") } catch { /* ignore */ }
  const analysis = analyzeFilledPacket((parsed?.filledPacket ?? {}) as Record<string, any>)

  let notifications_fired = 0
  const dispatch = async (f: PacketScanFinding) => {
    const r = await notifyComplianceFlag(supabase as any, {
      brokerageId,
      agentUserId: raiserUserId,
      alsoNotifyUserIds,
      flag: {
        type:       `listing.packet.${f.flagType}`,
        severity:   f.severity,
        title:      f.title,
        body:       f.body,
        entityType: "document",
        entityId:   doc.id as string,
      },
    })
    notifications_fired += r.notified_count
  }

  for (const f of analysis.blockers) await dispatch(f)
  if (analysis.warnings.length > 0) {
    await dispatch({
      flagType: "missing_field",
      severity: "low",
      title:    `${analysis.warnings.length} low-confidence field${analysis.warnings.length === 1 ? "" : "s"} on the listing packet`,
      body:     `Review fields: ${analysis.warnings.slice(0, 5).map(w => w.fieldName ?? w.formName).filter(Boolean).join(", ")}${analysis.warnings.length > 5 ? ` and ${analysis.warnings.length - 5} more` : ""}.`,
    })
  }

  return {
    success: true,
    listingId,
    documentId: doc.id as string,
    completionPercent: analysis.completionPercent,
    totalFields: analysis.totalFields,
    filledFields: analysis.filledFields,
    blockers: analysis.blockers,
    warnings: analysis.warnings,
    notifications_fired,
    signatureSides: analysis.signatureSides,
  }
}
