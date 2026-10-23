/**
 * lib/state-forms/closing-participants.ts — WHO THE DEAL'S STATE SAYS BELONGS AT THE CLOSING.
 *
 * Owner (wave 143): "In some states a closing attorney represents the buyer and one represents the
 * seller and initiates the title search; the deal's STATE decides who is legally included. Laws
 * differ per state." No universal rule — so this module holds NONE. It holds, per state, only what an
 * authoritative source says, with the source beside it; every other state is UNSUPPORTED and carries
 * the question that has to be answered before it can be supported.
 *
 * SURVIVORS READ, NOT REPLACED
 *   · lib/state-forms/registry.ts            — the state's FORMS (this file is its closing-people twin,
 *                                              same "the property's state decides" rule, same 51 keys).
 *   · lib/offers/regional-closing-costs.ts   — `settlementModel` / `attorneyClosing` are PUBLISHED
 *                                              CONVENTIONS for pricing a closing. They are surfaced here
 *                                              for an unsupported state as a labelled HINT, never as law.
 *   · lib/brokerage/get-brokerage-settings.ts — `closing_entity_type` is ONE brokerage-wide default; a
 *                                              state that requires an attorney overrides it, and the
 *                                              disagreement is reported (`conflicts`).
 *   · transaction_participants (role is free text) — what is already on the deal.
 *
 * WHAT THE SOURCES DO AND DO NOT SAY (published beside the table, not hidden in it)
 *   · They establish WHETHER a licensed attorney must conduct (or supervise) the closing and, in some
 *     states, the title examination. They do NOT assign "buyer's attorney vs seller's attorney" or
 *     "who orders the title search" by law in any state implemented here, except Delaware (the
 *     attorney "representing the buyer in examining the title") and New York's county-by-county
 *     CUSTOM (the buyer's attorney orders the title report). Where no source assigns it, the policy
 *     says so (`titleSearch.assignedByLaw: false`) and the finding asks the deal team to record who is
 *     doing it — it never guesses.
 *   · A bar-association opinion is not a court or a statute. `basis` says which each entry rests on, and
 *     a `bar_advisory_opinion` or `bar_guidance_custom` entry is worded as such.
 *
 * ABSENCE OF A STATE IS NOT "NO REQUIREMENT". An unsupported state returns status 'unsupported', never
 * an empty list that reads as "nobody is required".
 *
 * Sources retrieved 2026-10-23. Each URL was fetched through the research tool on that date; the
 * quoted holding is the source's own words, shortened. Re-verify on the cadence in `VERIFY_EVERY_DAYS`.
 */

import { getRegionalConventions, normalizeStateCode } from "@/lib/offers/regional-closing-costs"

export const CLOSING_POLICY_VERIFIED_ON = "2026-10-23"
export const VERIFY_EVERY_DAYS = 180

/** Who a policy entry can ask to be on the deal. */
export type ClosingParticipantRole =
  | "closing_attorney"          // an attorney conducting the closing, side not specified
  | "buyer_closing_attorney"
  | "seller_closing_attorney"
  | "lender_attorney"
  | "title_agent_or_company"
  | "settlement_agent"

export type AttorneyInvolvement =
  | "required"                            // a court or statute requires an attorney to conduct / supervise the closing
  | "required_for_title_exam_and_deed"    // title agents may conduct the closing; attorneys are required for the marketability exam and the deed (RI)
  | "customary"                           // practice, not a legal mandate

export type PolicyBasis = "statute" | "state_supreme_court" | "bar_advisory_opinion" | "bar_guidance_custom"

export interface PolicySource {
  title: string
  url:   string
  /** The holding or statement relied on, in the source's own terms, shortened. */
  says:  string
}

export interface StateClosingPolicy {
  state:      string
  stateName:  string
  involvement: AttorneyInvolvement
  basis:      PolicyBasis
  /** What the law (or the custom) requires, in one sentence a TC can read. */
  summary:    string
  /** Roles the state expects on the deal, and how firmly. */
  expects:    Array<{ role: ClosingParticipantRole; presence: "required" | "customary"; why: string }>
  titleSearch: {
    /** True only when a cited source assigns who performs / orders it. */
    assignedByLaw: boolean
    note: string
  }
  sources:    PolicySource[]
}

const P = (p: StateClosingPolicy): StateClosingPolicy => p

export const STATE_CLOSING_POLICIES: Readonly<Record<string, StateClosingPolicy>> = {
  GA: P({
    state: "GA", stateName: "Georgia", involvement: "required", basis: "state_supreme_court",
    summary: "Only a Georgia-licensed attorney may close a real estate transaction or prepare / facilitate execution of a deed of conveyance; rendering an opinion on title is the practice of law.",
    expects: [{ role: "closing_attorney", presence: "required", why: "Georgia Supreme Court: it is the unauthorized practice of law for anyone but a licensed Georgia attorney to close a real estate transaction." }],
    titleSearch: { assignedByLaw: false, note: "OCGA § 15-19-50 makes rendering opinions on the validity of title the practice of law; the sources do not say which party's attorney orders the search." },
    sources: [
      { title: "In re UPL Advisory Opinion 2003-2, 277 Ga. 472 (2003)", url: "https://www.gabar.org/docs/default-source/programs-pdf/in-re-upl-advisory-opinion-2003-2-277-ga-472-%282003%29.pdf",
        says: "It is the unauthorized practice of law for someone other than a duly licensed Georgia attorney to close a real estate transaction or to prepare or facilitate the execution of a deed of conveyance; OCGA § 15-19-50 (practice of law includes conveyancing and opinions on title)." },
    ],
  }),
  SC: P({
    state: "SC", stateName: "South Carolina", involvement: "required", basis: "state_supreme_court",
    summary: "Each step of a residential transaction — title search and certification, preparation of instruments, closing, recording and disbursement — is the practice of law and must be performed or supervised by a South Carolina lawyer. The same lawyer need not do every step.",
    expects: [{ role: "closing_attorney", presence: "required", why: "Boone v. Quicken Loans (S.C. 2017): each step entails the practice of law; the closing lawyer must confirm the other steps were handled by licensed South Carolina lawyers." }],
    titleSearch: { assignedByLaw: true, note: "Title search and certification is a step that must be performed or supervised by a South Carolina lawyer; the Court does not assign it to the buyer's or the seller's lawyer." },
    sources: [
      { title: "SC Bar Ethics Opinion 26-01 (citing Boone v. Quicken Loans, Inc., 420 S.C. 452 (2017))", url: "https://www.scbar.org/for-lawyers/quicklinks/legal-resources/ethics-advisory-opinions/ethics-opinion-26-01/",
        says: "Title Search and Certification, Preparation of Instruments, Closing the Transaction, and Recording and Disbursement each entail the practice of law and must be performed or supervised by a South Carolina licensed lawyer." },
      { title: "SC Bar Ethics Advisory Opinion 09-01 (State v. Buyers Service Co., 292 S.C. 426 (1987); Doe Law Firm v. Richardson, 371 S.C. 14 (2006))", url: "https://www.scbar.org/for-lawyers/quicklinks/legal-resources/ethics-advisory-opinions/ethics-advisory-opinion-09-01/",
        says: "The Court requires lawyer supervision of abstracting title, preparing documents, closing, recording and disbursing." },
    ],
  }),
  NC: P({
    state: "NC", stateName: "North Carolina", involvement: "required", basis: "statute",
    summary: "A nonlawyer may not handle a residential closing: preparing deeds and other legal documents, abstracting or passing upon title, and advising on legal rights are the practice of law. Title insurance issues only on the opinion of a licensed North Carolina attorney who is not the insurer's employee.",
    expects: [{ role: "closing_attorney", presence: "required", why: "N.C. Gen. Stat. §§ 84-2.1 and 84-4 (State Bar Authorized Practice Advisory Opinion 2002-1)." }],
    titleSearch: { assignedByLaw: true, note: "N.C. Gen. Stat. § 58-26-1: a title insurance policy issues only after an opinion of title from an attorney who has conducted, or caused to be conducted under direct supervision, a reasonable examination of the title." },
    sources: [
      { title: "NC State Bar Authorized Practice Advisory Opinion 2002-1", url: "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/authorized-practice-advisory-opinion-2002-1/",
        says: "May a nonlawyer handle a residential real estate closing for one or more of the parties? No. Only persons licensed to practice law in this state may handle most of these functions (N.C. Gen. Stat. §§ 84-2.1, 84-4, 58-26-1)." },
    ],
  }),
  DE: P({
    state: "DE", stateName: "Delaware", involvement: "required", basis: "state_supreme_court",
    summary: "A Delaware-licensed attorney must conduct the closing of a sale (and of a refinance) of Delaware real property and must be involved in drafting or reviewing the documents that transfer title; attorney participation is necessary in representing the buyer in examining the title and removing exceptions.",
    expects: [
      { role: "closing_attorney", presence: "required", why: "Matter of Mid-Atlantic Settlement Services, Inc. (Del. 2000): an attorney licensed in Delaware is required to conduct a closing of a sale of Delaware real property." },
      { role: "buyer_closing_attorney", presence: "required", why: "The same decision names an attorney 'representing the buyer in examining the title and removing exceptions to the title'." },
    ],
    titleSearch: { assignedByLaw: true, note: "The Delaware Supreme Court's decision places the title examination with an attorney representing the buyer." },
    sources: [
      { title: "Matter of Mid-Atlantic Settlement Services, Inc., Del. Supreme Ct. No. 102, 2000, UPL 95-15 (5/31/00) — ODC UPL digest", url: "https://courts.delaware.gov/ODC/Digest/Download.aspx?id=419",
        says: "Delaware attorneys must participate in all real estate settlements: an attorney is required to conduct a closing of a sale of Delaware real property, and to represent the buyer in examining the title and removing exceptions." },
    ],
  }),
  MA: P({
    state: "MA", stateName: "Massachusetts", involvement: "required", basis: "state_supreme_court",
    summary: "An attorney must be involved in the closing of a real property conveyance. Gathering the record (title abstract) is not itself the practice of law; analysing it to render an opinion on marketable title is, and the lender's closing attorney has that responsibility to the lender.",
    expects: [{ role: "closing_attorney", presence: "required", why: "Real Estate Bar Ass'n for Massachusetts v. National Real Estate Information Services, 459 Mass. 512 (2011): a lawyer is a necessary participant at the closing." }],
    titleSearch: { assignedByLaw: true, note: "The court separates the record search (commonly performed by nonlawyers for attorneys) from the marketability opinion (an attorney); it does not assign either to the buyer's or the seller's attorney." },
    sources: [
      { title: "Real Estate Bar Ass'n for Massachusetts v. National Real Estate Information Services, 459 Mass. 512 (2011)", url: "https://law.justia.com/cases/massachusetts/supreme-court/volumes/459/459mass512.html",
        says: "As a matter of common and long-standing practice in the Commonwealth, an attorney must be involved in the closing or settlement of real property conveyances; analysing title to render an opinion on marketability is the practice of law." },
    ],
  }),
  WV: P({
    state: "WV", stateName: "West Virginia", involvement: "required", basis: "bar_advisory_opinion",
    summary: "Conducting a real estate title examination and a real estate closing are the practice of law and may not be done by a lay person unless under the direct supervision and control of a licensed lawyer (or for the person's regular employer). This is the State Bar's Unlawful Practice of Law Committee acting as the Supreme Court's agent — an advisory opinion, not a statute. The committee's 2010 opinion was stayed for a time pending an appeal in McMahon v. Advanced Title Services (Brooke County Circuit Court); this is the amended 2015 text — confirm its current standing with West Virginia counsel before relying on it.",
    expects: [{ role: "closing_attorney", presence: "required", why: "WV State Bar Advisory Opinion 2010-002 (amended): title examination and closings are the practice of law." }],
    titleSearch: { assignedByLaw: true, note: "The opinion treats the title examination itself as the practice of law (attorney, or lay person under direct attorney supervision); it does not say whose attorney." },
    sources: [
      { title: "West Virginia State Bar Advisory Opinion 2010-002 (Amended 6-3-15)", url: "https://wvbar.org/wp-content/uploads/2012/04/Advisory-Opinion-2010-002-updated-6-3-15.pdf",
        says: "The activity of conducting a real estate title examination and real estate closing are the practice of law and cannot be conducted by a lay person unless under the direct supervision and control of a licensed lawyer." },
    ],
  }),
  RI: P({
    state: "RI", stateName: "Rhode Island", involvement: "required_for_title_exam_and_deed", basis: "state_supreme_court",
    summary: "Title insurance companies and their agents may conduct a residential closing in connection with issuing title insurance (with the Department of Business Regulation's disclosure notice). Examining title for marketability requires a licensed attorney, and a deed must be drafted or reviewed by an attorney.",
    expects: [{ role: "closing_attorney", presence: "required", why: "In re Paplauskas (R.I. 2020): an attorney must conduct (or be engaged by the title insurer for) the marketability exam and must draft or review the deed. A title agent may conduct the closing itself." }],
    titleSearch: { assignedByLaw: true, note: "Examination of title for marketability may be done by a title insurance company only through a licensed attorney it engages or employs." },
    sources: [
      { title: "In re Paplauskas, R.I. Supreme Court No. 2018-161-M.P. (May 29, 2020)", url: "https://law.justia.com/cases/rhode-island/supreme-court/2020/18-161.html",
        says: "Title insurance companies and their agents do not engage in the unauthorized practice of law when they conduct a residential real estate closing in connection with title insurance; examining title for marketability requires a licensed attorney; drafting a deed is the practice of law." },
      { title: "RI Dept. of Business Regulation Insurance Bulletin 2020-8", url: "https://dbr.ri.gov/sites/g/files/xkgbur696/files/documents/news/insurance/InsuranceBulletin2020-8.pdf",
        says: "Identifies the closing functions a licensed title insurance agent may perform and those that must be performed by a licensed attorney; requires a disclosure notice when a non-attorney agent conducts the closing." },
    ],
  }),
  CT: P({
    state: "CT", stateName: "Connecticut", involvement: "required", basis: "statute",
    summary: "Since October 1, 2019 no person may conduct a real estate closing (a mortgage-loan closing, or any transaction in which consideration is paid to change ownership of Connecticut real property) unless admitted as a Connecticut attorney in good standing. The Connecticut Bar Association's Real Property Section reads the Act as NOT making the title search itself part of 'conducting the closing'.",
    expects: [{ role: "closing_attorney", presence: "required", why: "Connecticut Public Act 19-88, § 1(a)." }],
    titleSearch: { assignedByLaw: false, note: "Per the Bar Association's advisory memo, an attorney need not perform the title search (a review of the land records); the Act does not assign it to a side." },
    sources: [
      { title: "Connecticut Public Act 19-88 'An Act Concerning Real Estate Closings' — CBA Real Property Section memorandum", url: "https://cdn.ymaws.com/members.ctbar.org/resource/resmgr/section_real_property/SB_320_PA_19-88_Memo_Final.pdf",
        says: "No person shall conduct a real estate closing unless such person has been admitted as an attorney in this state under section 51-80 and has not been disqualified from the practice of law (the memo is advisory and not binding on the courts)." },
    ],
  }),
  NY: P({
    state: "NY", stateName: "New York", involvement: "customary", basis: "bar_guidance_custom",
    summary: "Not a statutory requirement: attorneys are used in a residential transaction in most parts of New York, the buyer and the seller each customarily have their own, and the buyer's attorney generally orders the title report. Who orders and pays for the title search varies county by county, particularly upstate.",
    expects: [
      { role: "buyer_closing_attorney", presence: "customary", why: "NYC Bar / NYSBA: buyer and seller retain attorneys in most parts of New York; the buyer's attorney generally orders the title report." },
      { role: "seller_closing_attorney", presence: "customary", why: "NYC Bar / NYSBA: the seller's attorney customarily prepares the first draft of the contract and the deed." },
    ],
    titleSearch: { assignedByLaw: false, note: "Customary, not legal: NYSBA says the buyer's attorney generally orders the title report, and that who orders and pays varies by county (Residential Real Estate Practice Guide)." },
    sources: [
      { title: "NYSBA LEGALease: The Attorney's Role in Home Purchase Transactions", url: "https://nysba.org/legalease-the-attorneys-role-in-home-purchase-transactions/",
        says: "Generally, a buyer's attorney orders a title report from a title insurance company; in some areas of Upstate New York the buyer's attorney examines the land records." },
      { title: "NYSBA Residential Real Estate Practice Guide (county-by-county customs)", url: "https://nysba.org/residential-real-estate-practice-guide/",
        says: "Closing customs and practices vary widely from one county to the next, including who orders and pays for title searches." },
      { title: "NYC Bar: Buying and Selling Real Estate in New York City", url: "https://www.nycbar.org/get-legal-help/article/real-property-law/purchase-sale-real-property/",
        says: "Attorneys are used in a real estate transaction in most parts of New York; the buyer's attorney will order a title report." },
    ],
  }),
}

/** A closing role recognised from a free-text `transaction_participants.role`. */
function classifyParticipantRole(role: string | null | undefined): ClosingParticipantRole | null {
  const r = String(role ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (!r) return null
  if (r.includes("attorney") || r.includes("lawyer")) {
    if (r.includes("lender") || r.includes("bank")) return "lender_attorney"
    if (r.includes("buyer") || r.includes("purchaser")) return "buyer_closing_attorney"
    if (r.includes("seller")) return "seller_closing_attorney"
    return "closing_attorney"
  }
  if (r === "title" || r.includes("title_company") || r.includes("title_agent") || r.includes("escrow")) return "title_agent_or_company"
  if (r.includes("settlement")) return "settlement_agent"
  return null
}

export interface ParticipantGap {
  role:    ClosingParticipantRole
  presence: "required" | "customary"
  message: string
}

export interface ClosingParticipantAssessment {
  state:    string | null
  /** 'verified' = a sourced policy exists; 'unsupported' = it does not, and `question` says what to settle. */
  status:   "verified" | "unsupported"
  policy:   StateClosingPolicy | null
  gaps:     ParticipantGap[]
  /** The brokerage-wide default disagrees with the state (e.g. default 'title_company' in an attorney state). */
  conflicts: string[]
  /** A published CONVENTION for an unsupported state — a hint, never a requirement. */
  conventionHint: string | null
  /** The question to answer to move an unsupported state to verified. */
  question: string | null
}

const attorneyRoles: ReadonlySet<ClosingParticipantRole> = new Set<ClosingParticipantRole>([
  "closing_attorney", "buyer_closing_attorney", "seller_closing_attorney", "lender_attorney",
])

/**
 * PURE. What the deal's state expects at the closing, against who is on the deal.
 *
 * A gap is a QUESTION, not a verdict: the participant list is what someone remembered to type in, and
 * a title company can be an attorney's firm. The caller files it as `needs_review`, non-blocking.
 */
export function assessClosingParticipants(input: {
  stateCode: string | null | undefined
  participantRoles: ReadonlyArray<string | null | undefined>
  /** lib/brokerage/get-brokerage-settings.ts closing_entity_type, when known. */
  brokerageClosingEntityType?: string | null
}): ClosingParticipantAssessment {
  const state = normalizeStateCode(input.stateCode)
  if (!state) {
    return { state: null, status: "unsupported", policy: null, gaps: [], conflicts: [], conventionHint: null,
      question: "The deal has no recognisable property state, so the state's closing participants cannot be determined. Record the property address with its state." }
  }
  const policy = STATE_CLOSING_POLICIES[state] ?? null
  if (!policy) {
    const conv = getRegionalConventions(state)
    return {
      state, status: "unsupported", policy: null, gaps: [], conflicts: [],
      conventionHint: conv
        ? `Published closing convention (not law): ${conv.stateName} closings are customarily handled by ${conv.settlementModel.replace("_", " ")}${conv.attorneyClosing ? " with an attorney conducting the closing" : ""}.`
        : null,
      question: `Which participants does ${state} law require or customarily include at a residential closing — a closing attorney for the buyer, one for the seller, a title or escrow company, a settlement agent — and who initiates the title search? No authoritative source has been verified for ${state}; confirm with the brokerage's counsel or the state real estate commission, then add the policy with its citation to lib/state-forms/closing-participants.ts.`,
    }
  }

  const present = new Set<ClosingParticipantRole>()
  for (const r of input.participantRoles) { const c = classifyParticipantRole(r); if (c) present.add(c) }
  const hasAnyAttorney = [...present].some((r) => attorneyRoles.has(r))

  const gaps: ParticipantGap[] = []
  for (const e of policy.expects) {
    // A side-less 'closing attorney' is satisfied by any attorney on the deal; a side-specific one only
    // by that side's attorney (a side-less attorney cannot be assumed to be the buyer's).
    const satisfied = e.role === "closing_attorney" ? hasAnyAttorney : present.has(e.role)
    if (satisfied) continue
    gaps.push({
      role: e.role, presence: e.presence,
      message: `${policy.stateName}: no ${e.role.replace(/_/g, " ")} is on the deal's participant list. ${e.why} ` +
        (e.presence === "customary" ? "This is local custom, not a legal requirement — confirm who is acting." : "If the title company named is an attorney's firm, record the attorney as a participant."),
    })
  }

  const conflicts: string[] = []
  const entity = String(input.brokerageClosingEntityType ?? "").trim()
  if ((policy.involvement === "required") && entity && entity !== "attorney") {
    conflicts.push(`The brokerage's default closing entity is '${entity}', but ${policy.stateName} requires a licensed attorney to conduct the closing (${policy.sources[0].title}).`)
  }
  return { state, status: "verified", policy, gaps, conflicts, conventionHint: null, question: null }
}

/** Days since the policy table was verified; the runner reports a stale table rather than trusting it forever. */
export function closingPolicyAgeDays(now: Date = new Date()): number {
  return Math.floor((now.getTime() - Date.parse(CLOSING_POLICY_VERIFIED_ON)) / 86_400_000)
}
