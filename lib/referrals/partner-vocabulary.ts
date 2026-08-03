/**
 * lib/referrals/partner-vocabulary.ts
 *
 * "ADD PARTNER" THREW ON EVERY SURFACE THAT OFFERED IT.
 *
 * referral_partners has two CHECK constraints, and two of the three UIs that
 * create a partner sent values that satisfy NEITHER:
 *
 *   app/dashboard/agent/referrals/page.tsx offered
 *     PARTNER_TYPES   = ["Lender","Title","Attorney","Inspector","Agent","Other"]
 *     AGREEMENT_TYPES = ["Commission Split","Flat Fee","Reciprocal","Other"]
 *   — DISPLAY labels, Title Case, none of them storable.
 *
 *   app/dashboard/referrals/.../referral-pipeline-panel.tsx hard-coded
 *     partnerType: "individual", agreementType: "referral"
 *   — neither value exists in either constraint.
 *
 * Verified live against pg_constraint:
 *   referral_partners_partner_type_check   → real_estate_agent | mortgage_broker |
 *     title_company | home_inspector | contractor | insurance_agent | attorney |
 *     property_manager | other
 *   referral_partners_agreement_type_check → reciprocal | one_way | paid | informal
 *
 * So every "Add Partner" from those two screens raised
 * `violates check constraint "referral_partners_agreement_type_check"`, and in the
 * pipeline panel it took the whole add-referral flow down with it.
 *
 * The lesson this file exists to prevent: a picker must store a VALUE and show a
 * LABEL. Storing the label is how a dropdown that looks right writes a row the
 * database refuses.
 *
 * MIRRORS the two live CHECK constraints. Adding a member here without the
 * matching migration produces a value the database rejects.
 */

export type ReferralPartnerType =
  | "real_estate_agent"
  | "mortgage_broker"
  | "title_company"
  | "home_inspector"
  | "contractor"
  | "insurance_agent"
  | "attorney"
  | "property_manager"
  | "other"

export type ReferralAgreementType =
  | "reciprocal"
  | "one_way"
  | "paid"
  | "informal"

/** value → label. The value is what is stored; the label is what is shown. */
export const REFERRAL_PARTNER_TYPES: Array<{ value: ReferralPartnerType; label: string }> = [
  { value: "real_estate_agent", label: "Real Estate Agent" },
  { value: "mortgage_broker",   label: "Lender / Mortgage Broker" },
  { value: "title_company",     label: "Title Company" },
  { value: "home_inspector",    label: "Home Inspector" },
  { value: "contractor",        label: "Contractor" },
  { value: "insurance_agent",   label: "Insurance Agent" },
  { value: "attorney",          label: "Attorney" },
  { value: "property_manager",  label: "Property Manager" },
  { value: "other",             label: "Other" },
]

/**
 * value → label for the agreement.
 *
 * Note what is NOT here: "Commission Split" and "Flat Fee". Those describe HOW a
 * referral fee is calculated, which lives on referral_fee_percent /
 * referral_fee_amount — not what KIND of agreement this is. Offering them as
 * agreement types is what produced the unstorable values.
 */
export const REFERRAL_AGREEMENT_TYPES: Array<{ value: ReferralAgreementType; label: string }> = [
  { value: "reciprocal", label: "Reciprocal — we refer to each other" },
  { value: "one_way",    label: "One-way — we refer to them" },
  { value: "paid",       label: "Paid — a fee is owed on a closed referral" },
  { value: "informal",   label: "Informal — no standing arrangement" },
]

/** The safe default when a caller has no opinion: a partner record with no claim attached. */
export const DEFAULT_REFERRAL_PARTNER_TYPE: ReferralPartnerType = "other"
export const DEFAULT_REFERRAL_AGREEMENT_TYPE: ReferralAgreementType = "informal"

export function isReferralPartnerType(v: string): v is ReferralPartnerType {
  return REFERRAL_PARTNER_TYPES.some((t) => t.value === v)
}

export function isReferralAgreementType(v: string): v is ReferralAgreementType {
  return REFERRAL_AGREEMENT_TYPES.some((t) => t.value === v)
}

export function referralPartnerTypeLabel(v: string | null | undefined): string {
  if (!v) return "Partner"
  return REFERRAL_PARTNER_TYPES.find((t) => t.value === v)?.label ?? v
}

export function referralAgreementTypeLabel(v: string | null | undefined): string {
  if (!v) return "—"
  return REFERRAL_AGREEMENT_TYPES.find((t) => t.value === v)?.label ?? v
}
