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
] as const
export type GoverningTermKey = (typeof GOVERNING_TERM_KEYS)[number]

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
}

export interface GoverningTerm {
  key: GoverningTermKey
  value: unknown
  versionNo: number
  source: TermVersionSource
  offerId: string | null
  executedAt: string | null
}

export interface TermConflict {
  key: GoverningTermKey
  superseded: { versionNo: number; source: TermVersionSource; value: unknown }
  governing: { versionNo: number; source: TermVersionSource; value: unknown }
}

export interface GoverningTerms {
  /** key → the governing term, for every term at least one executed version names. */
  terms: Partial<Record<GoverningTermKey, GoverningTerm>>
  /** key → value, for convenience (a term nobody names is absent, never defaulted). */
  values: Partial<Record<GoverningTermKey, unknown>>
  /** Earlier executed values a later executed version replaced. */
  conflicts: TermConflict[]
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
 * PURE — THE PRECEDENCE RULE. See the header. `versions` may arrive in any order and may mix derived and recorded rows;
 * a `void` version is ignored, a `proposed` one never governs (it is reported under `pending`).
 */
export function resolveGoverningTerms(versions: TermsVersion[]): GoverningTerms {
  const ordered = [...versions].sort((a, b) => a.versionNo - b.versionNo)
  // Two executions at the SAME instant (a day-precision addendum date, a bulk snapshot) are ordered by what each one IS: the
  // original, then its counters, then an addendum, then an amendment — an addendum amends a contract that already exists, so on a
  // tie it follows. Version numbers are per-source sequences and cannot be compared across sources.
  const rank = (s: TermVersionSource) => (TERM_VERSION_SOURCES as readonly string[]).indexOf(s)
  const executed = ordered
    .filter((v) => v.status === "executed")
    .sort((a, b) => String(a.executedAt ?? "").localeCompare(String(b.executedAt ?? "")) || rank(a.source) - rank(b.source) || a.versionNo - b.versionNo)
  const terms: GoverningTerms["terms"] = {}
  const conflicts: TermConflict[] = []
  for (const v of executed) {
    for (const key of GOVERNING_TERM_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(v.terms, key)) continue
      const value = v.terms[key]
      const prior = terms[key]
      if (prior && JSON.stringify(prior.value) !== JSON.stringify(value)) {
        conflicts.push({ key, superseded: { versionNo: prior.versionNo, source: prior.source, value: prior.value }, governing: { versionNo: v.versionNo, source: v.source, value } })
      }
      terms[key] = { key, value, versionNo: v.versionNo, source: v.source, offerId: v.offerId, executedAt: v.executedAt }
    }
  }
  const values: GoverningTerms["values"] = {}
  for (const k of Object.keys(terms) as GoverningTermKey[]) values[k] = terms[k]!.value
  return {
    terms, values, conflicts,
    governingVersion: executed.length ? { source: executed[executed.length - 1].source, versionNo: executed[executed.length - 1].versionNo, offerId: executed[executed.length - 1].offerId } : null,
    versions: ordered,
    pending: ordered.filter((v) => v.status === "proposed"),
  }
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
