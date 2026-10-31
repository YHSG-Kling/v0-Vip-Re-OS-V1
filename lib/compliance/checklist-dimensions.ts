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
 *
 * WAVE 144 (lane 144A, owner ruling 1 — "contract subtype, financing and representation must be
 * SELF-HEALING"): the platform lists below are the BASELINE, not the whole vocabulary. A brokerage
 * may add its own terms (a Texas "intermediary" representation, an "FHA 203(k)" financing type)
 * through the approved adaptive-vocabulary path (lib/compliance/adaptive-vocabulary.ts — tenant
 * policy key `adaptive_vocabulary`). Every tenant term ROLLS UP to exactly one platform key below,
 * so a reader that only knows the platform list keeps working. This module stays pure and
 * client-safe: rowApplicability takes a `ChecklistVocabulary` (default PLATFORM_CHECKLIST_VOCABULARY)
 * instead of importing the tenant overlay, so the dependency points one way.
 *
 *   · A row value the vocabulary cannot interpret is UNRESOLVED (applies as a WARNING naming the
 *     dimension) — it was a silent wildcard before, which was harmless only while the m806 CHECK
 *     made such a row impossible.
 *   · Lineage: a rule naming a PLATFORM parent (new_construction) applies to a deal whose term rolls
 *     up to it (a tenant "new home — incomplete"); a rule naming the CHILD on a deal that only states
 *     the PARENT applies as a warning (the deal may or may not be that kind).
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

/**
 * THE FINANCING-TYPE VOCABULARY (wave 144A) — what `offers.financing_type` / `transactions.financing_type`
 * hold. There was no canonical constant: the same six values were retyped in the offer wizard, the
 * intake questions, the voice intake, the extractor prompt and the state form-field enum. This is the
 * ONE list; the scattered copies are named in lane 144A's notes (Outside-lane) to import it. No live
 * CHECK pins the column, so a brokerage term is WRITTEN AS ITS PLATFORM ROLL-UP (see
 * adaptive-vocabulary.ts vocabularyWriteValue) and every reader that compares against these six
 * (offer strength, the government-loan amendatory addendum, financingKindFor) keeps working.
 */
export const FINANCING_TYPES = ["cash", "conventional", "fha", "va", "usda", "other"] as const
export type FinancingType = (typeof FINANCING_TYPES)[number]

export const FINANCING_TYPE_LABEL: Record<FinancingType, string> = {
  cash: "Cash", conventional: "Conventional loan", fha: "FHA", va: "VA", usda: "USDA", other: "Other",
}

/** The government-backed loans that carry their own amendatory clauses (the offer wizard's addendum rule). */
export const GOVERNMENT_BACKED_FINANCING_TYPES: readonly FinancingType[] = ["fha", "va", "usda"]

/**
 * Historical / imported SPELLINGS of the six — an alias resolves forever and is never deleted (owner
 * ruling 1: "never silently delete historical values"). Keys are normalized (lower case, single
 * spaces, no trailing punctuation). Seller-carried notes are financing ('other'), as the kind map says.
 */
const FINANCING_TYPE_ALIASES: Readonly<Record<string, FinancingType>> = {
  "all cash": "cash", "cash offer": "cash", "cash buyer": "cash", "cash purchase": "cash", "no financing": "cash",
  "conventional loan": "conventional", "conventional mortgage": "conventional", "conv": "conventional",
  "fha loan": "fha", "va loan": "va", "usda loan": "usda", "rural development": "usda",
  "seller financing": "other", "owner financing": "other", "owner will carry": "other", "seller carry": "other",
}

/** trim, lower case, collapse whitespace, strip trailing punctuation — the ONE normalizer for a vocabulary value. */
export function normalizeVocabularyValue(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase().replace(/[!.]+$/g, "").replace(/\s+/g, " ").trim() : ""
}

/** A raw financing value → its PLATFORM type (exact, separator-tolerant, or a platform alias), or null. */
export function platformFinancingType(raw: unknown): FinancingType | null {
  const c = normalizeVocabularyValue(raw)
  if (!c) return null
  const underscored = c.replace(/[\s-]+/g, "_")
  if ((FINANCING_TYPES as readonly string[]).includes(underscored)) return underscored as FinancingType
  return FINANCING_TYPE_ALIASES[c] ?? null
}

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

/**
 * THE ONE CONTRACT-TYPE VOCABULARY, AND THE SECOND ONE MERGED ONTO IT (wave 145, lane 145H — CLAUDE.md §6; lane 144A
 * Outside-lane 2). The offer intake (lib/workflow/intake/voice-to-offer.ts) and the state form-field registry
 * (lib/state-forms/field-defs.ts OFFER_FIELD_DEFS.contractType) spoke a second list — residential | as_is |
 * new_construction | land | commercial — that nothing downstream could read (the checklist matches CONTRACT_SUBTYPES).
 * Both now speak CONTRACT_SUBTYPES. Historical / spoken spellings resolve here forever (an alias is never deleted):
 *
 *   residential → standard (the owner's mapping, 144A Outside-lane 2: a standard residential resale contract).
 *
 * TOMBSTONE — the three members that are NOT contract types, each with its home:
 *   · land, commercial → PROPERTY types (lib/constants/index.ts PROPERTY_TYPES, read off listings.property_type), not
 *     the kind of purchase contract. They resolve to nothing here, so the intake asks for the contract type.
 *   · as_is → a sale CONDITION, and jurisdictional: in Texas it is a term inside the standard TREC resale contract
 *     (¶7D "Buyer accepts the Property As Is"); in Florida it is a separate form (the FR/BAR "AS IS" contract). It is
 *     therefore never a platform constant: a brokerage whose market uses an as-is FORM adds it as a STATE-SCOPED,
 *     cited, compliance-attested contract-type term (Required documents → Vocabulary — lib/compliance/
 *     adaptive-vocabulary.ts), and the term then resolves through that brokerage's vocabulary.
 * Keys are normalized (normalizeVocabularyValue); separator-tolerant platform keys match before an alias.
 */
const CONTRACT_SUBTYPE_ALIASES: Readonly<Record<string, ContractSubtype>> = {
  "residential": "standard", "standard residential": "standard", "residential resale": "standard", "resale": "standard",
  "standard resale": "standard", "standard purchase": "standard",
  "new build": "new_construction", "builder contract": "new_construction", "new home": "new_construction",
  "reo": "reo_bank_owned", "bank owned": "reo_bank_owned", "bank-owned": "reo_bank_owned",
  "probate": "probate_estate", "estate sale": "probate_estate",
}

/** A raw contract-type value → its PLATFORM contract subtype (exact, separator-tolerant, or a platform alias), or null. */
export function platformContractSubtype(raw: unknown): ContractSubtype | null {
  const c = normalizeVocabularyValue(raw)
  if (!c) return null
  const underscored = c.replace(/[\s-]+/g, "_")
  if ((CONTRACT_SUBTYPES as readonly string[]).includes(underscored)) return underscored as ContractSubtype
  return CONTRACT_SUBTYPE_ALIASES[c] ?? null
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
 *
 * Wave 144A: the value is first resolved to its PLATFORM type — an alias ("All Cash") or a brokerage
 * term that rolls up to `cash` is cash; before this, "all cash" read as FINANCED, so a cash-only rule
 * (proof of funds) did not apply to it. `platformTypeOf` defaults to the platform list; a caller that
 * holds the tenant vocabulary passes adaptive-vocabulary.ts's resolver. An unrecognised non-empty
 * label keeps the historical rule (anything that is not cash is financing) — never loosened to unknown.
 */
export function financingKindFor(
  financingType: unknown,
  platformTypeOf: (raw: string) => string | null = platformFinancingType,
): FinancingKind | null {
  if (typeof financingType !== "string") return null
  const t = financingType.trim().toLowerCase()
  if (!t) return null
  const platform = platformTypeOf(t)
  if (platform) return platform === "cash" ? "cash" : "financed"
  return t === "cash" ? "cash" : "financed"
}

// ── The vocabulary a match reads (platform baseline by default) ────────────────────────

export type ResolvableDimension = "financing_kind" | "contract_subtype" | "representation"

/**
 * What rowApplicability needs from a vocabulary: a stored or asked value's LINEAGE — its canonical
 * key first, then each ancestor it rolls up to — or null when the vocabulary cannot interpret it.
 * PLATFORM_CHECKLIST_VOCABULARY knows the platform lists only; lib/compliance/adaptive-vocabulary.ts
 * checklistVocabularyFor adds a brokerage's approved terms and aliases.
 */
export interface ChecklistVocabulary {
  lineage(column: ResolvableDimension, value: string): readonly string[] | null
  /** Display label for a stored value; null = not in the vocabulary. */
  label(column: ResolvableDimension, value: string): string | null
}

const PLATFORM_DIMENSION_LIST: Readonly<Record<ResolvableDimension, readonly string[]>> = {
  financing_kind: FINANCING_KINDS, contract_subtype: CONTRACT_SUBTYPES, representation: REPRESENTATIONS,
}
const PLATFORM_DIMENSION_LABEL: Readonly<Record<ResolvableDimension, Readonly<Record<string, string>>>> = {
  financing_kind: FINANCING_KIND_LABEL, contract_subtype: CONTRACT_SUBTYPE_LABEL, representation: REPRESENTATION_LABEL,
}

/** The platform baseline as a ChecklistVocabulary — exact values only, every lineage of length one. */
export const PLATFORM_CHECKLIST_VOCABULARY: ChecklistVocabulary = {
  lineage: (column, value) => (PLATFORM_DIMENSION_LIST[column]?.includes(value) ? [value] : null),
  label: (column, value) => PLATFORM_DIMENSION_LABEL[column]?.[value] ?? null,
}

// ── The caller's side of the match ─────────────────────────────────────────────────────

export interface ChecklistContext {
  /** WHEN the caller is asking. Undefined = a pre-m806 caller: only stage-NULL rows apply. */
  stage?:           ChecklistStage | null
  financing?:       FinancingKind | null
  /** A platform ContractSubtype or a brokerage's approved term (wave 144A). */
  contractSubtype?: string | null
  /** A platform Representation or a brokerage's approved term (wave 144A). */
  representation?:  string | null
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
export function rowApplicability(
  row: ChecklistRowDimensions,
  ctx: ChecklistContext,
  vocabulary: ChecklistVocabulary = PLATFORM_CHECKLIST_VOCABULARY,
): RowApplicability {
  const unresolved: ChecklistDimensionColumn[] = []

  // STAGE — cumulative "due by". A row with a stage the caller did not state is NOT applied: it
  // was written for a stage-aware caller, and the stage-blind ones never saw a stage-bearing row.
  const rowStage = asChecklistStage(row.required_stage)
  if (rowStage) {
    const askedStage = asChecklistStage(ctx.stage)
    if (!askedStage) return { applies: false, unresolved }
    if (STAGE_RANK[rowStage] > STAGE_RANK[askedStage]) return { applies: false, unresolved }
  }

  const exact: Array<[ResolvableDimension, unknown, unknown]> = [
    ["financing_kind",   row.financing_kind,   ctx.financing],
    ["contract_subtype", row.contract_subtype, ctx.contractSubtype],
    ["representation",   row.representation,   ctx.representation],
  ]
  for (const [column, rowRaw, askedRaw] of exact) {
    if (typeof rowRaw !== "string" || !rowRaw.trim()) continue                  // row says ANY
    const rowLine = vocabulary.lineage(column, rowRaw.trim())
    // A stored value the vocabulary cannot interpret is never a wildcard: the rule applies, as a warning.
    if (!rowLine) { unresolved.push(column); continue }
    const askedLine = typeof askedRaw === "string" && askedRaw.trim() ? vocabulary.lineage(column, askedRaw.trim()) : null
    if (!askedLine) { unresolved.push(column); continue }                        // the caller cannot confirm it
    if (askedLine.includes(rowLine[0])) continue                                 // the asked value IS the rule's, or rolls up to it
    if (rowLine.includes(askedLine[0])) { unresolved.push(column); continue }    // the rule is more specific than what was asked
    return { applies: false, unresolved: [] }
  }
  return { applies: true, unresolved }
}

/**
 * How specific a row is — the tie-break between two rows at the same scope. Each pinned dimension
 * counts its lineage depth, so a brokerage term ("new home — incomplete") beats its platform parent
 * (new_construction); every platform value has depth one, exactly the old count.
 */
export function rowSpecificity(
  row: ChecklistRowDimensions & { state_code?: string | null },
  vocabulary: ChecklistVocabulary = PLATFORM_CHECKLIST_VOCABULARY,
): number {
  let n = row.state_code ? 1 : 0
  if (asChecklistStage(row.required_stage)) n++
  for (const column of ["financing_kind", "contract_subtype", "representation"] as const) {
    const raw = row[column]
    if (typeof raw === "string" && raw.trim()) n += vocabulary.lineage(column, raw.trim())?.length ?? 0
  }
  return n
}

/** A one-line, human description of what a rule is scoped to — the settings list and the notices read it. */
export function describeRowScope(
  row: ChecklistRowDimensions & { state_code?: string | null; deal_type?: string | null },
  vocabulary: ChecklistVocabulary = PLATFORM_CHECKLIST_VOCABULARY,
): string {
  const parts: string[] = []
  if (row.deal_type) parts.push(row.deal_type === "dual" ? "both sides" : `${row.deal_type} side`)
  if (row.state_code) parts.push(row.state_code)
  const stage = asChecklistStage(row.required_stage); if (stage) parts.push(`due by ${stage}`)
  for (const column of ["financing_kind", "contract_subtype", "representation"] as const) {
    const raw = row[column]
    if (typeof raw !== "string" || !raw.trim()) continue
    // An uninterpretable stored value is shown AS STORED, flagged — never hidden.
    parts.push((vocabulary.label(column, raw.trim()) ?? `${raw.trim()} (unrecognised)`).toLowerCase())
  }
  return parts.join(" · ")
}
