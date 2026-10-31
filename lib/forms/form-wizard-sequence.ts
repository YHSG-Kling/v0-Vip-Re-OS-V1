/**
 * lib/forms/form-wizard-sequence.ts — THE FORMWIZARD'S SEQUENCE, INTAKE AND FORM RECOMMENDATION. PURE.
 *
 * Owner (2026-10-18, verbatim): "formwizard steps should be correct" — "LISTING and OFFER forms only;
 * CDA is NOT a FormWizard step. AI asks 'listing forms or an offer?', gathers specifics
 * conversationally, recommends ACTUAL available legal forms (jurisdiction, brokerage settings,
 * representation, verified form requirements), agent approves the packet. Sequence: Purpose →
 * Property → Parties → Terms → Recommended Forms → Complete → Review → E-sign/Deliver. … AI coaches
 * like a knowledgeable real-estate coach; never invents legal terms, signatures or material facts."
 *
 * This module is the wizard's spine (app/components/form-wizard/FormWizard.tsx renders from it —
 * EXTENDED, not rewritten: every existing step component survives under the owner's order), with
 * three pure pieces the proof exercises without a browser:
 *
 *   · the SEQUENCE and the opening question;
 *   · the INTAKE — the questions the coach asks per purpose, each with the coaching sentence that
 *     EXPLAINS the field (what it is, what is usually expected, what happens if it is missing). The
 *     coach text never states a price, a date, a party name or a legal term as fact — those are the
 *     agent's answers, and the proof asserts no coach line carries a number;
 *   · the RECOMMENDATION — the state's verified package (lib/state-forms/registry.ts, the property's
 *     state decides) joined to what is ACTUALLY available (the agent's library + the legal-forms
 *     provider's library) by the ONE matcher (lib/forms/state-package-match.ts), with the addenda
 *     included only when the agent's answers call for them. It can only return forms that exist in
 *     `available`; a package form nobody has is NAMED under `missing`, never invented.
 *
 * Terms map onto the offer record through `offerTermsToCreateOfferFields` — the wizard used to send
 * createOffer `offer_price: 0, earnest_money: 0, financing_type: "conventional"` placeholders; the
 * agent's answers are the real terms now. `offerFormSourceFor` spells `offers.form_source` in the
 * live CHECK's vocabulary (the wizard used to send "my_forms,transaction_provider", a value the
 * column refuses — the whole offer insert was refused with it).
 *
 * Domain vocabulary (contingencies, earnest money, financing types, agency/representation,
 * disclosures) per the installed `real-estate-expert` skill; no library is called.
 */

import { matchStatePackage } from "./state-package-match"
// The ONE financing-type list (wave 144A) — the offer intake's picker is derived from it, never retyped (owner ruling 1:
// "no hard-coded alternate labels scattered in dropdowns"). checklist-dimensions.ts imports nothing, so the client wizard
// can carry it.
import { FINANCING_TYPES, FINANCING_TYPE_LABEL } from "@/lib/compliance/checklist-dimensions"

// ── Purpose + sequence ───────────────────────────────────────────────────────────────────────────

export const FORM_WIZARD_OPENING_QUESTION = "Are we preparing listing forms or an offer?"
export const FORM_WIZARD_PURPOSES = ["listing", "offer"] as const
export type FormWizardPurpose = (typeof FORM_WIZARD_PURPOSES)[number]

export const FORM_WIZARD_SEQUENCE = [
  { key: "purpose",           label: "Purpose" },
  { key: "property",          label: "Property" },
  { key: "parties",           label: "Parties" },
  { key: "terms",             label: "Terms" },
  { key: "recommended_forms", label: "Recommended Forms" },
  { key: "complete",          label: "Complete" },
  { key: "review",            label: "Review" },
  { key: "esign",             label: "E-Sign / Deliver" },
  { key: "monitor",           label: "Monitor" },
] as const
export type FormWizardStepKey = (typeof FORM_WIZARD_SEQUENCE)[number]["key"]

/** 1-based step number of a key (the wizard's `step` state). */
export function stepNumber(key: FormWizardStepKey): number {
  return FORM_WIZARD_SEQUENCE.findIndex((s) => s.key === key) + 1
}
/** The key at a 1-based step number; "purpose" for anything out of range. */
export function stepKeyAt(n: number): FormWizardStepKey {
  return FORM_WIZARD_SEQUENCE[Math.min(Math.max(n, 1), FORM_WIZARD_SEQUENCE.length) - 1].key
}
export const FORM_WIZARD_STEP_LABELS: readonly string[] = FORM_WIZARD_SEQUENCE.map((s) => s.label)

/** What the coach is and is not — rendered beside the intake and asserted by the proof. */
export const AI_COACH_RULES = [
  "explains what each field means and what is usually expected",
  "names what is still missing before the packet can be completed",
  "never invents legal terms, signatures or material facts — the agent's answers are the facts",
] as const

// ── Intake ───────────────────────────────────────────────────────────────────────────────────────

export type IntakeAnswers = Record<string, string | number | boolean | null | undefined>

export interface IntakeQuestion {
  key: string
  prompt: string
  /** The coach's explanation. Plain language; no numbers, no legal terms stated as fact. */
  coach: string
  kind: "text" | "number" | "date" | "select" | "boolean"
  options?: ReadonlyArray<{ value: string; label: string }>
  required?: boolean
  /** Ask only when the earlier answers make it relevant. */
  showWhen?: (answers: IntakeAnswers) => boolean
}

const isFinanced = (a: IntakeAnswers) => a.financing_type !== "cash"

export const LISTING_INTAKE: readonly IntakeQuestion[] = [
  { key: "representation", prompt: "What representation is the seller granting?", kind: "select", required: true,
    options: [
      { value: "exclusive_right_to_sell", label: "Exclusive right to sell" },
      { value: "exclusive_agency",        label: "Exclusive agency" },
      { value: "open_listing",            label: "Open listing" },
    ],
    coach: "The representation sets which listing agreement form applies and whether the brokerage is owed compensation however a buyer is found. The agreement form the state package requires follows from this answer." },
  { key: "listing_start", prompt: "When does the listing period start?", kind: "date", required: true,
    coach: "The listing period is the window the agreement is in force. Most forms need both the start and the expiration date; an agreement without an end date is usually incomplete." },
  { key: "listing_end", prompt: "When does the listing period end?", kind: "date", required: true,
    coach: "The expiration date closes the listing period. Extensions are a separate amendment later, never a change to the signed agreement." },
  { key: "list_price_confirmed", prompt: "Is the list price on the Property step the agreed list price?", kind: "boolean", required: true,
    coach: "The list price on the agreement is the seller's decision. If it is still being discussed, finish that conversation before the form is filled — the agreement states it as fact." },
  { key: "compensation", prompt: "What compensation is the brokerage paid, and is any offered to a buyer's broker?", kind: "text",
    coach: "Compensation is negotiated with the seller and written in the agreement where the form provides for it. Where a form or your market does not carry a buyer-broker compensation line, leave this blank and the coach will not fill it in for you." },
  { key: "pre_1978", prompt: "Was the home built before 1978 (or is the year unknown)?", kind: "boolean", required: true,
    coach: "Homes built before the federal lead-paint rule took effect need the lead-based paint disclosure in the packet. If the year is unknown, answer yes so the disclosure is included rather than left out." },
  { key: "hoa", prompt: "Is the property in an HOA or condominium association?", kind: "boolean", required: true,
    coach: "Association properties usually require an association or condominium disclosure and the governing documents. The recommendation includes that addendum only when you answer yes." },
  { key: "seller_disclosures_ready", prompt: "Does the seller have the property disclosure ready to complete?", kind: "boolean",
    coach: "The seller's property disclosure is the seller's statement, completed by the seller. The coach never fills it; the form is recommended so the seller can complete it in the packet." },
  { key: "special_terms", prompt: "Any special terms (exclusions, repairs, occupancy, timing)?", kind: "text",
    coach: "Special terms go in the agreement's additional-terms area in the seller's own words. Describe them plainly; a form never states a term the seller did not agree to." },
]

export const OFFER_INTAKE: readonly IntakeQuestion[] = [
  { key: "property_source", prompt: "Is this one of your brokerage's listings, or an outside property?", kind: "select", required: true,
    options: [{ value: "in_house", label: "Our listing" }, { value: "outside", label: "Outside property" }],
    coach: "An outside property needs no listing record on this platform — the offer is identified by its address and the listing agent on the other side. For an in-house listing the offer links to that listing so both sides see it." },
  { key: "offer_price", prompt: "What is the offer price?", kind: "number", required: true,
    coach: "The purchase price is the buyer's decision. The coach can explain how a price compares to the list price when you ask, but never proposes a number into the form." },
  { key: "financing_type", prompt: "How is the purchase financed?", kind: "select", required: true,
    options: FINANCING_TYPES.map((value) => ({ value, label: FINANCING_TYPE_LABEL[value] })),
    coach: "Financing decides which contingency and addendum forms belong in the packet: a financed purchase usually carries a financing contingency, and government-backed loans carry their own required amendatory clauses." },
  { key: "earnest_money", prompt: "What earnest money deposit is offered?", kind: "number", required: true,
    coach: "Earnest money is the buyer's good-faith deposit held in escrow and credited at closing. The amount and when it is due are the buyer's terms; the form states both." },
  { key: "down_payment_amount", prompt: "What down payment is the buyer bringing?", kind: "number", showWhen: isFinanced,
    coach: "The down payment helps the seller judge the strength of a financed offer and is what the lender's pre-approval should support." },
  { key: "closing_date", prompt: "What closing date is proposed?", kind: "date", required: true,
    coach: "The closing date drives every deadline after acceptance — inspection, appraisal and financing periods count from the executed contract toward it." },
  { key: "inspection_period_days", prompt: "How many days for the inspection period?", kind: "number", required: true,
    coach: "The inspection period is the buyer's window to inspect and, if the contract allows, request repairs or withdraw. A shorter period reads stronger to a seller; the buyer decides." },
  { key: "financing_contingency_days", prompt: "How many days for the financing contingency?", kind: "number", required: true, showWhen: isFinanced,
    coach: "The financing contingency protects the buyer if the loan is not approved in time. It is a deadline the lender should confirm is realistic." },
  { key: "appraisal_contingency", prompt: "Is the offer contingent on the appraisal?", kind: "boolean", required: true, showWhen: isFinanced,
    coach: "An appraisal contingency lets the buyer renegotiate or withdraw if the appraised value is below the price. Waiving it is a buyer's decision with real exposure — the coach explains, never decides." },
  { key: "appraisal_contingency_days", prompt: "How many days for the appraisal contingency?", kind: "number", showWhen: (a) => isFinanced(a) && a.appraisal_contingency === true,
    coach: "The appraisal window usually sits inside the financing period because the lender orders it." },
  { key: "sale_of_buyer_home", prompt: "Is the offer contingent on selling the buyer's current home?", kind: "boolean", required: true,
    coach: "A sale contingency needs its own addendum and tells the seller the offer depends on another closing. Answer yes only when the buyer truly needs it." },
  { key: "closing_cost_contribution", prompt: "Any seller credit toward closing costs requested?", kind: "number",
    coach: "A seller credit is a term of the offer, written where the form provides for it. Lenders cap credits by loan type — the buyer's lender confirms the limit." },
  { key: "escalation_clause", prompt: "Does the offer include an escalation clause?", kind: "boolean",
    coach: "An escalation clause raises the price in steps over a competing offer up to a cap. It needs its own addendum where the state package has one, and the cap is the buyer's decision." },
  { key: "escalation_cap", prompt: "What is the escalation cap?", kind: "number", showWhen: (a) => a.escalation_clause === true,
    coach: "The cap is the most the buyer will pay under the escalation — a number the buyer sets, never the coach." },
  { key: "pre_1978", prompt: "Was the home built before 1978 (or is the year unknown)?", kind: "boolean", required: true,
    coach: "Homes built before the federal lead-paint rule took effect need the lead-based paint disclosure in the packet. If the year is unknown, answer yes so the disclosure is included rather than left out." },
  { key: "hoa", prompt: "Is the property in an HOA or condominium association?", kind: "boolean", required: true,
    coach: "Association properties usually require an association or condominium addendum. It is recommended only when you answer yes." },
  { key: "inclusions_exclusions", prompt: "Any inclusions or exclusions (appliances, fixtures, items that stay or go)?", kind: "text",
    coach: "Inclusions and exclusions are written in the buyer's words on the form. If the listing's disclosure already names exclusions, repeat them here so the two agree." },
  { key: "special_terms", prompt: "Any special terms or conditions?", kind: "text",
    coach: "Special terms go in the contract's additional-terms area. Plain words; nothing the buyer did not ask for." },
]

export function intakeQuestionsFor(purpose: FormWizardPurpose, answers: IntakeAnswers): IntakeQuestion[] {
  const all = purpose === "listing" ? LISTING_INTAKE : OFFER_INTAKE
  return all.filter((q) => !q.showWhen || q.showWhen(answers))
}

/** The prompts of required questions still unanswered — what the coach says is missing. */
export function missingRequiredIntake(purpose: FormWizardPurpose, answers: IntakeAnswers): string[] {
  return intakeQuestionsFor(purpose, answers)
    .filter((q) => q.required)
    .filter((q) => { const v = answers[q.key]; return v === undefined || v === null || v === "" })
    .map((q) => q.prompt)
}

// ── Terms → the offer record ─────────────────────────────────────────────────────────────────────

export interface OfferTermFields {
  offer_price:                number
  earnest_money:              number
  down_payment_amount?:       number
  financing_type:             string
  financing_contingency:      boolean
  financing_contingency_days: number
  inspection_contingency:     boolean
  inspection_period_days:     number
  appraisal_contingency:      boolean
  appraisal_contingency_days: number
  closing_date:               string
  possession_terms:           string
  closing_cost_contribution?: number
  escalation_clause:          boolean
  escalation_cap?:            number
  special_conditions?:        string
  buyer_notes?:               string
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""))
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)

/**
 * PURE: the agent's answers as createOffer's term fields. Nothing is invented — an unanswered number is
 * 0 (what the record held before this step existed) and the Review step shows it blank; a cash purchase
 * carries no financing or appraisal contingency.
 */
export function offerTermsToCreateOfferFields(answers: IntakeAnswers): OfferTermFields {
  const financing = str(answers.financing_type) ?? "conventional"
  const financed = financing !== "cash"
  const inspectionDays = num(answers.inspection_period_days) ?? 0
  const financingDays = financed ? (num(answers.financing_contingency_days) ?? 0) : 0
  const appraisal = financed && answers.appraisal_contingency === true
  const appraisalDays = appraisal ? (num(answers.appraisal_contingency_days) ?? 0) : 0
  const escalation = answers.escalation_clause === true
  const specialBits = [str(answers.inclusions_exclusions) ? `Inclusions/exclusions: ${str(answers.inclusions_exclusions)}` : null, str(answers.special_terms)].filter(Boolean) as string[]
  return {
    offer_price:                num(answers.offer_price) ?? 0,
    earnest_money:              num(answers.earnest_money) ?? 0,
    ...(financed && num(answers.down_payment_amount) !== undefined ? { down_payment_amount: num(answers.down_payment_amount) } : {}),
    financing_type:             financing,
    financing_contingency:      financed && financingDays > 0,
    financing_contingency_days: financingDays,
    inspection_contingency:     inspectionDays > 0,
    inspection_period_days:     inspectionDays,
    appraisal_contingency:      appraisal,
    appraisal_contingency_days: appraisalDays,
    closing_date:               str(answers.closing_date) ?? "",
    possession_terms:           "at_closing",
    ...(num(answers.closing_cost_contribution) !== undefined ? { closing_cost_contribution: num(answers.closing_cost_contribution) } : {}),
    escalation_clause:          escalation,
    ...(escalation && num(answers.escalation_cap) !== undefined ? { escalation_cap: num(answers.escalation_cap) } : {}),
    ...(specialBits.length > 0 ? { special_conditions: specialBits.join("\n") } : {}),
  }
}

// ── form_source in the column's vocabulary ───────────────────────────────────────────────────────

/** A selected form's origin, as the wizard tracks it. */
export type SelectedFormSource = "my_forms" | "legal_forms_provider"

/** Legal-forms providers whose name `offers.form_source` admits; any other provider is recorded as `manual`. */
const FORM_SOURCE_PROVIDER_NAMES: ReadonlySet<string> = new Set(["authentisign", "docusign", "dotloop", "skyslope"])

/**
 * PURE: `offers.form_source` for the packet the agent built. A library (in-platform) packet is `in_app`;
 * a packet filled inside the legal-forms provider's window is that provider's name when the column admits
 * it, else `manual`; nothing selected is `manual`. Never the wizard's own source words.
 */
export function offerFormSourceFor(selected: ReadonlyArray<{ source: SelectedFormSource; providerName?: string | null }>): string {
  if (selected.some((f) => f.source === "my_forms")) return "in_app"
  const provider = selected.find((f) => f.source === "legal_forms_provider")?.providerName?.toLowerCase() ?? null
  if (provider && FORM_SOURCE_PROVIDER_NAMES.has(provider)) return provider
  return "manual"
}

// ── Recommendation ───────────────────────────────────────────────────────────────────────────────

export interface AvailableForm {
  /** The wizard's formRef (a library storage path or the provider's form id). */
  ref: string
  name: string
  source: SelectedFormSource
  providerName?: string | null
  category?: string | null
}

export interface FormRecommendation {
  ref: string
  name: string
  source: SelectedFormSource
  providerName?: string | null
  kind: "required" | "agency" | "addendum"
  /** The verified package form this file satisfies. */
  packageForm: string
  reason: string
}

export interface RecommendFormsResult {
  recommended: FormRecommendation[]
  /** Package forms that apply but nobody has — named, never invented. */
  missing: Array<{ packageForm: string; kind: "required" | "agency" | "addendum"; why: string }>
}

interface AddendumRule { test: RegExp; applies: (a: IntakeAnswers, purpose: FormWizardPurpose) => boolean; why: string }

/** Which addenda the answers call for. A rule names the addendum by the words its name carries. */
const ADDENDUM_RULES: readonly AddendumRule[] = [
  { test: /financ|loan|mortgage/i,        applies: (a, p) => p === "offer" && isFinanced(a),                         why: "the purchase is financed" },
  { test: /inspection/i,                  applies: (a, p) => p === "offer" && (num(a.inspection_period_days) ?? 0) > 0, why: "an inspection period was answered" },
  { test: /appraisal/i,                   applies: (a, p) => p === "offer" && isFinanced(a) && a.appraisal_contingency === true, why: "the offer is contingent on the appraisal" },
  { test: /escalation/i,                  applies: (a, p) => p === "offer" && a.escalation_clause === true,            why: "an escalation clause was answered" },
  { test: /sale of|buyer'?s? (property|home)|contingency for sale/i, applies: (a, p) => p === "offer" && a.sale_of_buyer_home === true, why: "the offer depends on selling the buyer's home" },
  { test: /\bfha\b|\bva\b|amendatory/i,   applies: (a, p) => p === "offer" && ["fha", "va", "usda"].includes(String(a.financing_type ?? "")), why: "a government-backed loan was answered" },
  { test: /lead/i,                        applies: (a) => a.pre_1978 === true,                                        why: "the home was built before 1978 (or the year is unknown)" },
  { test: /hoa|association|condo/i,       applies: (a) => a.hoa === true,                                             why: "the property is in an association" },
]

/**
 * PURE — THE RECOMMENDATION. Required + agency forms of the state's verified package always; an
 * addendum only when a rule's condition holds on the answers (an addendum no rule names is left to the
 * agent, never pushed). Every recommendation is a form from `available` — the matcher joins package
 * names to real files/provider forms (lib/forms/state-package-match.ts); a required form nobody has
 * is NAMED under `missing`. Library forms are matched before provider forms so the in-platform packet
 * (source (a)) wins when both exist.
 */
export function recommendForms(input: {
  purpose: FormWizardPurpose
  answers: IntakeAnswers
  statePackage: { required: string[]; addenda: string[]; brokerageRepresentation: string } | null
  available: AvailableForm[]
  stateCode?: string | null
}): RecommendFormsResult {
  if (!input.statePackage) return { recommended: [], missing: [] }
  const ordered = [...input.available.filter((f) => f.source === "my_forms"), ...input.available.filter((f) => f.source !== "my_forms")]
  const matches = matchStatePackage(input.statePackage, ordered, input.stateCode)
  const recommended: FormRecommendation[] = []
  const missing: RecommendFormsResult["missing"] = []
  for (const m of matches) {
    let reason: string | null = null
    if (m.kind === "required") reason = "required by the state's verified package"
    else if (m.kind === "agency") reason = "the agency / representation disclosure the state requires"
    else {
      const rule = ADDENDUM_RULES.find((r) => r.test.test(m.required))
      if (rule && rule.applies(input.answers, input.purpose)) reason = `addendum — ${rule.why}`
    }
    if (!reason) continue
    if (m.file) recommended.push({ ref: m.file.ref, name: m.file.name, source: m.file.source, providerName: m.file.providerName ?? null, kind: m.kind, packageForm: m.required, reason })
    else missing.push({ packageForm: m.required, kind: m.kind, why: `${reason}; not in your library or your legal-forms provider — add it or pick it there` })
  }
  return { recommended, missing }
}
