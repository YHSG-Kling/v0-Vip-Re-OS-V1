/**
 * lib/workflow/intelligence/packet-analysis.ts — PURE. No DB, no "use server".
 *
 * The field-level completeness walk that answers one question for ANY signable
 * packet: which signatures, initials, fields and whole forms are missing?
 *
 * It was written inside scan-offer-packet.ts and was reachable only for offers,
 * even though nothing in the logic is offer-shaped — it reads
 * `documents.content.filledPacket`, which the voice cockpit and the FormWizard
 * write identically for a listing agreement and for an offer.
 *
 * That mattered because the owner's compliance rule applies at BOTH checkpoints:
 * an accepted offer becoming a transaction, and a signed listing agreement
 * becoming a live listing. The listing side had no scanner at all, so
 * markAgreementSigned simply wrote `compliance_passed: true` as a literal.
 *
 * Extracted here rather than copied so there is ONE definition of "what counts
 * as a missing signature". Two copies of that rule would drift the first time
 * either side gained a form type.
 */

export interface PacketScanFinding {
  flagType:    "missing_signature" | "missing_initial" | "missing_form" | "missing_field" | "expired_disclosure" | "other"
  severity:    "low" | "medium" | "high" | "critical"
  title:       string
  body:        string
  formName?:   string
  fieldName?:  string
}

export interface PacketAnalysis {
  blockers:          PacketScanFinding[]
  warnings:          PacketScanFinding[]
  totalFields:       number
  filledFields:      number
  completionPercent: number
}

const SIGNATURE_HINTS = ["signature", "_sig", " sig "]
const INITIAL_HINTS   = ["initial", "_init", " init "]

/** PURE — is this field name a signature block, an initial block, or data? */
export function classifyMissingField(
  fieldName: string,
): "missing_signature" | "missing_initial" | "missing_field" {
  const lower = ` ${fieldName.toLowerCase()} `
  if (SIGNATURE_HINTS.some(h => lower.includes(h))) return "missing_signature"
  if (INITIAL_HINTS.some(h => lower.includes(h)))   return "missing_initial"
  return "missing_field"
}

/**
 * PURE — walk a filledPacket and classify every gap.
 *
 * `blockers` are things that must not reach a signature request: a form the
 * fill engine could not build, and any unfilled field (a missing signature
 * block is critical, a missing initial high, other fields medium).
 * `warnings` are low-confidence values that were filled but want a human eye.
 *
 * completionPercent counts only high/medium-confidence filled fields, so a
 * packet full of low-confidence guesses does NOT read as complete.
 */
export function analyzeFilledPacket(filledPacket: Record<string, any>): PacketAnalysis {
  const forms: any[] = [
    ...(Array.isArray(filledPacket?.forms)          ? filledPacket.forms          : []),
    ...(Array.isArray(filledPacket?.brokerageForms) ? filledPacket.brokerageForms : []),
  ]
  const agentMustComplete: string[] = Array.isArray(filledPacket?.agentMustComplete)
    ? filledPacket.agentMustComplete : []

  const blockers: PacketScanFinding[] = []
  const warnings: PacketScanFinding[] = []
  let totalFields = 0
  let filledHighOrMedium = 0

  // 1) Missing forms — the fill engine couldn't even build them.
  for (const formName of agentMustComplete) {
    blockers.push({
      flagType: "missing_form",
      severity: "high",
      title:    `Form missing: ${formName}`,
      body:     `${formName} couldn't be auto-filled and isn't in the packet. Open the form library and attach it before sending for signature.`,
      formName,
    })
  }

  // 2) Per-form field walk.
  for (const form of forms) {
    const formName = String(form?.formName ?? form?.formId ?? "Unknown form")
    const filledFields: any[] = Array.isArray(form?.filledFields) ? form.filledFields : []
    const unfilled:     any[] = Array.isArray(form?.unfilled)     ? form.unfilled     : []

    totalFields += filledFields.length + unfilled.length

    for (const ff of filledFields) {
      const confidence = String(ff?.confidence ?? "high").toLowerCase()
      if (confidence === "high" || confidence === "medium") filledHighOrMedium++
      if (confidence === "low") {
        warnings.push({
          flagType: "missing_field",
          severity: "low",
          title:    `Verify low-confidence field on ${formName}`,
          body:     `Field "${ff?.fieldName}" was filled with low confidence — verify the value before sending for signature.`,
          formName,
          fieldName: ff?.fieldName,
        })
      }
    }

    for (const uf of unfilled) {
      const fieldName = String(uf?.fieldName ?? "unknown field")
      const flagType  = classifyMissingField(fieldName)
      const severity: "high" | "critical" | "medium" =
        flagType === "missing_signature" ? "critical" :
        flagType === "missing_initial"   ? "high" : "medium"
      blockers.push({
        flagType, severity,
        title: flagType === "missing_signature" ? `Signature block missing on ${formName}`
             : flagType === "missing_initial"   ? `Initial block missing on ${formName}`
             :                                    `Field missing on ${formName}: ${fieldName}`,
        body:  `Form "${formName}", field "${fieldName}" — ${uf?.reason ?? "not provided in intake"}.`,
        formName,
        fieldName,
      })
    }
  }

  return {
    blockers,
    warnings,
    totalFields,
    filledFields: filledHighOrMedium,
    // No fields at all is 100% — an empty packet is not "0% complete", it is a
    // packet with nothing outstanding. The missing-FORM blockers above are what
    // catch a packet that should have had forms in it.
    completionPercent: totalFields > 0 ? Math.round((filledHighOrMedium / totalFields) * 100) : 100,
  }
}
