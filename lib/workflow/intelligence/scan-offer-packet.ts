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
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID }          from "@/lib/validations"
import { flagOfferCompliance }  from "@/app/actions/buyer-offer/flag-compliance"
import { notifyComplianceFlag } from "@/lib/notifications/notify-helpers"
import { analyzeFilledPacket, type PacketScanFinding } from "./packet-analysis"

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
  error?:            string
}

export async function scanOfferPacketCompleteness(params: {
  offerId: string
  raiserUserId: string
}): Promise<PacketScanSummary> {
  const { offerId, raiserUserId } = params

  if (!isValidUUID(offerId) || !isValidUUID(raiserUserId)) {
    return {
      success: false, offerId, documentId: null, completionPercent: 0,
      totalFields: 0, filledFields: 0, blockers: [], warnings: [],
      notifications_fired: 0, error: "Invalid IDs",
    }
  }

  const supabase = createServiceClient()

  // Find the staged offer document. Voice + manual paths both write
  // documents.metadata.linked_offer_id when staging.
  const { data: doc } = await supabase
    .from("documents")
    .select("id, brokerage_id, contact_id, content, metadata, status")
    .eq("document_type", "offer")
    .filter("metadata->>linked_offer_id", "eq", offerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!doc) {
    return {
      success: false, offerId, documentId: null, completionPercent: 0,
      totalFields: 0, filledFields: 0, blockers: [], warnings: [],
      notifications_fired: 0, error: "No staged document found for this offer",
    }
  }

  // Parse the filledPacket JSON from documents.content
  let parsed: any = {}
  try { parsed = JSON.parse((doc.content as string | null) ?? "{}") } catch { /* ignore */ }
  const filledPacket = (parsed?.filledPacket ?? {}) as Record<string, any>
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
  }

  if (!isValidUUID(listingId) || !isValidUUID(raiserUserId)) {
    return { success: false, ...empty, error: "Invalid IDs" }
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
    return { success: false, ...empty, error: `Could not read the document store: ${docError.message}` }
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
  }
}
