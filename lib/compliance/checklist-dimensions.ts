/**
 * lib/compliance/checklist-dimensions.ts
 *
 * THE DIMENSIONS OF THE BROKERAGE'S REQUIRED-DOCUMENT CHECKLIST, CLIENT-SAFE AND PURE.
 *
 * Owner (wave 143): "The brokerage gives the COMPLETE list of required documents for each
 * contract type, for compliance including closing." A checklist row used to be selectable by
 * ONE thing besides scope — the deal SIDE (`deal_type`: buyer | seller | dual) and an optional
 * STATE. Everything else a brokerage actually varies a list by had no column, so a brokerage
 * could not say "proof of funds on CASH deals", "short-sale addendum on SHORT SALES", or "the
 * final settlement statement at CLOSING" — and the closing file had no checklist of its own.
 *
 * SURVIVOR EXTENDED, NOT REPLACED: this module is read by the ONE resolver
 * (lib/compliance/required-documents.ts:resolveRequiredDocuments) and the settings screen.
 * It adds four nullable dimensions to `brokerage_required_documents` (m806):
 *
 *   required_stage      listing | offer | contract | closing   — WHEN the document is due.
 *                       This ONE vocabulary carries both "listing / offer / contract type" and
 *                       "closing stage" (CLAUDE.md §6: two spellings of one idea are a defect).
 *   financing_kind      cash | financed
 *   contract_subtype    standard | new_construction | short_sale | reo_bank_owned |
 *                       probate_estate | lease_option
 *   representation      single_agency | dual_agency | designated_agency | transaction_brokerage
 *                       (the RELATIONSHIP model states regulate — distinct from `deal_type`, which
 *                       is the SIDE the brokerage holds)
 *   policy_version      integer, bumped on every edit of a rule (evidence of which list applied)
 *
 * NULL ON A ROW MEANS "ANY" — every row written before m806 is a wildcard on all four, so adding
 * the columns changes nothing until a brokerage sets one.
 *
 * RULE OF APPLICABILITY (rowApplicability), one place:
 *   · a row that names a value the caller KNOWS and that differs   → does not apply;
 *   · a row that names a value the caller does NOT know            → APPLIES, as a WARNING, with
 *     the unknown dimension named. "We could not tell whether this is a cash deal" must never
 *     render as "proof of funds is not required" (CLAUDE.md §4: nobody checked ≠ checked and fine);
 *   · STAGE is cumulative ("due BY"): a row due at `offer` is still due at `contract` and
 *     `closing`; a row due at `closing` is not yet due at `offer`. A caller that states NO stage
 *     sees only stage-NULL rows, which is exactly what every pre-m806 caller saw.
 *
 * BLIND SPOTS (published beside the rule): the property TYPE (condo / land / multi-family) is not a
 * dimension here — `listings.property_type` already carries it and no checklist row has asked for
 * it yet; `representation` is almost never KNOWN today (no column on transactions records it), so
 * a row that sets it applies as a warning until a caller supplies it.
 */

// ── Vocabularies (MIRROR the m806 CHECKs; scripts/closing-compliance-guard.ts holds them equal) ──

export const CHECKLIST_STAGES = ["listing", "offer", "contract", "closing"] as const
export type ChecklistStage = (typeof CHECKLIST_STAGES)[number]

export const CHECKLIST_STAGE_LABEL: Record<ChecklistStage, string> = {
  listing:  "Listing — before it goes live",
  offer:    "Offer — before it goes to compliance",
  contract: "Contract — executed, transaction creation",
  closing:  "Closing — before the CDA / closing",
}

export const FINANCING_KINDS = ["cash", "financed"] as const
export type FinancingKind = (typeof FINANCING_KINDS)[number]

export const FINANCING_KIND_LABEL: Record<FinancingKind, string> = { cash: "Cash", financed: "Financed" }

export const CONTRACT_SUBTYPES = [
  "standard", "new_construction", "short_sale", "reo_bank_owned", "probate_estate", "lease_option",
] as const
export type ContractSubtype = (typeof CONTRACT_SUBTYPES)[number]

export const CONTRACT_SUBTYPE_LABEL: Record<ContractSubtype, string> = {
  standard:         "Standard resale",
  new_construction: "New construction",
  short_sale:       "Short sale",
  reo_bank_owned:   "REO / bank-owned",
  probate_estate:   "Probate / estate sale",
  lease_option:     "Lease option",
}

export const REPRESENTATIONS = ["single_agency", "dual_agency", "designated_agency", "transaction_brokerage"] as const
export type Representation = (typeof REPRESENTATIONS)[number]

export const REPRESENTATION_LABEL: Record<Representation, string> = {
  single_agency:         "Single agency",
  dual_agency:           "Dual agency",
  designated_agency:     "Designated agency",
  transaction_brokerage: "Transaction brokerage (non-agency)",
}

/** The dimension columns, in the order a row names them. */
export const CHECKLIST_DIMENSION_COLUMNS = ["required_stage", "financing_kind", "contract_subtype", "representation"] as const
export type ChecklistDimensionColumn = (typeof CHECKLIST_DIMENSION_COLUMNS)[number]

const STAGE_RANK: Record<ChecklistStage, number> = { listing: 0, offer: 1, contract: 2, closing: 3 }

// ── Narrowing (tolerant of a raw value; never throws) ──────────────────────────────────

const oneOf = <T extends string>(set: readonly T[], v: unknown): T | null =>
  typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null

export const asChecklistStage = (v: unknown): ChecklistStage | null => oneOf(CHECKLIST_STAGES, v)
export const asFinancingKind = (v: unknown): FinancingKind | null => oneOf(FINANCING_KINDS, v)
export const asContractSubtype = (v: unknown): ContractSubtype | null => oneOf(CONTRACT_SUBTYPES, v)
export const asRepresentation = (v: unknown): Representation | null => oneOf(REPRESENTATIONS, v)

/**
 * `offers.financing_type` / `transactions.financing_type` → the checklist's two-valued kind.
 * The wizard writes cash | conventional | fha | va | usda | other; 'other' is financed (a seller-
 * carried note is still financing). An empty or absent value is UNKNOWN (null), never 'cash'.
 */
export function financingKindFor(financingType: unknown): FinancingKind | null {
  if (typeof financingType !== "string") return null
  const t = financingType.trim().toLowerCase()
  if (!t) return null
  return t === "cash" ? "cash" : "financed"
}

// ── The caller's side of the match ─────────────────────────────────────────────────────

export interface ChecklistContext {
  /** WHEN the caller is asking. Undefined = a pre-m806 caller: only stage-NULL rows apply. */
  stage?:           ChecklistStage | null
  financing?:       FinancingKind | null
  contractSubtype?: ContractSubtype | null
  representation?:  Representation | null
}

/** The dimension columns of a stored row (all optional: a row read before m806 carries none). */
export interface ChecklistRowDimensions {
  required_stage?:   string | null
  financing_kind?:   string | null
  contract_subtype?: string | null
  representation?:   string | null
}

export interface RowApplicability {
  applies: boolean
  /** Dimensions the row names but the caller did not state — the row applies as a WARNING. */
  unresolved: ChecklistDimensionColumn[]
}

/**
 * PURE. Does a stored rule apply to the question being asked, and is the answer certain?
 * See the module header for the rule; this is its one implementation.
 */
export function rowApplicability(row: ChecklistRowDimensions, ctx: ChecklistContext): RowApplicability {
  const unresolved: ChecklistDimensionColumn[] = []

  // STAGE — cumulative "due by". A row with a stage the caller did not state is NOT applied: it
  // was written for a stage-aware caller, and the stage-blind ones never saw a stage-bearing row.
  const rowStage = asChecklistStage(row.required_stage)
  if (rowStage) {
    const askedStage = asChecklistStage(ctx.stage)
    if (!askedStage) return { applies: false, unresolved }
    if (STAGE_RANK[rowStage] > STAGE_RANK[askedStage]) return { applies: false, unresolved }
  }

  const exact: Array<[ChecklistDimensionColumn, string | null, string | null]> = [
    ["financing_kind",   asFinancingKind(row.financing_kind),     asFinancingKind(ctx.financing)],
    ["contract_subtype", asContractSubtype(row.contract_subtype), asContractSubtype(ctx.contractSubtype)],
    ["representation",   asRepresentation(row.representation),    asRepresentation(ctx.representation)],
  ]
  for (const [column, rowValue, askedValue] of exact) {
    if (!rowValue) continue                       // row says ANY
    if (!askedValue) { unresolved.push(column); continue } // row names a value the caller cannot confirm
    if (rowValue !== askedValue) return { applies: false, unresolved: [] }
  }
  return { applies: true, unresolved }
}

/** How many dimensions a row pins down — the tie-break between two rows at the same scope. */
export function rowSpecificity(row: ChecklistRowDimensions & { state_code?: string | null }): number {
  let n = row.state_code ? 1 : 0
  if (asChecklistStage(row.required_stage)) n++
  if (asFinancingKind(row.financing_kind)) n++
  if (asContractSubtype(row.contract_subtype)) n++
  if (asRepresentation(row.representation)) n++
  return n
}

/** A one-line, human description of what a rule is scoped to — the settings list and the notices read it. */
export function describeRowScope(row: ChecklistRowDimensions & { state_code?: string | null; deal_type?: string | null }): string {
  const parts: string[] = []
  if (row.deal_type) parts.push(row.deal_type === "dual" ? "both sides" : `${row.deal_type} side`)
  if (row.state_code) parts.push(row.state_code)
  const stage = asChecklistStage(row.required_stage); if (stage) parts.push(`due by ${stage}`)
  const fin = asFinancingKind(row.financing_kind); if (fin) parts.push(FINANCING_KIND_LABEL[fin].toLowerCase())
  const sub = asContractSubtype(row.contract_subtype); if (sub) parts.push(CONTRACT_SUBTYPE_LABEL[sub].toLowerCase())
  const rep = asRepresentation(row.representation); if (rep) parts.push(REPRESENTATION_LABEL[rep].toLowerCase())
  return parts.join(" · ")
}
