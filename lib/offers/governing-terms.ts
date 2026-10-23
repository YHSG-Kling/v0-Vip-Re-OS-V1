// lib/offers/governing-terms.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CONTRACT PRECEDENCE — ONE reader of "what do the contract terms say NOW" (wave 143, lane 143A).
//
// Owner (wave 143, verbatim): "CLOSING compliance also checks that commission and contract terms match the settlement (which
// party pays the title owner's policy, etc.); a counter supersedes the contract terms." Brief: a versioned authoritative terms
// record; an executed counter/addendum supersedes inconsistent earlier terms; originals preserved; closing compliance (lane B)
// reads the governing terms through ONE reader, `governingContractTerms(transactionId | offerId)`.
//
// ── AUDIT (CLAUDE.md §1) ────────────────────────────────────────────────────────────────────────
//   BUILT   the term vocabulary: lib/transactions/contract-terms.ts CONTRACT_TERM_COLUMNS (the twelve terms an offer, a
//           counter and a transaction all carry, same names) and COUNTER_CARRIED_COLUMNS — extended here, not re-listed.
//   BUILT   the versioned chain: every counter is a NEW `offers` row (parent_offer_id, current_round, the carried terms) and
//           the original is never mutated — "originals preserved" already holds for offers and counters.
//   MISSING (built here) (a) the PRECEDENCE RULE as a function — nothing said which executed version governs which term;
//           (b) a durable, immutable record of the terms at execution (offers rows are editable; a dispute needs what was
//           signed); (c) a home for ADDENDA and AMENDMENTS, which have no structured store anywhere (documents hold the PDF,
//           not the terms); (d) terms that are not offer columns at all (WHO PAYS THE OWNER'S TITLE POLICY).
//
// ── THE RULE lives in lib/offers/governing-terms-rule.ts (pure; precedence, versions from the offers chain, the merge). This file is the I/O half:
//   the ONE reader, the recorder (an executed version only from a document that shows BOTH signatures) and the promotion freeze.
//
// Not server-only: every read is behind an injected client, so a plain tsx guard drives it on the in-memory client.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  GOVERNING_TERM_KEYS, OFFER_COLUMN_TO_KEY, TERM_VERSION_SOURCES, TERM_VERSION_STATUSES, canonicalTerms, mergeVersions, resolveGoverningTerms,
  signaturesPresent, versionsFromOfferChain,
  type GoverningTerms, type OfferRowForTerms, type TermVersionSource, type TermVersionStatus, type TermsVersion,
} from "./governing-terms-rule"

type Svc = SupabaseClient<any, any, any>

// ─── I/O: the ONE reader and the writers ────────────────────────────────────────────────────────────────

const OFFER_COLS = ["id", "parent_offer_id", "offer_type", "current_round", "status", "esign_status", "buyer_signed_at", "seller_signed_at", "fully_signed_contract_received_at", "esign_completed_at", "responded_at", "created_at", "transaction_id", ...GOVERNING_TERM_KEYS.filter((k) => !["title_policy_payer", "title_company", "buyer_agent_commission_pct", "buyer_agent_commission_flat", "commission_payer"].includes(k)), ...Object.keys(OFFER_COLUMN_TO_KEY)].join(", ")

/** Walk each anchor offer up to its chain root, then gather every descendant (counters hang off the row they counter, so the chain is deeper than one level). Tenant-pinned; a refused read is a returned reason. */
async function collectChain(svc: Svc, brokerageId: string, anchorIds: string[]): Promise<
  | { ok: true; roots: Set<string>; rows: Map<string, OfferRowForTerms>; transactionId: string | null }
  | { ok: false; reason: string }
> {
  const roots = new Set<string>()
  const rows = new Map<string, OfferRowForTerms>()
  let transactionId: string | null = null
  for (const id of anchorIds) {
    let cur = id
    for (let i = 0; i < 20; i++) {
      const { data, error } = await svc.from("offers").select(OFFER_COLS).eq("id", cur).eq("brokerage_id", brokerageId).maybeSingle()
      if (error) return { ok: false, reason: `offer read refused: ${error.message}` }
      if (!data) { if (i === 0) return { ok: false, reason: "no such offer in this brokerage" }; break }
      const row = data as unknown as OfferRowForTerms
      rows.set(row.id, row)
      if (!row.parent_offer_id) { roots.add(row.id); break }
      cur = row.parent_offer_id
    }
  }
  let frontier = [...roots]
  for (let depth = 0; depth < 20 && frontier.length > 0; depth++) {
    const { data, error } = await svc.from("offers").select(OFFER_COLS).in("parent_offer_id", frontier).eq("brokerage_id", brokerageId)
    if (error) return { ok: false, reason: `offer chain read refused: ${error.message}` }
    const kids = (data ?? []) as unknown as OfferRowForTerms[]
    for (const k of kids) rows.set(k.id, k)
    frontier = kids.map((k) => k.id)
  }
  for (const r of rows.values()) if (typeof r.transaction_id === "string") { transactionId = r.transaction_id; break }
  return { ok: true, roots, rows, transactionId }
}

export type GoverningRef = { transactionId: string; offerId?: undefined } | { offerId: string; transactionId?: undefined }

/**
 * THE ONE READER — `governingContractTerms(transactionId | offerId)`. Closing compliance (and anything else that asks
 * "what does the contract say now") calls this and nothing else. Tenant-pinned; a refused read is a returned reason, never an
 * empty "no terms" (supabase-js resolves refusals, CLAUDE.md §3).
 */
export async function governingContractTerms(
  svc: Svc,
  brokerageId: string,
  ref: GoverningRef,
): Promise<{ ok: true; rootOfferId: string | null; transactionId: string | null; governing: GoverningTerms } | { ok: false; reason: string }> {
  if (!brokerageId) return { ok: false, reason: "no tenant: the governing terms were not read" }
  // 1 · find the anchor offer row(s)
  let anchorIds: string[] = []
  let transactionId: string | null = ref.transactionId ?? null
  if (ref.transactionId) {
    const { data, error } = await svc.from("offers").select("id").eq("brokerage_id", brokerageId).eq("transaction_id", ref.transactionId)
    if (error) return { ok: false, reason: `offers read refused: ${error.message}` }
    anchorIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  } else if (ref.offerId) {
    anchorIds = [ref.offerId]
  }
  // 2 · walk each anchor to its chain root and gather every row of the chain (originals included)
  const collected = await collectChain(svc, brokerageId, anchorIds)
  if (!collected.ok) return collected
  const { roots, rows: chainRows } = collected
  if (!transactionId) transactionId = collected.transactionId
  // 3 · the immutable record
  const rootList = [...roots]
  let recorded: TermsVersion[] = []
  {
    const filters: string[] = []
    if (rootList.length) filters.push(`root_offer_id.in.(${rootList.join(",")})`)
    if (transactionId) filters.push(`transaction_id.eq.${transactionId}`)
    if (filters.length) {
      const { data, error } = await svc.from("contract_term_versions").select("version_no, source, status, offer_id, document_id, executed_at, terms").eq("brokerage_id", brokerageId).or(filters.join(","))
      if (error) return { ok: false, reason: `contract_term_versions read refused: ${error.message}` }
      recorded = ((data ?? []) as Array<Record<string, any>>).map((r) => ({
        versionNo: Number(r.version_no), source: r.source as TermVersionSource, status: r.status as TermVersionStatus,
        offerId: (r.offer_id as string | null) ?? null, documentId: (r.document_id as string | null) ?? null,
        executedAt: (r.executed_at as string | null) ?? null, terms: (r.terms ?? {}) as Record<string, unknown>, derived: false,
      }))
    }
  }
  const derived = versionsFromOfferChain([...chainRows.values()])
  return { ok: true, rootOfferId: rootList[0] ?? null, transactionId, governing: resolveGoverningTerms(mergeVersions(recorded, derived)) }
}


export interface RecordVersionInput {
  brokerageId: string
  rootOfferId?: string | null
  transactionId?: string | null
  offerId?: string | null
  source: TermVersionSource
  status: TermVersionStatus
  terms: Record<string, unknown>
  documentId?: string | null
  executedAt?: string | null
  recordedBy?: string | null
  evidence?: Record<string, unknown>
}

/**
 * Record a version in the immutable record. REFUSED, by name, when: the terms hold a key outside the vocabulary; there is no
 * anchor (root offer or transaction); an EXECUTED version has no document, or its document does not show BOTH parties' signatures
 * (an addendum is not executed because a person says so — nothing here invents a signature); the tenant does not own the anchor.
 * The version number is assigned here (an offers-row version takes the row's own number; an addendum / amendment the next in its
 * source) and the unique index makes a concurrent duplicate a refusal, not a second row.
 */
export async function recordContractTermsVersion(svc: Svc, input: RecordVersionInput): Promise<{ ok: true; versionNo: number; id: string } | { ok: false; reason: string }> {
  if (!input.brokerageId) return { ok: false, reason: "no tenant" }
  if (!input.rootOfferId && !input.transactionId) return { ok: false, reason: "a terms version needs an anchor: the chain's root offer or a transaction" }
  const { terms, unknownKeys } = canonicalTerms(input.terms)
  if (unknownKeys.length) return { ok: false, reason: `not contract terms in the vocabulary: ${unknownKeys.join(", ")}` }
  if (Object.keys(terms).length === 0) return { ok: false, reason: "a terms version must name at least one term" }
  if (!(TERM_VERSION_SOURCES as readonly string[]).includes(input.source) || !(TERM_VERSION_STATUSES as readonly string[]).includes(input.status)) return { ok: false, reason: "unknown source or status" }

  if (input.status === "executed") {
    if (!input.documentId) return { ok: false, reason: "an executed version needs the executed document it came from" }
    const { data: doc, error: dErr } = await svc.from("documents").select("id, signature_completeness").eq("id", input.documentId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (dErr) return { ok: false, reason: `document read refused: ${dErr.message}` }
    if (!doc) return { ok: false, reason: "the document is not in this brokerage" }
    const sig = signaturesPresent((doc as { signature_completeness?: unknown }).signature_completeness, ["buyer", "seller"])
    if (sig.missing.length) return { ok: false, reason: `the document does not show ${sig.missing.join(" and ")} signed — a version is not executed until both parties' signatures are on it` }
  }
  if (input.rootOfferId) {
    const { data, error } = await svc.from("offers").select("id").eq("id", input.rootOfferId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `offer read refused: ${error.message}` }
    if (!data) return { ok: false, reason: "the root offer is not in this brokerage" }
  }
  // VERSION NUMBERS. An offers-row version (offer | counter) takes the ROW'S OWN number (root = 1, a counter = its round) so the
  // recorded twin and the derived one agree; an addendum / amendment is numbered within its own source (Addendum 1, 2, …). The unique
  // index includes `source`, so the two sequences can never collide.
  let next = 1
  if (input.offerId && (input.source === "offer" || input.source === "counter")) {
    const chain = await collectChain(svc, input.brokerageId, [input.offerId])
    if (!chain.ok) return chain
    const row = chain.rows.get(input.offerId)
    if (!row) return { ok: false, reason: "the offer is not in this brokerage" }
    next = row.parent_offer_id ? Math.max(2, row.current_round ?? 2) : 1
  } else {
    const q = svc.from("contract_term_versions").select("version_no").eq("brokerage_id", input.brokerageId).eq("source", input.source)
    const { data, error } = input.rootOfferId ? await q.eq("root_offer_id", input.rootOfferId) : await q.eq("transaction_id", input.transactionId as string)
    if (error) return { ok: false, reason: `contract_term_versions read refused: ${error.message}` }
    next = Math.max(0, ...((data ?? []) as Array<{ version_no: number }>).map((r) => Number(r.version_no))) + 1
  }
  const { data: ins, error } = await svc
    .from("contract_term_versions")
    .insert({
      brokerage_id: input.brokerageId, root_offer_id: input.rootOfferId ?? null, transaction_id: input.transactionId ?? null, offer_id: input.offerId ?? null,
      document_id: input.documentId ?? null, version_no: next, source: input.source, status: input.status, terms,
      executed_at: input.status === "executed" ? (input.executedAt ?? new Date().toISOString()) : null, recorded_by: input.recordedBy ?? null, evidence: input.evidence ?? {},
    })
    .select("id")
  if (error) return { ok: false, reason: error.code === "23505" ? "that version number was just recorded by another request — retry" : `contract_term_versions insert refused: ${error.message}` }
  const id = ((ins ?? [])[0] as { id?: string } | undefined)?.id
  return id ? { ok: true, versionNo: next, id } : { ok: false, reason: "contract_term_versions insert matched no row" }
}

/**
 * THE CALL EVERY OFFER → TRANSACTION PROMOTION MAKES once the transaction exists (kernel, submit-to-compliance,
 * convert-to-transaction): freeze the executed terms, log a refusal, never throw. The transaction is already created, so a
 * failure here is a logged finding — it is never a reason to undo the promotion.
 */
export async function freezeExecutedTermsAfterPromotion(input: { brokerageId: string; offerId: string; transactionId: string; recordedBy?: string | null; client?: Svc }): Promise<void> {
  try {
    const svc = input.client ?? ((await import("@/lib/supabase/service")).createServiceClient() as unknown as Svc)
    const snap = await snapshotExecutedTerms(svc, input)
    if (!snap.ok) console.error(`[governing-terms] transaction ${input.transactionId}: executed terms NOT frozen — ${snap.reason}`)
  } catch (err) {
    console.error(`[governing-terms] transaction ${input.transactionId}: executed-terms step threw —`, (err as Error)?.message ?? err)
  }
}

/**
 * At the moment an offer becomes a transaction, freeze the EXECUTED versions of its chain into the immutable record (the
 * offers rows stay editable by agents; a dispute needs what was signed). Idempotent: a version already recorded for an offer is
 * skipped. Non-fatal for the caller — the promotion has happened; a refusal is returned for the log.
 */
async function snapshotExecutedTerms(svc: Svc, input: { brokerageId: string; offerId: string; transactionId: string; recordedBy?: string | null }): Promise<{ ok: true; recorded: number } | { ok: false; reason: string }> {
  const gov = await governingContractTerms(svc, input.brokerageId, { offerId: input.offerId })
  if (!gov.ok) return gov
  if (!gov.rootOfferId) return { ok: false, reason: "no chain root" }
  const { data: have, error } = await svc.from("contract_term_versions").select("offer_id, status, evidence").eq("brokerage_id", input.brokerageId).eq("root_offer_id", gov.rootOfferId)
  if (error) return { ok: false, reason: `contract_term_versions read refused: ${error.message}` }
  const recordedByOffer = new Map(((have ?? []) as Array<{ offer_id: string | null; status: string; evidence: Record<string, unknown> | null }>).filter((r) => !!r.offer_id).map((r) => [r.offer_id as string, r]))
  let recorded = 0
  for (const v of gov.governing.versions) {
    if (v.status !== "executed" || !v.offerId) continue
    const existing = recordedByOffer.get(v.offerId)
    if (existing?.status === "executed" || existing?.status === "void") continue // already frozen (or deliberately void): never rewritten
    if (existing?.status === "proposed") {
      // a person-confirmed term set recorded while the counter was open: it is now executed — freeze it WITH those terms
      const { data: upd, error: updErr } = await svc.from("contract_term_versions")
        .update({ status: "executed", executed_at: v.executedAt ?? new Date().toISOString(), terms: v.terms, transaction_id: input.transactionId, evidence: { ...(existing.evidence ?? {}), snapshot: "offer_to_transaction_promotion" } })
        .eq("brokerage_id", input.brokerageId).eq("offer_id", v.offerId).eq("status", "proposed").select("id")
      if (updErr) return { ok: false, reason: `freezing version ${v.versionNo} refused: ${updErr.message}` }
      if (upd && upd.length > 0) recorded++
      continue
    }
    const { error: insErr } = await svc.from("contract_term_versions").insert({
      brokerage_id: input.brokerageId, root_offer_id: gov.rootOfferId, transaction_id: input.transactionId, offer_id: v.offerId, document_id: null,
      version_no: v.versionNo, source: v.source, status: "executed", terms: v.terms, executed_at: v.executedAt ?? new Date().toISOString(), recorded_by: input.recordedBy ?? null,
      evidence: { snapshot: "offer_to_transaction_promotion" },
    })
    if (insErr && insErr.code !== "23505") return { ok: false, reason: `snapshot of version ${v.versionNo} refused: ${insErr.message}` }
    if (!insErr) recorded++
  }
  return { ok: true, recorded }
}
