// lib/lead-pipeline/permit-sourcer.ts
//
// PERMIT / PRE-LISTING INTENT SOURCER (lane 73D — owner ruling wave 73, verbatim:
// "exa is good at looking for leads like permit"). SourceKey `permit_prelisting_intent`
// (lib/lead-pipeline/source-intent-map.ts).
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────────
// lib/external/permit-signals.ts already reads city/county Socrata + ArcGIS permit
// PORTALS on a daily cadence and, by explicit and repeatedly-documented design, never
// mints a lead from a bare permit address ("Turning an address into a lead is lead
// SOURCING... not here" — that file's own header). It only ATTACHES a permit signal to
// a lead or contact the brokerage ALREADY owns. docs/lead-acquisition-coverage-2026-09.md
// item #32 records permit/pre-listing signals as still-genuinely-MISSING for
// ACQUISITION for exactly that reason.
//
// This lane is the acquisition half the owner asked for, on a DIFFERENT provider and a
// DIFFERENT shape of evidence: Exa neural search over the open web for recent building-
// permit NEWS/filings, estate/probate notices, "coming soon" pre-listing chatter, and
// contractor-bid posts. REVERSED IN PART (wave 150, owner ruling R9 — "Exa for public-market
// research, never for people"): the name such a page carries is NOT read any more; every hit
// is PROPERTY evidence (an address) or a job/civic event, stated on the C35 envelope, and the
// subject gate keeps both off the Lead door. When a hit's address turns out to match a
// lead/contact the brokerage already owns, this lane defers to the SAME attach path
// instead of minting a duplicate person — see `routePermitPrelistingHits` below, which
// reuses `normalizeStreetAddress` + `matchPermitsToLeads` from permit-signals.ts (one
// address vocabulary, CLAUDE.md §6) rather than writing a second address normalizer.
//
// Territory-centric (CLAUDE.md §3/wave 65 ruling): `buildPermitSearchQueries` returns
// zero queries for a market with no city/state/county — never a global sweep.
//
// Fail-closed (CLAUDE.md §4): `sourcePermitPrelistingIntent` delegates every network call
// to `lib/external/exa-client.ts::exaSearch`, which reads `EXA_API_KEY` and returns
// `{ results: [], cost: 0 }` BEFORE importing the Exa SDK adapter when the key is absent
// — no network call is made. `lib/providers/exa/client.ts` is the official `exa-js`
// adapter that wrapper ultimately calls (read, not re-implemented here — one Exa
// adapter, per wave 70B's SDK-adoption ruling).
//
// Cost (docs/provider-matrix-2026-09.md's Exa row): `costDollars.total` returned per call
// when Exa states one; `exaSearch` falls back to the published list price (lane 89B,
// exa-client.ts::exaSearchListCost — $7/1k requests incl. 10 results + $1/1k results above
// 10; the old `0.005 × numResults` overstated a 15-result query ~3×) when it does not — this
// lane reuses that same wrapper and fallback rather than inventing a second price.

import { exaSearch, type ExaResult } from "@/lib/external/exa-client"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"
// `matchPermitsToLeads` calls `normalizeStreetAddress` internally on both sides of the
// match — that IS the reuse (CLAUDE.md §6: one address vocabulary, not imported and
// re-called a second time here).
import {
  matchPermitsToLeads,
  classifyPermitStrength,
  PERMIT_SIGNAL_TYPE,
  type MatchableLead,
  type SignalStrength,
} from "@/lib/external/permit-signals"
import { excludeConvertedLeads } from "@/lib/contact-promotion/conversion-finality"

export interface PermitMarket {
  city: string | null
  state: string | null
  zip_codes?: string[] | null
  counties?: string[] | null
}

/**
 * Only permits/probate filings/chatter dated within this many days are worth sourcing —
 * a "coming soon" post or a probate notice from six months ago has almost certainly
 * already resolved one way or the other. Documented here (not a magic number at the
 * call site) because it is the one knob that trades recall for staleness: widen it and
 * more hits arrive, but more of them describe a sale that already happened.
 */
export const PERMIT_SOURCER_LOOKBACK_DAYS = 45

/** At most this many of `buildPermitSearchQueries`' queries run per sourcer call — the
 *  same per-run bound `sourceNewConstructionIntent` / `sourceAgentSeekingPhraseIntent`
 *  apply to their own phrase sets, here doubling as Exa spend control (each query is a
 *  metered request). */
const MAX_QUERIES_PER_RUN = 5
const RESULTS_PER_QUERY = 15

export type PermitSearchCategory = "permit" | "probate" | "coming_soon" | "contractor_bid"

export interface PermitSearchQuery {
  query: string
  category: PermitSearchCategory
}

/**
 * PURE. Territory-centric Exa query builder — the four evidence shapes the owner named:
 * recent residential building permits (remodel/addition/roof/pool), estate/probate
 * notices, "coming soon"/pre-listing chatter, and contractor-bid posts.
 *
 * TERRITORY HONESTY (wave 65 ruling, restated by every sourcer since): a market with no
 * city, no county, and no state yields ZERO queries — never a global, unscoped sweep.
 */
export function buildPermitSearchQueries(market: PermitMarket): PermitSearchQuery[] {
  const city = market.city?.trim() ?? ""
  const state = market.state?.trim() ?? ""
  const counties = market.counties ?? []

  const locationTokens: string[] = [
    city,
    ...counties.map((c) => c.replace(/\s+county$/i, "").trim()),
    [city, state].filter(Boolean).join(", "),
  ].filter(Boolean)

  if (locationTokens.length === 0) return []

  const out: PermitSearchQuery[] = []
  for (const loc of locationTokens) {
    out.push(
      { query: `recent residential remodel or addition building permit filed ${loc}`, category: "permit" },
      { query: `building permit issued roof replacement or pool ${loc}`, category: "permit" },
      { query: `estate sale probate property listing ${loc}`, category: "probate" },
      { query: `coming soon home for sale pre-listing preparation ${loc}`, category: "coming_soon" },
      { query: `contractor bid renovation remodel before selling ${loc}`, category: "contractor_bid" },
    )
  }
  return out
}

// ── Property address extraction (best-effort, never fabricated) ──

// TOMBSTONE (wave 150, lane 150Z — lane 150KLMO Outside-lane 2, owner ruling R9 "Exa for public-market research with
// citations, NEVER for people"): APPLICANT_PATTERNS, extractApplicantName and splitDisplayName — which lifted an
// applicant / executor / poster NAME (and fell back to the page's `author`) out of an Exa page to mint a seller PERSON —
// are deleted, not moved: the capability is REVERSED by R9. What survives is the property EVIDENCE path below
// (extractPropertyAddress → routePermitPrelistingHits attaches to a lead/contact the tenant already owns), and a person
// is only ever identified through the licensed owner-contact rail (lib/ai-isa/property-lookup-rail.ts
// CONTACT_PROVIDER_ROUTES), never from an Exa page.

/** A conservative US street-address pattern: house number + 1-4 word tokens + a
 *  recognized suffix. Matches the FIRST occurrence only — text about a permit or a
 *  probate filing names the subject property once, near the top. */
const STREET_ADDRESS_RE =
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Boulevard|Way|Pl|Place|Cir|Circle|Ter|Terrace|Pkwy|Parkway|Trl|Trail)\b\.?/i

/** PURE. Best-effort property address extraction; null when the text carries none —
 *  never a guessed/truncated fragment. */
export function extractPropertyAddress(text: string): string | null {
  const m = STREET_ADDRESS_RE.exec(text)
  return m ? m[0].trim() : null
}

// ── Normalizer ──────────────────────────────────────────────────────────────

/**
 * PURE. An Exa result → a permit/pre-listing seller-side EVIDENCE record (property or job/civic event — never a
 * person, R9). Quicklist-style tags
 * (mirroring the vocabulary BatchData's quicklist tags use elsewhere in this pipeline —
 * `demolition` / `probate` / `coming_soon` / `contractor_bid` — plus the query's own
 * `category`) ride in `intentSignals`.
 */
export function normalizePermitSearchResult(
  result: ExaResult,
  market: PermitMarket,
  category: PermitSearchCategory,
): NormalizedScrapedRecord {
  const text = `${result.title ?? ""} ${result.text ?? ""}`
  // R9: no person is read from the page (no applicant name, no `author`) — the record is PROPERTY evidence when the page
  // names an address, else a job/civic event; the subject gate (raw-record-types subjectKindLeadProblem) keeps both off
  // the Lead door, and the attach path below still files it on a lead/contact the tenant already owns.
  const propertyAddress = extractPropertyAddress(text)

  const intentSignals = ["permit_prelisting_intent", category]
  if (/\b(demolition|demolish|teardown|tear down|raze)\b/i.test(text)) intentSignals.push("demolition")
  if (/\b(probate|estate sale|inherited)\b/i.test(text)) intentSignals.push("probate")
  if (/coming soon/i.test(text)) intentSignals.push("coming_soon")
  if (category === "contractor_bid" && /\b(bid|quote|estimate)\b/i.test(text)) intentSignals.push("contractor_bid")

  return {
    sourceRecordId: `permit-exa-${Buffer.from(String(result.url ?? result.id ?? text)).toString("base64").slice(0, 40)}`,
    source: "permit_prelisting_intent",
    behaviorType: "search_signal",
    intentType: "seller",
    intentSignals,
    city: market.city,
    state: market.state,
    propertyAddress,
    sourceUrl: result.url ?? null,
    // classifyPermitStrength (reused, not re-derived — CLAUDE.md §6) maps demolition
    // language to "strong" and remodel/probate language to "moderate"; mirrored onto
    // the 0-100 motivation scale this pipeline's other sourcers use.
    motivationScore:
      classifyPermitStrength({ description: text, valuation: null }) === "strong" ? 65
      : classifyPermitStrength({ description: text, valuation: null }) === "moderate" ? 55
      : 45,
    rawPayload: { id: result.id, url: result.url, title: result.title, category },
    envelope: { subjectKind: propertyAddress ? "property" : "job_civic_event", proofUrls: result.url ? [result.url] : [] },
  }
}

// ── Sourcer (Exa network call) ──────────────────────────────────────────────

/**
 * Discover permit/pre-listing SELLER intent for a territory via Exa neural search.
 * FAIL-CLOSED: `exaSearch` reads `EXA_API_KEY` itself and returns `{results:[],cost:0}`
 * with no network call when it is absent — this function makes no separate check
 * because there is nothing left for it to gate; a missing territory is checked HERE
 * (via `buildPermitSearchQueries` returning `[]`) so a market with no geography never
 * reaches `exaSearch` at all.
 */
export async function sourcePermitPrelistingIntent(
  market: PermitMarket,
): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const queries = buildPermitSearchQueries(market)
  if (queries.length === 0) return { records: [], cost: 0 }

  const since = new Date(Date.now() - PERMIT_SOURCER_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)

  const all: NormalizedScrapedRecord[] = []
  let cost = 0
  for (const { query, category } of queries.slice(0, MAX_QUERIES_PER_RUN)) {
    const r = await exaSearch({ query, numResults: RESULTS_PER_QUERY, startPublishedDate: since })
      .catch(() => ({ results: [] as ExaResult[], cost: 0 }))
    cost += r.cost ?? 0
    for (const result of r.results ?? []) {
      const rec = normalizePermitSearchResult(result, market, category)
      if (isViableRecord(rec)) all.push(rec)
    }
  }
  return { records: all, cost }
}

// ── Attach-vs-mint routing (the permit-signals reuse) ───────────────────────

/** `detected_via` this lane stamps — distinct from `PERMIT_DETECTED_VIA` ("socrata") /
 *  `ARCGIS_DETECTED_VIA` ("arcgis") in permit-signals.ts, the same pattern that file
 *  already uses to tell two providers of the SAME `motivated_seller_signals` spine
 *  apart (see its "AND A SECOND PROVIDER" section). One table, three provenances. */
export const EXA_PERMIT_DETECTED_VIA = "exa"

/** Minimal client surface — accepts the SSR or service supabase client. */
type SupabaseLike = { from: (table: string) => any }

const MAX_MATCHABLE_ROWS = 5000

export interface PermitAttachResult {
  /** Hits with NO address match to an owned lead/contact — the caller mints these as
   *  raw_scraped_leads through the normal pipeline (insertSocial/ingestRawSourceBatch),
   *  exactly like every other SourceKey. */
  toMint: NormalizedScrapedRecord[]
  attached: number
  alreadyRecorded: number
  attachedByEntity: { lead: number; contact: number }
  errors: string[]
}

/**
 * Splits Exa permit/pre-listing hits into MINT (no owned-record match — proceed as a
 * normal raw lead) vs ATTACH (the hit's address matches a lead/contact this brokerage
 * ALREADY owns — write a `motivated_seller_signals` row instead, exactly like
 * `lib/external/permit-signals.ts::ingestPermitSignals` does for its own Socrata/ArcGIS
 * rows). Reuses `normalizeStreetAddress` (via `matchPermitsToLeads`, which calls it
 * internally) rather than a second address normalizer — CLAUDE.md §6.
 *
 * Records with no `propertyAddress` at all (a probate/bid post with only a name) have
 * nothing to attach-match on and always mint — the same posture `property_required`
 * sources already have via `isViableRecord`.
 */
export async function routePermitPrelistingHits(params: {
  supabase: SupabaseLike
  brokerageId: string
  records: NormalizedScrapedRecord[]
}): Promise<PermitAttachResult> {
  const { supabase, brokerageId, records } = params
  const result: PermitAttachResult = {
    toMint: records,
    attached: 0,
    alreadyRecorded: 0,
    attachedByEntity: { lead: 0, contact: 0 },
    errors: [],
  }

  const withAddress = records.filter((r) => !!r.propertyAddress)
  if (withAddress.length === 0) return result

  // ── this brokerage's own unconverted leads + contacts (address-bearing) ──
  // Same tenant-scoping + conversion-exclusion as ingestPermitSignals: `leads.contact_id`
  // set means the CONTACT is the survivor for matching (CLAUDE.md §1 duplicate rule —
  // reused via the ONE conversion guard, not re-derived here).
  const { data: leadRows, error: leadsError } = await excludeConvertedLeads(
    supabase.from("leads").select("id, address").eq("brokerage_id", brokerageId),
  )
    .not("address", "is", null)
    .limit(MAX_MATCHABLE_ROWS)
  if (leadsError) {
    result.errors.push(`leads read refused: ${leadsError.message}`)
    return result
  }

  const { data: contactRows, error: contactsError } = await supabase
    .from("contacts")
    .select("id, address")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .not("address", "is", null)
    .limit(MAX_MATCHABLE_ROWS)
  if (contactsError) {
    result.errors.push(`contacts read refused: ${contactsError.message}`)
    return result
  }

  const leads: MatchableLead[] = [
    ...((leadRows ?? []) as Array<{ id: string; address: string | null }>).map((l) => ({ ...l, entity: "lead" as const })),
    ...((contactRows ?? []) as Array<{ id: string; address: string | null }>).map((c) => ({ ...c, entity: "contact" as const })),
  ]
  if (leads.length === 0) return result

  // Shaped as permit-portal-style rows so `matchPermitsToLeads`' own address reader
  // (readPermitAddress → the ADDRESS_KEYS candidate list, which tries "address" first)
  // finds the property address under the SAME key every Socrata portal uses — the
  // original record rides along as `__rec` and comes back on `PermitMatch.raw`.
  const permitRows = withAddress.map((r) => ({ address: r.propertyAddress, __rec: r }))
  const outcome = matchPermitsToLeads(permitRows, leads)
  if (outcome.matches.length === 0) return result

  // Idempotency scoped to THIS lane's detected_via — the Socrata/ArcGIS lane's own
  // idempotency read (ingestPermitSignals) is untouched and reads its own dedupe_key
  // format (`datasetId|tail|entity:id`), which never collides with this lane's
  // (`exa|a:...`), so the two attach paths coexist on the one table safely.
  const { data: existingRows, error: existingError } = await supabase
    .from("motivated_seller_signals")
    .select("signal_details")
    .eq("brokerage_id", brokerageId)
    .eq("signal_type", PERMIT_SIGNAL_TYPE)
    .eq("detected_via", EXA_PERMIT_DETECTED_VIA)
  if (existingError) {
    result.errors.push(`existing-signal read refused: ${existingError.message}`)
    return result
  }
  const already = new Set<string>()
  for (const row of (existingRows ?? []) as Array<{ signal_details: { dedupe_key?: string } | null }>) {
    const k = row?.signal_details?.dedupe_key
    if (typeof k === "string" && k) already.add(k)
  }

  const matchedRecordIds = new Set<string>()
  const toWrite: Array<Record<string, unknown>> = []
  for (const match of outcome.matches) {
    const rec = (match.raw as { __rec?: NormalizedScrapedRecord } | undefined)?.__rec
    const dedupeKey = `exa|a:${match.addressKey}|${match.entity}:${match.entityId}`
    if (rec) matchedRecordIds.add(rec.sourceRecordId) // matched ⇒ never minted, recorded or not
    if (already.has(dedupeKey)) {
      result.alreadyRecorded++
      continue
    }
    already.add(dedupeKey)
    const strength: SignalStrength = classifyPermitStrength({
      description: rec ? `${rec.rawPayload?.title ?? ""}` : null,
      valuation: null,
    })
    toWrite.push({
      ...(match.entity === "contact" ? { contact_id: match.entityId } : { lead_id: match.entityId }),
      brokerage_id: brokerageId,
      signal_type: PERMIT_SIGNAL_TYPE,
      signal_strength: strength,
      detected_via: EXA_PERMIT_DETECTED_VIA,
      signal_details: {
        reason: "Permit / pre-listing activity found via Exa search at this lead's address",
        dedupe_key: dedupeKey,
        permit_address: match.permitAddress,
        entity: match.entity,
        address_key: match.addressKey,
        source_url: rec?.sourceUrl ?? null,
        intent_signals: rec?.intentSignals ?? [],
      },
    })
  }

  if (toWrite.length > 0) {
    const { data: inserted, error: insertError } = await supabase
      .from("motivated_seller_signals")
      .insert(toWrite)
      .select("id")
    if (insertError) {
      result.errors.push(`motivated_seller_signals insert refused: ${insertError.message}`)
    } else {
      result.attached = (inserted ?? []).length
      for (const row of toWrite) {
        if ((row as { contact_id?: string }).contact_id) result.attachedByEntity.contact++
        else result.attachedByEntity.lead++
      }
    }
  }

  // Every matched hit (attached this run OR already recorded) is pulled out of the
  // mint list — an owned address never mints a second, duplicate person.
  result.toMint = records.filter((r) => !matchedRecordIds.has(r.sourceRecordId))
  return result
}
