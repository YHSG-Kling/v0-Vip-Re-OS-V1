// lib/offers/governing-terms-rule.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CONTRACT PRECEDENCE — THE PURE RULE (wave 143, lane 143A). The I/O half — the ONE reader `governingContractTerms`, the
// recorder and the promotion freeze — is lib/offers/governing-terms.ts, which calls this module; the split is the same shape as
// lib/esign/packet-states.ts (pure ladder) beside packet-state-writer.ts (the one writer): the rule is driven by a plain tsx
// guard with no client, and it is import-safe from a client component.
//
// ── THE RULE (pure, proved with positive controls) ────────────────────────────────────────────────
//   A version GOVERNS a term when it is EXECUTED (both parties' signatures — never merely proposed) and it names that term;
//   among executed versions that name a term, the LATEST executed one wins (ties: the original, then a counter, then an addendum,
//   then an amendment — an addendum amends a contract that already exists — then the higher version number). A version names
//   a term by carrying a value for it — an explicit `null` in a recorded version is a deliberate STRIKE and governs as null; a
//   derived-from-offers-row version names only the columns that hold a value (an offers column cannot tell "struck" from
//   "never stated"). A term no executed version names has no governing value (null) — the reader never defaults.
//   A superseded value is not deleted: it is returned beside the governing one as a CONFLICT, so closing compliance can say
//   "the contract said the buyer pays the owner's policy; the executed counter moved it to the seller".

import { CONTRACT_TERM_COLUMNS } from "@/lib/transactions/contract-terms"
// THE ONE DEFINITION of "fully executed by both buyer and seller" (CLAUDE.md §6) — the predicate every creation gate refuses on.
// Imported so a row the gates call executed can never be a row whose terms nobody governs (wave 144, lane 144C: see isExecutedOfferRow).
import { isOfferFullyExecuted } from "@/lib/transactions/offer-execution-state"

/**
 * THE GOVERNING TERM VOCABULARY — one spelling per term. The twelve contract-term columns are IMPORTED (never restated);
 * the rest are the terms an offer row carries under a different column name or does not carry at all.
 */
export const GOVERNING_TERM_KEYS = [
  ...CONTRACT_TERM_COLUMNS,
  "offer_price",
  "closing_date",
  "earnest_money",
  "earnest_money_due_days",
  "contingencies",
  // commission — the offers.disclosed_* columns, named for what they are
  "buyer_agent_commission_pct",
  "buyer_agent_commission_flat",
  "commission_payer",
  // not offer columns: only a recorded version (an addendum, an amendment, a confirmed counter reading) can name them
  "title_policy_payer",
  "title_company",
  // WAVE 152 (lane 152E — owner: "compliance also need to compare terms besides reading documents"; directive 152E names
  // property + parties, repairs / holdbacks / escrow and special conditions as governed terms). The property is an offers
  // column (COUNTER_CARRIED_COLUMNS); the rest only an executed addendum / amendment (or a confirmed reading) can name — before
  // this an executed repair-credit or party-change addendum was REFUSED by the recorder as "not contract terms in the vocabulary".
  "property_address",
  "buyer_names",
  "seller_names",
  "repair_credit",
  "repair_holdback",
  "special_conditions",
] as const
export type GoverningTermKey = (typeof GOVERNING_TERM_KEYS)[number]

/**
 * The governing terms an `offers` row does NOT carry under the same name — the ONE reader (governing-terms.ts) selects every
 * other key as an offers column, so a key added here can never become a column the database refuses (42703) and turn every
 * governing read into a refused read.
 */
export const NOT_OFFER_COLUMN_TERM_KEYS: ReadonlySet<GoverningTermKey> = new Set<GoverningTermKey>([
  "title_policy_payer", "title_company", "buyer_agent_commission_pct", "buyer_agent_commission_flat", "commission_payer",
  "buyer_names", "seller_names", "repair_credit", "repair_holdback", "special_conditions",
])

/** offers column → governing term key, where the names differ. */
export const OFFER_COLUMN_TO_KEY: Readonly<Record<string, GoverningTermKey>> = {
  disclosed_buyer_commission_pct: "buyer_agent_commission_pct",
  disclosed_buyer_commission_flat: "buyer_agent_commission_flat",
  disclosed_commission_payer: "commission_payer",
}

export const TERM_VERSION_SOURCES = ["offer", "counter", "addendum", "amendment"] as const
export const TERM_VERSION_STATUSES = ["proposed", "executed", "void"] as const
export type TermVersionSource = (typeof TERM_VERSION_SOURCES)[number]
export type TermVersionStatus = (typeof TERM_VERSION_STATUSES)[number]

export interface TermsVersion {
  versionNo: number
  source: TermVersionSource
  status: TermVersionStatus
  offerId: string | null
  documentId: string | null
  executedAt: string | null
  terms: Record<string, unknown>
  /** Who recorded the version and the transaction it anchors to (null on a derived, offer-chain version). */
  recordedBy?: string | null
  transactionId?: string | null
  /** True for a version computed from an `offers` row rather than read from the immutable record. */
  derived: boolean
  /**
   * WAVE 151 (lane 151K — owner: "addenda can happen during the transaction"): the instant the instrument's SIGNED EFFECTIVE
   * LANGUAGE says it takes effect, when it states one apart from its execution (contract_term_versions.evidence.effective_on,
   * read as the end of that day — the same convention the addendum door uses for the execution instant). Null = effective on
   * execution. Precedence is by this instant; see foldTermsByPrecedence.
   */
  effectiveAt?: string | null
  /** WAVE 152 (lane 152E): the recorded version's evidence (contract_term_versions.evidence — term_evidence per changed term,
   *  effective_on, how it was recorded); null on a version derived from an offers row. The term ledger reads it. */
  evidence?: Record<string, unknown> | null
}

// ─── WAVE 151 (lane 151K): PER-TERM SOURCE EVIDENCE ON AN EXECUTED ADDENDUM / AMENDMENT ─────────────────────────────────────
//
// Directive: "extract changed terms with source-page/field evidence". The versioned record (m797) carries a free `evidence`
// jsonb; this is the ONE shape of its `term_evidence` key — one entry per changed term, saying WHERE on the executed document
// the term was read: a deterministic extraction row of that document (lib/transactions/closing-compliance.ts reads the same
// ledger, document_field_extractions), the recording person's stated page / field / quote, or — honestly — neither yet
// ("person_reading_unlocated": recorded, flagged for a human, never invented). Nothing here is a model.

const TERM_EVIDENCE_SOURCES = ["document_extraction", "person_reading", "person_reading_unlocated"] as const
export type TermEvidenceSource = (typeof TERM_EVIDENCE_SOURCES)[number]

export interface TermEvidence {
  source: TermEvidenceSource
  /** The extraction field key or the field the person named (e.g. "price", "closing_date", "Paragraph 7"). */
  field: string | null
  /** The page of the executed document, 1-based, when known. */
  page: number | null
  /** A short verbatim quote from the document, when the person supplied one. */
  quote: string | null
  /** The document's own value for the term as extracted (null when no extraction names it). */
  extracted: unknown
  /** Whether the extraction's value agrees with the recorded term (null = no extraction to compare). */
  agrees: boolean | null
  /** The extraction's confidence ("verified" when a person verified the row), null without one. */
  confidence: string | null
}

/** governing term key → the extraction field keys that state it on a contract / addendum (the same keys closing compliance reads). */
const TERM_EVIDENCE_FIELDS: Readonly<Partial<Record<GoverningTermKey, readonly string[]>>> = {
  offer_price: ["price", "counter_price", "offer_price", "purchase_price", "sales_price"],
  earnest_money: ["earnest_money_amount", "earnest_money", "earnest_money_deposit"],
  closing_date: ["closing_date"],
  closing_cost_contribution: ["seller_concession_amount", "closing_cost_contribution", "seller_credit_to_buyer"],
  title_policy_payer: ["owner_title_policy_payer", "title_policy_payer"],
  property_address: ["property_address"],
}

export interface StatedTermEvidence { page?: number | null; field?: string | null; quote?: string | null }

/** A date, money or party value as a comparable string (null = not comparable in that form). */
function comparableTerm(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : null
  if (typeof v !== "string") return null
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const money = s.replace(/[$,\s]/g, "")
  if (/^-?\d+(\.\d+)?$/.test(money)) return String(Math.round(Number(money) * 100) / 100)
  return s.toLowerCase()
}

/**
 * PURE — the evidence for every CHANGED term of an executed addendum / amendment, from the document's own extraction rows first
 * (ledger rows over the scan blob), the recording person's stated page / field / quote second, and an honest
 * "person_reading_unlocated" otherwise. REFUSED, by name, when a VERIFIED or HIGH-confidence extraction of the same document
 * reads a different value than the term being recorded — the paper and the typed term disagree, and nothing here picks one.
 * A low / medium extraction that disagrees is recorded with `agrees: false` (a question for a person, not an accusation).
 */
export function termEvidenceFor(input: {
  terms: Record<string, unknown>
  extractions: ReadonlyArray<{ field_key: string; field_value_json: unknown; confidence: string | null; verified_at: string | null }>
  scanFields?: Record<string, unknown> | null
  stated?: Record<string, StatedTermEvidence> | null
}): { ok: true; termEvidence: Record<string, TermEvidence>; unlocated: string[] } | { ok: false; reason: string } {
  const out: Record<string, TermEvidence> = {}
  const unlocated: string[] = []
  const blob = input.scanFields && typeof input.scanFields === "object" && !Array.isArray(input.scanFields) ? input.scanFields : {}
  for (const [key, value] of Object.entries(input.terms)) {
    const fields = TERM_EVIDENCE_FIELDS[key as GoverningTermKey] ?? [key]
    let found: TermEvidence | null = null
    for (const f of fields) {
      const row = input.extractions.find((r) => r.field_key === f)
      const raw = row ? row.field_value_json : blob[f]
      if (raw === undefined || raw === null || raw === "") continue
      const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
      const extracted = obj && "value" in obj ? obj.value : raw
      const page = obj && typeof (obj.page ?? obj.page_number) === "number" ? Number(obj.page ?? obj.page_number) : null
      const confidence = row ? (row.verified_at ? "verified" : (row.confidence ?? "low")) : "scan"
      const a = comparableTerm(extracted), b = comparableTerm(value)
      const agrees = a === null || b === null ? null : a === b
      found = { source: "document_extraction", field: f, page, quote: null, extracted, agrees, confidence }
      break
    }
    if (found) {
      if (found.agrees === false && (found.confidence === "verified" || found.confidence === "high")) {
        return { ok: false, reason: `the executed document's ${found.confidence} extraction of ${found.field} reads ${JSON.stringify(found.extracted)} but the term being recorded says ${JSON.stringify(value)} — the paper and the typed term disagree; verify the document before recording` }
      }
      out[key] = found
      continue
    }
    const s = input.stated?.[key]
    const page = typeof s?.page === "number" && Number.isFinite(s.page) && s.page >= 1 ? Math.floor(s.page) : null
    const field = typeof s?.field === "string" && s.field.trim() ? s.field.trim().slice(0, 120) : null
    const quote = typeof s?.quote === "string" && s.quote.trim() ? s.quote.trim().slice(0, 400) : null
    if (page !== null || field || quote) { out[key] = { source: "person_reading", field, page, quote, extracted: null, agrees: null, confidence: null }; continue }
    out[key] = { source: "person_reading_unlocated", field: null, page: null, quote: null, extracted: null, agrees: null, confidence: null }
    unlocated.push(key)
  }
  return { ok: true, termEvidence: out, unlocated }
}

export interface GoverningTerm {
  key: GoverningTermKey
  value: unknown
  versionNo: number
  source: TermVersionSource
  offerId: string | null
  executedAt: string | null
  /** WAVE 152 (lane 152E): the governing instrument's document and signed effective instant (the term ledger names them). */
  documentId?: string | null
  effectiveAt?: string | null
}

export interface TermConflict {
  key: GoverningTermKey
  superseded: { versionNo: number; source: TermVersionSource; value: unknown }
  governing: { versionNo: number; source: TermVersionSource; value: unknown }
}

/**
 * WAVE 151 (lane 151K): two executed instruments of the SAME source (two addenda, two amendments) name one term with
 * different values and NOTHING signed orders them — their effective instants tie (two addenda signed the same day, neither
 * stating an effective date), or the effective language and the signing order contradict each other (the earlier-signed one
 * takes effect later). The term has NO governing value until a person reviews it; the versions are listed, nothing is picked.
 */
export interface UnresolvedTermConflict {
  key: GoverningTermKey
  reason: "same_effective_instant" | "effective_order_contradicts_execution_order"
  versions: Array<{ versionNo: number; source: TermVersionSource; value: unknown; executedAt: string | null; effectiveAt: string | null; documentId: string | null }>
}

export interface GoverningTerms {
  /** key → the governing term, for every term at least one executed version names (an UNRESOLVED term is absent here). */
  terms: Partial<Record<GoverningTermKey, GoverningTerm>>
  /** key → value, for convenience (a term nobody names is absent, never defaulted; an unresolved one is absent too). */
  values: Partial<Record<GoverningTermKey, unknown>>
  /** Earlier executed values a later executed version replaced. */
  conflicts: TermConflict[]
  /** Terms two same-source executed instruments contradict each other on, with nothing signed to order them — review needed. */
  unresolved: UnresolvedTermConflict[]
  /** The newest EXECUTED version in precedence order (the contract as it stands), or null when nothing is executed. */
  governingVersion: { source: TermVersionSource; versionNo: number; offerId: string | null } | null
  /** Every version considered, in order — originals included. Nothing is dropped. */
  versions: TermsVersion[]
  /** Versions that exist but do not govern yet (proposed) — the agent should know a counter is pending. */
  pending: TermsVersion[]
}

const isCanonicalKey = (k: string): k is GoverningTermKey => (GOVERNING_TERM_KEYS as readonly string[]).includes(k)

/** PURE: keep only canonical term keys (an unknown key is dropped by the caller's validation, never silently renamed). */
export function canonicalTerms(raw: Record<string, unknown> | null | undefined): { terms: Record<string, unknown>; unknownKeys: string[] } {
  const terms: Record<string, unknown> = {}
  const unknownKeys: string[] = []
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (isCanonicalKey(k)) terms[k] = v
    else unknownKeys.push(k)
  }
  return { terms, unknownKeys }
}

/**
 * PURE — THE ONE PRECEDENCE FOLD over any versioned term vocabulary (wave 146, lane 146I — closes lane 145B Outside-lane 16:
 * "one precedence function"). The contract rail (below) and the listing-agreement rail (lib/listings/listing-agreement-terms.ts)
 * each held a copy of this loop; both now call it with their own key set and source rank, so the two can never order executions
 * differently. Executed versions only: ordered by executedAt, then the caller's source rank (on a same-instant tie the original
 * precedes what amends it), then versionNo; a version NAMES a term by carrying its key (an explicit null is a strike and
 * governs as null); a later different value supersedes and the earlier one is returned as a conflict, never deleted.
 */
export interface FoldOptions<V> {
  /**
   * WAVE 151 (lane 151K): the instant a version's SIGNED EFFECTIVE LANGUAGE says it takes effect; defaults to its executedAt.
   * Precedence is by this instant ("governing-term precedence by signed effective language"), then the caller's source rank,
   * then versionNo.
   */
  effectiveAt?: (v: V) => string | null | undefined
  /**
   * WAVE 151 (lane 151K): the sources whose version numbers carry NO precedence (an addendum's number is its RECORDING order,
   * not its signing order). Two executed versions of one such source that name one key with different values are UNRESOLVED —
   * neither governs the key — when their effective instants tie, or when their effective order contradicts their execution
   * order. A later instrument whose effective instant is strictly later settles the key again. Sources not listed keep the
   * existing reading (two counters at one instant are ordered by their round, which IS the negotiation order).
   */
  unresolvedTieSources?: readonly string[]
}

export interface FoldUnresolved<K extends string, V> { key: K; reason: "same_effective_instant" | "effective_order_contradicts_execution_order"; versions: Array<{ value: unknown; version: V }> }

export function foldTermsByPrecedence<K extends string, V extends { versionNo: number; executedAt: string | null; source: string; terms: Record<string, unknown> }>(
  executedVersions: readonly V[],
  keys: readonly K[],
  rank: (source: V["source"]) => number,
  opts: FoldOptions<V> = {},
): { ordered: V[]; won: Partial<Record<K, { value: unknown; version: V }>>; conflicts: Array<{ key: K; superseded: { value: unknown; version: V }; governing: { value: unknown; version: V } }>; unresolved: FoldUnresolved<K, V>[] } {
  const eff = (v: V): string => String(opts.effectiveAt?.(v) ?? v.executedAt ?? "")
  const ordered = [...executedVersions].sort((a, b) =>
    eff(a).localeCompare(eff(b)) || String(a.executedAt ?? "").localeCompare(String(b.executedAt ?? "")) || rank(a.source) - rank(b.source) || a.versionNo - b.versionNo)
  const won: Partial<Record<K, { value: unknown; version: V }>> = {}
  const conflicts: Array<{ key: K; superseded: { value: unknown; version: V }; governing: { value: unknown; version: V } }> = []
  const open: Partial<Record<K, FoldUnresolved<K, V>>> = {}
  const tieSources = new Set(opts.unresolvedTieSources ?? [])
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  for (const v of ordered) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(v.terms, key)) continue
      const value = v.terms[key]
      const dispute = open[key]
      if (dispute) {
        // An open dispute on this key: a STRICTLY later effective instant that does not contradict the signing order settles it;
        // anything else joins the dispute (a three-way tie is still a tie).
        const laterThanAll = dispute.versions.every((d) => eff(d.version) < eff(v) && String(d.version.executedAt ?? "") <= String(v.executedAt ?? ""))
        if (!laterThanAll) { dispute.versions.push({ value, version: v }); continue }
        delete open[key]
        for (const d of dispute.versions) if (!same(d.value, value)) conflicts.push({ key, superseded: d, governing: { value, version: v } })
        won[key] = { value, version: v }
        continue
      }
      const prior = won[key]
      if (prior && !same(prior.value, value)) {
        if (tieSources.has(v.source) && prior.version.source === v.source) {
          const effTie = eff(prior.version) === eff(v)
          const execReversed = !!prior.version.executedAt && !!v.executedAt && String(v.executedAt) < String(prior.version.executedAt)
          if (effTie || execReversed) {
            open[key] = { key, reason: effTie ? "same_effective_instant" : "effective_order_contradicts_execution_order", versions: [prior, { value, version: v }] }
            delete won[key]
            continue
          }
        }
        conflicts.push({ key, superseded: prior, governing: { value, version: v } })
      }
      won[key] = { value, version: v }
    }
  }
  return { ordered, won, conflicts, unresolved: Object.values(open) as FoldUnresolved<K, V>[] }
}

/** The end of the stated day — the instant a day-precision effective date takes effect (the addendum door's execution convention). */
export const endOfDayInstant = (day: string | null | undefined): string | null => (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T23:59:59.999Z` : null)

/**
 * PURE — THE PRECEDENCE RULE. See the header. `versions` may arrive in any order and may mix derived and recorded rows;
 * a `void` version is ignored, a `proposed` one never governs (it is reported under `pending`).
 *
 * WAVE 151 (lane 151K): precedence is by SIGNED EFFECTIVE LANGUAGE (`effectiveAt`, else the execution instant). Two executed
 * ADDENDA (or two AMENDMENTS) that contradict each other on one term with nothing signed to order them are reported under
 * `unresolved` — the term has no governing value until a person reviews it; nothing is invented from their version numbers.
 */
export function resolveGoverningTerms(versions: TermsVersion[]): GoverningTerms {
  const ordered = [...versions].sort((a, b) => a.versionNo - b.versionNo)
  // Two executions at the SAME instant (a day-precision addendum date, a bulk snapshot) are ordered by what each one IS: the
  // original, then its counters, then an addendum, then an amendment — an addendum amends a contract that already exists, so on a
  // tie it follows. Version numbers are per-source sequences and cannot be compared across sources.
  const rank = (s: TermVersionSource) => (TERM_VERSION_SOURCES as readonly string[]).indexOf(s)
  const fold = foldTermsByPrecedence(ordered.filter((v) => v.status === "executed"), GOVERNING_TERM_KEYS, rank, {
    effectiveAt: (v) => v.effectiveAt ?? v.executedAt,
    unresolvedTieSources: ["addendum", "amendment"],
  })
  const executed = fold.ordered
  const terms: GoverningTerms["terms"] = {}
  for (const key of Object.keys(fold.won) as GoverningTermKey[]) {
    const w = fold.won[key]!
    terms[key] = { key, value: w.value, versionNo: w.version.versionNo, source: w.version.source, offerId: w.version.offerId, executedAt: w.version.executedAt, documentId: w.version.documentId ?? null, effectiveAt: w.version.effectiveAt ?? null }
  }
  const conflicts: TermConflict[] = fold.conflicts.map((c) => ({
    key: c.key,
    superseded: { versionNo: c.superseded.version.versionNo, source: c.superseded.version.source, value: c.superseded.value },
    governing: { versionNo: c.governing.version.versionNo, source: c.governing.version.source, value: c.governing.value },
  }))
  const unresolved: UnresolvedTermConflict[] = fold.unresolved.map((u) => ({
    key: u.key, reason: u.reason,
    versions: u.versions.map((d) => ({ versionNo: d.version.versionNo, source: d.version.source, value: d.value, executedAt: d.version.executedAt, effectiveAt: d.version.effectiveAt ?? null, documentId: d.version.documentId })),
  }))
  const values: GoverningTerms["values"] = {}
  for (const k of Object.keys(terms) as GoverningTermKey[]) values[k] = terms[k]!.value
  return {
    terms, values, conflicts, unresolved,
    governingVersion: executed.length ? { source: executed[executed.length - 1].source, versionNo: executed[executed.length - 1].versionNo, offerId: executed[executed.length - 1].offerId } : null,
    versions: ordered,
    pending: ordered.filter((v) => v.status === "proposed"),
  }
}

// ─── WAVE 152 (lane 152E): THE PER-TRANSACTION TERM LEDGER — a READ of the governing terms, not another summary ───────────
//
// Owner (verbatim): "compliance also need to compare terms besides reading documents." Directive 152E: "for each governed term,
// show source document/version, signed effective date, party signatures, page/section/quote, prior value, new value and
// authority … do not use highest version number alone". This is that read, PURE, over the ONE precedence result above
// (resolveGoverningTerms) — it decides nothing the resolver did not: a proposed version is listed as pending and NEVER governs,
// an unresolved tie has no value and lists its contenders, a superseded value is the prior value beside the governing one.
// The I/O half (governing-terms.ts contractTermLedger) hands in each source document's signature reading; closing compliance
// (lib/transactions/closing-compliance.ts) reads the rows to hold a term whose executed source was never located on the page.

/** Every governed term in exactly one of the directive's groups (module-private: the rows carry their group). */
const TERM_LEDGER_GROUPS: ReadonlyArray<{ key: string; label: string; terms: readonly GoverningTermKey[] }> = [
  { key: "property_and_parties", label: "Property and parties", terms: ["property_address", "buyer_names", "seller_names"] },
  { key: "price_and_financing", label: "Price and financing", terms: ["offer_price", "financing_type", "down_payment_amount", "down_payment_percent", "escalation_clause", "escalation_cap", "appraisal_gap"] },
  { key: "deposits_and_credits", label: "Earnest money, deposits and credits", terms: ["earnest_money", "earnest_money_due_days", "due_diligence_fee", "closing_cost_contribution", "repair_credit"] },
  { key: "costs_by_party", label: "Seller-paid and buyer-paid costs", terms: ["title_policy_payer", "title_company", "commission_payer"] },
  { key: "deadlines", label: "Inspection, appraisal and financing deadlines", terms: ["inspection_period_days", "appraisal_contingency_days", "financing_contingency_days", "contingencies"] },
  { key: "closing", label: "Closing date and possession", terms: ["closing_date", "possession_terms"] },
  { key: "repairs_and_conditions", label: "Repairs, holdbacks, escrow and special conditions", terms: ["repair_holdback", "special_conditions"] },
  { key: "commission", label: "Commission (buyer side, as the contract states it)", terms: ["buyer_agent_commission_pct", "buyer_agent_commission_flat"] },
]

export interface TermLedgerRow {
  key: GoverningTermKey
  group: string
  status: "governing" | "unresolved" | "proposed_only"
  /** The governing value (null when unresolved or only proposed — never a guess). */
  value: unknown
  /** The executed value the governing instrument replaced; undefined when nothing was replaced. */
  priorValue?: unknown
  /** The governing instrument (null when nothing executed names the term). */
  source: { kind: TermVersionSource; versionNo: number; documentId: string | null; offerId: string | null } | null
  executedAt: string | null
  /** The instant the instrument's signed effective language makes it effective (null = on execution). */
  effectiveAt: string | null
  /** The governing instrument's document reading — which parties signed, which did not (null: an offers-row instrument). */
  signatures: { signed: string[]; missing: string[] } | null
  /** Where on the executed document the term was read (the recorded per-term evidence), or null when none was recorded. */
  evidence: TermEvidence | null
  /** In words: what makes this value the governing one. */
  authority: string
  recordedBy: string | null
  /** Proposed (unsigned) versions naming the term — listed, NEVER governing. */
  pending: Array<{ versionNo: number; source: TermVersionSource; value: unknown; documentId: string | null }>
  /** The contenders when two executed instruments contradict each other and nothing signed orders them. */
  unresolved: UnresolvedTermConflict["versions"] | null
}

export interface TermLedger {
  rows: TermLedgerRow[]
  /** Groups no executed, proposed or disputed version states at all — said, never defaulted. */
  notStated: Array<{ group: string; label: string }>
  /** How the executed contract words its closing date (transactions.contract_closing_terms), when the deal has read it. */
  closingWording: "on" | "on_or_before" | null
}

const groupOf = (key: GoverningTermKey): string => TERM_LEDGER_GROUPS.find((g) => g.terms.includes(key))?.key ?? "other"

/**
 * PURE — the term ledger of one contract. `signaturesByDocument` maps a source document id to its signature_completeness
 * reading (the same shape the recorder reads); a document absent from it reads `signatures: null` (not read), never "signed".
 */
export function buildTermLedger(
  governing: GoverningTerms,
  signaturesByDocument: Readonly<Record<string, unknown>> = {},
  opts: { closingWording?: string | null } = {},
): TermLedger {
  const versionOf = (source: TermVersionSource, versionNo: number, offerId: string | null) =>
    governing.versions.find((v) => v.source === source && v.versionNo === versionNo && (v.offerId ?? null) === (offerId ?? null) && v.status === "executed")
  const sigs = (documentId: string | null): TermLedgerRow["signatures"] =>
    documentId && Object.prototype.hasOwnProperty.call(signaturesByDocument, documentId) ? signaturesPresent(signaturesByDocument[documentId], ["buyer", "seller"]) : null
  const evidenceOf = (v: TermsVersion | undefined, key: string): TermEvidence | null => {
    const te = (v?.evidence as { term_evidence?: Record<string, TermEvidence> } | null | undefined)?.term_evidence
    return te && typeof te === "object" && te[key] ? te[key] : null
  }
  const pendingFor = (key: string) => governing.pending.filter((p) => Object.prototype.hasOwnProperty.call(p.terms, key))
    .map((p) => ({ versionNo: p.versionNo, source: p.source, value: p.terms[key], documentId: p.documentId }))
  const named = new Set<GoverningTermKey>()
  const rows: TermLedgerRow[] = []
  for (const key of GOVERNING_TERM_KEYS) {
    const t = governing.terms[key]
    const u = governing.unresolved.find((x) => x.key === key)
    const pending = pendingFor(key)
    if (!t && !u && pending.length === 0) continue
    named.add(key)
    if (t) {
      const v = versionOf(t.source, t.versionNo, t.offerId)
      const replaced = [...governing.conflicts].reverse().find((c) => c.key === key && c.governing.versionNo === t.versionNo && c.governing.source === t.source)
      const documentId = t.documentId ?? v?.documentId ?? null
      const signatures = sigs(documentId)
      const authority = documentId
        ? `executed ${t.source} ${t.versionNo} (document ${documentId})${signatures ? (signatures.missing.length ? ` — the document does NOT show ${signatures.missing.join(" and ")} signed` : " — signed by buyer and seller") : ""}`
        : v?.derived
          ? `the executed ${t.source === "offer" ? "offer" : `counter (round ${t.versionNo})`} — both parties' signatures on the offer record`
          : `executed ${t.source} ${t.versionNo} frozen in the terms record`
      rows.push({
        key, group: groupOf(key), status: "governing", value: t.value, ...(replaced ? { priorValue: replaced.superseded.value } : {}),
        source: { kind: t.source, versionNo: t.versionNo, documentId, offerId: t.offerId }, executedAt: t.executedAt, effectiveAt: t.effectiveAt ?? v?.effectiveAt ?? null,
        signatures, evidence: evidenceOf(v, key), authority, recordedBy: v?.recordedBy ?? null, pending, unresolved: null,
      })
      continue
    }
    if (u) {
      rows.push({
        key, group: groupOf(key), status: "unresolved", value: null, source: null, executedAt: null, effectiveAt: null, signatures: null, evidence: null,
        authority: `NO governing value — ${u.versions.length} executed ${u.versions[0]?.source ?? "instrument"}s contradict each other (${u.reason === "same_effective_instant" ? "same effective instant" : "effective language contradicts the signing order"}); the responsible licensed professional or closing attorney decides which governs`,
        recordedBy: null, pending, unresolved: u.versions,
      })
      continue
    }
    rows.push({
      key, group: groupOf(key), status: "proposed_only", value: null, source: null, executedAt: null, effectiveAt: null, signatures: null, evidence: null,
      authority: "only PROPOSED (unsigned) versions name this term — a proposal never governs until both parties sign it", recordedBy: null, pending, unresolved: null,
    })
  }
  const notStated = TERM_LEDGER_GROUPS.filter((g) => !g.terms.some((k) => named.has(k))).map((g) => ({ group: g.key, label: g.label }))
  const w = opts.closingWording
  return { rows, notStated, closingWording: w === "on" || w === "on_or_before" ? w : null }
}

// ─── deriving versions from the offer chain (the existing, versioned, never-mutated store) ───────────────

export interface OfferRowForTerms {
  id: string
  parent_offer_id?: string | null
  offer_type?: string | null
  current_round?: number | null
  status?: string | null
  esign_status?: string | null
  buyer_signed_at?: string | null
  seller_signed_at?: string | null
  seller_response_type?: string | null
  transaction_id?: string | null
  fully_signed_contract_received_at?: string | null
  esign_completed_at?: string | null
  responded_at?: string | null
  created_at?: string | null
  [column: string]: unknown
}

/**
 * PURE: is this offers row an EXECUTED contract — accepted AND signed by both parties, or the ladder says fully_executed?
 * `countered` counts when the signatures are there: issueCounterOffer flips the PARENT to `countered` even when that parent was
 * already an executed contract (lib/kernel/offers.ts: "the original … stays part of the executed contract"), so the status alone
 * cannot say. A negotiation-stage root that was merely countered has no seller signature on it and is not executed.
 *
 * WAVE 144 (lane 144C) — THE TWO READINGS OF "EXECUTED" NOW AGREE. This predicate read only `status` + signatures, while every
 * creation gate reads the ONE definition (lib/transactions/offer-execution-state.ts isOfferFullyExecuted: buyer_signed_at + the
 * fully-signed contract on file by an admissible path). They disagreed on a real writer: lib/forms/esign-execution-loop.ts stamps a
 * completed envelope `fully_signed` with both signatures and the contract on file but never sets `status` — so the gates created a
 * transaction from a counter whose terms this rule called merely "proposed", the freeze recorded nothing, and closing compliance had
 * no governing terms. A row the ONE definition calls fully executed is now executed here too (unless it is void). The older
 * admissions are kept, so nothing that governed before stops governing.
 */
const VOID_OFFER_STATUSES = new Set(["rejected", "withdrawn", "voided", "expired"])
const isVoidOfferRow = (row: OfferRowForTerms) => VOID_OFFER_STATUSES.has(String(row.status ?? ""))
function isExecutedOfferRow(row: OfferRowForTerms): boolean {
  if (isVoidOfferRow(row)) return false
  if (isOfferFullyExecuted(row)) return true
  if (row.status !== "accepted" && row.status !== "countered") return false
  if (row.esign_status === "fully_executed") return true
  return !!row.fully_signed_contract_received_at || (!!row.buyer_signed_at && !!row.seller_signed_at)
}

/** PURE: when the row became an executed contract (the latest of the evidence dates; created_at as the floor). */
function executedAtOf(row: OfferRowForTerms): string | null {
  const dates = [row.fully_signed_contract_received_at, row.esign_completed_at, row.responded_at, row.seller_signed_at, row.buyer_signed_at].filter((d): d is string => typeof d === "string" && d.length > 0)
  if (dates.length) return [...dates].sort().slice(-1)[0]
  return typeof row.created_at === "string" ? row.created_at : null
}

/** PURE: the terms an offers row NAMES — only columns that hold a value (null cannot be told from "never stated"). */
function termsFromOfferRow(row: OfferRowForTerms): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of GOVERNING_TERM_KEYS) {
    const value = row[key]
    if (value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)) out[key] = value
  }
  for (const [column, key] of Object.entries(OFFER_COLUMN_TO_KEY)) {
    const value = row[column]
    if (value !== null && value !== undefined) out[key] = value
  }
  return out
}

/**
 * PURE: one version per chain row — the root is version 1 `offer`, every counter row a `counter` at its round.
 *
 * AN EXECUTED COUNTER INCORPORATES ITS CHAIN: a counter changes some terms of the offer it answers and carries the rest, and the
 * original "stays part of the executed contract" (lib/kernel/offers.ts). So every ancestor of an executed row that was not itself
 * executed (and not withdrawn / rejected) becomes an EXECUTED layer at the moment its nearest executed descendant executed —
 * which is what lets a term only the original names (the commission disclosure, which counters do not carry) survive under the
 * counter, while precedence (latest executed, then higher version) still gives every changed term to the counter.
 */
export function versionsFromOfferChain(rows: OfferRowForTerms[]): TermsVersion[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const void_ = isVoidOfferRow
  const incorporatedAt = new Map<string, string>() // ancestor id → the earliest executedAt among its executed descendants
  for (const r of rows) {
    if (!isExecutedOfferRow(r)) continue
    const at = executedAtOf(r) ?? ""
    let cur = r.parent_offer_id ? byId.get(r.parent_offer_id) : undefined
    for (let i = 0; cur && i < 25; i++) {
      if (!isExecutedOfferRow(cur) && !void_(cur)) {
        const prev = incorporatedAt.get(cur.id)
        if (prev === undefined || at < prev) incorporatedAt.set(cur.id, at)
      }
      cur = cur.parent_offer_id ? byId.get(cur.parent_offer_id) : undefined
    }
  }
  return rows.map((r) => {
    const executed = isExecutedOfferRow(r)
    const incorporated = !executed && incorporatedAt.has(r.id)
    return {
      versionNo: r.parent_offer_id ? Math.max(2, r.current_round ?? 2) : 1,
      source: (r.parent_offer_id || r.offer_type === "counter" ? "counter" : "offer") as TermVersionSource,
      status: (executed || incorporated ? "executed" : void_(r) ? "void" : "proposed") as TermVersionStatus,
      offerId: r.id,
      documentId: null,
      executedAt: executed ? executedAtOf(r) : incorporated ? (incorporatedAt.get(r.id) as string) : null,
      terms: termsFromOfferRow(r),
      derived: true,
    }
  })
}

/**
 * PURE: merge recorded versions with the ones derived from the offers chain, per offers row.
 *   · a recorded EXECUTED row is the immutable snapshot — it stands exactly as written (offers rows stay editable);
 *   · a recorded PROPOSED row carries a person-confirmed term set (a received counter, a buyer counter-back): its TERMS win
 *     over the row's columns, but WHETHER it is executed follows the offers row (so the counter governs the moment it executes);
 *   · a recorded VOID row stands;
 *   · a derived version with no recorded twin is used as it is.
 */
export function mergeVersions(recorded: TermsVersion[], derived: TermsVersion[]): TermsVersion[] {
  const derivedByOffer = new Map(derived.filter((d) => d.offerId).map((d) => [d.offerId as string, d]))
  const recordedOffers = new Set(recorded.map((r) => r.offerId).filter((x): x is string => !!x))
  const merged = recorded.map((r) => {
    const twin = r.offerId ? derivedByOffer.get(r.offerId) : undefined
    if (!twin || r.status === "executed" || r.status === "void") return r
    return { ...r, versionNo: twin.versionNo, terms: { ...twin.terms, ...r.terms }, status: twin.status, executedAt: twin.executedAt ?? r.executedAt }
  })
  return [...merged, ...derived.filter((d) => !d.offerId || !recordedOffers.has(d.offerId))]
}

// ─── THE ACCEPTED SEQUENCE — which instruments ARE the executed contract (wave 144, lane 144C) ─────────────────────────────
//
// Owner (wave 144, ruling 2, verbatim essentials): "If a counter is present and accepted, the ORIGINAL OFFER + the ACCEPTED COUNTER
// (+ required addenda) together are the executed contract; BOTH go through the compliance scan before anything becomes a transaction.
// Keep every document/version (the counter never replaces the original). Unaccepted counters never become terms. With several
// counters, the authoritative terms come from the actually accepted sequence, not the latest draft."
//
// The TERMS half of that already held (resolveGoverningTerms: proposed never governs; an executed counter incorporates its
// ancestors). What no code said was WHICH ROWS the compliance scan must read, so the creation gate and the compliance checkpoint read
// only the one submitted row's paperwork — the original offer's documents (filed against the root) were never scanned when a
// counter executed, and a rejected sibling counter's paperwork, when it rode in on the contact link, was judged as if it were part
// of the contract. This is that rule, pure, using the SAME executed / void readings as the terms above — one rule, two consumers.

/** Why a chain row is NOT part of the executed contract. It is kept (every version is kept) — it is just never terms. */
export type SequenceExclusion = "void" | "not_accepted" | "after_execution"

export interface AcceptedOfferSequence {
  rootOfferId: string
  /** The executed instrument the contract resolved to — the row being promoted. */
  headOfferId: string
  /** root → … → head in negotiation order: the original offer, each counter it answered, the accepted counter. Void ancestors excluded. */
  sequence: string[]
  /** Every other row of the chain and why it is not part of the contract. */
  excluded: Array<{ offerId: string; reason: SequenceExclusion }>
  /** Transactions already created from ANY row of the chain (one executed contract → ONE transaction). */
  transactionIds: string[]
}

export type AcceptedSequenceRefusal = "unknown_offer" | "not_executed" | "later_execution" | "competing_execution" | "broken_chain"

/** PURE: the path from the chain root down to `offerId` (root first), or null when a parent link leaves the rows given. */
function chainPathTo(rows: OfferRowForTerms[], offerId: string): string[] | null {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const path: string[] = []
  let cur = byId.get(offerId)
  for (let i = 0; cur && i < 25; i++) {
    path.unshift(cur.id)
    if (!cur.parent_offer_id) return path
    const next = byId.get(cur.parent_offer_id)
    if (!next) return null
    cur = next
  }
  return null
}

/**
 * PURE: the instruments a head INCORPORATES — its path from the root, minus void ancestors (a withdrawn / rejected / expired row on
 * the way is not part of the contract; the head itself is always kept). The same reading versionsFromOfferChain applies to terms.
 * null when the path leaves the rows given.
 */
export function sequenceThrough(rows: OfferRowForTerms[], headOfferId: string): string[] | null {
  const path = chainPathTo(rows, headOfferId)
  if (!path) return null
  const byId = new Map(rows.map((r) => [r.id, r]))
  return path.filter((id) => id === headOfferId || !isVoidOfferRow(byId.get(id)!))
}

/**
 * PURE — THE ACCEPTED SEQUENCE for the row being promoted. Refused, by name, when: the row is not in the chain; it is not executed
 * (same reading as the terms rule); a LATER instrument below it executed (promote that one — it is the contract as it stands);
 * another branch of the same chain also executed (two contracts cannot both be the deal — a person must say which was accepted);
 * or a parent link points outside the rows read. Nothing is guessed and nothing is dropped: every non-sequence row is reported.
 */
export function acceptedOfferSequence(
  rows: OfferRowForTerms[],
  offerId: string,
): { ok: true; sequence: AcceptedOfferSequence } | { ok: false; code: AcceptedSequenceRefusal; reason: string; offerIds: string[] } {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const head = byId.get(offerId)
  if (!head) return { ok: false, code: "unknown_offer", reason: "the offer is not in the chain that was read", offerIds: [offerId] }
  if (!isExecutedOfferRow(head)) {
    return { ok: false, code: "not_executed", reason: isVoidOfferRow(head) ? `the offer is ${head.status} — a void instrument is never the contract` : "the offer is not executed by both buyer and seller", offerIds: [offerId] }
  }
  const path = chainPathTo(rows, offerId)
  if (!path) return { ok: false, code: "broken_chain", reason: "a counter in this chain points at an offer that could not be read — the chain is incomplete", offerIds: [offerId] }
  const onPath = new Set(path)
  // descendants of the head (anything whose path runs through it)
  const below = new Set<string>()
  for (const r of rows) {
    if (r.id === offerId) continue
    const p = chainPathTo(rows, r.id)
    if (p && p.includes(offerId)) below.add(r.id)
  }
  const laterExecuted = [...below].filter((id) => isExecutedOfferRow(byId.get(id)!))
  if (laterExecuted.length) return { ok: false, code: "later_execution", reason: `a later instrument in this chain executed after it (${laterExecuted.join(", ")}) — that one is the contract as it stands`, offerIds: laterExecuted }
  const competing = rows.filter((r) => !onPath.has(r.id) && !below.has(r.id) && isExecutedOfferRow(r)).map((r) => r.id)
  if (competing.length) return { ok: false, code: "competing_execution", reason: `another branch of this chain also reads as executed (${competing.join(", ")}) — a person must say which counter was actually accepted`, offerIds: competing }
  const sequence = sequenceThrough(rows, offerId) ?? [offerId]
  const inSequence = new Set(sequence)
  const excluded = rows.filter((r) => !inSequence.has(r.id)).map((r) => ({
    offerId: r.id,
    reason: (isVoidOfferRow(r) ? "void" : below.has(r.id) ? "after_execution" : "not_accepted") as SequenceExclusion,
  }))
  const transactionIds = [...new Set(rows.map((r) => r.transaction_id).filter((t): t is string => typeof t === "string" && t.length > 0))]
  return { ok: true, sequence: { rootOfferId: path[0], headOfferId: offerId, sequence, excluded, transactionIds } }
}

/** PURE: signatures-only evidence — which of `parties` have a `signed === true` signature on a document's reading. (Initials are the compliance gate's question, not this record's.) */
export function signaturesPresent(signatureCompleteness: unknown, parties: readonly string[]): { signed: string[]; missing: string[] } {
  const sc = signatureCompleteness && typeof signatureCompleteness === "object" && !Array.isArray(signatureCompleteness) ? (signatureCompleteness as { signatures?: Array<{ signer_role?: string | null; signed?: unknown }> }) : {}
  const sigs = Array.isArray(sc.signatures) ? sc.signatures : []
  const has = (p: string) => sigs.some((s) => String(s?.signer_role ?? "").trim().toLowerCase() === p && s?.signed === true)
  return { signed: parties.filter(has), missing: parties.filter((p) => !has(p)) }
}
