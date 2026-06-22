// lib/offers/commission-disclosure.ts
// PURE validation + method resolution for the NAR-2024 buyer commission disclosure
// acknowledgment. Extracted from app/actions/buyer-offer/acknowledge-commission.ts so
// the compliance rules are unit-testable and identical between the action and tests.
//
// NAR 2024 settlement: a buyer must explicitly acknowledge the compensation their
// agent will receive BEFORE the offer is submitted for signature. submit-for-signature
// HARD-BLOCKS until offers.buyer_commission_acknowledged_at is set.

export type CommissionPayer = "seller" | "buyer" | "split" | "either"
/**
 * Disclosure methods. `click_through` (buyer self-ack) and `wet_signature` are recorded
 * inline. `esign` is a REQUEST intent only — the action resolves the brokerage's connected
 * provider via resolveESignProviderForActor (agent→team→brokerage cascade; dotloop/docusign/
 * skyslope/authentisign) and STORES the resolved provider (docusign/dotloop per the column
 * CHECK). The agent never picks the provider — that is the app's ownership-cascade rule.
 */
export type DisclosureMethod = "click_through" | "wet_signature" | "esign" | "docusign" | "dotloop"

export interface CommissionDisclosureInput {
  disclosedBuyerCommissionPct?: number
  disclosedBuyerCommissionFlat?: number
  disclosedCommissionPayer?: CommissionPayer | string
  affirmativeConsent: boolean
  disclosureMethod?: DisclosureMethod
}

const PAYERS: ReadonlySet<string> = new Set(["seller", "buyer", "split", "either"])

/**
 * Returns an error message, or null if the disclosure may be recorded.
 * `isBuyer` = the caller is the buyer themselves (self-ack via click-through) vs an
 * agent recording on the buyer's behalf (must use a signed method, never click-through).
 */
export function validateCommissionDisclosure(
  input: CommissionDisclosureInput,
  isBuyer: boolean,
): string | null {
  if (!input.affirmativeConsent) {
    return "Buyer must affirmatively acknowledge the commission terms"
  }
  if (!input.disclosedBuyerCommissionPct && !input.disclosedBuyerCommissionFlat) {
    return "Commission percentage or flat amount required (NAR 2024 — explicit comp terms mandatory)"
  }
  if (!input.disclosedCommissionPayer || !PAYERS.has(input.disclosedCommissionPayer)) {
    return "Commission payer required (seller / buyer / split / either)"
  }
  // An agent recording on the buyer's behalf cannot use the buyer's self-click path.
  if (!isBuyer && (input.disclosureMethod ?? "click_through") === "click_through") {
    return "Agent must record acknowledgment via wet_signature, docusign, or dotloop"
  }
  return null
}

/** The effective disclosure method: explicit request wins; else buyer→click_through, agent→wet_signature. */
export function resolveDisclosureMethod(
  requested: DisclosureMethod | undefined,
  isBuyer: boolean,
): DisclosureMethod {
  return requested ?? (isBuyer ? "click_through" : "wet_signature")
}

/** Methods that dispatch through the brokerage's connected e-sign provider (vs recorded inline). */
export function isEsignDispatchMethod(method: DisclosureMethod): boolean {
  return method === "esign" || method === "docusign" || method === "dotloop"
}
