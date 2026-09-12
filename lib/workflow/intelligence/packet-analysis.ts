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
  /** Which side of the table the field belongs to, when the name says so. */
  side?:       PacketSide
}

/**
 * Which side of the table a signature/initial block belongs to.
 *
 * `unspecified` is a REAL answer, not a default: it means the packet named a
 * signature block without naming whose it is. A caller must not read it as
 * "covered" — see `signatureSides` below.
 */
export type PacketSide = "buyer" | "seller" | "unspecified"

/** What the packet was able to SHOW about one side's signature blocks. */
export interface SideSignatureEvidence {
  /**
   * The packet contained at least one signature/initial block naming this
   * side — filled or not. FALSE means the packet said nothing whatsoever
   * about this side, which is silence, not a pass.
   */
  evidenced:   boolean
  /** How many of this side's signature/initial blocks are still unsigned. */
  outstanding: number
}

export interface PacketAnalysis {
  blockers:          PacketScanFinding[]
  warnings:          PacketScanFinding[]
  totalFields:       number
  filledFields:      number
  completionPercent: number
  /**
   * Per-side signature evidence, so a caller can tell "both sides are signed"
   * apart from "this packet never mentioned the seller".
   *
   * The analyzer REPORTS; it does not decide. What "both sides" means differs
   * per checkpoint — an offer is buyer + seller, a listing agreement is seller
   * + listing broker — so each gate applies its own rule to this evidence.
   */
  signatureSides:    Record<PacketSide, SideSignatureEvidence>
}

const SIGNATURE_HINTS = ["signature", "_sig", " sig "]
const INITIAL_HINTS   = ["initial", "_init", " init "]

// The side vocabulary is NOT invented here. These are the party tokens the
// form-fill engine already maps intake fields onto —
// lib/workflow/intake/form-fill-engine.ts:HEURISTIC_PATTERNS matches
// /^(buyer|purchaser).*name/ and /^(seller|grantor).*name/ against real form
// field names. The same tokens are what a signature block on those forms
// carries. Nothing here guesses a convention the tree does not already use.
const BUYER_SIDE_TOKENS  = ["buyer", "purchaser", "grantee"]
const SELLER_SIDE_TOKENS = ["seller", "grantor"]

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
 * PURE — whose block is this? Reads the side out of the field NAME; it never
 * infers one.
 *
 * Returns `unspecified` in BOTH directions of doubt:
 *   · no party token at all  ("page_3_initials")
 *   · more than one party token ("buyer_and_seller_initials") — a field that
 *     belongs to two sides is evidence for neither, because signing it says
 *     nothing about which party actually did.
 * A caller that needs "both sides" must therefore see two separately-named
 * blocks, which is the only thing that actually proves two signatures.
 *
 * Module-private on purpose: the side reaches callers as data — `finding.side`
 * and `PacketAnalysis.signatureSides` — so there is ONE place that decides it
 * and no surface can form a second opinion by calling the classifier itself.
 */
function classifyFieldSide(fieldName: string): PacketSide {
  const lower = ` ${fieldName.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `
  const hasBuyer  = BUYER_SIDE_TOKENS.some(t => lower.includes(` ${t}`))
  const hasSeller = SELLER_SIDE_TOKENS.some(t => lower.includes(` ${t}`))
  if (hasBuyer && !hasSeller) return "buyer"
  if (hasSeller && !hasBuyer) return "seller"
  return "unspecified"
}

const SIDE_LABEL: Record<PacketSide, string> = {
  buyer:       "Buyer",
  seller:      "Seller",
  unspecified: "Unattributed",
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

  // Per-side signature evidence. Seeded at zero/false so "the packet never
  // mentioned this side" is recorded as exactly that, and cannot be read as a
  // side that came back clean.
  const signatureSides: Record<PacketSide, SideSignatureEvidence> = {
    buyer:       { evidenced: false, outstanding: 0 },
    seller:      { evidenced: false, outstanding: 0 },
    unspecified: { evidenced: false, outstanding: 0 },
  }
  /** A signature/initial block was SEEN for this side (filled or not). */
  const noteSignatureBlock = (fieldName: string, outstanding: boolean): PacketSide => {
    const side = classifyFieldSide(fieldName)
    signatureSides[side].evidenced = true
    if (outstanding) signatureSides[side].outstanding++
    return side
  }

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
      // A FILLED signature block is still evidence that this side is in the
      // packet at all — that is what makes "the seller was never asked to
      // sign" distinguishable from "the seller signed".
      const filledName = String(ff?.fieldName ?? "")
      if (filledName && classifyMissingField(filledName) !== "missing_field") {
        noteSignatureBlock(filledName, false)
      }
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
      // The blocker NAMES the side. "a signature is missing" sends the TC
      // hunting through the packet; "the SELLER's signature is missing" is the
      // missing piece the owner's step 4 says goes back to the TC and agent.
      const side = flagType === "missing_field"
        ? undefined
        : noteSignatureBlock(fieldName, true)
      const blockWord = flagType === "missing_signature" ? "signature" : "initial"
      const sideTitle = side && side !== "unspecified"
        ? `${SIDE_LABEL[side]} ${blockWord} block missing on ${formName}`
        : `${blockWord[0].toUpperCase()}${blockWord.slice(1)} block missing on ${formName}`
      const sideNote = side === "unspecified"
        ? ` The field name does not say which side this block belongs to — confirm on the form.`
        : ""
      blockers.push({
        flagType, severity,
        title: flagType === "missing_field"
             ? `Field missing on ${formName}: ${fieldName}`
             : sideTitle,
        body:  `Form "${formName}", field "${fieldName}" — ${uf?.reason ?? "not provided in intake"}.${sideNote}`,
        formName,
        fieldName,
        ...(side ? { side } : {}),
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
    //
    // NOTE for anyone reading this number as "the paperwork is complete": it is
    // a FIELD count and nothing more. `signatureSides` is what says whether the
    // packet was even able to speak about a given side.
    completionPercent: totalFields > 0 ? Math.round((filledHighOrMedium / totalFields) * 100) : 100,
    signatureSides,
  }
}
