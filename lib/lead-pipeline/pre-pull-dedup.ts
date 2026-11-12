// lib/lead-pipeline/pre-pull-dedup.ts
//
// PRE-PULL DEDUP — BEFORE any paid per-person lookup or list purchase (wave 151, lane 151C). PURE core + ONE injectable
// reader (the same shape as pooled-pull.ts: the proof runs the core with zero network; production passes the service client).
//
// Directive 151C: "Pre-pull deduplication has priority: before any paid per-person lookup or bulk list purchase, use already
// known source IDs, normalized property/APN/address, current RawData, verified owner/person relationships, Leads, Contacts,
// prior provider results, caches and exclusion/estimate features when supported. Where a list comes with only aggregate
// geography, run cost/count/freshness preview first; do not fabricate person identity to satisfy a dedup check. A property
// may have multiple owners and an owner may have multiple properties; do not force either into a single person record.
// Protect tenants from each other's underlying personal records while using internal duplicate-cost controls."
//
// SURVIVORS (LAW 1 — extended, each named, none replaced):
//   · the identity KEYS — lib/identity/subject-identity.ts subjectIdentityKeys (APN county-scoped / address / entity /
//     household / person) — the producer already writes them on every raw row (external_ids.identity_keys); this file READS
//     them back as the known set and keys candidates with the same function, so a key can never be spelled two ways;
//   · the post-intake person dedup — pipeline-processor.ts findBestMatch (three tables, tenant-pinned, confident match
//     only) — still the second, deterministic identity-aware dedup at intake; this file is the one BEFORE the money;
//   · a fresh provider answer is not re-bought — lib/enrichment/provider-dedup.ts isFresh / PROVIDER_FRESHNESS_DAYS, and
//     the honest "has this lead really been enriched" test — lib/enrichment/lead-freshness.ts leadHasEnrichmentEvidence;
//   · the replay guard AFTER purchase — C35 idempotency key (m961). This file is what saves the purchase.
//
// TWO OWNERS, ONE PROPERTY. A property key (APN / address) is NOT a person key. For a PERSON lookup a known property only
// ANNOTATES the candidate (`same_property:…`) — the person is still bought if unknown, because the other owner of the same
// parcel is a different person. For a PROPERTY lookup a known property IS the duplicate. Nothing here mints an identity:
// a candidate with no identifier yields no keys and is reported as undeduplicable, never guessed.
//
// TENANT ISOLATION. The reader pins every read to the tenant (brokerage_id, or the tenant's own market ids for the
// platform-pool raw rows that feed it). The platform's duplicate-cost control is the source-record id of an OBSERVATION
// (a listing id, a parcel), never another tenant's person row.

import type { SupabaseClient } from "@supabase/supabase-js"
import { subjectIdentityKeys } from "@/lib/identity/subject-identity"
import { isFresh, PROVIDER_FRESHNESS_DAYS } from "@/lib/enrichment/provider-dedup"
import { leadHasEnrichmentEvidence } from "@/lib/enrichment/lead-freshness"
import { evaluateFreshness, type FreshnessAssessment } from "./freshness"

export type PrePullLookupKind = "person" | "property" | "list"

export interface PrePullCandidate {
  /** The caller's handle for this candidate (a provider id, a row id, an index). */
  ref: string
  source: string
  sourceRecordId?: string | null
  apn?: string | null
  countyFips?: string | null
  propertyAddress?: string | null
  zip?: string | null
  state?: string | null
  ownerName?: string | null
  lastName?: string | null
  mailingAddress?: string | null
  email?: string | null
  phone?: string | null
  /** When known, the candidate is judged by its freshness policy too (a stale candidate is never bought). */
  signalAt?: string | null
  observedAt?: string | null
  behaviorType?: string | null
  intentSignals?: readonly string[] | null
  subjectKind?: string | null
}

/** Everything already held that a pull would pay for again. Sets of KEYS, never records. */
export interface KnownAcquisitionKeys {
  /** `<source>|<source_record_id>` of observations already held (this tenant's rows + the platform-pool rows its markets feed). */
  sourceRecordIds: ReadonlySet<string>
  /** `email:` / `phone:` keys of this tenant's Leads, Contacts and raw observations. */
  personKeys: ReadonlySet<string>
  /** `apn:` / `addr:` keys of properties already observed for this tenant. A property is not a person. */
  propertyKeys: ReadonlySet<string>
  /** Person key → the last PAID provider answer on record (a fresh one is never re-bought). */
  priorProviderResults: ReadonlyMap<string, { provider: string; at: string | null }>
  scope: { brokerageId: string | null; includesPlatformPool: boolean }
}

export type PrePullDedupReason = "new" | "known_source_id" | "known_person" | "prior_provider_result_fresh" | "known_property" | "stale_candidate" | "undeduplicable"

export interface PrePullDedupVerdict {
  ref: string
  action: "buy" | "skip"
  reason: PrePullDedupReason
  matchedKey: string | null
  /** Evidence attached without merging anyone: `same_property:<key>`, `known_person:<key>` (on a property lookup). */
  relations: string[]
  freshness: FreshnessAssessment | null
  why: string
}

export interface PrePullDedupPlan {
  verdicts: PrePullDedupVerdict[]
  buy: PrePullCandidate[]
  skipped: number
  /** skipped ÷ candidates — the overlap the value formula removes from the yield. */
  overlapRatio: number
  byReason: Partial<Record<PrePullDedupReason, number>>
  /** The sets the verdicts were judged against (published: a dedup against an empty set is not a dedup). */
  judgedAgainst: { sourceRecordIds: number; personKeys: number; propertyKeys: number; priorProviderResults: number }
}

const sourceIdKey = (source: string, id: string | null | undefined): string | null => {
  const s = (source ?? "").trim().toLowerCase(), i = (id ?? "").trim()
  return s && i ? `${s}|${i}` : null
}

/** PURE — the identity keys ONE candidate carries, split by what they identify (the same function the producer writes with). */
function candidateKeys(c: PrePullCandidate): { person: string[]; property: string[]; sourceId: string | null } {
  const all = subjectIdentityKeys({
    apn: c.apn ?? null, countyFips: c.countyFips ?? null, propertyAddress: c.propertyAddress ?? null, zip: c.zip ?? null,
    ownerName: c.ownerName ?? null, lastName: c.lastName ?? null, mailingAddress: c.mailingAddress ?? null, state: c.state ?? null,
    email: c.email ?? null, phone: c.phone ?? null,
  })
  return {
    person: all.filter((k) => k.startsWith("email:") || k.startsWith("phone:")),
    property: all.filter((k) => k.startsWith("apn:") || k.startsWith("addr:")),
    sourceId: sourceIdKey(c.source, c.sourceRecordId),
  }
}

/**
 * PURE — which candidates to BUY and which are already held. Order: a known observation (source id) is never re-bought;
 * a fresh paid answer on the same person is never re-bought; a known person is not bought again for a person / list
 * lookup; a known property is the duplicate only for a PROPERTY lookup (for a person it is a relation); a stale candidate
 * (its own freshness policy) is held; everything else is new.
 * @proofSeam the candidate-level production reader is the smart-search hydrate (app/api/webhooks/batchdata-smart-search/
 *  route.ts:142, the one paid per-property lookup fed by provider ids — outside lane 151C's files; the exact wiring is in
 *  lane 151C's notes, Outside-lane 5). The aggregate half (previewAggregateList) is live in the planner today.
 */
export function planPrePullDedup(
  candidates: readonly PrePullCandidate[],
  known: KnownAcquisitionKeys,
  opts: { lookupKind: PrePullLookupKind; providerFreshnessDays?: number; now?: Date | number },
): PrePullDedupPlan {
  const days = opts.providerFreshnessDays ?? PROVIDER_FRESHNESS_DAYS.peopledata_profile
  const nowDate = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now())
  const verdicts: PrePullDedupVerdict[] = []
  const buy: PrePullCandidate[] = []
  const byReason: Partial<Record<PrePullDedupReason, number>> = {}
  const tally = (r: PrePullDedupReason) => { byReason[r] = (byReason[r] ?? 0) + 1 }
  for (const c of candidates) {
    const keys = candidateKeys(c)
    const relations: string[] = []
    const emit = (action: "buy" | "skip", reason: PrePullDedupReason, matchedKey: string | null, freshness: FreshnessAssessment | null, why: string) => {
      verdicts.push({ ref: c.ref, action, reason, matchedKey, relations, freshness, why })
      tally(reason)
      if (action === "buy") buy.push(c)
    }
    if (keys.sourceId && known.sourceRecordIds.has(keys.sourceId)) { emit("skip", "known_source_id", keys.sourceId, null, "this observation is already held — a replay is never bought"); continue }
    const priorKey = keys.person.find((k) => known.priorProviderResults.has(k))
    if (priorKey && opts.lookupKind !== "property") {
      const prior = known.priorProviderResults.get(priorKey)!
      if (isFresh(prior.at, days, nowDate)) { emit("skip", "prior_provider_result_fresh", priorKey, null, `${prior.provider} answered for this person on ${prior.at} — within ${days} days, not re-bought`); continue }
    }
    const personKey = keys.person.find((k) => known.personKeys.has(k))
    if (personKey && opts.lookupKind !== "property") { emit("skip", "known_person", personKey, null, "this person is already a Lead, Contact or raw observation of this tenant — not bought again"); continue }
    if (personKey) relations.push(`known_person:${personKey}`)
    const propertyKey = keys.property.find((k) => known.propertyKeys.has(k))
    if (propertyKey && opts.lookupKind === "property") { emit("skip", "known_property", propertyKey, null, "this property is already observed for this tenant — the record is not bought again"); continue }
    if (propertyKey) relations.push(`same_property:${propertyKey}`)
    const freshness = c.signalAt || c.observedAt
      ? evaluateFreshness({ source: c.source, behaviorType: c.behaviorType, intentSignals: c.intentSignals, subjectKind: c.subjectKind, signalAt: c.signalAt ?? null, observedAt: c.observedAt ?? null, now: nowDate })
      : null
    if (freshness?.hold) { emit("skip", "stale_candidate", null, freshness, freshness.holdReason ?? freshness.why); continue }
    if (!keys.sourceId && keys.person.length === 0 && keys.property.length === 0) {
      emit("buy", "undeduplicable", null, freshness, "no identifier to dedup on — bought as new, never given an invented identity")
      continue
    }
    emit("buy", "new", null, freshness, relations.length ? `new person; ${relations.join(", ")} (annotated, not merged — two owners of one property stay two people)` : "not held — new")
  }
  const skipped = verdicts.filter((v) => v.action === "skip").length
  return {
    verdicts, buy, skipped,
    overlapRatio: candidates.length > 0 ? Math.round((skipped / candidates.length) * 100) / 100 : 0,
    byReason,
    judgedAgainst: { sourceRecordIds: known.sourceRecordIds.size, personKeys: known.personKeys.size, propertyKeys: known.propertyKeys.size, priorProviderResults: known.priorProviderResults.size },
  }
}

export interface AggregateListPreview {
  kind: "aggregate_preview"
  source: string
  /** The provider's / history's COUNT — a count, never contacts (Versium Estimate returns an estimated available count). */
  count: number | null
  estimatedCostUsd: number | null
  /** count × (1 − known overlap) — what a purchase would ADD; null when nothing is known to estimate from. */
  expectedNewRecords: number | null
  knownOverlapRatio: number | null
  freshness: { factor: number; policy: string } | null
  /** Always false: an aggregate preview never names a person. */
  identityFabricated: false
  via: string
  why: string
}

/**
 * PURE — the cost / count / freshness PREVIEW a list with only aggregate geography gets BEFORE any purchase. No person is
 * named; nothing is bought; the planner shows it beside the quote.
 */
export function previewAggregateList(input: {
  source: string
  count: number | null
  unitUsd: number | null
  minimumUsd?: number | null
  knownOverlapRatio: number | null
  freshness: { factor: number; policy: string } | null
  via: string
}): AggregateListPreview {
  const count = typeof input.count === "number" && input.count >= 0 ? Math.floor(input.count) : null
  const overlap = typeof input.knownOverlapRatio === "number" ? Math.max(0, Math.min(1, input.knownOverlapRatio)) : null
  const cost = count !== null && typeof input.unitUsd === "number" ? Math.round(Math.max(count * input.unitUsd, input.minimumUsd ?? 0) * 100) / 100 : null
  const expectedNew = count !== null ? Math.round(count * (1 - (overlap ?? 0))) : null
  return {
    kind: "aggregate_preview", source: input.source, count, estimatedCostUsd: cost, expectedNewRecords: expectedNew, knownOverlapRatio: overlap,
    freshness: input.freshness, identityFabricated: false, via: input.via,
    why: count === null ? "no count to preview — nothing is bought until a free count / estimate exists"
      : `${count} records via ${input.via}${cost !== null ? ` ≈ $${cost}` : " (no price)"}${overlap !== null ? `, ${Math.round(overlap * 100)}% already held` : ""}${input.freshness ? `, expected freshness ${input.freshness.factor} (${input.freshness.policy})` : ""} — a count, not contacts`,
  }
}

/** The empty known set — what a caller passes when the store could not be read is `null`, never this. */
const NO_KNOWN_KEYS: KnownAcquisitionKeys = Object.freeze({
  sourceRecordIds: new Set<string>(), personKeys: new Set<string>(), propertyKeys: new Set<string>(),
  priorProviderResults: new Map<string, { provider: string; at: string | null }>(), scope: { brokerageId: null, includesPlatformPool: false },
})

const chunk = <T,>(xs: readonly T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out }
const PROBE_CHUNK = 100
/** The identity keys one call will read for (persons first) — a bound on the per-key reads, published in the header. */
const MAX_IDENTITY_KEY_READS = 50

/**
 * THE READER (injectable client). Loads, for ONE tenant, the known keys a set of candidates could collide with: raw
 * observations (this tenant's rows and the platform-pool rows its own markets feed), Leads and Contacts (tenant-pinned),
 * plus each Lead's last real enrichment (lead-freshness.ts leadHasEnrichmentEvidence — a stamp without a profile is not an
 * answer). Every read's `error` is read; a refused read returns `null` so the caller cannot dedup against a half-set
 * (CLAUDE.md §4: a gate that cannot run must refuse — the caller previews / holds instead of buying).
 * @proofSeam same production reader as planPrePullDedup (the smart-search hydrate — lane 151C notes, Outside-lane 5).
 */
export async function loadKnownAcquisitionKeys(
  client: SupabaseClient<any, any, any>,
  scope: { brokerageId: string | null; marketIds: readonly string[] },
  probe: { candidates: readonly PrePullCandidate[] },
): Promise<KnownAcquisitionKeys | null> {
  const keys = probe.candidates.map(candidateKeys)
  const sourceIds = [...new Set(keys.map((k) => k.sourceId).filter((k): k is string => !!k))]
  const persons = [...new Set(keys.flatMap((k) => k.person))]
  const properties = [...new Set(keys.flatMap((k) => k.property))]
  const emails = persons.filter((k) => k.startsWith("email:")).map((k) => k.slice(6))
  const phones = persons.filter((k) => k.startsWith("phone:")).map((k) => k.slice(6))
  const out = { sourceRecordIds: new Set<string>(), personKeys: new Set<string>(), propertyKeys: new Set<string>(), prior: new Map<string, { provider: string; at: string | null }>() }
  const scopeTerms = [...(scope.brokerageId ? [`brokerage_id.eq.${scope.brokerageId}`] : []), ...(scope.marketIds.length ? [`market_id.in.(${scope.marketIds.join(",")})`] : [])]
  if (scopeTerms.length === 0) return { ...NO_KNOWN_KEYS, scope: { brokerageId: scope.brokerageId, includesPlatformPool: false } }

  // 1. Raw observations — by source record id (replays) and by identity key (persons + properties).
  for (const ids of chunk(sourceIds.map((k) => k.split("|").slice(1).join("|")), PROBE_CHUNK)) {
    const { data, error } = await client.from("raw_scraped_leads").select("source, source_record_id").or(scopeTerms.join(",")).in("source_record_id", ids)
    if (error) { console.error("[pre-pull-dedup] raw source-id read refused — no dedup this cycle:", error.message); return null }
    for (const r of (data ?? []) as Array<{ source: string; source_record_id: string | null }>) { const k = sourceIdKey(r.source, r.source_record_id); if (k) out.sourceRecordIds.add(k) }
  }
  // One read per identity key (bounded: the first MAX_IDENTITY_KEY_READS keys, persons first). external_ids.identity_keys is
  // the producer's space-joined key string (m961), so the match is a text containment; the keys carry no comma / paren.
  // (Published: a PostgREST `or()` over the JSON path would collapse these into one read per chunk; it is kept per key so the
  // in-memory harness that proves this reader runs the SAME grammar production runs.)
  for (const k of [...persons, ...properties].slice(0, MAX_IDENTITY_KEY_READS)) {
    const { data, error } = await client.from("raw_scraped_leads").select("external_ids").or(scopeTerms.join(",")).ilike("external_ids->>identity_keys", `%${k}%`)
    if (error) { console.error("[pre-pull-dedup] raw identity-key read refused — no dedup this cycle:", error.message); return null }
    for (const r of (data ?? []) as Array<{ external_ids: { identity_keys?: string } | null }>) {
      for (const held of String(r.external_ids?.identity_keys ?? "").split(" ").filter(Boolean)) {
        if (held.startsWith("email:") || held.startsWith("phone:")) out.personKeys.add(held)
        else if (held.startsWith("apn:") || held.startsWith("addr:")) out.propertyKeys.add(held)
      }
    }
  }
  // 2. Leads + Contacts — tenant-pinned; only a tenant with a brokerage holds either.
  if (scope.brokerageId && (emails.length || phones.length)) {
    const idTerms = [...(emails.length ? [`email.in.(${emails.join(",")})`] : []), ...(phones.length ? [`phone.in.(${phones.join(",")})`] : [])].join(",")
    const { data: leads, error: leadErr } = await client.from("leads").select("email, phone, enrichment_profile, last_enriched_at").eq("brokerage_id", scope.brokerageId).or(idTerms)
    if (leadErr) { console.error("[pre-pull-dedup] leads read refused — no dedup this cycle:", leadErr.message); return null }
    for (const l of (leads ?? []) as Array<{ email: string | null; phone: string | null; enrichment_profile: unknown; last_enriched_at: string | null }>) {
      const ks = candidateKeys({ ref: "", source: "", email: l.email, phone: l.phone }).person
      for (const k of ks) {
        out.personKeys.add(k)
        if (leadHasEnrichmentEvidence(l)) out.prior.set(k, { provider: String((l.enrichment_profile as { provider?: unknown } | null)?.provider ?? "provider"), at: l.last_enriched_at })
      }
    }
    const { data: contacts, error: contactErr } = await client.from("contacts").select("email, phone").eq("brokerage_id", scope.brokerageId).is("deleted_at", null).or(idTerms)
    if (contactErr) { console.error("[pre-pull-dedup] contacts read refused — no dedup this cycle:", contactErr.message); return null }
    for (const c of (contacts ?? []) as Array<{ email: string | null; phone: string | null }>) for (const k of candidateKeys({ ref: "", source: "", email: c.email, phone: c.phone }).person) out.personKeys.add(k)
  }
  return { sourceRecordIds: out.sourceRecordIds, personKeys: out.personKeys, propertyKeys: out.propertyKeys, priorProviderResults: out.prior, scope: { brokerageId: scope.brokerageId, includesPlatformPool: scope.marketIds.length > 0 } }
}
