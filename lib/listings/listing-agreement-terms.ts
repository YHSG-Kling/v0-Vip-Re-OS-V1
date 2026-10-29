// lib/listings/listing-agreement-terms.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE LISTING AGREEMENT'S GOVERNING TERMS — the seller-agreed MLS live date and the seller's Coming Soon address
// instruction (wave 145, lane 145B; owner rulings 1 and 2, 2026-10-27; cross-lane contract C7).
//
// Owner: "The listing agreement would have the date the seller wants to go live on the MLS so check the listing
// agreement." and "You can advertise a coming soon only if you don't disclose the street address, unless otherwise."
//
// AUDIT FIRST (CLAUDE.md §1). The survivors this module EXTENDS, never replaces:
//   · listing_agreements — the ONE insert is markAgreementSigned (app/actions/seller-listing/execution-engine.ts); its
//     terms are columns (total_commission_rate, seller_transaction_fee, effective_date …). m856 adds the two terms this
//     ruling names as two more columns, WRITE-ONCE (a DB trigger refuses changing a recorded value).
//   · contract_term_versions (m797, wave 143A) — THE versioned, immutable record of executed contract terms. It had no
//     listing-agreement anchor; m856 adds `listing_agreement_id`, so an executed AMENDMENT to a listing agreement is a
//     `source = 'amendment'` version in the same table the offer side's addenda use (contract C7 — lane 145C's
//     post-transaction addendum writes the transaction-anchored twin; neither writes a second store).
//   · listings.go_live_date (wave 143A) — the PLANNED MLS live date; lib/listings/mls-live-date.ts recordPlannedMlsLiveDate
//     stays its ONE writer. This module only tells it which date the executed agreement governs.
//
// THE PRECEDENCE RULE is m797's (lib/offers/governing-terms-rule.ts resolveGoverningTerms), applied to the listing
// vocabulary: a term is governed by the LATEST EXECUTED version that names it; on an equal instant the original
// agreement precedes an amendment, then the higher version number; an explicit null in an amendment is a deliberate
// STRIKE; a superseded value is kept beside the governing one as a CONFLICT — nothing is mutated, so the original
// signed terms are preserved by construction. The offer-side resolver iterates the OFFER vocabulary only, so this is
// the same rule over a different key set — since wave 146 (lane 146I) literally the same function:
// lib/offers/governing-terms-rule.ts foldTermsByPrecedence, called with this key set and this rail's source rank.
//
// WHAT "MLS LIVE" IS NOT. The governed date is the SELLER-AGREED INTENDED live date — never the agreement's execution
// date, never the coming-soon period, never the actual MLS activation and never a VERIFIED MLS status. A verified live
// date has exactly one writer (recordVerifiedMlsLive, fed by RentCast / the tenant's IDX Broker feed only).
//
// Not `server-only` (a guard drives it with an injected client). Every read is tenant-pinned and reads its { error };
// every write counts the rows it touched (CLAUDE.md §3).

import type { SupabaseClient } from "@supabase/supabase-js"
import { ymdOf } from "./compute-dom"
import { isAtOrPastAllSigned } from "@/lib/esign/packet-states"
import { foldTermsByPrecedence, signaturesPresent } from "@/lib/offers/governing-terms-rule"

type Svc = SupabaseClient<any, any, any>

/** The listing-agreement term vocabulary — one spelling per term (CLAUDE.md §6). The m856 columns carry the same names. */
export const LISTING_AGREEMENT_TERM_KEYS = ["seller_requested_mls_live_date", "coming_soon_street_address_authorized"] as const
export type ListingAgreementTermKey = (typeof LISTING_AGREEMENT_TERM_KEYS)[number]

const isTermKey = (k: string): k is ListingAgreementTermKey => (LISTING_AGREEMENT_TERM_KEYS as readonly string[]).includes(k)

/** Where an executed term came from: the original agreement row, or an executed amendment (contract_term_versions). */
export type ListingTermSource = "listing_agreement" | "amendment"

export interface ListingTermVersion {
  id: string | null
  versionNo: number
  source: ListingTermSource
  executedAt: string | null
  documentId: string | null
  terms: Partial<Record<ListingAgreementTermKey, unknown>>
}

export interface GoverningListingTerm {
  key: ListingAgreementTermKey
  value: unknown
  source: ListingTermSource
  versionNo: number
  executedAt: string | null
  documentId: string | null
}

export interface ListingTermConflict {
  key: ListingAgreementTermKey
  superseded: { source: ListingTermSource; versionNo: number; value: unknown }
  governing: { source: ListingTermSource; versionNo: number; value: unknown }
}

export interface ResolvedListingTerms {
  terms: Partial<Record<ListingAgreementTermKey, GoverningListingTerm>>
  conflicts: ListingTermConflict[]
  versions: ListingTermVersion[]
}

/** PURE — one term value as the vocabulary admits it, or a reason. `null` is a STRIKE (allowed in an amendment). */
function listingTermValueProblem(key: ListingAgreementTermKey, value: unknown): string | null {
  if (value === null) return null
  if (key === "seller_requested_mls_live_date") return typeof value === "string" && ymdOf(value) === value ? null : "the seller-requested MLS live date is a calendar day (yyyy-mm-dd)"
  if (key === "coming_soon_street_address_authorized") return typeof value === "boolean" ? null : "the seller's Coming Soon street-address instruction is yes or no"
  return "not a listing-agreement term"
}

/**
 * PURE — THE PRECEDENCE RULE over the listing vocabulary (see the header). Versions may arrive in any order.
 * Only executed versions are passed in (an amendment is recorded executed or not at all); a version NAMES a term
 * by carrying the key (the original row names a term only when its column holds a value — a column cannot tell
 * "struck" from "never stated").
 * Module-private: governingListingAgreementTerms is its one caller (scripts/listing-coming-soon-live-date-guard.ts §D
 * drives ordering, ties, strikes and conflicts through that reader on seeded rows).
 */
function resolveListingAgreementTerms(versions: ListingTermVersion[]): ResolvedListingTerms {
  // THE ONE PRECEDENCE FOLD (wave 146, lane 146I — closes 145B Outside-lane 16): the contract rail's
  // lib/offers/governing-terms-rule.ts foldTermsByPrecedence, over this vocabulary and this rail's source rank (the
  // original agreement precedes an amendment on a same-instant tie). The inline copy of the loop that stood here is gone.
  const rank = (s: ListingTermSource) => (s === "listing_agreement" ? 0 : 1)
  const fold = foldTermsByPrecedence(versions as Array<ListingTermVersion & { terms: Record<string, unknown> }>, LISTING_AGREEMENT_TERM_KEYS, rank)
  const terms: ResolvedListingTerms["terms"] = {}
  for (const key of Object.keys(fold.won) as ListingAgreementTermKey[]) {
    const w = fold.won[key]!
    terms[key] = { key, value: w.value, source: w.version.source, versionNo: w.version.versionNo, executedAt: w.version.executedAt, documentId: w.version.documentId }
  }
  const conflicts: ListingTermConflict[] = fold.conflicts.map((c) => ({
    key: c.key,
    superseded: { source: c.superseded.version.source, versionNo: c.superseded.version.versionNo, value: c.superseded.value },
    governing: { source: c.governing.version.source, versionNo: c.governing.version.versionNo, value: c.governing.value },
  }))
  return { terms, conflicts, versions: fold.ordered }
}

/** A refused read that means "m856 is not applied yet" (the column / anchor does not exist) — not a tenant refusal. */
function isPreM856Refusal(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  const code = String(error.code ?? "")
  const msg = String(error.message ?? "")
  return code === "42703" || code === "PGRST204"
    || (/listing_agreement_id|seller_requested_mls_live_date|coming_soon_street_address_authorized/.test(msg) && /does not exist|could not find/i.test(msg))
}

export type GoverningListingTermsResult =
  | {
      ok: true
      /** The executed listing agreement the terms come from; null when the listing has none (nothing governs). */
      agreementId: string | null
      /** false when m856 is not applied: the terms cannot be recorded yet, so nothing governs (legacy behaviour). */
      termsRecordable: boolean
      resolved: ResolvedListingTerms
      /** The governed seller-agreed MLS live date (yyyy-mm-dd), or null when no executed version states one. */
      sellerRequestedMlsLiveDate: string | null
      /** true / false as the executed agreement (or an amendment) states it; null = not recorded = NOT authorized. */
      comingSoonStreetAddressAuthorized: boolean | null
    }
  | { ok: false; reason: string }

/**
 * THE ONE READER of a listing's executed listing-agreement terms. FAIL CLOSED: a refused read is ok:false (callers
 * say "unknown", never "not stated"). Pre-m856 (the columns / anchor are absent) is ok:true with termsRecordable
 * false and nothing governed — the legacy behaviour, named.
 */
export async function governingListingAgreementTerms(svc: Svc, input: { brokerageId: string; listingId: string }): Promise<GoverningListingTermsResult> {
  if (!input.brokerageId || !input.listingId) return { ok: false, reason: "no tenant or listing" }
  const empty = (agreementId: string | null, recordable: boolean): GoverningListingTermsResult => ({
    ok: true, agreementId, termsRecordable: recordable, resolved: { terms: {}, conflicts: [], versions: [] }, sellerRequestedMlsLiveDate: null, comingSoonStreetAddressAuthorized: null,
  })
  const base = "id, esign_status, seller_signed_at, agent_signed_at, fully_executed_at, created_at"
  let recordable = true
  let res: { data: unknown[] | null; error: { code?: string; message: string } | null } = await svc.from("listing_agreements").select(`${base}, ${LISTING_AGREEMENT_TERM_KEYS.join(", ")}`)
    .eq("listing_id", input.listingId).eq("brokerage_id", input.brokerageId).order("created_at", { ascending: false }).limit(10)
  if (res.error && isPreM856Refusal(res.error)) {
    recordable = false
    res = await svc.from("listing_agreements").select(base)
      .eq("listing_id", input.listingId).eq("brokerage_id", input.brokerageId).order("created_at", { ascending: false }).limit(10)
  }
  if (res.error) return { ok: false, reason: `the listing agreement could not be read: ${res.error.message}` }
  const executed = ((res.data ?? []) as Array<Record<string, any>>).find((r) => isAtOrPastAllSigned(r.esign_status))
  if (!executed) return empty(null, recordable)
  if (!recordable) return empty(String(executed.id), false)

  const original: ListingTermVersion = {
    id: String(executed.id), versionNo: 0, source: "listing_agreement", documentId: null,
    executedAt: (executed.fully_executed_at ?? executed.seller_signed_at ?? executed.agent_signed_at ?? executed.created_at ?? null) as string | null,
    terms: Object.fromEntries(LISTING_AGREEMENT_TERM_KEYS.filter((k) => executed[k] !== null && executed[k] !== undefined).map((k) => [k, k === "seller_requested_mls_live_date" ? ymdOf(executed[k]) : executed[k]])),
  }
  const am = await svc.from("contract_term_versions").select("id, version_no, source, status, terms, executed_at, document_id")
    .eq("brokerage_id", input.brokerageId).eq("listing_agreement_id", String(executed.id)).eq("status", "executed")
  if (am.error && !isPreM856Refusal(am.error)) return { ok: false, reason: `the listing agreement's amendments could not be read: ${am.error.message}` }
  const amendments: ListingTermVersion[] = am.error ? [] : ((am.data ?? []) as Array<Record<string, any>>).map((r) => ({
    id: String(r.id), versionNo: Number(r.version_no), source: "amendment" as const, executedAt: (r.executed_at as string | null) ?? null, documentId: (r.document_id as string | null) ?? null,
    terms: Object.fromEntries(Object.entries((r.terms ?? {}) as Record<string, unknown>).filter(([k]) => isTermKey(k))) as ListingTermVersion["terms"],
  }))
  const resolved = resolveListingAgreementTerms([original, ...amendments])
  const date = resolved.terms.seller_requested_mls_live_date?.value
  const auth = resolved.terms.coming_soon_street_address_authorized?.value
  return {
    ok: true, agreementId: String(executed.id), termsRecordable: !am.error, resolved,
    sellerRequestedMlsLiveDate: typeof date === "string" ? ymdOf(date) : null,
    comingSoonStreetAddressAuthorized: typeof auth === "boolean" ? auth : null,
  }
}

/** PURE — a calendar day yyyy-mm-dd that is a real day and not in the future (one day of slack for the writer's zone). */
function executedOnProblem(raw: unknown, now: Date): string | null {
  if (typeof raw !== "string" || ymdOf(raw) !== raw) return "Give the day the amendment was fully signed, as yyyy-mm-dd."
  if (Date.parse(`${raw}T00:00:00Z`) > now.getTime() + 24 * 3_600_000) return "An amendment cannot have been signed in the future."
  return null
}

export interface RecordListingAmendmentInput {
  brokerageId: string
  listingId: string
  /** The stored document that IS the executed amendment — it must show the SELLER's and the listing side's signatures. */
  documentId: string
  /** ONLY the terms the amendment changes, in the listing-agreement vocabulary. An explicit null strikes a term. */
  terms: Record<string, unknown>
  /** The day it was fully signed (yyyy-mm-dd). */
  executedOn: string
  recordedBy: string | null
  now?: Date
}

/**
 * Record an EXECUTED amendment to the listing's executed agreement as a contract_term_versions row (m797 + m856).
 * REFUSED, by name, when: a key is outside the vocabulary or a value is malformed; the listing has no executed
 * agreement; m856 is not applied; the document is not this tenant's or not this listing's, or does not show the seller
 * AND the listing agent / broker signed (nothing here invents a signature); the version number was just taken.
 * The original agreement row is never touched — the amendment supersedes it at read time.
 */
export async function recordListingAgreementAmendment(svc: Svc, input: RecordListingAmendmentInput): Promise<
  { ok: true; versionNo: number; id: string; agreementId: string; changed: ListingAgreementTermKey[] } | { ok: false; reason: string }
> {
  const now = input.now ?? new Date()
  const keys = Object.keys(input.terms ?? {})
  const unknown = keys.filter((k) => !isTermKey(k))
  if (unknown.length) return { ok: false, reason: `not listing-agreement terms: ${unknown.join(", ")}` }
  if (!keys.length) return { ok: false, reason: "state the term(s) the amendment changes" }
  const problems = keys.map((k) => listingTermValueProblem(k as ListingAgreementTermKey, input.terms[k])).filter((p): p is string => !!p)
  if (problems.length) return { ok: false, reason: problems.join("; ") }
  const dayErr = executedOnProblem(input.executedOn, now)
  if (dayErr) return { ok: false, reason: dayErr }

  const current = await governingListingAgreementTerms(svc, { brokerageId: input.brokerageId, listingId: input.listingId })
  if (!current.ok) return { ok: false, reason: current.reason }
  if (!current.agreementId) return { ok: false, reason: "this listing has no executed listing agreement to amend" }
  if (!current.termsRecordable) return { ok: false, reason: "listing-agreement amendments cannot be recorded until migration m856 is applied" }

  const { data: doc, error: dErr } = await svc.from("documents").select("id, listing_id, signature_completeness")
    .eq("id", input.documentId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (dErr) return { ok: false, reason: `the amendment document could not be read: ${dErr.message}` }
  if (!doc) return { ok: false, reason: "the amendment document is not in your brokerage" }
  const d = doc as { listing_id?: string | null; signature_completeness?: unknown }
  if (d.listing_id && d.listing_id !== input.listingId) return { ok: false, reason: "the amendment document is filed against a different listing" }
  const seller = signaturesPresent(d.signature_completeness, ["seller"])
  const listingSide = signaturesPresent(d.signature_completeness, ["agent", "broker"])
  if (seller.missing.length || listingSide.signed.length === 0) {
    return { ok: false, reason: `the document does not show ${[seller.missing.length ? "the seller" : null, listingSide.signed.length ? null : "the listing agent or broker"].filter(Boolean).join(" and ")} signed — an amendment is not executed until both sides' signatures are on it` }
  }

  const { data: prior, error: pErr } = await svc.from("contract_term_versions").select("version_no")
    .eq("brokerage_id", input.brokerageId).eq("listing_agreement_id", current.agreementId).eq("source", "amendment")
  if (pErr) return { ok: false, reason: `the amendment record could not be read: ${pErr.message}` }
  const next = Math.max(0, ...((prior ?? []) as Array<{ version_no: number }>).map((r) => Number(r.version_no))) + 1
  const terms = Object.fromEntries(keys.map((k) => [k, input.terms[k]]))
  const { data: ins, error } = await svc.from("contract_term_versions").insert({
    brokerage_id: input.brokerageId, listing_agreement_id: current.agreementId, root_offer_id: null, offer_id: null, transaction_id: null,
    document_id: input.documentId, version_no: next, source: "amendment", status: "executed", terms,
    // End of the stated day: an amendment amends an agreement that already exists, so on a same-day tie it is the later act.
    executed_at: `${input.executedOn}T23:59:59.999Z`, recorded_by: input.recordedBy, evidence: { recorded_via: "listing_agreement_amendment", executed_on: input.executedOn, listing_id: input.listingId },
  }).select("id")
  if (error) return { ok: false, reason: error.code === "23505" ? "that amendment number was just recorded by another request — retry" : `the amendment could not be recorded: ${error.message}` }
  const id = ((ins ?? [])[0] as { id?: string } | undefined)?.id
  if (!id) return { ok: false, reason: "the amendment insert matched no row" }
  const changed = keys.filter((k) => JSON.stringify(current.resolved.terms[k as ListingAgreementTermKey]?.value ?? null) !== JSON.stringify(terms[k])) as ListingAgreementTermKey[]
  return { ok: true, versionNo: next, id, agreementId: current.agreementId, changed }
}

/**
 * Write the ORIGINAL executed agreement's two terms (markAgreementSigned's second statement — the agreement row is
 * inserted first so a pre-m856 database still files the agreement). Only NULL columns are written: the m856 trigger
 * refuses changing a recorded value, and this writer never asks it to (`.is(col, null)`). Counted.
 */
export async function recordOriginalListingAgreementTerms(svc: Svc, input: {
  brokerageId: string; agreementId: string; terms: Partial<Record<ListingAgreementTermKey, unknown>>
}): Promise<{ ok: true; written: ListingAgreementTermKey[] } | { ok: false; reason: string; preMigration: boolean }> {
  const keys = (Object.keys(input.terms) as ListingAgreementTermKey[]).filter((k) => isTermKey(k) && input.terms[k] !== undefined && input.terms[k] !== null)
  for (const k of keys) {
    const p = listingTermValueProblem(k, input.terms[k])
    if (p) return { ok: false, reason: p, preMigration: false }
  }
  const written: ListingAgreementTermKey[] = []
  for (const k of keys) {
    const { data, error } = await svc.from("listing_agreements").update({ [k]: input.terms[k] })
      .eq("id", input.agreementId).eq("brokerage_id", input.brokerageId).is(k, null).select("id")
    if (error) return { ok: false, reason: `${k} was not recorded on the agreement: ${error.message}`, preMigration: isPreM856Refusal(error) }
    if (!data || data.length === 0) return { ok: false, reason: `${k} matched no unrecorded agreement row — a recorded term changes only through an executed amendment`, preMigration: false }
    written.push(k)
  }
  return { ok: true, written }
}
