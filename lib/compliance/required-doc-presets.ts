/**
 * lib/compliance/required-doc-presets.ts
 *
 * Per-state required-document presets brokers can seed in one click during
 * onboarding. The presets reflect what each state's NAR + association +
 * common brokerage policy typically requires for a buyer-side transaction.
 *
 * Used by app/actions/compliance/seed-required-docs.ts — broker picks their
 * scope (brokerage / team / their own agent_user_id) + state, action
 * inserts the matching rows into brokerage_required_documents.
 *
 * The classifications match the live documents.classification CHECK
 * constraint exactly (migration 1075). Each preset row also carries a
 * description that's surfaced in the broker's settings UI so they know
 * WHY each rule exists.
 *
 * `block_on_missing=true` means submit-to-compliance refuses without it.
 * `false` means warning only.
 *
 * State coverage: TX, CA, FL, NY, IL, GA, AZ, CO, WA, NC + a US baseline
 * brokers in any other state can use as a starting point.
 */

import type { DocumentClassification } from "./required-documents"

export interface RequiredDocPreset {
  classification:   DocumentClassification
  block_on_missing: boolean
  description:      string
}

// ── US baseline — applies regardless of state ──────────────────────────────
const US_BASELINE: RequiredDocPreset[] = [
  { classification: "signed_contract",      block_on_missing: true,  description: "Executed purchase contract on file (NAR baseline)." },
  { classification: "pre_approval_letter",  block_on_missing: true,  description: "Buyer's lender pre-approval (non-cash deals)." },
  { classification: "proof_of_funds",       block_on_missing: false, description: "Required when financing_type='cash'." },
  { classification: "agency_disclosure",    block_on_missing: true,  description: "NAR 2024 Settlement — buyer agency disclosure." },
  { classification: "commission_agreement", block_on_missing: true,  description: "Buyer Broker Agreement (NAR 2024 mandatory)." },
  { classification: "disclosure",           block_on_missing: false, description: "Seller's property disclosure (state-form specific)." },
  { classification: "id_document",          block_on_missing: false, description: "Buyer ID for compliance file (warning)." },
]

// ── SELLER baseline (m356) ─────────────────────────────────────────────────
//
// The preset library was buyer-only, but the seeder has always accepted
// dealType: "seller" — so seeding a seller scope installed the BUYER stack
// (pre-approval letter, proof of funds, buyer-broker agreement) under a seller
// deal_type. A seller has no pre-approval letter, so those rules could never be
// satisfied and every seller file would sit permanently blocked.
//
// Owner's ruling drives the two anchors here: the LISTING AGREEMENT must be
// signed to take on a listing, and the SELLER BROKER AGREEMENT is a DIFFERENT
// document — both are separately requirable.
const SELLER_BASELINE: RequiredDocPreset[] = [
  { classification: "listing_agreement",             block_on_missing: true,  description: "Signed listing agreement — the listing cannot be taken on without it." },
  { classification: "seller_broker_agreement",       block_on_missing: false, description: "Seller broker agreement. DISTINCT from the listing agreement; required by some brokerages in addition to it." },
  { classification: "agency_disclosure",             block_on_missing: true,  description: "Seller-side agency disclosure (state-form specific)." },
  { classification: "disclosure",                    block_on_missing: true,  description: "Seller's property condition disclosure." },
  { classification: "commission_agreement",          block_on_missing: true,  description: "Listing-side commission terms on file." },
  { classification: "title_report",                  block_on_missing: false, description: "Preliminary title / ownership report (warning until ordered)." },
  { classification: "hoa_documents",                 block_on_missing: false, description: "HOA docs where the property is in an association." },
  { classification: "id_document",                   block_on_missing: false, description: "Seller ID for the compliance file (warning)." },
  { classification: "preliminary_closing_statement", block_on_missing: false, description: "Preliminary HUD / settlement statement from title or the closing attorney — the trigger to prepare the CDA." },
]

// ── State-specific additions on top of the baseline ───────────────────────
// Each state's "Additional" rows are STACKED with the baseline by the seeder.

const TX_ADDITIONS: RequiredDocPreset[] = [
  { classification: "addendum",             block_on_missing: false, description: "TX: Third Party Financing Addendum (TREC 40-9) when applicable." },
  { classification: "disclosure",           block_on_missing: true,  description: "TX: Seller's Disclosure Notice (TREC OP-H) — required by state." },
  { classification: "hoa_documents",        block_on_missing: false, description: "TX: HOA Subdivision Information when property is in an HOA." },
  { classification: "lender_letter",        block_on_missing: false, description: "TX: 3rd-party financing notice (when applicable)." },
]

const CA_ADDITIONS: RequiredDocPreset[] = [
  { classification: "disclosure",           block_on_missing: true,  description: "CA: TDS (Transfer Disclosure Statement) — Civil Code 1102." },
  { classification: "addendum",             block_on_missing: true,  description: "CA: Natural Hazard Disclosure Statement." },
  { classification: "agency_disclosure",    block_on_missing: true,  description: "CA: AD (Agency Disclosure) - Civil Code 2079.14 — required at first substantive contact." },
  { classification: "hoa_documents",        block_on_missing: false, description: "CA: HOA documents per Civil Code 4525 when property is in a common interest development." },
]

const FL_ADDITIONS: RequiredDocPreset[] = [
  { classification: "disclosure",           block_on_missing: true,  description: "FL: Seller's Property Disclosure (FAR/BAR)." },
  { classification: "addendum",             block_on_missing: false, description: "FL: Hurricane/flood-zone addendum when applicable." },
  { classification: "agency_disclosure",    block_on_missing: true,  description: "FL: Transaction Broker / Single Agent Notice." },
]

const NY_ADDITIONS: RequiredDocPreset[] = [
  { classification: "disclosure",           block_on_missing: true,  description: "NY: Property Condition Disclosure Statement (PCDS)." },
  { classification: "agency_disclosure",    block_on_missing: true,  description: "NY: NYS Disclosure Form for Buyer/Tenant." },
  { classification: "lender_letter",        block_on_missing: false, description: "NY: Mortgage Commitment Letter (attorney-review state)." },
]

const IL_ADDITIONS: RequiredDocPreset[] = [
  { classification: "disclosure",           block_on_missing: true,  description: "IL: Residential Real Property Disclosure Report (765 ILCS 77)." },
  { classification: "addendum",             block_on_missing: false, description: "IL: Radon Awareness Disclosure (Public Act 95-0210)." },
]

const GA_ADDITIONS: RequiredDocPreset[] = [
  { classification: "disclosure",           block_on_missing: true,  description: "GA: Seller's Property Disclosure Statement (GAR F301)." },
  { classification: "agency_disclosure",    block_on_missing: true,  description: "GA: Brokerage Engagement / Agency Disclosure (BRRETA)." },
]

const AZ_ADDITIONS: RequiredDocPreset[] = [
  { classification: "disclosure",           block_on_missing: true,  description: "AZ: SPDS (Seller's Property Disclosure Statement)." },
  { classification: "agency_disclosure",    block_on_missing: true,  description: "AZ: Real Estate Agency Disclosure and Election." },
]

const CO_ADDITIONS: RequiredDocPreset[] = [
  { classification: "disclosure",           block_on_missing: true,  description: "CO: Seller's Property Disclosure (CREC SPD-1)." },
  { classification: "addendum",             block_on_missing: false, description: "CO: Source of Water Addendum (when on well)." },
  { classification: "agency_disclosure",    block_on_missing: true,  description: "CO: CREC Brokerage Disclosure to Buyer." },
]

const WA_ADDITIONS: RequiredDocPreset[] = [
  { classification: "disclosure",           block_on_missing: true,  description: "WA: Form 17 (Seller Disclosure Statement)." },
  { classification: "agency_disclosure",    block_on_missing: true,  description: "WA: Real Estate Brokerage in Washington (agency law pamphlet) — RCW 18.86." },
]

const NC_ADDITIONS: RequiredDocPreset[] = [
  { classification: "disclosure",           block_on_missing: true,  description: "NC: Residential Property Disclosure (RPOADS)." },
  { classification: "addendum",             block_on_missing: false, description: "NC: Mineral and Oil/Gas Rights Mandatory Disclosure." },
  { classification: "agency_disclosure",    block_on_missing: true,  description: "NC: Working with Real Estate Agents brochure acknowledgement." },
]

const STATE_ADDITIONS: Record<string, RequiredDocPreset[]> = {
  TX: TX_ADDITIONS,
  CA: CA_ADDITIONS,
  FL: FL_ADDITIONS,
  NY: NY_ADDITIONS,
  IL: IL_ADDITIONS,
  GA: GA_ADDITIONS,
  AZ: AZ_ADDITIONS,
  CO: CO_ADDITIONS,
  WA: WA_ADDITIONS,
  NC: NC_ADDITIONS,
}

/**
 * Returns the merged preset list for a given state. State-specific rows
 * REPLACE baseline rows for the same classification when both exist
 * (state-specific descriptions are more useful for the broker).
 */
export function getRequiredDocPresetsForState(
  stateCode: string | null | undefined,
  /** WHICH SIDE of the deal. The seeder has always taken a dealType, but this
   *  resolver ignored it and returned the buyer stack regardless — so seeding a
   *  seller scope installed pre_approval_letter and proof_of_funds as BLOCKING
   *  requirements a seller can never satisfy. Defaulted to "buyer" so existing
   *  callers are unchanged. */
  dealType: "buyer" | "seller" | "dual" = "buyer",
): RequiredDocPreset[] {
  const upperState = (stateCode ?? "").toUpperCase()
  const stateRows  = STATE_ADDITIONS[upperState] ?? []
  // Per-classification merge: state row overrides baseline for the same key.
  // A "dual" scope legitimately wants both sides' paperwork on file.
  const merged = new Map<string, RequiredDocPreset>()
  if (dealType === "buyer" || dealType === "dual") {
    for (const p of US_BASELINE) merged.set(p.classification, p)
  }
  if (dealType === "seller" || dealType === "dual") {
    for (const p of SELLER_BASELINE) merged.set(p.classification, p)
  }
  // State additions are written against the buyer stack today; they still apply
  // to a dual scope, and to a seller scope only where the classification is one
  // the seller side actually carries (agency_disclosure, disclosure, title…).
  for (const p of stateRows) {
    if (dealType === "seller" && !SELLER_BASELINE.some((s) => s.classification === p.classification)) continue
    merged.set(p.classification, p)
  }
  return Array.from(merged.values())
}

/** List all states with state-specific presets (for the onboarding picker). */
export function getSupportedPresetStates(): string[] {
  return Object.keys(STATE_ADDITIONS).sort()
}
