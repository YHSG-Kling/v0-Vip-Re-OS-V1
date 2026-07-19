// lib/financing/letter-strength.ts
//
// FINANCING LETTER STRENGTH — the shared, PURE assessor behind the pre-qual vs pre-approval
// "moment of truth" nudges (buyer loan-checklist rail + the agent's offer-strategy brief).
//
// DATA HONESTY (verified against the live schema): the OS does NOT record the letter TYPE.
// There is no pre_qualification vs pre_approval discriminator anywhere — buyer_financial_profiles
// carries pre_approval_amount / pre_approval_lender / pre_approval_letter_doc_id /
// pre_approval_expires_at plus a `verified` flag (agent/lender-verified via the financial-
// verification event rail), document-autofile buckets BOTH "pre-qual" and "pre-approval" phrases
// into one 'pre_approval_letter' category, and the data-steward normalizer collapses
// 'pre-qualified' into 'pre_approved'. So the closest DETERMINISTIC signals are:
//   · verified === true            → a lender/agent-VERIFIED pre-approval on file (strong)
//   · amount/letter but !verified  → a letter of UNKNOWN strength — pre-qual-equivalent until
//                                    verified (self-reported numbers, nothing underwritten here)
//   · nothing on file              → no letter at all
//   · is_cash_buyer                → financing letters don't apply (proof of funds instead)
// Everything here keys off those signals — never a fabricated letter type. All copy is
// fair-housing-safe: financing process + documents only, nothing about who the buyer is.

export type FinancingLetterStrength =
  | "cash"                  // cash buyer — letter strength is a proof-of-funds conversation
  | "verified_preapproval"  // lender-verified pre-approval on file, not expired
  | "expired_letter"        // was verified/on file but the expiry date has passed
  | "unverified_letter"     // an amount/letter exists but is not verified (pre-qual-strength at best)
  | "no_letter"             // nothing on file

/** The buyer_financial_profiles fields the assessment reads (the SAME row the pre-approval
 *  record sourcing reads — one source of truth, no parallel financing state). */
export interface FinancingLetterFacts {
  isCashBuyer?: boolean | null
  verified?: boolean | null
  preApprovalAmount?: number | null
  preApprovalLetterDocId?: string | null
  preApprovalExpiresAt?: string | null
}

export interface FinancingLetterAssessment {
  strength: FinancingLetterStrength
  /** Plain-language, buyer-voiced upgrade line (null when there is nothing honest to nudge). */
  buyerNudge: string | null
  /** Blunt agent-facing note for briefs/rationales (null when financing is already strong). */
  agentNote: string | null
}

/** PURE: assess the buyer's financing-letter strength from the profile facts. */
export function assessFinancingLetterStrength(
  facts: FinancingLetterFacts | null | undefined,
  now: Date = new Date(),
): FinancingLetterAssessment {
  if (facts?.isCashBuyer) {
    return { strength: "cash", buyerNudge: null, agentNote: null }
  }

  const hasLetter =
    !!facts?.preApprovalLetterDocId ||
    (typeof facts?.preApprovalAmount === "number" && facts.preApprovalAmount > 0)

  const expiresAt = facts?.preApprovalExpiresAt ? new Date(facts.preApprovalExpiresAt) : null
  const expired = !!(expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < now.getTime())

  if (hasLetter && facts?.verified && !expired) {
    return { strength: "verified_preapproval", buyerNudge: null, agentNote: null }
  }

  if (hasLetter && expired) {
    return {
      strength: "expired_letter",
      buyerNudge:
        "Your financing letter looks past its date — letters usually run about 60-90 days. A fresh, lender-verified pre-approval is the stronger letter and keeps your offer taken seriously. Your agent can help you refresh it.",
      agentNote:
        "Financing note: the buyer's letter on file is past its expiry date (letters typically run 60-90 days). Get a refreshed, lender-verified pre-approval before submitting — sellers weight the current, verified letter.",
    }
  }

  if (hasLetter) {
    return {
      strength: "unverified_letter",
      buyerNudge:
        "Quick heads-up on your financing letter: a pre-qualification is only an estimate from what you told a lender — a pre-approval means the lender actually verified your credit, income, and savings. The pre-approval is the stronger letter, and it's the one sellers weight. Upgrading early is worth it — your agent can connect you with a lender.",
      agentNote:
        "Financing note: the buyer's letter is not lender-verified on file — treat it as pre-qual strength until verified. A verified pre-approval is the stronger letter and what listing agents/sellers weight; coach the upgrade now, and if offering as-is, present the financing honestly rather than overstating it.",
    }
  }

  return {
    strength: "no_letter",
    buyerNudge:
      "One step makes your future offer much stronger: a pre-approval letter. A pre-qualification is just an estimate, but a pre-approval means a lender verified your credit, income, and savings — and it's the letter sellers take seriously. Getting it early (letters last about 60-90 days) means you're ready when the right home appears.",
    agentNote:
      "Financing note: no financing letter on file for this buyer. A lender-verified pre-approval is the stronger letter and what sellers weight — many won't take an offer seriously without one. Coach the pre-approval before (or alongside) submitting, and present the financing position honestly.",
  }
}
