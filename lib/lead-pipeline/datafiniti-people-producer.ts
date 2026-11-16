// lib/lead-pipeline/datafiniti-people-producer.ts
// ─────────────────────────────────────────────────────────────────────────────
// DATAFINITI PEOPLE DATA → THE ONE RAWDATA DOOR (wave 153, lane 153M; owner ruling B1; directive Part B §3.2).
//
// NOT A NEW DATA PLATFORM (OS-CONSTITUTION law 1 / law 2). Every step is an existing survivor, composed:
//   · rights      — PROVIDER_ACTIVATION.datafiniti (lib/ai-isa/property-lookup-rail.ts; dormant pending rights today) for the
//                   platform route; the tenant route's verdict is deriveTenantProviderConnectionState (pending_owner_licensing
//                   today). Rights missing → nothing is called, not even the free reads.
//   · dedup       — lib/lead-pipeline/pre-pull-dedup.ts planPrePullDedup BEFORE the paid pull (held candidates in lookup mode)
//                   and AGAIN on the returned records (ingress), with recordPrePullDedupSavings for the avoided spend;
//   · preview     — the free count (countDatafinitiPeople, num_records: 0) through previewAggregateList — a count, never contacts;
//   · spend gate  — lib/lead-pipeline/source-discovery-planner.ts paidPullApproval WITH the door context (approved plan line /
//                   platform provider within budget / healthy authorized tenant connection);
//   · intake      — lib/kernel/scraping.ts ingestRawSourceBatch (THE one RawData producer; source datafiniti_people, rights
//                   licensed_vendor via source-intent-map.ts sourceRightsFor) → the Raw Lead gate → Lead → AI ISA. Never a Contact;
//   · cost        — meterVendorSpend (vendor_usage_tracking) ONCE per request / download_id (the idempotency key), from the
//                   response's own total_cost × the account plan's published per-record figure; null cost → price_state unknown.
// Every I/O door is injected (`deps`) so scripts/datafiniti-connector-guard.ts drives this exact code with zero network.
//
// GROUNDED — a Datafiniti person reaches the RawData door only when the record itself carries: a first + last name, at least
// one contact point that may be used (a TCPA-litigator-flagged record's phones are suppressed), a Datafiniti id / key to anchor
// a replay, a dateUpdated inside the owner_profile_pull stale window, and EITHER an owner ↔ property linkage the vendor
// documents (propertiesOwnedHistory / mostRecentPropertyPurchaseKey) OR it answers a lookup of a candidate the tenant already
// holds. Nothing here scores intent, infers a seller probability or invents a play (owner B5): intent stays 'unknown'.
//
// NO OUTREACH. This module writes RawData and a ledger row — it imports no messaging, no sequence, no Contact writer.

import {
  buildDatafinitiPeopleQuery, countDatafinitiPeople, searchDatafinitiPeople, startDatafinitiPeopleDownload, datafinitiDownloadStatus,
  getDatafinitiAccountHealth,
  type DatafinitiCredential, type DatafinitiClientOptions, type DatafinitiPeopleFilters, type DatafinitiPeopleRecord, type DatafinitiFailure,
} from "@/lib/external/datafiniti-client"
import { PROVIDER_ACTIVATION, type ProviderActivation } from "@/lib/ai-isa/property-lookup-rail"
import { planPrePullDedup, previewAggregateList, type KnownAcquisitionKeys, type PrePullCandidate, type PrePullDedupPlan, type AggregateListPreview } from "@/lib/lead-pipeline/pre-pull-dedup"
import { paidPullApproval, type StoredPlanRow, type PlatformProviderDoor } from "@/lib/lead-pipeline/source-discovery-planner"
import { evaluateFreshness, type FreshnessAssessment } from "@/lib/lead-pipeline/freshness"
import { stableContentDigest, type NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"
import type { IngestRawSourceBatchParams, IngestBatchResult } from "@/lib/kernel/scraping"
import type { MeterVendorInput } from "@/lib/vendor-governance/meter-vendor"
import type { TenantProviderConnectionVerdict } from "@/lib/providers/tenant-provider-connections"

export const DATAFINITI_SOURCE_KEY = "datafiniti_people"
const VENDOR = "datafiniti"

// ─── the documented-schema mapper ────────────────────────────────────────────────────────────────────────────────────

export interface DatafinitiFieldProvenance {
  /** Our field. */
  field: "first_name" | "last_name" | "phone" | "email" | "work_location" | "property_link"
  /** The vendor's field exactly as the schema names it. */
  vendorField: string
  /** The vendor's own date for this value (phoneNumbers[].lastDateSeen, dateUpdated, datePurchased …), or null. */
  seenAt: string | null
}

export interface DatafinitiMapResult {
  record: NormalizedScrapedRecord | null
  grounded: boolean
  /** Why a record is not written (refused / ungrounded / stale). null when written. */
  outcome: "written" | "refused" | "ungrounded" | "stale"
  why: string
  provenance: DatafinitiFieldProvenance[]
  propertyKeys: string[]
  freshness: FreshnessAssessment | null
  /** The pre-pull dedup candidate for the ingress pass (same keys the producer writes). */
  candidate: PrePullCandidate | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : typeof v === "string" && v.trim() ? [v.trim()] : [])
const iso = (v: unknown): string | null => { const s = str(v); if (!s) return null; const ms = Date.parse(s); return Number.isFinite(ms) ? new Date(ms).toISOString() : null }

/**
 * PURE — map ONE documented People record. Sparse records are honoured: a missing field stays missing (never filled, never
 * inferred); geography is the person's WORK location per the schema and is labelled so (never a property address); a property
 * is linked only through the vendor's own property keys; a TCPA-litigator flag suppresses every phone; a deceased record is
 * refused; a stale dateUpdated is held.
 */
export function mapDatafinitiPerson(
  raw: DatafinitiPeopleRecord,
  ctx: { retrievedAt: string; now?: Date; answersHeldCandidate?: string | null; queryDigest: string; downloadId?: string | null },
): DatafinitiMapResult {
  const r = (raw ?? {}) as DatafinitiPeopleRecord
  const provenance: DatafinitiFieldProvenance[] = []
  const none = (outcome: DatafinitiMapResult["outcome"], why: string, extra: Partial<DatafinitiMapResult> = {}): DatafinitiMapResult =>
    ({ record: null, grounded: false, outcome, why, provenance, propertyKeys: [], freshness: null, candidate: null, ...extra })

  if (r.deceased === true || str(r.dateOfDeath)) return none("refused", "the record is marked deceased — never a lead")
  const id = str(r.id) ?? strs(r.keys)[0] ?? null
  if (!id) return none("refused", "no Datafiniti id or key — a replay could not be anchored, so the record is not written")

  const updatedAt = iso(r.dateUpdated)
  const firstName = str(r.firstName), lastName = str(r.lastName)
  if (firstName) provenance.push({ field: "first_name", vendorField: "firstName", seenAt: updatedAt })
  if (lastName) provenance.push({ field: "last_name", vendorField: "lastName", seenAt: updatedAt })

  // Phones — suppressed entirely when the person is on the TCPA litigators list (schema `tcpa`).
  const tcpa = r.tcpa === true
  let phone: string | null = null
  if (!tcpa) {
    const nested = (Array.isArray(r.phoneNumbers) ? r.phoneNumbers : [])
      .filter((p) => p && str(p.number))
      .sort((a, b) => (Date.parse(String(b.lastDateSeen ?? "")) || 0) - (Date.parse(String(a.lastDateSeen ?? "")) || 0))
    const pick =
      str(r.phoneNumberHighScoreMobile) ? { v: str(r.phoneNumberHighScoreMobile)!, f: "phoneNumberHighScoreMobile", at: null as string | null }
      : str(r.phoneNumberHighScoreLand) ? { v: str(r.phoneNumberHighScoreLand)!, f: "phoneNumberHighScoreLand", at: null as string | null }
      : nested[0] ? { v: str(nested[0].number)!, f: "phoneNumbers[].number", at: iso(nested[0].lastDateSeen) }
      : null
    if (pick) {
      phone = pick.v
      const seen = pick.at ?? iso(nested.find((p) => str(p.number) === pick.v)?.lastDateSeen) ?? updatedAt
      provenance.push({ field: "phone", vendorField: pick.f, seenAt: seen })
    }
  }
  // Email — a PERSONAL address first, then the generic list; professional (work) addresses are never used as a personal channel.
  const personal = strs(r.personalEmails)[0] ?? null
  const generic = strs(r.emails)[0] ?? null
  const email = (personal ?? generic)?.toLowerCase() ?? null
  if (email) provenance.push({ field: "email", vendorField: personal ? "personalEmails" : "emails", seenAt: updatedAt })

  // Work location — labelled as such (schema: "the current city where this person works").
  const city = str(r.city), state = str(r.province), zip = str(r.postalCode)
  if (city || state || zip) provenance.push({ field: "work_location", vendorField: "city / province / postalCode", seenAt: updatedAt })

  // Owner ↔ property — ONLY through the vendor's own property keys (propertiesOwned is deprecated — a fallback only).
  const history = Array.isArray(r.propertiesOwnedHistory) ? r.propertiesOwnedHistory : []
  const propertyKeys = [...new Set([
    ...history.map((h) => str(h?.propertyKey)).filter((k): k is string => !!k),
    ...(str(r.mostRecentPropertyPurchaseKey) ? [str(r.mostRecentPropertyPurchaseKey)!] : []),
    ...(history.length === 0 && !str(r.mostRecentPropertyPurchaseKey) ? strs(r.propertiesOwned) : []),
  ])]
  const ownedNow = history.filter((h) => h && str(h.propertyKey) && !str(h.dateSold)).map((h) => str(h.propertyKey)!)
  if (propertyKeys.length) provenance.push({ field: "property_link", vendorField: history.length ? "propertiesOwnedHistory" : str(r.mostRecentPropertyPurchaseKey) ? "mostRecentPropertyPurchaseKey" : "propertiesOwned (deprecated)", seenAt: iso(r.mostRecentPropertyPurchaseDate) ?? iso(history[0]?.datePurchased) ?? updatedAt })

  const freshness = evaluateFreshness({ source: DATAFINITI_SOURCE_KEY, behaviorType: "datafiniti_person_record", intentSignals: [], subjectKind: propertyKeys.length ? "owner" : "person", signalAt: null, observedAt: updatedAt, lastVerifiedAt: updatedAt, now: ctx.now ?? new Date(ctx.retrievedAt) })
  const candidate: PrePullCandidate = {
    ref: id, source: DATAFINITI_SOURCE_KEY, sourceRecordId: id,
    ownerName: firstName && lastName ? `${firstName} ${lastName}` : null, lastName, state: state ?? null,
    email, phone, observedAt: updatedAt, subjectKind: propertyKeys.length ? "owner" : "person",
  }
  if (!firstName || !lastName) return none("ungrounded", "no first + last name on the record", { freshness, propertyKeys, candidate })
  if (!phone && !email) return none("ungrounded", tcpa ? "the only contact points are phones on a TCPA-litigator record (suppressed) and no email" : "no phone or email on the record", { freshness, propertyKeys, candidate })
  if (!updatedAt) return none("ungrounded", "no dateUpdated — the record's recency cannot be judged", { freshness, propertyKeys, candidate })
  if (freshness.hold) return none("stale", freshness.holdReason ?? freshness.why, { freshness, propertyKeys, candidate })
  const answered = ctx.answersHeldCandidate ?? null
  if (!propertyKeys.length && !answered) return none("ungrounded", "no owner ↔ property linkage on the record and it answers no held candidate — a bare identity is not a raw lead", { freshness, propertyKeys, candidate })

  const proofUrls = strs(r.sourceURLs).filter((u) => /^https:\/\//.test(u) && !/^https:\/\/(www\.)?datafiniti\.co\/?$/.test(u)).slice(0, 10)
  const record: NormalizedScrapedRecord = {
    sourceRecordId: id,
    source: DATAFINITI_SOURCE_KEY,
    behaviorType: "datafiniti_person_record",
    intentType: "unknown",
    intentSignals: [DATAFINITI_SOURCE_KEY, ...(propertyKeys.length ? ["property_owner_on_record"] : []), ...(propertyKeys.length || !answered ? [] : ["work_location_only"])],
    firstName, lastName, fullName: `${firstName} ${lastName}`,
    email, phone,
    // WORK location (schema) — the territory gate reads it; it is never written as a property or mailing address.
    city, state, zip,
    propertyAddress: null, mailingAddress: null,
    motivationScore: null, sourceUrl: proofUrls[0] ?? null,
    paidPersonData: true,
    rawPayload: r as Record<string, unknown>,
    envelope: {
      subjectKind: propertyKeys.length ? "owner" : "person",
      externalIds: {
        datafiniti_id: id,
        ...(str(r.mostRecentPropertyPurchaseKey) ? { datafiniti_property_key: str(r.mostRecentPropertyPurchaseKey)! } : propertyKeys[0] ? { datafiniti_property_key: propertyKeys[0] } : {}),
        ...(ctx.downloadId ? { datafiniti_download_id: ctx.downloadId } : {}),
      },
      proofUrls,
      evidence: {
        provider: VENDOR, retrieved_at: ctx.retrievedAt, date_added: iso(r.dateAdded), date_updated: updatedAt,
        query_digest: ctx.queryDigest, field_provenance: provenance,
        geography_basis: "work_location (schema: where this person works) — never a property address",
        property_keys: propertyKeys, properties_currently_owned: ownedNow,
        tcpa_litigator: tcpa, phones_suppressed: tcpa,
        professional_emails_withheld: strs(r.professionalEmails).length + (str(r.primaryEmail) ? 1 : 0),
        answers_held_candidate: answered,
        freshness: { verdict: freshness.verdict, policy: freshness.policy, ageDays: freshness.ageDays },
      },
    },
  }
  return { record, grounded: true, outcome: "written", why: answered ? `answers held candidate ${answered}` : `owner ↔ property linkage (${propertyKeys.length} key${propertyKeys.length === 1 ? "" : "s"})`, provenance, propertyKeys, freshness, candidate }
}

// ─── the pull ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DatafinitiPullInput {
  /** The tenant — resolved from the SESSION by the caller, never a body value. */
  brokerageId: string
  route: "platform" | "tenant"
  /** route tenant only: THE tenant's own connection (row id + decrypted token + its derived verdict). */
  tenantConnection?: { id: string; brokerageId: string; token: string | null; verdict: TenantProviderConnectionVerdict } | null
  mode: "lookup" | "search" | "download"
  /** lookup: candidates the tenant ALREADY holds, each with its own typed filters. */
  lookups?: Array<{ candidate: PrePullCandidate; filters: DatafinitiPeopleFilters }>
  /** search / download: the typed filters (never prose). */
  filters?: DatafinitiPeopleFilters
  numRecords: number
  view?: string | null
  /** The caller's stable id for THIS purchase decision (a plan line + territory + cycle). It anchors the charge-once key. */
  requestId: string
  /** download: resume an already-started download instead of starting (and paying for) a new one. */
  resumeDownloadId?: string | null
  territory: { city: string | null; state: string | null; zip_codes: string[] }
  marketId?: string | null
  now?: Date
}

export interface DatafinitiPullDeps {
  client?: DatafinitiClientOptions
  /** Override for the proofs (a simulated post-decision activation); production omits it → PROVIDER_ACTIVATION.datafiniti. */
  activation?: ProviderActivation
  loadKnown: () => Promise<KnownAcquisitionKeys | null>
  loadPlans: () => Promise<readonly StoredPlanRow[] | null>
  /** The platform route's door facts (configured by NAME, budget) — the caller reads them; null for a tenant pull. */
  platformDoor?: PlatformProviderDoor | null
  /** Has a charge under this key already been booked? null = the ledger could not be read (fail closed). */
  chargeBooked: (idempotencyKey: string) => Promise<boolean | null>
  ingest: (p: IngestRawSourceBatchParams) => Promise<IngestBatchResult>
  book: (input: MeterVendorInput) => Promise<boolean>
  recordSavings?: (input: { brokerageId: string; provider: string; door: string; plan: PrePullDedupPlan; unitUsd: number | null; priceBasis: "published" | "estimated"; coverage: "tenant_paid" | "platform_covered" }) => Promise<unknown>
  /** Fetch a completed download's result files (format not documented to us: a JSON array or NDJSON is accepted). */
  fetchDownloadFile?: (url: string) => Promise<DatafinitiPeopleRecord[] | null>
  /** Wave 153 (lane 153T): persist the resume checkpoint the moment a PAID download id exists (before its status is read), so a
   *  later cycle resumes it instead of buying again (lib/lead-pipeline/datafiniti-territory-door.ts). false = not written. */
  onDownloadStarted?: (p: { downloadId: string; requestId: string; chargeKey: string }) => Promise<boolean>
}

export interface DatafinitiPullReport {
  ok: boolean
  refused: string | null
  stage: "rights" | "known_keys" | "account" | "preview" | "spend_gate" | "charge_ledger" | "paid_call" | "download_pending" | "ingest" | "done"
  route: "platform" | "tenant"
  preview: AggregateListPreview | null
  countUnavailable: boolean
  prePull: { candidates: number; skipped: number; byReason: PrePullDedupPlan["byReason"] } | null
  paidCalls: number
  replayedCharge: boolean
  outcomeUnknown: { charged: boolean | null; resent: boolean } | null
  creditsCharged: number | null
  costUsd: number | null
  priceBasis: "published_tier" | "published_ceiling" | null
  booked: boolean
  returned: number
  mapped: { written: number; refused: number; ungrounded: number; stale: number }
  ingressDuplicates: number
  ingested: IngestBatchResult | null
  downloadId: string | null
  failure: DatafinitiFailure | null
  /** Wave 153 (lane 153T): whether the resume checkpoint for a freshly started download was written (null = none started). */
  checkpointed: boolean | null
}

const blank = (route: "platform" | "tenant"): DatafinitiPullReport => ({
  ok: false, refused: null, stage: "rights", route, preview: null, countUnavailable: false, prePull: null, paidCalls: 0, replayedCharge: false,
  outcomeUnknown: null, creditsCharged: null, costUsd: null, priceBasis: null, booked: false, returned: 0,
  mapped: { written: 0, refused: 0, ungrounded: 0, stale: 0 }, ingressDuplicates: 0, ingested: null, downloadId: null, failure: null, checkpointed: null,
})

/**
 * THE GATED PULL. Order (the first refusal stops everything, and nothing paid runs after it):
 *   rights → known keys → (lookup) pre-pull dedup → free account read → free count → paid-pull gate → charge-once check →
 *   paid search / download (or resume) → map (grounded only) → dedup again at ingress → THE RawData producer → one booking.
 */
export async function runDatafinitiPeoplePull(input: DatafinitiPullInput, deps: DatafinitiPullDeps): Promise<DatafinitiPullReport> {
  const now = input.now ?? new Date()
  const rep = blank(input.route)
  const refuse = (stage: DatafinitiPullReport["stage"], why: string, failure: DatafinitiFailure | null = null): DatafinitiPullReport => ({ ...rep, stage, refused: why, failure })

  // 1 · RIGHTS. Platform: the activation state; tenant: the connection's derived verdict, pinned to THIS tenant.
  const activation = deps.activation ?? PROVIDER_ACTIVATION.datafiniti
  if (activation.state !== "active") return refuse("rights", `Datafiniti is ${activation.state} (${activation.rights.status}) — not activated; nothing is called until the owner's licensing decision`)
  let cred: DatafinitiCredential
  if (input.route === "tenant") {
    const c = input.tenantConnection ?? null
    if (!c) return refuse("rights", "a tenant pull names no tenant connection")
    if (c.brokerageId !== input.brokerageId) return refuse("rights", "the connection belongs to another tenant — a tenant's key never serves another tenant")
    if (!c.verdict.mayIngest) return refuse("rights", `tenant connection ${c.verdict.state}: ${c.verdict.reason}`)
    cred = { owner: "tenant", brokerageId: input.brokerageId, connectionId: c.id, token: c.token }
  } else {
    cred = { owner: "platform" }
  }
  const coverage: "tenant_paid" | "platform_covered" = input.route === "tenant" ? "tenant_paid" : "platform_covered"

  // 2 · KNOWN KEYS (a refused read is not an empty set — fail closed).
  const known = await deps.loadKnown()
  if (!known) return refuse("known_keys", "the known-keys read was refused — a dedup against a half-set would re-buy held people")

  // 3 · LOOKUP MODE: pre-pull dedup of held candidates BEFORE any paid call.
  let lookups = input.lookups ?? []
  if (input.mode === "lookup") {
    const plan = planPrePullDedup(lookups.map((l) => l.candidate), known, { lookupKind: "person", now })
    rep.prePull = { candidates: lookups.length, skipped: plan.skipped, byReason: plan.byReason }
    const buyRefs = new Set(plan.buy.map((c) => c.ref))
    lookups = lookups.filter((l) => buyRefs.has(l.candidate.ref))
    if (plan.skipped > 0 && deps.recordSavings) await deps.recordSavings({ brokerageId: input.brokerageId, provider: VENDOR, door: "datafiniti_people_lookup", plan, unitUsd: null, priceBasis: "estimated", coverage })
    if (lookups.length === 0) return { ...rep, ok: true, stage: "done", refused: null }
  }

  // 4 · FREE ACCOUNT READ — credit health, the plan's published unit, the baseline for an outcome-unknown reconcile.
  const acct = await getDatafinitiAccountHealth(cred, deps.client)
  if (!acct.ok) return refuse("account", `account read failed (${acct.kind}): ${acct.message}`, acct)
  if (acct.disabled) return refuse("account", "the Datafiniti account is disabled (disabled_code ≠ 0)")
  if (!acct.peopleSearch.view) return refuse("account", "the account's plan does not enable people:search")
  if (input.mode === "download" && !acct.peopleSearch.download) return refuse("account", "the account's plan does not enable people downloads")
  const unit = acct.unit.unitUsd
  rep.priceBasis = acct.unit.basis

  // 5 · FREE COUNT (search / download) — a count, never contacts. A trial account may refuse it: UNAVAILABLE, never assumed.
  const filters = input.mode === "lookup" ? null : (input.filters ?? {})
  let want = Math.max(0, Math.floor(input.numRecords))
  if (filters) {
    const q = buildDatafinitiPeopleQuery(filters)
    if (!q.ok) return refuse("preview", `query refused: ${q.problems.join("; ")}`)
    if (!input.resumeDownloadId) {
      const c = await countDatafinitiPeople(cred, filters, deps.client)
      if (!c.ok && c.kind !== "count_unavailable") return refuse("preview", `count failed (${c.kind}): ${c.message}`, c)
      rep.countUnavailable = !c.ok
      rep.preview = previewAggregateList({ source: DATAFINITI_SOURCE_KEY, count: c.ok ? c.numFound : null, unitUsd: unit, knownOverlapRatio: null, freshness: null, via: c.ok ? "datafiniti num_records: 0 (0 credits)" : "count unavailable on this plan" })
      if (c.ok && c.numFound === 0) return { ...rep, ok: true, stage: "done" }
      if (c.ok) want = Math.min(want, c.numFound)
    }
  } else {
    want = lookups.length * Math.max(1, Math.min(want || 1, 3))
  }

  // 6 · PAID-PULL GATE (approved plan / platform provider within budget / healthy authorized tenant connection).
  const plans = await deps.loadPlans()
  const tenantDoor = input.route === "tenant" && input.tenantConnection
    ? { vendor: VENDOR, status: "connected" as const, healthy: input.tenantConnection.verdict.state === "healthy" || input.tenantConnection.verdict.state === "degraded", authorized: input.tenantConnection.verdict.mayIngest }
    : null
  const gate = paidPullApproval(plans, { brokerageId: input.brokerageId, source: DATAFINITI_SOURCE_KEY }, now, { platform: input.route === "platform" ? deps.platformDoor ?? null : null, tenant: tenantDoor })
  // A RESUME buys nothing (status + result files are free; the start was charged and booked) — so the SPEND gate does not
  // apply to it (wave 153, lane 153T): a territory whose budget that very purchase spent must still collect what it paid for
  // before the 7-day links lapse. Rights were checked at step 1 and still are.
  if (!gate.allowed && !input.resumeDownloadId) return refuse("spend_gate", gate.reason)
  if (gate.allowed && gate.maxSpendUsd !== null && !input.resumeDownloadId) {
    const affordable = Math.floor(gate.maxSpendUsd / unit)
    if (affordable <= 0) return refuse("spend_gate", `the approved ceiling ($${gate.maxSpendUsd}) buys no record at $${unit} each`)
    want = Math.min(want, affordable)
  }

  // 7 · CHARGE ONCE — the request (or the download) is bought at most once.
  const queryDigest = stableContentDigest({ mode: input.mode, filters, lookups: lookups.map((l) => l.filters), view: input.view ?? null })
  // A RESUME makes no paid call (status + result files are free), so it needs no charge check; every paid start / search does.
  const chargeKey = `datafiniti:${input.route}:${input.brokerageId}:${input.requestId}:${queryDigest}`
  if (!input.resumeDownloadId) {
    const already = await deps.chargeBooked(chargeKey)
    if (already === null) return refuse("charge_ledger", "the spend ledger could not be read — a paid call is never made without knowing it was not already bought")
    if (already) return { ...rep, ok: true, stage: "done", replayedCharge: true, refused: null }
  }

  // 8 · THE PAID CALL(S).
  const retrievedAt = now.toISOString()
  const batch: Array<{ rec: DatafinitiPeopleRecord; answers: string | null }> = []
  let credits: number | null = 0
  let downloadId: string | null = input.resumeDownloadId ?? null
  const reconcile = async (failure: DatafinitiFailure, resend: () => Promise<unknown>): Promise<DatafinitiPullReport | null> => {
    // OUTCOME UNKNOWN (owner B10): reconcile first — a credit delta means the vendor charged (never re-ask: it would charge
    // again); no delta means nothing was processed, so the call is re-sent ONCE automatically; an unreadable account holds.
    const after = await getDatafinitiAccountHealth(cred, deps.client)
    if (!after.ok || after.peopleCreditsUsed === null || acct.peopleCreditsUsed === null || credits === null) {
      return { ...refuse("paid_call", "outcome unknown and the account could not be reconciled — held, never re-sent blind", failure), outcomeUnknown: { charged: null, resent: false } }
    }
    // The baseline includes what THIS pull already bought before the failed call (lookup mode makes several calls).
    const delta = after.peopleCreditsUsed - (acct.peopleCreditsUsed + credits)
    if (delta > 0) {
      const booked = await deps.book(booking(delta, null, "outcome_unknown_reconciled"))
      return { ...refuse("paid_call", `outcome unknown: the account shows ${delta} credit(s) charged but no records were received — booked, NOT re-sent (a re-send would charge again)`, failure), outcomeUnknown: { charged: true, resent: false }, creditsCharged: delta, costUsd: Math.round(delta * unit * 1e6) / 1e6, booked }
    }
    rep.outcomeUnknown = { charged: false, resent: true }
    await resend()
    return null
  }
  const booking = (creditsUsed: number | null, records: number | null, note: string): MeterVendorInput => ({
    vendorName: VENDOR, usageType: DATAFINITI_SOURCE_KEY,
    cost: creditsUsed === null ? 0 : Math.round(creditsUsed * unit * 1e6) / 1e6,
    unitCount: Math.max(1, Math.floor(creditsUsed ?? records ?? 1)),
    brokerageId: input.brokerageId,
    priceState: creditsUsed === null ? "unknown" : "variable",
    costBasis: "estimated", coverage, idempotencyKey: chargeKey,
    systemSource: "datafiniti_people_producer",
    metadata: { route: input.route, mode: input.mode, credits: creditsUsed, unit_usd: unit, price_basis: acct.unit.basis, plan_id: acct.unit.planId, download_id: downloadId, note, ...(input.route === "tenant" ? { cost_payer: "tenant", connection_id: input.tenantConnection?.id ?? null } : {}) },
  })

  if (input.mode === "lookup") {
    const per = Math.max(1, Math.min(Math.floor(input.numRecords) || 1, 3))
    for (const l of lookups) {
      const once = async () => searchDatafinitiPeople(cred, { filters: l.filters, numRecords: per, view: input.view ?? null }, deps.client)
      let s = await once()
      rep.paidCalls++
      if (!s.ok && s.kind === "outcome_unknown") {
        let second: Awaited<ReturnType<typeof once>> | null = null
        const held = await reconcile(s, async () => { second = await once(); rep.paidCalls++ })
        if (held) return held
        s = second ?? s
      }
      if (!s.ok) return refuse("paid_call", `search failed (${s.kind}): ${s.message}`, s)
      credits = credits === null || s.totalCostCredits === null ? null : credits + s.totalCostCredits
      for (const rec of s.records) batch.push({ rec, answers: l.candidate.ref })
    }
  } else if (input.mode === "search") {
    const n = Math.max(1, Math.min(want, 10))
    const once = async () => searchDatafinitiPeople(cred, { filters: filters!, numRecords: n, view: input.view ?? null }, deps.client)
    let s = await once()
    rep.paidCalls++
    if (!s.ok && s.kind === "outcome_unknown") {
      let second: Awaited<ReturnType<typeof once>> | null = null
      const held = await reconcile(s, async () => { second = await once(); rep.paidCalls++ })
      if (held) return held
      s = second ?? s
    }
    if (!s.ok) return refuse("paid_call", `search failed (${s.kind}): ${s.message}`, s)
    credits = s.totalCostCredits
    for (const rec of s.records) batch.push({ rec, answers: null })
  } else {
    if (!downloadId) {
      const d = await startDatafinitiPeopleDownload(cred, { filters: filters!, numRecords: Math.max(1, want), view: input.view ?? null }, deps.client)
      rep.paidCalls++
      if (!d.ok) return refuse("paid_call", `download start failed (${d.kind}): ${d.message}${d.kind === "outcome_unknown" ? " — a download start is never re-sent blind; reconcile the account before any retry" : ""}`, d)
      downloadId = d.downloadId
      credits = d.totalCostCredits
      // The charge is the START's total_cost — booked now under the request key (a replayed start is refused at step 7) with
      // the download id in metadata; a resume makes no paid call and books nothing.
      rep.booked = await deps.book(booking(credits, null, "download_started"))
      rep.creditsCharged = credits
      rep.costUsd = credits === null ? null : Math.round(credits * unit * 1e6) / 1e6
      if (deps.onDownloadStarted) rep.checkpointed = await deps.onDownloadStarted({ downloadId: downloadId!, requestId: input.requestId, chargeKey }).catch(() => false)
    }
    rep.downloadId = downloadId
    const st = await datafinitiDownloadStatus(cred, downloadId!, deps.client)
    if (!st.ok) return { ...refuse("download_pending", `download status unreadable (${st.kind}): ${st.message} — resume with download_id ${downloadId}`, st), downloadId, booked: rep.booked, creditsCharged: rep.creditsCharged, costUsd: rep.costUsd, paidCalls: rep.paidCalls }
    if (st.status !== "completed") return { ...rep, ok: st.status !== "cancelled", stage: "download_pending", refused: st.status === "cancelled" ? "the download was cancelled" : null }
    if (!deps.fetchDownloadFile) return { ...rep, stage: "download_pending", refused: "no download-file reader configured — resume later with the download_id" }
    for (const link of st.links) {
      const recs = await deps.fetchDownloadFile(link)
      if (recs === null) return { ...rep, stage: "download_pending", refused: `result file unreadable (${link.slice(0, 80)}) — resume with download_id ${downloadId} (links valid 7 days)` }
      for (const rec of recs) batch.push({ rec, answers: null })
    }
  }
  rep.returned = batch.length

  // 9 · MAP (documented schema, grounded only) and DEDUP AGAIN at ingress.
  const mapped = batch.map((b) => mapDatafinitiPerson(b.rec, { retrievedAt, now, answersHeldCandidate: b.answers, queryDigest, downloadId }))
  for (const m of mapped) rep.mapped[m.outcome]++
  const written = mapped.filter((m) => m.record && m.candidate)
  const ingress = planPrePullDedup(written.map((m) => m.candidate!), known, { lookupKind: "person", now })
  const keep = new Set(ingress.buy.map((c) => c.ref))
  rep.ingressDuplicates = ingress.skipped
  const records = written.filter((m) => keep.has(m.candidate!.ref)).map((m) => m.record!)

  // 10 · THE ONE RAWDATA PRODUCER.
  const costUsd = credits === null ? null : Math.round(credits * unit * 1e6) / 1e6
  if (records.length) {
    rep.ingested = await deps.ingest({
      brokerageId: input.brokerageId, marketId: input.marketId ?? null,
      source: DATAFINITI_SOURCE_KEY, sourceFamily: "people_data", sourceChannel: VENDOR,
      records, executionId: null, marketGeo: input.territory,
      // cost_per_record is the PLATFORM's recorded cost — a tenant-paid pull never writes it.
      batchCostUsd: input.route === "platform" ? costUsd : null,
      actor: { type: "manager_action", id: input.route === "tenant" ? `datafiniti:tenant:${input.tenantConnection?.id ?? "?"}` : "datafiniti:platform" },
    })
  }

  // 11 · ONE BOOKING (search / lookup). A download booked at its start; a 0-credit answer books nothing.
  if (input.mode !== "download") {
    rep.creditsCharged = credits
    rep.costUsd = costUsd
    if (credits === null || credits > 0) rep.booked = await deps.book(booking(credits, batch.length, input.mode))
  }
  return { ...rep, ok: true, stage: "done", refused: null, downloadId }
}
