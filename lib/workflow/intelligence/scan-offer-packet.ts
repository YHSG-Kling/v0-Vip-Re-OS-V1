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

export interface PacketScanFinding {
  flagType:    "missing_signature" | "missing_initial" | "missing_form" | "missing_field" | "expired_disclosure" | "other"
  severity:    "low" | "medium" | "high" | "critical"
  title:       string
  body:        string
  formName?:   string
  fieldName?:  string
}

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

const SIGNATURE_HINTS = ["signature", "_sig", " sig "]
const INITIAL_HINTS   = ["initial", "_init", " init "]

function classifyMissingField(fieldName: string): "missing_signature" | "missing_initial" | "missing_field" {
  const lower = ` ${fieldName.toLowerCase()} `
  if (SIGNATURE_HINTS.some(h => lower.includes(h))) return "missing_signature"
  if (INITIAL_HINTS.some(h => lower.includes(h)))   return "missing_initial"
  return "missing_field"
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
  const forms: any[] = [
    ...(Array.isArray(filledPacket.forms)          ? filledPacket.forms          : []),
    ...(Array.isArray(filledPacket.brokerageForms) ? filledPacket.brokerageForms : []),
  ]
  const agentMustComplete: string[] = Array.isArray(filledPacket.agentMustComplete)
    ? filledPacket.agentMustComplete : []

  const blockers: PacketScanFinding[] = []
  const warnings: PacketScanFinding[] = []
  let totalFields = 0
  let filledHighOrMedium = 0

  // ── 1) Missing forms (the form-fill engine couldn't even build them) ─────
  for (const formName of agentMustComplete) {
    blockers.push({
      flagType: "missing_form",
      severity: "high",
      title:    `Form missing: ${formName}`,
      body:     `${formName} couldn't be auto-filled and isn't in the packet. Open the form library and attach it before sending for signature.`,
      formName,
    })
  }

  // ── 2) Per-form field walk ───────────────────────────────────────────────
  for (const form of forms) {
    const formName = String(form.formName ?? form.formId ?? "Unknown form")
    const filledFields: any[] = Array.isArray(form.filledFields) ? form.filledFields : []
    const unfilled:     any[] = Array.isArray(form.unfilled)     ? form.unfilled     : []

    totalFields += filledFields.length + unfilled.length

    for (const ff of filledFields) {
      const confidence = String(ff.confidence ?? "high").toLowerCase()
      if (confidence === "high" || confidence === "medium") filledHighOrMedium++
      if (confidence === "low") {
        warnings.push({
          flagType: "missing_field",
          severity: "low",
          title:    `Verify low-confidence field on ${formName}`,
          body:     `Field "${ff.fieldName}" was filled with low confidence — verify the value before sending for signature.`,
          formName,
          fieldName: ff.fieldName,
        })
      }
    }

    for (const uf of unfilled) {
      const fieldName = String(uf.fieldName ?? "unknown field")
      const flagType  = classifyMissingField(fieldName)
      const severity: "high" | "critical" | "medium" =
        flagType === "missing_signature" ? "critical" :
        flagType === "missing_initial"   ? "high" : "medium"
      blockers.push({
        flagType, severity,
        title: flagType === "missing_signature" ? `Signature block missing on ${formName}`
             : flagType === "missing_initial"   ? `Initial block missing on ${formName}`
             :                                    `Field missing on ${formName}: ${fieldName}`,
        body:  `Form "${formName}", field "${fieldName}" — ${uf.reason ?? "not provided in intake"}.`,
        formName,
        fieldName,
      })
    }
  }

  const completionPercent = totalFields > 0
    ? Math.round((filledHighOrMedium / totalFields) * 100)
    : 100

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
