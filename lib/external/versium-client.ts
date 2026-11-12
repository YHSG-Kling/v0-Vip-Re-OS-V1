// lib/external/versium-client.ts
//
// VERSIUM REACH — Demographic Append API, `financial` output type ONLY. Built by lane 85C (wave 85);
// FINALIZED by lane 86A (wave 86) — owner deferred the credit-band provider to the integrator's
// recommendation, and Versium IS the credit-band provider ("credit provider → integrator recommends
// VERSIUM (built; key-gated; per match)").
//
// WHY THIS PROVIDER, AND WHY ONLY THIS OUTPUT (Exa research 2026-09-26 lane 85C, re-read 2026-09-27
// lane 86A — lane-86A notes):
//   · Of the four household attributes, three (marital status, household income, net worth) are
//     ALREADY BOUGHT from BatchData's `demographic` dataset (enrichment-column-map.ts HOUSEHOLD
//     FINANCIALS). No provider this repo already pays for sells a CREDIT band: PeopleData's person
//     schema has none, BatchData's 32 demographic fields have none.
//   · Versium's `financial` output ("Financial, Household and Auto Insights") returns `Credit Rating`
//     (a modeled band, e.g. "700-749"), `Household Income` and `Estimated Net Worth`
//     (api-documentation.versium.com/reference/api-output-1). Match credits are billed ONLY on a
//     match ("You are only charged for successful results … If there is no match, there is no cost"
//     — versium.com/pricing): $0.075–$0.05 pay-as-you-go (web only — no API), $0.05–$0.02 in credit
//     packages (API access included, from $250), under $0.02 on an annual subscription.
//     VERSIUM_MATCH_CREDIT_USD books the credit-package CEILING — the same don't-understate rule
//     peopledata-client.ts applies to PDL — and is the one price VENDOR_PRICING.versium mirrors.
//
// THE API CONTRACT (api-documentation.versium.com, read 2026-09-27):
//   · GET https://api.versium.com/v2/demographic?output[]=financial&<inputs>  (HTTPS only)
//   · Auth: header `x-versium-api-key` (case-sensitive key; "Authentication").
//   · Required inputs for `financial`: phone OR email OR (address + city/state/zip) OR
//     (first + last + city + state) OR (first + last + zip). country: only "US" is supported.
//     phone = 10-digit NANP; zip = 5-digit (ZIP+4 accepted).
//   · Config: cfg_maxrecs (default 1 — kept at 1: one household, one credit), rcfg_max_time
//     (seconds, the vendor-side run-time cap; set below the gateway's own timeout).
//   · Response: { versium: { match_counts: { financial: n }, num_matches, num_results, results: [ {
//     "Individual Level Match": "Yes"|"No", "Household Income", "Estimated Net Worth",
//     "Credit Rating", … } ] } }. Fields with no value are OMITTED.
//   · Status: 400 malformed / missing inputs · 401 invalid key · 402 match credits exhausted ·
//     403 account has no API access (pay-as-you-go) · 429 over 20 q/s (NOT re-processed — must be
//     re-sent; the gateway's one bounded GET retry covers it) · 500 vendor fault.
//   · BILLING UNIT = a match credit per MATCHED output type. The response's own
//     `match_counts.financial` is what was charged; this client books exactly that many credits, so
//     a match that carried none of the three fields this repo keeps is still booked (it was billed),
//     and a no-match books $0.
//
// FCRA: Versium is not a consumer reporting agency; `Credit Rating` is a MODELED marketing estimate.
// It is stored as a band only (normalizeModeledCreditBand) and carries credit_basis
// 'modeled_marketing_estimate'. It is SHOWN on the agent-facing contact card labelled "modeled
// estimate" (owner, wave 86: "add because most audience or info will be used from the contact
// card") and it NEVER feeds outbound copy, an eligibility / pricing / steering decision, or a
// persona trait — asserted with a positive control by scripts/enrichment-one-rail-guard.ts
// Layer 8d (the modeled-credit firewall).
//
// FAIL CLOSED: no VERSIUM_API_KEY → no network call, `{ data: null, cost: 0, skipped: "unconfigured" }`.
// Egress goes through the connector gateway (the single egress path), never a bare fetch.
//
// OWNER SETUP (what must happen before a single band lands — lane-86A notes §1):
//   1. Create a Versium REACH account (versium.com → Get an account; business verification unlocks
//      the free trial's API test credits).
//   2. Buy a CREDIT PACKAGE (from $250; pay-as-you-go has NO API access and would return 403).
//      Turn on auto-refill (Settings → Payment Details) or a 402 stops the rung when credits run out.
//   3. Settings → Manage API Keys → Create Key; optionally IP-restrict it to the Vercel egress.
//   4. Set VERSIUM_API_KEY in Vercel (Production + Preview). Nothing else: the budget gate, the
//      ledger booking and the provider order are already wired.

import { householdFinancialsFromVersium, buildVersiumDemographicProfile, fieldProvenanceStamp, type FieldProvenance, type HouseholdFinancials } from "@/lib/lead-pipeline/enrichment-column-map"

// ─── OUR CAPABILITY CONTRACT (wave 96, lane 96B — owner blueprint: "Versium behind OUR normalized
// capability contract, never raw vendor shapes leaking; provenance per field") ──────────────────
// Every public result below is OUR shape: normalized values + a provenance stamp. The raw Versium
// response body never leaves this file (appendVersiumDemographics used to hand its caller the raw
// result rows; it now maps them here through enrichment-column-map.ts::buildVersiumDemographicProfile,
// the ONE vocabulary, and returns the profile). Credentials are read HERE only (process.env.
// VERSIUM_API_KEY) — never a parameter, never in agent/tool context.

/** The capabilities this adapter serves, named as the platform asks for them (not as Versium's
 *  endpoints are named). The ledger rows a caller books carry the same name in metadata.capability.
 *  Wave 142 (lane 142D): + person.enrich_business_identity (the B2B2C crosswalk) and
 *  person.enrich_online_presence (the full-demographic real-estate indicators). */
type VersiumCapability =
  | "person.enrich_contact" | "person.enrich_demographics" | "person.enrich_financial" | "property.enrich_facts"
  | "person.enrich_business_identity" | "person.enrich_online_presence"
  // Wave 144 (lane 144E): the Online Audience MATCH + APPEND (hashed ad-platform identifiers onto the record) and the
  // ListGen ESTIMATE (a count — its provenance names this capability).
  | "person.enrich_online_audience" | "audience.estimate"

/** Provenance for a value this adapter returned — written beside the value where it is stored.
 *  Wave 100 (lane 100C): this shape is the SURVIVOR every provider now writes — it is THE
 *  FieldProvenance (enrichment-column-map.ts) narrowed to Versium's source / capability / match levels,
 *  and it is built through THE ONE writer (fieldProvenanceStamp) below. */
export interface VersiumProvenance extends FieldProvenance {
  source: "versium"
  capability: VersiumCapability
  /** ISO time the vendor answered. */
  retrievedAt: string
  /** "individual" = Versium matched the named person; "household" = only the household at the input's
   *  phone / email / address; null = Versium did not say (the contact output carries no level). */
  matchConfidence: "individual" | "household" | null
}

/** Whether the platform Versium credential is set — the ONE place outside a call that may look at it
 *  (callers skip a budget read when the rung cannot run). Never returns or forwards the key. */
export function isVersiumConfigured(): boolean {
  return !!process.env.VERSIUM_API_KEY
}

/** PURE — Versium's "Individual Level Match" flag → our match confidence (null when absent). */
function matchConfidenceOf(row: unknown): VersiumProvenance["matchConfidence"] {
  if (!row || typeof row !== "object") return null
  const raw = (row as Record<string, unknown>)["Individual Level Match"]
  if (raw === undefined || raw === null || String(raw).trim() === "") return null
  return String(raw).trim().toLowerCase() === "yes" ? "individual" : "household"
}

function provenance(capability: VersiumCapability, retrievedAt: string, row: unknown): VersiumProvenance {
  return fieldProvenanceStamp({ source: "versium", capability, purpose: "enrichment", retrievedAt, matchConfidence: matchConfidenceOf(row) }) as VersiumProvenance
}

/** One match credit — the credit-package ceiling (don't understate a bill). A no-match is free. */
export const VERSIUM_MATCH_CREDIT_USD = 0.05
/** Per MATCHED record on the `financial` output type: exactly one match credit. */
export const VERSIUM_FINANCIAL_MATCH_COST_USD = VERSIUM_MATCH_CREDIT_USD
export const VERSIUM_NO_MATCH_COST_USD = 0

// ─── WAVE 143 (lane 143D): THE OFFICIAL MATCH-CREDIT WEIGHTS — ONE TABLE, AND THE BILLS IT CORRECTS ────────
// Source (read 2026-10-23, Exa fetch): https://reach-help.versium.com/docs/match-value-conversion-table
// ("Match Credits Value Conversion Table") and the B2B2C output sample's Billing table
// (https://api-documentation.versium.com/reference/b2b2c-output-sample). A response's `match_counts` is the
// number of MATCHED outputs, NOT the credits: the B2B2C sample returns `business_email: 1` and bills it at 2.
// Until 143D this file booked `match_counts × 1 credit` everywhere, which under-booked two products by the
// published weight — a wrong number on the vendor ledger is a wrong cost (CLAUDE.md §5):
//   · full_demographic  — 3 credits per matched record (was booked as 1: a 3× under-booking), and
//   · B2B2C business_email — 2 credits per matched record (was booked as 1).
// One credit stays the credit-package CEILING (VERSIUM_MATCH_CREDIT_USD); a no-match is free.
export const VERSIUM_CREDIT_WEIGHTS = Object.freeze({
  contact_email: 1,
  contact_phone: 1,
  /** "Contact Append · Multi Email (via REACH API only)" — 1 per email returned. */
  contact_email_multi_per_email: 1,
  /** Demographic Append · each category (Basic / Household-Financial-Auto / Lifestyle / Political) — 1. */
  demographic_category: 1,
  /** "If you select 2 or more categories, REACH charges a maximum of 2 match credits per record." */
  demographic_multi_category_cap: 2,
  financial: 1,
  /** Demographic Append · Full Demographic Insights (via REACH API only) — 3. */
  full_demographic: 3,
  b2b2c_business_email: 2,
  b2b2c_consumer_mobile: 1,
  /** Per email address RETURNED ("two consumer emails cost two credits"). */
  b2b2c_consumer_email: 1,
  b2b2c_consumer_address: 1,
  /** Once per record that returns ANY consumer contact point; not charged for a business_email-only request. */
  b2b2c_crosswalk: 1,
  email_validation: 0.5,
  firmographic: 3,
  c2b: 3,
  ip2domain_firmographic: 3,
  hem_to_business_domain: 1,
  online_audience: 1,
  abm_business_email: 2,
  persona_business_email: 2,
  cab_per_contact_point: 1,
  cab_per_demographic_category: 1,
} as const)
export type VersiumCreditKey = keyof typeof VERSIUM_CREDIT_WEIGHTS

/** PURE — USD for a number of match credits at the credit-package ceiling (cents-rounded; zero credits are free). */
export function versiumCreditsUsd(credits: number): number {
  return credits > 0 ? Math.round(credits * VERSIUM_MATCH_CREDIT_USD * 100) / 100 : VERSIUM_NO_MATCH_COST_USD
}

const VERSIUM_API_BASE = "https://api.versium.com/v2"
/** Vendor-side run-time cap (seconds) — below the gateway's 15s per-attempt timeout so Versium
 *  answers "no match in time" instead of the socket dying mid-bill. */
const VERSIUM_MAX_TIME_SECONDS = "10"

export interface VersiumIdentity {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

/** PURE — the Versium search params for one identity, or null when it carries none of Versium's
 *  accepted input shapes (then nothing is asked and nothing is spent). */
export function versiumQueryFor(id: VersiumIdentity): Record<string, string> | null {
  const t = (v: string | null | undefined) => (typeof v === "string" ? v.trim() : "")
  const first = t(id.firstName), last = t(id.lastName), email = t(id.email)
  const phone = t(id.phone).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "")
  const address = t(id.address), city = t(id.city), state = t(id.state)
  // Versium takes a 5-digit ZIP (ZIP+4 accepted); anything else is not a ZIP and is not sent.
  const zipMatch = t(id.zip).match(/^(\d{5})(?:-?\d{4})?$/)
  const zip = zipMatch ? zipMatch[1] : ""
  const q: Record<string, string> = {}
  if (first && last) { q.first = first; q.last = last }
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) q.email = email
  if (phone.length === 10) q.phone = phone
  if (address) q.address = address
  if (city) q.city = city
  if (state) q.state = state
  if (zip) q.zip = zip
  const nameGeo = !!(q.first && q.last && ((q.city && q.state) || q.zip))
  const postal = !!(q.address && ((q.city && q.state) || q.zip))
  if (!(q.email || q.phone || nameGeo || postal)) return null
  q.country = "US"
  return q
}

/** The documented status codes, each named for what the operator must do (never a bare "HTTP 402"). */
export function versiumStatusProblem(status: number | null): string {
  switch (status) {
    case 400: return "versium 400: request malformed or missing a required input"
    case 401: return "versium 401: VERSIUM_API_KEY is invalid — create a new key under Settings → Manage API Keys"
    case 402: return "versium 402: match credits exhausted — buy a credit package or enable auto-refill"
    case 403: return "versium 403: this Versium account has no API access (pay-as-you-go is web-only) — a credit package or subscription is required"
    case 429: return "versium 429: over the 20 queries/second rate limit — the call was not processed"
    case null: return "versium: network error or timeout"
    default: return status >= 500 ? `versium ${status}: vendor fault` : `versium ${status}`
  }
}

export interface VersiumFinancialParse {
  /** The mapped household financials (only fields this repo keeps). */
  data: HouseholdFinancials | null
  /** Match credits Versium charged for this response (match_counts.financial; a result with no
   *  count is one match — the documented default of one record, one credit). */
  credits: number
  /** "individual" when Versium matched the named person, "household" when it matched only the
   *  household at the input's phone / email / address. Null on a no-match. */
  matchLevel: "individual" | "household" | null
}

/** PURE — one Versium demographic response body → what was bought and what it cost in credits. */
export function parseVersiumFinancialResponse(body: unknown): VersiumFinancialParse {
  const v = (body && typeof body === "object" ? (body as Record<string, any>).versium : null) ?? {}
  const results: unknown[] = Array.isArray(v.results) ? v.results : []
  const first = results[0]
  if (!first || typeof first !== "object") return { data: null, credits: 0, matchLevel: null }
  const counted = Number(v.match_counts?.financial)
  const credits = Number.isFinite(counted) && counted >= 0 ? counted : 1
  const ilm = String((first as Record<string, unknown>)["Individual Level Match"] ?? "").trim().toLowerCase()
  const matchLevel = ilm === "yes" ? "individual" : "household"
  const mapped = householdFinancialsFromVersium(first)
  return { data: Object.keys(mapped).length > 0 ? mapped : null, credits, matchLevel }
}

export interface VersiumFinancialResult {
  data: HouseholdFinancials | null
  cost: number
  /** Credits charged (cost = credits × VERSIUM_MATCH_CREDIT_USD). */
  credits?: number
  matchLevel?: "individual" | "household" | null
  /** Set when Versium returned mapped values (wave 96 — provenance per field). */
  provenance?: VersiumProvenance
  skipped?: "unconfigured" | "no_identity"
  error?: string
}

/** One Versium financial append. Never throws. */
export async function appendVersiumFinancial(id: VersiumIdentity): Promise<VersiumFinancialResult> {
  const apiKey = process.env.VERSIUM_API_KEY
  if (!apiKey) return { data: null, cost: 0, skipped: "unconfigured" }
  const query = versiumQueryFor(id)
  if (!query) return { data: null, cost: 0, skipped: "no_identity" }
  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const res = await callConnector<any>({
      connector: "versium",
      baseUrl: VERSIUM_API_BASE,
      path: "demographic",
      method: "GET",
      query: { ...query, "output[]": "financial", cfg_maxrecs: "1", rcfg_max_time: VERSIUM_MAX_TIME_SECONDS },
      auth: { style: "header", name: "x-versium-api-key", value: apiKey },
      timeoutMs: 15_000,
    })
    // A refused call bills nothing (402/401/403/429/4xx are refusals; a 5xx returns no result).
    if (!res.ok) return { data: null, cost: 0, error: `${versiumStatusProblem(res.status)}${res.error ? ` — ${res.error}` : ""}` }
    const parsed = parseVersiumFinancialResponse(res.data)
    return {
      data: parsed.data,
      cost: parsed.credits > 0 ? parsed.credits * VERSIUM_MATCH_CREDIT_USD : VERSIUM_NO_MATCH_COST_USD,
      credits: parsed.credits,
      matchLevel: parsed.matchLevel,
      ...(parsed.data ? { provenance: fieldProvenanceStamp({ source: "versium", capability: "person.enrich_financial", purpose: "enrichment", matchConfidence: parsed.matchLevel }) as VersiumProvenance } : {}),
    }
  } catch (e) {
    return { data: null, cost: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── CONTACT APPEND — owner/person EMAIL (+ PHONE) — wave 93, lane 93B2 ─────────────────────
// Owner cost decision (2026-10-01, relayed by the coordinator; owner: "make sure our platform is
// setup the most effective and cost effective"): VERSIUM FIRST for the owner/person email + phone
// append, People Data Labs only when Versium misses (PDL stays the PERSON-PROFILE provider). Versium
// is an EXISTING vendor (the financial append above), so this adds no vendor. Price
// (versium.com/pricing, Exa 2026-10-01): Contact Append = 1 match credit per MATCHED output type
// ($0.05 credit-package ceiling, $0.02 and lower at volume; a no-match is free) vs PDL $0.25/match.
//   · GET /v2/contact?output[]=email | output[]=phone (+ the inputs versiumQueryFor builds). ONE
//     output per request (the gateway query carries one value per key): a LEAD asks EMAIL only (leads
//     are email + direct mail — no SMS/voice to a lead), a CONTACT asks email, then phone only when it
//     has none. Each output is its own match credit either way.
//   · FIELD NAMES — VERIFIED 2026-10-23 (143D) against api-documentation.versium.com/reference/contact-
//     append-output-sample: output `email` → "Email Address"; output `phone` → "Phone" (+ "Line Type"); output
//     `phone_mobile` → "Mobile Phone"; every row may carry "Individual Level Match". The alternates the
//     parser still reads ("Email", "Phone Number", lower-case keys) are tolerance, not contract.
//     match_counts[output] is what was billed (VERSIUM_CREDIT_WEIGHTS), a match with no count is one credit.
//     TCPA: a `phone` output may be a LANDLINE — the caller's DNC / line-type scrub decides what may be dialled.
// FAIL CLOSED: no VERSIUM_API_KEY → { skipped: "unconfigured" } and the caller's chain runs as before.

export type VersiumContactOutput = "email" | "phone"

/** PURE — one Versium contact response → the contact points + the credits billed for this output. */
function parseVersiumContactResponse(body: unknown, output: VersiumContactOutput): { values: string[]; credits: number; firstRow: Record<string, unknown> | null } {
  const v = (body && typeof body === "object" ? (body as Record<string, any>).versium : null) ?? {}
  const results: Array<Record<string, unknown>> = Array.isArray(v.results)
    ? v.results.filter((r: unknown): r is Record<string, unknown> => !!r && typeof r === "object")
    : []
  const keys = output === "email" ? ["Email Address", "Email", "email"] : ["Phone", "Mobile Phone", "Phone Number", "phone"]
  const values: string[] = []
  let firstRow: Record<string, unknown> | null = null
  for (const r of results) for (const k of keys) {
    const raw = r[k]
    const s = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : ""
    const ok = output === "email" ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) : s.replace(/\D/g, "").length >= 10
    if (ok && !values.includes(s)) { values.push(s); firstRow ??= r }
  }
  if (values.length === 0) return { values, credits: 0, firstRow: null }
  const counted = Number(v.match_counts?.[output])
  return { values, credits: Number.isFinite(counted) && counted >= 0 ? counted : 1, firstRow }
}

export interface VersiumContactResult {
  emails: string[]
  phones: string[]
  matched: boolean
  /** USD billed (credits × VERSIUM_MATCH_CREDIT_USD); a no-match is $0. */
  cost: number
  credits: number
  /** Wave 96 — provenance per contact-point field that came back (email / phone). */
  provenance: Partial<Record<VersiumContactOutput, VersiumProvenance>>
  skipped?: "unconfigured" | "no_identity"
  error?: string
}

/** One Versium request (injectable so the proof runs with zero network). */
export type VersiumContactCall = (output: VersiumContactOutput, query: Record<string, string>) =>
  Promise<{ ok: boolean; status: number | null; data: unknown; error?: string | null }>

/** Versium contact append for ONE person. Never throws. `outputs` asked in order. */
export async function appendVersiumContact(
  id: VersiumIdentity,
  outputs: readonly VersiumContactOutput[],
  deps: { call?: VersiumContactCall } = {},
): Promise<VersiumContactResult> {
  const out: VersiumContactResult = { emails: [], phones: [], matched: false, cost: 0, credits: 0, provenance: {} }
  const apiKey = process.env.VERSIUM_API_KEY
  if (!apiKey && !deps.call) return { ...out, skipped: "unconfigured" }
  const query = versiumQueryFor(id)
  if (!query) return { ...out, skipped: "no_identity" }
  const call: VersiumContactCall = deps.call ?? (async (output, q) => {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    return callConnector<any>({
      connector: "versium",
      baseUrl: VERSIUM_API_BASE,
      path: "contact",
      method: "GET",
      query: { ...q, "output[]": output, cfg_maxrecs: "1", rcfg_max_time: VERSIUM_MAX_TIME_SECONDS },
      auth: { style: "header", name: "x-versium-api-key", value: apiKey as string },
      timeoutMs: 15_000,
    })
  })
  for (const output of outputs) {
    try {
      const res = await call(output, query)
      // A refused call bills nothing (402/401/403/429/4xx are refusals; a 5xx returns no result).
      if (!res.ok) { out.error = `${versiumStatusProblem(res.status)}${res.error ? ` — ${res.error}` : ""}`; continue }
      const parsed = parseVersiumContactResponse(res.data, output)
      out.credits += parsed.credits
      if (output === "email") out.emails.push(...parsed.values)
      else out.phones.push(...parsed.values)
      if (parsed.values.length > 0) out.provenance[output] = provenance("person.enrich_contact", new Date().toISOString(), parsed.firstRow)
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e)
    }
  }
  out.matched = out.emails.length > 0 || out.phones.length > 0
  out.cost = versiumCreditsUsd(out.credits)
  return out
}

// ─── DEMOGRAPHIC APPEND after a contact hit — wave 93, lane 93B3 ──────────────────────────────
// The categories PDL used to supply, bought from Versium instead (one match credit per category
// output, a no-match is free): GET /v2/demographic?output[]=demographic | output[]=financial. One
// request per category (one value per gateway query key), so each category is billed — and booked by
// the caller — on its own. The financial category is the SAME output appendVersiumFinancial buys for
// the household-financials rung. Every category is mapped HERE through
// enrichment-column-map.ts::buildVersiumDemographicProfile (one vocabulary) — wave 96 moved that map
// inside the adapter so no raw Versium row reaches a caller.

/** One Versium demographic request (injectable so the proof runs with zero network). */
export type VersiumDemographicCall = (output: "demographic" | "financial", query: Record<string, string>) =>
  Promise<{ ok: boolean; status: number | null; data: unknown; error?: string | null }>

export interface VersiumDemographicsResult {
  /** OUR profile (enrichment_profile vocabulary, provider 'versium', captured_at = retrievedAt) mapped
   *  from every category that matched — null when none did. Wave 96: this replaced the raw `results`
   *  rows the adapter used to return (the vendor's own field names leaked to the caller, which then
   *  mapped them itself). */
  profile: Record<string, any> | null
  /** The categories that matched (and were billed). */
  categories: Array<"demographic" | "financial">
  provenance: VersiumProvenance | null
  /** Credits charged per category (the response's own match_counts; a result with no count is one). */
  creditsByCategory: Partial<Record<"demographic" | "financial", number>>
  cost: number
  skipped?: "unconfigured" | "no_identity" | "nothing_to_buy"
  error?: string
}

/** Versium demographic append for ONE person, for the given categories only. Never throws. */
export async function appendVersiumDemographics(
  id: VersiumIdentity,
  categories: ReadonlyArray<"demographic" | "financial">,
  deps: { call?: VersiumDemographicCall } = {},
): Promise<VersiumDemographicsResult> {
  const out: VersiumDemographicsResult = { profile: null, categories: [], provenance: null, creditsByCategory: {}, cost: 0 }
  // The raw rows stay inside this function: mapped below, never returned.
  const rows: Partial<Record<"demographic" | "financial", Record<string, unknown>>> = {}
  if (categories.length === 0) return { ...out, skipped: "nothing_to_buy" }
  const apiKey = process.env.VERSIUM_API_KEY
  if (!apiKey && !deps.call) return { ...out, skipped: "unconfigured" }
  const query = versiumQueryFor(id)
  if (!query) return { ...out, skipped: "no_identity" }
  const call: VersiumDemographicCall = deps.call ?? (async (output, q) => {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    return callConnector<any>({
      connector: "versium",
      baseUrl: VERSIUM_API_BASE,
      path: "demographic",
      method: "GET",
      query: { ...q, "output[]": output, cfg_maxrecs: "1", rcfg_max_time: VERSIUM_MAX_TIME_SECONDS },
      auth: { style: "header", name: "x-versium-api-key", value: apiKey as string },
      timeoutMs: 15_000,
    })
  })
  let credits = 0
  for (const category of categories) {
    try {
      const res = await call(category, query)
      if (!res.ok) { out.error = `${versiumStatusProblem(res.status)}${res.error ? ` — ${res.error}` : ""}`; continue }
      const v = (res.data && typeof res.data === "object" ? (res.data as Record<string, any>).versium : null) ?? {}
      const first = Array.isArray(v.results) ? v.results.find((r: unknown) => !!r && typeof r === "object") : null
      if (!first) continue
      const counted = Number(v.match_counts?.[category])
      const c = Number.isFinite(counted) && counted >= 0 ? counted : 1
      rows[category] = first as Record<string, unknown>
      out.creditsByCategory[category] = c
      credits += c
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e)
    }
  }
  out.categories = Object.keys(rows) as Array<"demographic" | "financial">
  if (out.categories.length > 0) {
    const retrievedAt = new Date().toISOString()
    out.profile = buildVersiumDemographicProfile(rows, retrievedAt)
    out.provenance = provenance("person.enrich_demographics", retrievedAt, rows.demographic ?? rows.financial)
  }
  out.cost = versiumCreditsUsd(credits)
  return out
}

// ─── PROPERTY FACTS — GAP-ONLY (wave 139, lane 139D) ────────────────────────────────────────
// Owner (wave 138): "Versium (ALSO a property-data provider)". AUDITED against the official docs
// (api-documentation.versium.com/reference/api-output-1 "Demographic Output Sample" and
// /reference/data-dictionary "Available Data", read 2026-10-08 via Exa): Versium sells NO property
// record — no beds / baths / square feet / lot / APN / tax bill. What it does sell is the household
// block of the Demographic Append `financial` output ("Financial, Household and Auto Insights"),
// which accepts a postal ADDRESS alone (address + city/state or zip): `Home Year Built`,
// `Dwelling Type`, `Home Purchase Date`, plus `Home Purchase Price` / `Home Value` (RANGES, e.g.
// "$350,000-399,999"), `Home Market Value` (a modeled estimate) and mortgage fields. So Versium is a
// NARROW, GAP-ONLY property-facts source behind RentCast (primary) and BatchData (backup):
//   · mapped (exact values only): yearBuilt, propertyType (Dwelling Type), lastSaleDate (purchase date);
//   · NEVER mapped: any price / value / market value — a valuation belongs to property_valuation
//     (RentCast → BatchData, owner rulings) and a range is not a figure; and every person, credit or
//     household-financial field — an address-keyed answer describes the RESIDENT household, so it is
//     dropped here, inside the adapter (no raw row leaves this file).
// Same request, auth, billing unit and fail-closed rules as appendVersiumFinancial above (one match
// credit per matched `financial` output; a no-match is free).

/** The property facts Versium can fill — OUR shape, exact values only. */
interface VersiumPropertyFacts {
  yearBuilt: number | null
  propertyType: string | null
  /** ISO YYYY-MM-DD — only from a full 8-digit purchase date (a month-only date is never padded). */
  lastSaleDate: string | null
}

/** PURE — one Versium `financial` result row → the property facts it carries (null fields when absent).
 *  In-file only: scripts/provider-adapter-guard.ts (section O) asserts the mapping through
 *  appendVersiumPropertyFacts with an injected `call` (no value / price / person field is ever mapped). */
function versiumPropertyFactsFrom(row: unknown): VersiumPropertyFacts {
  const r = row && typeof row === "object" ? (row as Record<string, unknown>) : {}
  const text = (k: string) => (typeof r[k] === "string" || typeof r[k] === "number" ? String(r[k]).trim() : "")
  const yRaw = text("Home Year Built")
  const y = /^\d{4}$/.test(yRaw) ? Number(yRaw) : NaN
  const yearBuilt = Number.isInteger(y) && y >= 1700 && y <= new Date().getUTCFullYear() + 1 ? y : null
  const dwelling = text("Dwelling Type")
  const d = text("Home Purchase Date").replace(/-/g, "")
  const lastSaleDate = /^\d{8}$/.test(d) && Number(d.slice(4, 6)) >= 1 && Number(d.slice(4, 6)) <= 12 && Number(d.slice(6, 8)) >= 1 && Number(d.slice(6, 8)) <= 31
    ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null
  return { yearBuilt, propertyType: dwelling || null, lastSaleDate }
}

export interface VersiumPropertyFactsResult {
  /** null on a no-match or when the match carried none of the three facts. */
  facts: VersiumPropertyFacts | null
  /** Credits charged (match_counts.financial; a result row with no count is one credit). */
  credits: number
  /** USD billed (credits × VERSIUM_MATCH_CREDIT_USD) — the caller books it; a no-match is $0. */
  cost: number
  provenance: VersiumProvenance | null
  skipped?: "unconfigured" | "no_address"
  error?: string
}

/** Versium property facts for ONE postal address (never a person — no name / email / phone is sent).
 *  Never throws. */
export async function appendVersiumPropertyFacts(
  addr: { address: string | null; city: string | null; state: string | null; zip: string | null },
  deps: { call?: VersiumDemographicCall } = {},
): Promise<VersiumPropertyFactsResult> {
  const none: VersiumPropertyFactsResult = { facts: null, credits: 0, cost: 0, provenance: null }
  const apiKey = process.env.VERSIUM_API_KEY
  if (!apiKey && !deps.call) return { ...none, skipped: "unconfigured" }
  const query = versiumQueryFor({ address: addr.address, city: addr.city, state: addr.state, zip: addr.zip })
  if (!query || !query.address) return { ...none, skipped: "no_address" }
  const call: VersiumDemographicCall = deps.call ?? (async (output, q) => {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    return callConnector<any>({
      connector: "versium",
      baseUrl: VERSIUM_API_BASE,
      path: "demographic",
      method: "GET",
      query: { ...q, "output[]": output, cfg_maxrecs: "1", rcfg_max_time: VERSIUM_MAX_TIME_SECONDS },
      auth: { style: "header", name: "x-versium-api-key", value: apiKey as string },
      timeoutMs: 15_000,
    })
  })
  try {
    const res = await call("financial", query)
    // A refused call bills nothing (401/402/403/429/4xx are refusals; a 5xx returns no result).
    if (!res.ok) return { ...none, error: `${versiumStatusProblem(res.status)}${res.error ? ` — ${res.error}` : ""}` }
    const v = (res.data && typeof res.data === "object" ? (res.data as Record<string, any>).versium : null) ?? {}
    const first = Array.isArray(v.results) ? v.results.find((x: unknown) => !!x && typeof x === "object") : null
    if (!first) return none
    const counted = Number(v.match_counts?.financial)
    const credits = Number.isFinite(counted) && counted >= 0 ? counted : 1
    const f = versiumPropertyFactsFrom(first)
    const any = f.yearBuilt !== null || f.propertyType !== null || f.lastSaleDate !== null
    return {
      facts: any ? f : null,
      credits,
      cost: versiumCreditsUsd(credits),
      provenance: any ? provenance("property.enrich_facts", new Date().toISOString(), first) : null,
    }
  } catch (e) {
    return { ...none, error: e instanceof Error ? e.message : String(e) }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WAVE 142 (lane 142D) — THE VERSIUM PRODUCT AUDIT (owner: "audit real products — contact/business
// append, B2B2C identity matching, 'Online Presence Indicator - Real Estate' and other real-estate
// indicators, Versium REACH MCP, B2B2C data append. Verify every field against the real schema before
// relying on it.") Read 2026-10-19 through the research capability (Exa — versium.com and
// api-documentation.versium.com are not reachable from this environment's egress proxy):
//   · api-documentation.versium.com/reference/b2b2c-append-api      (the B2B2C Crosswalk Append API)
//   · versium.com/b2b2c-data-append/                                (the product + billing statement)
//   · versium.com/versium-reach-mcp/                                (the REACH MCP server)
//   · api-documentation.versium.com/reference/full-demographic-insights + /reference/output-sample-full-
//     demographic (the field list and a sample row — where "Online Presence Indicator - Real Estate" lives)
// What is VERIFIED is cited beside the code; what the pages did not show is marked UNRESOLVED and read
// defensively (an absent field stays absent — never guessed, never a mapped column).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * THE REACH MCP VERDICT — recorded as data so the decision is readable, not remembered.
 * versium.com/versium-reach-mcp (verified): endpoint https://app.versium.com/mcp/reach, Streamable HTTP,
 * "your agent must support OAuth dynamic client registration to securely connect to your Versium REACH
 * account"; tools = the SAME appends this adapter already calls over REST (Contact, Demographic,
 * Firmographic, C2B, IP-to-Domain), audience ESTIMATES (CAB / B2B list gen) and email validation; it
 * EXCLUDES "Online Audience Append", "ABM specific list generation" and "Look-alike specific list
 * generation". A server-side kernel capability cannot complete an interactive OAuth-DCR handshake, and
 * every append the MCP exposes is reachable through the REST contract behind the ONE egress
 * (connector-gateway) with a server key — so the MCP adds no supported value for the kernel today.
 * NOT WIRED (no duplicate rail; LAW 2). Revisit if Versium publishes a non-interactive credential for
 * the MCP or a CAB estimate REST endpoint the audience research could use.
 */
export const VERSIUM_REACH_MCP = Object.freeze({
  url: "https://app.versium.com/mcp/reach",
  transport: "streamable_http",
  auth: "oauth_dynamic_client_registration",
  wired: false,
  // 144E (2026-10-25): + data_prep — the same FAQ lists "Data Prep tools (Cleanse/Dedupe)" first among the exclusions.
  excludedByVendor: ["online_audience_append", "abm_list_generation", "lookalike_list_generation", "data_prep"] as const,
  verdict: "every append it exposes is the REST contract this adapter already calls through the connector gateway; the OAuth-DCR handshake is interactive, so it is not a server credential — not wired, no second rail",
  verifiedAt: "2026-10-19",
  source: "https://versium.com/versium-reach-mcp/",
  // ── WAVE 143 (lane 143D): THE MCP VERDICT, RE-PROVED AGAINST THE LIVE SERVER (2026-10-23) ──────────────────
  // The owner asked: connect the MCP through the existing governance IF a server-side credential model exists,
  // else WAITING_EXTERNAL with the exact reason. Two unauthenticated GETs and one unauthenticated POST against
  // the server (no credential sent) settle it:
  //   · GET  /.well-known/oauth-protected-resource/mcp/reach → { resource, authorization_servers:
  //          ["https://app.versium.com"], scopes_supported: ["mcp:use"] }
  //   · GET  /.well-known/oauth-authorization-server → authorization_endpoint /oauth/authorize, token_endpoint
  //          /oauth/token, registration_endpoint /oauth/register, response_types ["code"], code_challenge_methods
  //          ["S256"], grant_types ["authorization_code","refresh_token"] — NO client_credentials grant.
  //   · POST /mcp/reach (initialize, no credential) → 401 `WWW-Authenticate: Bearer realm="mcp",
  //          resource_metadata="…/oauth-protected-resource/mcp/reach"` — a Bearer token is required, and the only
  //          documented way to obtain one is the interactive authorization-code flow.
  // So there is NO server-side credential model: BatchData's MCP (lib/external/batchdata-mcp.ts) takes a static
  // server bearer; Versium's does not. Everything the MCP lists (Contact, Demographic, Firmographic, C2B,
  // IP-to-Domain, CAB estimates, email validation) is reachable by REST with the platform's x-versium-api-key,
  // so not wiring it loses NO capability — it would add a second, interactive-credential rail (LAW 2).
  status: "WAITING_EXTERNAL",
  oauth: Object.freeze({
    issuer: "https://app.versium.com",
    authorizationEndpoint: "https://app.versium.com/oauth/authorize",
    tokenEndpoint: "https://app.versium.com/oauth/token",
    registrationEndpoint: "https://app.versium.com/oauth/register",
    grantTypes: ["authorization_code", "refresh_token"] as const,
    pkce: "S256",
    scope: "mcp:use",
    clientCredentialsGrant: false,
    unauthenticatedInitialize: "401 WWW-Authenticate: Bearer realm=\"mcp\"",
  }),
  /** What must exist before this can be wired — each is a person or a purchase, never code. */
  waitingOn: [
    "a Versium REACH subscription with API access enabled (the MCP page: 'an active Versium REACH subscription with API access enabled') — the same account VERSIUM_API_KEY belongs to",
    "ONE interactive OAuth authorization-code consent by a human at app.versium.com/oauth/authorize (RFC 7591 dynamic client registration at /oauth/register, PKCE S256, scope mcp:use) to mint the refresh token",
    "the owner's decision whether the platform or each tenant owns the REACH subscription, and an encrypted per-owner refresh-token store (encryptSecret) — no such store exists for this provider",
  ] as const,
  /** If it is ever wired, reuse the survivor pattern — never a hand-rolled JSON-RPC body. */
  wiringPattern: "lib/external/batchdata-mcp.ts (@modelcontextprotocol/sdk Client + StreamableHTTPClientTransport) with an OAuthClientProvider over the encrypted refresh token; every tool call through routeCapability + checkVendorBudget + meterVendorSpend + withActionLedger",
  /** The vendor's own prompt library names look-alike RESEARCH as a supported use: "Based on these 10 best-performing
   *  customer profiles, use Versium to find the common demographic denominators." (versium.com/versium-reach-mcp, 2026-10-23) */
  vendorLookalikeResearchUse: "common demographic denominators of a customer list — research, not a targeting model",
  // ── WAVE 144 (lane 144E): RE-PROVED 2026-10-25, AND THE ACTUAL TOOL LIST ─────────────────────────────────────────────
  // The same three unauthenticated probes were re-run on 2026-10-25 and answered identically (protected-resource metadata
  // scopes ["mcp:use"]; authorization-server grant_types ["authorization_code","refresh_token"], PKCE S256, registration
  // endpoint /oauth/register; POST initialize → 401 `Bearer realm="mcp"`). Transport re-confirmed by the vendor
  // (reach-help.versium.com/docs/mcp-overview: "The agent must support the Streamable HTTP transport method and OAuth dynamic
  // client registration") and by the Glama registry's authenticated inspection ("Streamable HTTP · MCP 2025-11-25").
  reverifiedAt: "2026-10-25",
  /**
   * THE ACTUAL TOOL LIST. `tools/list` needs the Bearer token this platform cannot mint (above), so it is read from the two
   * published sources that DO hold an authenticated session: the vendor's MCP Server Overview ("Available Tools": Contact /
   * Demographic / Firmographic / C2B / IP-to-Domain Append, CAB + B2B List Generation Estimates, Email Validation, Search
   * Documentation — reach-help.versium.com/docs/mcp-overview, read 2026-10-25) and the Glama MCP registry's OAuth-authenticated
   * inspection, which enumerates "20 tools" with their annotations (glama.ai/mcp/connectors/com.versium.app/versium-reach,
   * last tested 2026-10-25). Every tool is mapped to the REST product of VERSIUM_PRODUCT_MATRIX that performs the same
   * operation, with the verdict that decides whether the MCP would add anything:
   *   REST_SURVIVOR      — the same operation is already WIRED over REST with the platform key (LAW 2: no second rail)
   *   SURVIVOR_ELSEWHERE — a cheaper provider already serves the capability (PeopleData validates e-mail)
   *   OWNER_DECISION     — spends credits on a purchased list (create_job bills "on completion") — a human approves money
   *   NO_CALLER          — available, no flow of this OS needs it (the matrix row names the trigger)
   *   NOT_APPLICABLE     — cannot serve a flow of this OS
   * None is NOT reachable by REST — so not wiring the MCP loses NO capability. The vendor's exclusions are VERIFIED ABSENT
   * from the list (no online-audience, look-alike-list, ABM-list or cleanse/dedupe tool); the guard asserts that by name.
   */
  tools: Object.freeze([
    { name: "contact_append", readOnly: true, product: "contact_append", verdict: "REST_SURVIVOR" },
    { name: "demographic_append", readOnly: true, product: "demographic_append", verdict: "REST_SURVIVOR" },
    { name: "b2b2c_append", readOnly: true, product: "b2b2c_append", verdict: "REST_SURVIVOR" },
    { name: "b2c_listgen_estimate", readOnly: true, product: "b2c_listgen_estimate", verdict: "REST_SURVIVOR" },
    { name: "b2c_listgen_options", readOnly: true, product: "b2c_listgen_estimate", verdict: "NO_CALLER" },
    { name: "b2b_listgen_estimate", readOnly: true, product: "abm_persona_listgen", verdict: "NO_CALLER" },
    { name: "b2b_listgen_options", readOnly: true, product: "abm_persona_listgen", verdict: "NO_CALLER" },
    { name: "c2b_append", readOnly: true, product: "b2b_append_family", verdict: "NO_CALLER" },
    { name: "firmographic_append", readOnly: true, product: "b2b_append_family", verdict: "NO_CALLER" },
    { name: "ip_to_domain_append", readOnly: true, product: "visitor_to_company", verdict: "NOT_APPLICABLE" },
    { name: "email_validation", readOnly: true, product: "email_validation", verdict: "SURVIVOR_ELSEWHERE" },
    { name: "create_job", readOnly: false, product: "b2c_listgen_job", verdict: "OWNER_DECISION" },
    { name: "job_status", readOnly: true, product: "b2c_listgen_job", verdict: "OWNER_DECISION" },
    { name: "create_project", readOnly: false, product: "b2c_listgen_job", verdict: "OWNER_DECISION" },
    { name: "list_projects", readOnly: true, product: "b2c_listgen_job", verdict: "OWNER_DECISION" },
    { name: "show_project", readOnly: true, product: "b2c_listgen_job", verdict: "OWNER_DECISION" },
    { name: "list_lists", readOnly: true, product: "b2c_listgen_job", verdict: "OWNER_DECISION" },
    { name: "show_list", readOnly: true, product: "b2c_listgen_job", verdict: "OWNER_DECISION" },
    { name: "preview_list", readOnly: true, product: "b2c_listgen_job", verdict: "OWNER_DECISION" },
    { name: "docs_search", readOnly: true, product: null, verdict: "NOT_APPLICABLE" },
  ] as const),
  toolListSources: ["https://reach-help.versium.com/docs/mcp-overview", "https://glama.ai/mcp/connectors/com.versium.app/versium-reach"] as const,
  toolListVerifiedAt: "2026-10-25",
})

// ─── B2B2C CROSSWALK APPEND — business identity ↔ consumer identity ───────────────────────────
// VERIFIED (api-documentation.versium.com/reference/b2b2c-append-api, read 2026-10-19):
//   · GET (or POST) https://api.versium.com/v2/b2b2cAppend — US-only ("Records outside the US return zero
//     results"); auth `x-versium-api-key`; "Access to this endpoint must also be enabled on your account;
//     a key without B2B2C access returns 400 with a list of the API groups it can reach."
//   · INPUTS (one combination required, else 400): `li_url` (a LinkedIn profile URL — "the most specific
//     identity signal available"; tried first when both are supplied) OR `first` + `last` + `city` +
//     `state`; optional `zip` (5-digit), `address` (refines the consumer email lookup), `country` (US).
//   · OUTPUTS (`output[]`, "Repeat the parameter once per requested output"): business_email ·
//     consumer_mobile ("Mobile lines only — landline and VoIP candidates are discarded") · consumer_email
//     · consumer_address. "Requesting any of the three consumer outputs runs the identity crosswalk.
//     `crosswalk` is not a selectable value — it is reported and charged automatically when a consumer
//     contact point is returned." "One request returns at most one result record."
//   · CONFIG: cfg_required (comma = AND, semicolon = OR; "If the requirement is not satisfied, the whole
//     response is a zero-result response and nothing is charged"), cfg_max_emails_b2c (1 default → 2;
//     "consumer email is charged per email address returned"), cfg_max_phones_b2c (1 → 2; "charged once
//     per matched record no matter how many numbers come back").
//   · BILLING (versium.com/b2b2c-data-append + the Output Sample's Billing table, 2026-10-23): business_email
//     2 credits per matched record · consumer_mobile 1 per matched record · consumer_email 1 per address
//     RETURNED · consumer_address 1 · crosswalk 1 once per record that returns ANY consumer contact point
//     (not charged for a business_email-only request, nothing for no data). The response's own
//     `match_counts` is the number of matched outputs; this client books Σ match_counts[k] × weight[k]
//     (VERSIUM_CREDIT_WEIGHTS) at the credit-package ceiling (don't understate a bill); a no-match books $0.
//   · ONE OUTPUT PER REQUEST: the ONE egress (connector-gateway `query: Record<string, string>`) carries
//     one value per key, exactly as the contact append above; the default ask is consumer_email ONLY
//     (one crosswalk, one data point) — the identity-matching key the scanner dedups on. Each EXTRA output
//     is its own request and re-pays the crosswalk (the documented repeat of `output[]` would share it —
//     an extension the gateway owner can make; see lane 143D notes, Outside-lane).
//   · RESULT ROW FIELD NAMES — VERIFIED 2026-10-23 (143D) against
//     api-documentation.versium.com/reference/b2b2c-output-sample (the 142D "UNRESOLVED" item, closed):
//       business_email   → `EmailAddrJSONB2B`  array of { EmailAddr }
//       consumer_mobile  → `PhoneJSONB2C`      array of { Phone, LineType, Carrier?, CarrierParent?, CustomerType?, PaymentType? }
//       consumer_email   → `EmailAddrJSONB2C`  array of { EmailAddr }
//       consumer_address → `AddressB2C` · `CityB2C` · `StateB2C` · `ZipB2C` · `CountryB2C`  (flat scalars)
//     "Empty fields and empty collections are omitted"; "Collections are always JSON arrays, never JSON-
//     encoded strings". The parser reads ONLY these names (the pre-143D parser read guessed names —
//     "Business Email", "Consumer Mobile", … — that no documented response carries, so a real match would
//     have parsed to nothing and been billed for nothing). A billed match whose row carries none of the
//     documented names is reported as `b2b2c_schema_drift`, never read as "no match".

export type VersiumB2B2COutput = "business_email" | "consumer_mobile" | "consumer_email" | "consumer_address"
export const VERSIUM_B2B2C_OUTPUTS: readonly VersiumB2B2COutput[] = ["business_email", "consumer_mobile", "consumer_email", "consumer_address"]

export interface VersiumB2B2CIdentity {
  /** A LinkedIn profile URL — satisfies the input rule alone. */
  linkedinUrl?: string | null
  firstName?: string | null
  lastName?: string | null
  city?: string | null
  /** Two-letter US state. */
  state?: string | null
  zip?: string | null
  address?: string | null
}

/** PURE — the documented input combinations, or null (nothing asked, nothing spent). */
export function versiumB2B2CQueryFor(id: VersiumB2B2CIdentity): Record<string, string> | null {
  const t = (v: string | null | undefined) => (typeof v === "string" ? v.trim() : "")
  const li = t(id.linkedinUrl)
  const first = t(id.firstName), last = t(id.lastName), city = t(id.city), state = t(id.state).toUpperCase()
  const q: Record<string, string> = {}
  if (/^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/in\/[^\s/?#]+/i.test(li)) q.li_url = li
  if (first && last && city && /^[A-Z]{2}$/.test(state)) { q.first = first; q.last = last; q.city = city; q.state = state }
  if (!q.li_url && !q.first) return null
  const zipMatch = t(id.zip).match(/^(\d{5})(?:-?\d{4})?$/)
  if (zipMatch) q.zip = zipMatch[1]
  if (t(id.address)) q.address = t(id.address)
  q.country = "US"
  return q
}

export interface VersiumB2B2CResult {
  businessEmails: string[]
  consumerEmails: string[]
  consumerMobiles: string[]
  consumerAddress: { address: string | null; city: string | null; state: string | null; zip: string | null } | null
  matched: boolean
  /** Match credits billed: Σ match_counts[k] × VERSIUM_CREDIT_WEIGHTS[k] (outputs + the counted crosswalk). */
  credits: number
  cost: number
  provenance: Partial<Record<VersiumB2B2COutput, VersiumProvenance>>
  skipped?: "unconfigured" | "no_identity"
  error?: string
}

/** One B2B2C request (injectable so the proof runs with zero network). */
export type VersiumB2B2CCall = (output: VersiumB2B2COutput, query: Record<string, string>) =>
  Promise<{ ok: boolean; status: number | null; data: unknown; error?: string | null }>

/** The credit weight of each B2B2C `match_counts` key (VERSIUM_CREDIT_WEIGHTS — the published table). */
const B2B2C_COUNT_WEIGHT: Readonly<Record<string, number>> = Object.freeze({
  business_email: VERSIUM_CREDIT_WEIGHTS.b2b2c_business_email,
  consumer_mobile: VERSIUM_CREDIT_WEIGHTS.b2b2c_consumer_mobile,
  consumer_email: VERSIUM_CREDIT_WEIGHTS.b2b2c_consumer_email,
  consumer_address: VERSIUM_CREDIT_WEIGHTS.b2b2c_consumer_address,
  crosswalk: VERSIUM_CREDIT_WEIGHTS.b2b2c_crosswalk,
})

/**
 * PURE — the WORST-CASE match credits ONE B2B2C request for `output` can bill (cfg_max_emails_b2c /
 * cfg_max_phones_b2c are pinned to 1 by the call below): the output's own weight, plus the crosswalk
 * for any consumer output. The pre-flight budget gate asks for exactly this BEFORE a credit is spent.
 */
function versiumB2B2CRequestCredits(output: VersiumB2B2COutput): number {
  return B2B2C_COUNT_WEIGHT[output] + (output === "business_email" ? 0 : VERSIUM_CREDIT_WEIGHTS.b2b2c_crosswalk)
}

/** PURE — the worst-case credits for a list of outputs (one request each; each consumer request re-pays the crosswalk). */
export function versiumB2B2CWorstCaseCredits(outputs: readonly VersiumB2B2COutput[]): number {
  return outputs.filter((o) => VERSIUM_B2B2C_OUTPUTS.includes(o)).reduce((sum, o) => sum + versiumB2B2CRequestCredits(o), 0)
}

/** PURE — one B2B2C `match_counts` object → the credits it bills (Σ count × published weight; unknown keys ignored). */
function versiumB2B2CCreditsFromCounts(counts: unknown): number {
  if (!counts || typeof counts !== "object") return 0
  let credits = 0
  for (const [k, w] of Object.entries(B2B2C_COUNT_WEIGHT)) {
    const n = Number((counts as Record<string, unknown>)[k])
    if (Number.isFinite(n) && n > 0) credits += n * w
  }
  return credits
}

/**
 * PURE — one b2b2cAppend response, one output → the values it carried + the credits billed. Reads ONLY the
 * documented names (header block above). `drift` is true when the vendor BILLED a match (match_counts > 0 or a
 * result row exists) but the row carries none of the names this output is documented to use.
 */
function parseVersiumB2B2CResponse(body: unknown, output: VersiumB2B2COutput): {
  values: string[]; address: VersiumB2B2CResult["consumerAddress"]; credits: number; row: Record<string, unknown> | null; drift: boolean
} {
  const v = (body && typeof body === "object" ? (body as Record<string, any>).versium : null) ?? {}
  const results: Array<Record<string, unknown>> = Array.isArray(v.results)
    ? v.results.filter((r: unknown): r is Record<string, unknown> => !!r && typeof r === "object")
    : []
  const row = results[0] ?? null
  const scalar = (r: Record<string, unknown>, key: string): string => {
    const raw = r[key]
    return typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : ""
  }
  /** A documented array-of-objects collection → the string at `field` of each item. */
  const collect = (r: Record<string, unknown>, collection: string, field: string, accept: (item: Record<string, unknown>, s: string) => boolean = () => true): string[] => {
    const arr = r[collection]
    if (!Array.isArray(arr)) return []
    const out: string[] = []
    for (const item of arr) {
      if (!item || typeof item !== "object") continue
      const s = scalar(item as Record<string, unknown>, field)
      if (s && accept(item as Record<string, unknown>, s) && !out.includes(s)) out.push(s)
    }
    return out
  }
  const emailOk = (_: Record<string, unknown>, s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
  // "Mobile lines only — landline and VoIP candidates are discarded" (vendor); defence in depth: an item that
  // STATES a non-mobile line type is dropped here too.
  const mobileOk = (item: Record<string, unknown>, s: string) => s.replace(/\D/g, "").length >= 10 && (!scalar(item, "LineType") || /mobile|wireless|cell/i.test(scalar(item, "LineType")))
  const values: string[] = []
  let address: VersiumB2B2CResult["consumerAddress"] = null
  if (row) {
    if (output === "consumer_address") {
      const street = scalar(row, "AddressB2C"), city = scalar(row, "CityB2C"), state = scalar(row, "StateB2C"), zip = scalar(row, "ZipB2C")
      if (street || city || state || zip) address = { address: street || null, city: city || null, state: state || null, zip: zip || null }
    } else if (output === "business_email") values.push(...collect(row, "EmailAddrJSONB2B", "EmailAddr", emailOk).map((e) => e.toLowerCase()))
    else if (output === "consumer_email") values.push(...collect(row, "EmailAddrJSONB2C", "EmailAddr", emailOk).map((e) => e.toLowerCase()))
    else values.push(...collect(row, "PhoneJSONB2C", "Phone", mobileOk))
  }
  const answered = values.length > 0 || !!address
  // What the vendor billed comes from ITS match_counts — independent of whether we could read the row — and a
  // billed match must never parse to "free": if it counted something we booked it (the financial parser's rule).
  const counted = versiumB2B2CCreditsFromCounts(v.match_counts)
  const billed = counted > 0 || answered
  const credits = counted > 0
    ? counted
    : answered ? versiumB2B2CRequestCredits(output) : 0 // no counts but a documented value: the published default for ONE record
  return { values, address, credits, row: answered ? row : null, drift: billed && !answered && !!row }
}

/** Versium B2B2C crosswalk for ONE business identity. `outputs` asked in order, one request each. Never throws. */
export async function appendVersiumB2B2C(
  id: VersiumB2B2CIdentity,
  outputs: readonly VersiumB2B2COutput[] = ["consumer_email"],
  deps: { call?: VersiumB2B2CCall } = {},
): Promise<VersiumB2B2CResult> {
  const out: VersiumB2B2CResult = { businessEmails: [], consumerEmails: [], consumerMobiles: [], consumerAddress: null, matched: false, credits: 0, cost: 0, provenance: {} }
  const apiKey = process.env.VERSIUM_API_KEY
  if (!apiKey && !deps.call) return { ...out, skipped: "unconfigured" }
  const query = versiumB2B2CQueryFor(id)
  if (!query) return { ...out, skipped: "no_identity" }
  const call: VersiumB2B2CCall = deps.call ?? (async (output, q) => {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    return callConnector<any>({
      connector: "versium",
      baseUrl: VERSIUM_API_BASE,
      path: "b2b2cAppend",
      method: "GET",
      // cfg_required = the output asked: a response that cannot carry it is a zero-result response and
      // "nothing is charged" (documented) — never a credit for an empty crosswalk.
      query: { ...q, "output[]": output, cfg_required: output, cfg_max_emails_b2c: "1", cfg_max_phones_b2c: "1", rcfg_max_time: VERSIUM_MAX_TIME_SECONDS },
      auth: { style: "header", name: "x-versium-api-key", value: apiKey as string },
      timeoutMs: 15_000,
    })
  })
  for (const output of outputs) {
    if (!VERSIUM_B2B2C_OUTPUTS.includes(output)) continue
    try {
      const res = await call(output, query)
      // A refused call bills nothing (400 incl. "no B2B2C access" / 401 / 402 / 429 are refusals; a 5xx returns no result).
      if (!res.ok) { out.error = `${versiumStatusProblem(res.status)}${res.error ? ` — ${res.error}` : ""}`; continue }
      const parsed = parseVersiumB2B2CResponse(res.data, output)
      out.credits += parsed.credits
      if (output === "business_email") out.businessEmails.push(...parsed.values)
      else if (output === "consumer_email") out.consumerEmails.push(...parsed.values)
      else if (output === "consumer_mobile") out.consumerMobiles.push(...parsed.values)
      else if (parsed.address) out.consumerAddress = parsed.address
      if (parsed.row) out.provenance[output] = provenance("person.enrich_business_identity", new Date().toISOString(), parsed.row)
      if (parsed.drift) out.error = `b2b2c_schema_drift: the vendor billed a ${output} match whose row carries none of the documented names (api-documentation.versium.com/reference/b2b2c-output-sample)`
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e)
    }
  }
  out.matched = out.businessEmails.length > 0 || out.consumerEmails.length > 0 || out.consumerMobiles.length > 0 || !!out.consumerAddress
  out.cost = versiumCreditsUsd(out.credits)
  return out
}

// ─── ONLINE PRESENCE / REAL-ESTATE INDICATORS — the `full_demographic` output ──────────────────
// VERIFIED (api-documentation.versium.com/reference/full-demographic-insights — the field list; and
// /reference/output-sample-full-demographic — `match_counts: { full_demographic: 1 }`, results[0] keyed
// by the display names below, "Yes"/"No" on indicator fields; read 2026-10-19):
//   · GET /v2/demographic?output[]=full_demographic — the same inputs (versiumQueryFor), auth and config
//     as every other demographic output; a no-match is free. BILLING — PUBLISHED, 2026-10-23 (143D; the
//     142D note said "not published"): the Match Credits Value Conversion Table lists "Demographic Append ·
//     Full Demographic Insights (via REACH API only) = 3 match credits" (VERSIUM_CREDIT_WEIGHTS.full_demographic),
//     so one matched record bills `match_counts.full_demographic × 3` credits. Booked at that weight (it
//     was booked as ONE credit — a 3× under-booking on the vendor ledger).
//   · THE FIELDS THIS REPO KEEPS — each name verbatim from the field list, each a property / behaviour
//     fact: "Online Presence Indicator - Real Estate" (the owner's named indicator — the person's
//     observed online real-estate activity), "Investing Real Estate", "Investing Estimated Residential
//     Properties Owned", "Home Own or Rent", "Length of Residence", "Home Sales Transaction",
//     "Business Owner", "Small Office or Home Office", "Home Improvement", "Lifestyles Home Improvement",
//     "Decorating and Furnishing", "Mortgage Purchase Date", "Refinance Date", "Online Purchasing Indicator".
//   · PROTECTED CHARACTERISTICS NEVER LEAVE THIS FILE (fair housing; owner: "respect consent, fair
//     housing, protected characteristics and platform ad policies"). The full output ALSO carries race /
//     ethnicity ("Ethnicity", "Ethnic Group", "African American Professional", "Assimilation"), religion
//     ("Religion", "Christian Families", "Religious …"), national origin / language ("Language"),
//     familial status ("Presence of Children", "Number of Children", "Single Parent", "Generations In
//     Household", "Grandchildren", "Parenting", every "… in Household" age band), sex ("Gender",
//     "Working Woman in Household"), age ("DOB", "Age Range", "Senior in Household", "Young Adult …"),
//     disability-adjacent health fields, "Veteran In Household" and "Party Affiliation". The mapper reads
//     ONLY the allow-list above and the raw row is never returned — a research/intent signal, never a
//     targeting segment (lookalike-audience.ts carries the ad-policy verdict). WAVE 145 (145F, owner
//     ruling 12): those protected fields are no longer thrown away — they leave ONLY in the segregated
//     `protectedResearch` field (vendor-modeled, research-only; see versiumProtectedResearchFrom below).

/** The real-estate indicators Versium's full demographic output carries — OUR shape, booleans and plain values only. */
export interface VersiumRealEstateIndicators {
  /** "Online Presence Indicator - Real Estate" — observed online real-estate activity. */
  onlinePresenceRealEstate: boolean | null
  /** "Investing Real Estate". */
  investingRealEstate: boolean | null
  /** "Investing Estimated Residential Properties Owned" (an integer when stated). */
  residentialPropertiesOwned: number | null
  /** "Home Own or Rent" → owner | renter. */
  homeOwnRent: "owner" | "renter" | null
  /** "Length of Residence" (the vendor's band, e.g. "15+ Years"). */
  lengthOfResidence: string | null
  /** "Home Sales Transaction" (e.g. "Resale"). */
  homeSalesTransaction: string | null
  /** "Business Owner" / "Small Office or Home Office" — either flag. */
  businessOwner: boolean | null
  /** "Home Improvement" / "Lifestyles Home Improvement" / "Decorating and Furnishing" — any flag. */
  homeImprovementInterest: boolean | null
  /** "Online Purchasing Indicator". */
  onlinePurchasing: boolean | null
  /** "Mortgage Purchase Date" → ISO YYYY-MM-DD (full 8-digit dates only). */
  mortgagePurchaseDate: string | null
  /** "Refinance Date" → ISO YYYY-MM-DD (full 8-digit dates only). */
  refinanceDate: string | null
}

/** A field name that names a protected characteristic (or an age/household band) — never mapped onto an indicator. */
const VERSIUM_PROTECTED_CLASS_FIELD = /ethnic|religio|christian|african american|assimilation|\blanguage\b|children|single parent|generations|grandchildren|parenting|in household|household rank|gender|working woman|\bdob\b|age range|senior|young adult|veteran|party affiliation|health|dieting|disab/i

// ── WAVE 145 (lane 145F — owner ruling 12: "no protected fair housing protected attributes holding back any enrichment syncing as it
// is a major road block when needing that research"). The protected fields of the SAME paid row used to be DISCARDED here. They now
// leave this adapter in ONE segregated field — `protectedResearch` — and nowhere else: never on `indicators`, never on the
// provenance, never re-mapped onto a contacts column. Its ONE consumer is the research store (lib/enrichment/protected-research-store.ts
// → public.protected_research_attributes, m864: RLS, service-role writes, research reads only). Every value is VENDOR-MODELED
// (Versium's own word for these fields) — stored with that basis, never presented as a fact about the person. ──

/** The protected class a Versium field bears (one vocabulary — m864's attribute_class CHECK). Order matters: "Veteran In Household"
 *  is military status, not household composition. */
const VERSIUM_PROTECTED_CLASS_OF: ReadonlyArray<readonly [RegExp, VersiumProtectedClass]> = [
  [/veteran/i, "military_status"],
  [/ethnic|african american|assimilation/i, "race_color_national_origin"],
  [/\blanguage\b/i, "language"],
  [/religio|christian/i, "religion"],
  [/gender|working woman/i, "sex"],
  [/\bdob\b|age range|senior|young adult/i, "age"],
  [/children|single parent|generations|grandchildren|parenting|in household|household rank/i, "familial_status"],
  [/party affiliation/i, "political_affiliation"],
  [/health|dieting|disab/i, "disability_health"],
]

export type VersiumProtectedClass = "race_color_national_origin" | "language" | "religion" | "familial_status" | "sex" | "age" | "disability_health" | "military_status" | "political_affiliation"

/** One protected field of a paid row — research-only; the vendor's verbatim field name, its value, the class it bears. */
export interface VersiumProtectedResearchField {
  sourceField: string
  value: string
  protectedClass: VersiumProtectedClass
  basis: "vendor_modeled"
}

/** PURE — the protected fields of one full_demographic row (non-empty values only), for the segregated research store. */
function versiumProtectedResearchFrom(row: unknown): VersiumProtectedResearchField[] {
  const r = row && typeof row === "object" ? (row as Record<string, unknown>) : {}
  const out: VersiumProtectedResearchField[] = []
  for (const [k, v] of Object.entries(r)) {
    if (!VERSIUM_PROTECTED_CLASS_FIELD.test(k)) continue
    const value = typeof v === "string" || typeof v === "number" ? String(v).trim() : ""
    if (!value) continue
    const cls = VERSIUM_PROTECTED_CLASS_OF.find(([re]) => re.test(k))?.[1]
    if (cls) out.push({ sourceField: k.slice(0, 120), value: value.slice(0, 200), protectedClass: cls, basis: "vendor_modeled" })
  }
  return out
}

/** PURE — the allow-listed facts from one full_demographic row; everything protected is never read. */
function versiumRealEstateIndicatorsFrom(row: unknown): VersiumRealEstateIndicators {
  const r = row && typeof row === "object" ? (row as Record<string, unknown>) : {}
  const get = (k: string): string => {
    if (VERSIUM_PROTECTED_CLASS_FIELD.test(k)) return "" // belt and braces: an allow-list key can never be a protected one
    const v = r[k]
    return typeof v === "string" || typeof v === "number" ? String(v).trim() : ""
  }
  const yn = (k: string): boolean | null => { const s = get(k).toLowerCase(); return s === "yes" || s === "y" || s === "true" ? true : s === "no" || s === "n" || s === "false" ? false : null }
  const anyYes = (...ks: string[]): boolean | null => { const vals = ks.map(yn); return vals.some((v) => v === true) ? true : vals.every((v) => v === null) ? null : false }
  const int = (k: string): number | null => { const s = get(k).replace(/[^\d]/g, ""); return s ? Number(s) : null }
  const isoDate = (k: string): string | null => {
    const d = get(k).replace(/-/g, "")
    return /^\d{8}$/.test(d) && Number(d.slice(4, 6)) >= 1 && Number(d.slice(4, 6)) <= 12 && Number(d.slice(6, 8)) >= 1 && Number(d.slice(6, 8)) <= 31
      ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null
  }
  const own = get("Home Own or Rent").toLowerCase()
  return {
    onlinePresenceRealEstate: yn("Online Presence Indicator - Real Estate"),
    investingRealEstate: yn("Investing Real Estate"),
    residentialPropertiesOwned: int("Investing Estimated Residential Properties Owned"),
    homeOwnRent: own ? (/rent/.test(own) ? "renter" : /own/.test(own) ? "owner" : null) : null,
    lengthOfResidence: get("Length of Residence") || null,
    homeSalesTransaction: get("Home Sales Transaction") || null,
    businessOwner: anyYes("Business Owner", "Small Office or Home Office"),
    homeImprovementInterest: anyYes("Home Improvement", "Lifestyles Home Improvement", "Decorating and Furnishing"),
    onlinePurchasing: yn("Online Purchasing Indicator"),
    mortgagePurchaseDate: isoDate("Mortgage Purchase Date"),
    refinanceDate: isoDate("Refinance Date"),
  }
}

export interface VersiumRealEstateIndicatorsResult {
  /** null on a no-match or when the match carried none of the allow-listed facts. */
  indicators: VersiumRealEstateIndicators | null
  credits: number
  cost: number
  provenance: VersiumProvenance | null
  /** Wave 145 (ruling 12): the SAME row's protected fields — SEGREGATED, research-only (protected-research-store.ts); empty on a no-match. */
  protectedResearch: VersiumProtectedResearchField[]
  skipped?: "unconfigured" | "no_identity"
  error?: string
}

/** One full_demographic request (injectable so the proof runs with zero network). */
export type VersiumFullDemographicCall = (output: "full_demographic", query: Record<string, string>) =>
  Promise<{ ok: boolean; status: number | null; data: unknown; error?: string | null }>

/** Versium real-estate / online-presence indicators for ONE person. Never throws; no raw row leaves. */
export async function appendVersiumRealEstateIndicators(
  id: VersiumIdentity,
  deps: { call?: VersiumFullDemographicCall } = {},
): Promise<VersiumRealEstateIndicatorsResult> {
  const none: VersiumRealEstateIndicatorsResult = { indicators: null, credits: 0, cost: 0, provenance: null, protectedResearch: [] }
  const apiKey = process.env.VERSIUM_API_KEY
  if (!apiKey && !deps.call) return { ...none, skipped: "unconfigured" }
  const query = versiumQueryFor(id)
  if (!query) return { ...none, skipped: "no_identity" }
  const call: VersiumFullDemographicCall = deps.call ?? (async (output, q) => {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    return callConnector<any>({
      connector: "versium",
      baseUrl: VERSIUM_API_BASE,
      path: "demographic",
      method: "GET",
      query: { ...q, "output[]": output, cfg_maxrecs: "1", rcfg_max_time: VERSIUM_MAX_TIME_SECONDS },
      auth: { style: "header", name: "x-versium-api-key", value: apiKey as string },
      timeoutMs: 15_000,
    })
  })
  try {
    const res = await call("full_demographic", query)
    if (!res.ok) return { ...none, error: `${versiumStatusProblem(res.status)}${res.error ? ` — ${res.error}` : ""}` }
    const v = (res.data && typeof res.data === "object" ? (res.data as Record<string, any>).versium : null) ?? {}
    const first = Array.isArray(v.results) ? v.results.find((x: unknown) => !!x && typeof x === "object") : null
    if (!first) return none
    const counted = Number(v.match_counts?.full_demographic)
    const credits = (Number.isFinite(counted) && counted >= 0 ? counted : 1) * VERSIUM_CREDIT_WEIGHTS.full_demographic
    const ind = versiumRealEstateIndicatorsFrom(first)
    const any = Object.values(ind).some((x) => x !== null)
    const protectedResearch = versiumProtectedResearchFrom(first)
    return {
      indicators: any ? ind : null,
      credits,
      cost: versiumCreditsUsd(credits),
      // The provenance stamp describes the MATCH (capability, time, match level) — never a field value; it rides the research rows too.
      provenance: any || protectedResearch.length > 0 ? provenance("person.enrich_online_presence", new Date().toISOString(), first) : null,
      protectedResearch,
    }
  } catch (e) {
    return { ...none, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── ONLINE AUDIENCE APPEND — a MATCH, then an APPEND of hashed ad-platform identifiers (wave 144, lane 144E) ──────────
// OWNER (wave 144, ruling 10): "`online_audience_append` is NOT targeting: it matches contacts' online profiles (if any) and
// appends matched online contact identifiers (hashed/alternate IDs per the real schema) to the platform record; downstream ad
// targeting is a separate governed action; appended ad-tech identifiers are never fed to email/SMS as permissioned addresses."
// Wave 143 (143D) filed this product POLICY_GATED as "TARGETING plumbing, not research" and built no client. That was the
// misreading this section corrects: the call targets nobody — it answers "which online identifiers belong to a person we
// already hold", and the record keeps the answer. Targeting stays where it always was: lib/kernel/ads.ts syncAudience, behind
// the audience's consent basis, the fair-housing refusal and the persona basis.
//
// VERIFIED 2026-10-25 (Exa fetch of the vendor's own pages):
//   · api-documentation.versium.com/reference/online-audience-append-api-new — GET https://api.versium.com/v2/onlineAudience;
//     CONSUMER inputs: email | phone | address+city+state+zip | first+last+city+state | first+last+zip (the shapes
//     versiumQueryFor already builds); cfg_maxrecs (1 default → 100), rcfg_max_time, rcfg_oa_services[] (facebook · google ·
//     linkedin · generic · adroll · original; liveramp / stackadapt "requires permission"; default "every service"). "The API
//     will first transform the string to lowercase and then perform the hashing" — SHA-256 everywhere except AdRoll (MD5).
//     Legacy endpoints b2cOnlineAudience / b2bOnlineAudience "will continue to work" — not used (one endpoint, §6).
//   · /reference/output-sample-new — `match_counts: { online_audience: 1 }`; results[0] = { adroll:[{email:[md5…]}],
//     facebook:[{email, phone, fn, ln, fi, ct, st, country, zip}], generic:[{email}, …], google:[{Email, Phone, "First Name",
//     "Last Name", Zip, Country}], linkedin:[{email, firstname, lastname, jobtitle, employeecompany, country, appleidfa,
//     googleaid}], tiktok:[{email, phone}], original:[{email}] } — every leaf an ARRAY of strings; "output fields with no value
//     do not show up". In the vendor's own sample Google's Zip / Country and LinkedIn's names / title / company / country come
//     back in PLAINTEXT.
//   · reach-help.versium.com/docs/create-an-online-audience — the identifiers are "alternate and online emails that have been
//     linked to the person online, and may include historical contact points … useful in display-ad targeting … They are not
//     appropriate for direct email campaigns." Hence the firewall below.
//   · reach-help.versium.com/docs/match-value-conversion-table — "Online Audience Append · Digital Audience = 1" match credit
//     (VERSIUM_CREDIT_WEIGHTS.online_audience), billed per matched record; a no-match is free.
//   · versium.com/versium-reach-mcp + reach-help.versium.com/docs/mcp-overview — EXCLUDED from the REACH MCP, so this REST call
//     is the only supported interface (VERSIUM_REACH_MCP.excludedByVendor).
//
// WHAT THIS ADAPTER KEEPS — the hash identifiers ONLY, by (service, field) and by SHAPE: a 64-hex SHA-256 (32-hex MD5 for
// AdRoll) or, for LinkedIn's two mobile-advertising-ID slots, a UUID. Every plaintext value (Google Zip / Country, LinkedIn
// names / title / employer / country), every value of an undocumented field and every malformed value is DROPPED and COUNTED
// (`dropped`) — the record gains match identifiers, never an invented plaintext profile or behaviour. No result field is an
// e-mail address or a phone number, so nothing returned here can be mailed or dialled (lib/enrichment/online-audience-store.ts
// keeps the stored block away from every channel resolver; scripts/versium-capability-matrix-guard.ts section J proves both).

/** The ad-platform sections of the documented response, as the vendor names them. */
export const VERSIUM_ONLINE_AUDIENCE_SERVICES = ["facebook", "google", "linkedin", "tiktok", "adroll", "generic", "original"] as const
export type VersiumOnlineAudienceService = (typeof VERSIUM_ONLINE_AUDIENCE_SERVICES)[number]

/** OUR identifier vocabulary (one spelling per kind across every service — §6). */
export type OnlineAudienceIdKind =
  | "email_sha256" | "phone_sha256" | "email_md5"
  | "first_name_sha256" | "last_name_sha256" | "first_initial_sha256" | "city_sha256" | "state_sha256" | "zip_sha256" | "country_sha256"
  | "maid_idfa" | "maid_gaid"

type OnlineAudienceShape = "sha256" | "md5" | "uuid"
/** (service, vendor field) → our kind + the shape the value must have. A vendor field absent from this map is NEVER kept. */
const ONLINE_AUDIENCE_FIELD_MAP: Readonly<Record<VersiumOnlineAudienceService, Readonly<Record<string, { kind: OnlineAudienceIdKind; shape: OnlineAudienceShape }>>>> = Object.freeze({
  facebook: {
    email: { kind: "email_sha256", shape: "sha256" }, phone: { kind: "phone_sha256", shape: "sha256" },
    fn: { kind: "first_name_sha256", shape: "sha256" }, ln: { kind: "last_name_sha256", shape: "sha256" }, fi: { kind: "first_initial_sha256", shape: "sha256" },
    ct: { kind: "city_sha256", shape: "sha256" }, st: { kind: "state_sha256", shape: "sha256" }, zip: { kind: "zip_sha256", shape: "sha256" }, country: { kind: "country_sha256", shape: "sha256" },
  },
  // Zip / Country arrive in plaintext in the vendor's sample — not in the map, so dropped.
  google: { Email: { kind: "email_sha256", shape: "sha256" }, Phone: { kind: "phone_sha256", shape: "sha256" }, "First Name": { kind: "first_name_sha256", shape: "sha256" }, "Last Name": { kind: "last_name_sha256", shape: "sha256" } },
  // firstname / lastname / jobtitle / employeecompany / country arrive in plaintext — dropped; the mobile ad IDs keep only a UUID.
  linkedin: { email: { kind: "email_sha256", shape: "sha256" }, appleidfa: { kind: "maid_idfa", shape: "uuid" }, googleaid: { kind: "maid_gaid", shape: "uuid" } },
  tiktok: { email: { kind: "email_sha256", shape: "sha256" }, phone: { kind: "phone_sha256", shape: "sha256" } },
  adroll: { email: { kind: "email_md5", shape: "md5" } },
  generic: { email: { kind: "email_sha256", shape: "sha256" } },
  original: { email: { kind: "email_sha256", shape: "sha256" } },
})

const SHAPE_RE: Readonly<Record<OnlineAudienceShape, RegExp>> = Object.freeze({
  sha256: /^[a-f0-9]{64}$/,
  md5: /^[a-f0-9]{32}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
})

/** PURE — is this string an online-audience identifier SHAPE (a hash or a mobile ad ID)? The channel-side firewall asks this:
 *  such a value is never an e-mail address or a phone number, and must never be treated as one. */
export function isOnlineAudienceIdentifier(value: unknown): boolean {
  if (typeof value !== "string") return false
  const v = value.trim().toLowerCase()
  return SHAPE_RE.sha256.test(v) || SHAPE_RE.md5.test(v) || (SHAPE_RE.uuid.test(v) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v))
}

/** OUR shape of one append: service → kind → distinct identifiers (hash values only). */
export interface VersiumOnlineAudienceIdentifiers {
  services: Partial<Record<VersiumOnlineAudienceService, Partial<Record<OnlineAudienceIdKind, string[]>>>>
  identifierCount: number
}

export interface VersiumOnlineAudienceResult {
  /** True when the vendor matched the person AND at least one documented-shape identifier survived the mapper. */
  matched: boolean
  identifiers: VersiumOnlineAudienceIdentifiers | null
  /** What the vendor sent that was NOT kept — published so the drop is a number, never invisible. */
  dropped: { plaintext: number; malformed: number; unknownService: number }
  credits: number
  cost: number
  provenance: VersiumProvenance | null
  /** The vendor's query_id (the audit join to the Versium usage report). */
  queryId: string | null
  skipped?: "unconfigured" | "no_identity"
  error?: string
}

/** One onlineAudience request (injectable so the proof runs with zero network). */
export type VersiumOnlineAudienceCall = (path: string, query: Record<string, string>) =>
  Promise<{ ok: boolean; status: number | null; data: unknown; error?: string | null }>

/** PURE — the documented response → OUR identifiers + what was dropped + the credits billed. */
function parseVersiumOnlineAudienceResponse(body: unknown): Pick<VersiumOnlineAudienceResult, "identifiers" | "dropped" | "credits" | "queryId"> & { rowMatched: boolean } {
  const v = (body && typeof body === "object" ? (body as Record<string, any>).versium : null) ?? {}
  const dropped = { plaintext: 0, malformed: 0, unknownService: 0 }
  const queryId = typeof v.query_id === "string" ? v.query_id : null
  const row = Array.isArray(v.results) ? v.results.find((x: unknown) => !!x && typeof x === "object") : null
  if (!row) return { identifiers: null, dropped, credits: 0, queryId, rowMatched: false }
  const counted = Number(v.match_counts?.online_audience)
  const credits = (Number.isFinite(counted) && counted >= 0 ? counted : 1) * VERSIUM_CREDIT_WEIGHTS.online_audience
  const services: VersiumOnlineAudienceIdentifiers["services"] = {}
  let identifierCount = 0
  for (const [serviceKey, entries] of Object.entries(row as Record<string, unknown>)) {
    const service = (VERSIUM_ONLINE_AUDIENCE_SERVICES as readonly string[]).includes(serviceKey) ? (serviceKey as VersiumOnlineAudienceService) : null
    const list = Array.isArray(entries) ? entries : [entries]
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue
      for (const [field, raw] of Object.entries(entry as Record<string, unknown>)) {
        const values = (Array.isArray(raw) ? raw : [raw]).filter((x): x is string | number => typeof x === "string" || typeof x === "number").map((x) => String(x).trim()).filter(Boolean)
        if (!service) { dropped.unknownService += values.length; continue }
        const spec = ONLINE_AUDIENCE_FIELD_MAP[service][field]
        if (!spec) { dropped.plaintext += values.length; continue }
        for (const value of values) {
          const lower = value.toLowerCase()
          if (!SHAPE_RE[spec.shape].test(lower) || (spec.shape === "uuid" && !isOnlineAudienceIdentifier(lower))) { dropped.malformed++; continue }
          const bucket = ((services[service] ??= {})[spec.kind] ??= [])
          if (!bucket.includes(lower)) { bucket.push(lower); identifierCount++ }
        }
      }
    }
  }
  return { identifiers: identifierCount > 0 ? { services, identifierCount } : null, dropped, credits, queryId, rowMatched: true }
}

/** PURE — the onlineAudience PATH: `rcfg_oa_services[]` repeated on the path (the gateway query map carries one value per key),
 *  restricted to the documented public services (liveramp / stackadapt "require permission" and are never asked). */
function versiumOnlineAudiencePath(services: readonly VersiumOnlineAudienceService[] | undefined): string {
  const asked = [...new Set((services ?? []).filter((s) => (VERSIUM_ONLINE_AUDIENCE_SERVICES as readonly string[]).includes(s)))]
  return asked.length ? `onlineAudience?${asked.map((s) => `rcfg_oa_services[]=${encodeURIComponent(s)}`).join("&")}` : "onlineAudience"
}

/** The worst case one request can bill (the budget pre-flight's number): one matched record × the published weight. */
export const VERSIUM_ONLINE_AUDIENCE_WORST_CASE_CREDITS = VERSIUM_CREDIT_WEIGHTS.online_audience

/**
 * One Online Audience MATCH + APPEND for ONE person. Never throws; no raw row and no plaintext value leaves this function.
 * `services` narrows the sections asked for (data minimisation — the tenant's governed audiences name the platforms in use).
 */
export async function appendVersiumOnlineAudience(
  id: VersiumIdentity,
  opts: { services?: readonly VersiumOnlineAudienceService[] } = {},
  deps: { call?: VersiumOnlineAudienceCall; brokerageId?: string | null } = {},
): Promise<VersiumOnlineAudienceResult> {
  const none: VersiumOnlineAudienceResult = { matched: false, identifiers: null, dropped: { plaintext: 0, malformed: 0, unknownService: 0 }, credits: 0, cost: 0, provenance: null, queryId: null }
  const apiKey = process.env.VERSIUM_API_KEY
  if (!apiKey && !deps.call) return { ...none, skipped: "unconfigured" }
  const query = versiumQueryFor(id)
  if (!query) return { ...none, skipped: "no_identity" }
  const call: VersiumOnlineAudienceCall = deps.call ?? (async (path, q) => {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    return callConnector<any>({
      connector: "versium",
      baseUrl: VERSIUM_API_BASE,
      path,
      method: "GET",
      query: q,
      auth: { style: "header", name: "x-versium-api-key", value: apiKey as string },
      timeoutMs: 15_000,
      ...(deps.brokerageId ? { brokerageId: deps.brokerageId } : {}),
    })
  })
  try {
    const res = await call(versiumOnlineAudiencePath(opts.services), { ...query, cfg_maxrecs: "1", rcfg_max_time: VERSIUM_MAX_TIME_SECONDS })
    if (!res.ok) return { ...none, error: `${versiumStatusProblem(res.status)}${res.error ? ` — ${res.error}` : ""}` }
    const parsed = parseVersiumOnlineAudienceResponse(res.data)
    const cost = versiumCreditsUsd(parsed.credits)
    // A BILLED match whose row carried none of the documented hash fields is schema drift — still booked (it was billed),
    // never read as "no match" and never as free (the B2B2C adapter's rule, same reason).
    const drift = parsed.rowMatched && parsed.credits > 0 && !parsed.identifiers
    return {
      matched: !!parsed.identifiers,
      identifiers: parsed.identifiers,
      dropped: parsed.dropped,
      credits: parsed.credits,
      cost,
      provenance: parsed.identifiers ? provenance("person.enrich_online_audience", new Date().toISOString(), null) : null,
      queryId: parsed.queryId,
      ...(drift ? { error: `online_audience_schema_drift: a billed match carried no documented hash field (dropped ${parsed.dropped.plaintext} plaintext, ${parsed.dropped.malformed} malformed, ${parsed.dropped.unknownService} unknown-service values)` } : {}),
    }
  } catch (e) {
    return { ...none, error: e instanceof Error ? e.message : String(e) }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WAVE 143 (lane 143D) — THE VERSIUM PRODUCT MATRIX: EVERY PRODUCT REACHABLE THROUGH A PUBLISHED INTERFACE,
// WHAT IT BILLS, WHICH CAPABILITY SERVES IT, AND WHAT STANDS BETWEEN US AND CALLING IT.
// Owner: "Use ALL Versium features including online behaviour; Vercel AI Gateway is the AI route; Versium as an AI
// tool (it converses with an AI; this OS uses MCP, SDK, webhooks, APIs); consider Versium for lead-acquisition steps."
//
// Read 2026-10-23 through the research capability (Exa) AND direct unauthenticated probes of the MCP's OAuth metadata
// (the REST docs, the Match Credits Value Conversion Table and app.versium.com were all reachable this time):
//   · api-documentation.versium.com/llms.txt (the full product index), /reference/<product> and its output sample
//   · reach-help.versium.com/docs/match-value-conversion-table  (the credit weights — VERSIUM_CREDIT_WEIGHTS)
//   · versium.com/versium-reach-mcp, versium.com/apis, versium.com/b2b2c-data-append
//
// INTERFACES THAT EXIST (and the ones that do not):
//   · REST  — https://api.versium.com/v2/*, header `x-versium-api-key`. The ONLY interface a server credential works on.
//   · MCP   — https://app.versium.com/mcp/reach, OAuth authorization-code only (VERSIUM_REACH_MCP.status WAITING_EXTERNAL).
//   · SDK   — NONE published: the developer portal documents REST and nothing else (index read 2026-10-23).
//   · WEBHOOK — exactly one: `callback_url` on the asynchronous JOB products (bulk append, ListGen, dedupe); Versium
//             POSTs a body identical to the Job Status response. It carries no documented signature, so a receiver must
//             authenticate by an unguessable per-job token in the callback path and RE-READ the job status over REST
//             with the API key — never trust the body. No job product is built, so no receiver is built (no reader).
//
// A product is only ever one of these (the status says which, and `note` says why):
export type VersiumProductStatus =
  | "WIRED"                 // capability + client + caller + booking exist at the base commit
  | "WIRED_143D"            // wired by this lane (a caller reads the result)
  | "WIRED_144E"            // wired by wave 144, lane 144E (the Online Audience match + append — 143D had misfiled it as targeting)
  | "POLICY_GATED"          // reachable, but its use is ad targeting / outbound — it stays behind the legal / privacy / platform checks and no research path calls it
  | "OWNER_DECISION"        // irreversible spend or a purchased list — a human approves money (owner ruling), nothing is built to spend it unattended
  | "WAITING_EXTERNAL"      // blocked on a credential, a published price or a person — the dependency is named exactly
  | "NOT_ROUTED_SURVIVOR"   // a cheaper or in-house survivor already serves the capability (principle 14 / LAW 1)
  | "NOT_BUILT_NO_CALLER"   // available and understood; no flow of this OS needs it today, and an export nothing reads is an orphan (CLAUDE.md §1) — the trigger that would justify building it is named
  | "NOT_APPLICABLE"        // cannot serve a flow of this OS (or does not exist)

export interface VersiumProduct {
  id: string
  name: string
  interface: "rest" | "rest_async_job" | "mcp" | "sdk" | "webhook"
  endpoint: string
  docs: string
  outputs: readonly string[]
  /** Published match-credit weights this product bills (VERSIUM_CREDIT_WEIGHTS keys); null = the weight is NOT published. */
  creditKeys: readonly VersiumCreditKey[] | null
  /** The capability in CONTACT_PROVIDER_ROUTES (lib/ai-isa/property-lookup-rail.ts) that serves it; null = none does (the status says why).
   *  For NOT_ROUTED_SURVIVOR it is the capability the NEED maps to — versium is deliberately NOT on that route. */
  capability: string | null
  /** Further capabilities the same product serves (Contact Append is both owner_contact and reverse_contact). */
  alsoCapabilities?: readonly string[]
  status: VersiumProductStatus
  /** Where the request / response field names were checked against the vendor's own documentation. */
  contract: "VERIFIED" | "PARTIAL" | "NOT_REQUIRED"
  /** The file + symbol that CALLS it (the guard reads the stripped source for the symbol); null when nothing does. */
  caller: { file: string; symbol: string } | null
  note: string
}

const VERSIUM_DOCS = "https://api-documentation.versium.com/reference"

export const VERSIUM_PRODUCT_MATRIX: readonly VersiumProduct[] = Object.freeze([
  {
    id: "contact_append", name: "Contact Append", interface: "rest", endpoint: "GET /v2/contact",
    docs: `${VERSIUM_DOCS}/contact-append-api`,
    outputs: ["email", "phone", "phone_mobile", "address", "email_multiple", "phone_multiple"],
    creditKeys: ["contact_email", "contact_phone", "contact_email_multi_per_email"],
    capability: "owner_contact", alsoCapabilities: ["reverse_contact"], status: "WIRED", contract: "VERIFIED",
    caller: { file: "lib/ai-isa/property-lookup-rail.ts", symbol: "runVersiumContactLeg" },
    note: "Versium FIRST for owner / person email + phone (owner cost decision 2026-10-01); also the first provider of reverse_contact. A `phone` answer may be a landline — the DNC / line-type scrub decides what may be dialled.",
  },
  {
    id: "demographic_append", name: "Demographic Append (basic, household / financial / auto)", interface: "rest", endpoint: "GET /v2/demographic",
    docs: `${VERSIUM_DOCS}/demographic-append-api`,
    outputs: ["demographic", "financial", "lifestyle_interests", "political_donor"],
    creditKeys: ["demographic_category", "demographic_multi_category_cap", "financial"],
    capability: "owner_contact", status: "WIRED", contract: "VERIFIED",
    caller: { file: "lib/ai-isa/property-lookup-rail.ts", symbol: "appendVersiumDemographics" },
    note: "Bought on a contact hit, only the categories the profile still lacks (versiumDemographicCategoriesNeeded). The `financial` category is also the household-financials rung (lib/enrichment/household-financials.ts, modeled credit band — a firewalled estimate, never a decision input). The Lifestyle & Interests and Political & Donor categories are NOT bought: no real-estate decision depends on political / donor data, party affiliation is a sensitive attribute, and the lifestyle signals the OS uses are the allow-listed indicators of full_demographic.",
  },
  {
    id: "property_facts", name: "Property facts (address-keyed financial output)", interface: "rest", endpoint: "GET /v2/demographic?output[]=financial (address)",
    docs: `${VERSIUM_DOCS}/demographic-append-api`,
    outputs: ["Home Year Built", "Dwelling Type", "Home Purchase Date"],
    creditKeys: ["financial"],
    capability: "property_facts", status: "WIRED", contract: "VERIFIED",
    caller: { file: "lib/avm/provider-chain.ts", symbol: "appendVersiumPropertyFacts" },
    note: "Gap-only, behind RentCast and BatchData. Never a valuation (property_valuation stays RentCast then BatchData).",
  },
  {
    id: "full_demographic", name: "Full Demographic Insights — Online Presence Indicator (Real Estate) and online behaviour", interface: "rest", endpoint: "GET /v2/demographic?output[]=full_demographic",
    docs: `${VERSIUM_DOCS}/full-demographic-insights`,
    outputs: ["Online Presence Indicator - Real Estate", "Investing Real Estate", "Home Own or Rent", "Length of Residence", "Home Improvement", "Online Purchasing Indicator", "Mortgage Purchase Date", "Refinance Date"],
    creditKeys: ["full_demographic"],
    capability: "online_presence", status: "WIRED_143D", contract: "VERIFIED",
    caller: { file: "lib/kernel/lookalike-audience.ts", symbol: "runVersiumOnlinePresenceLeg" },
    note: "3 match credits per matched record (published; it was booked as 1). Allow-listed property / behaviour facts only — every protected characteristic in the same row is dropped inside the adapter. 143D adds the missing half: the indicators are PERSISTED on the contact (enrichment_profile.real_estate_indicators + field provenance) by the bounded research pass, and READ by the look-alike research.",
  },
  {
    id: "b2b2c_append", name: "B2B2C Crosswalk Append", interface: "rest", endpoint: "GET|POST /v2/b2b2cAppend",
    docs: `${VERSIUM_DOCS}/b2b2c-append-api`,
    outputs: ["business_email", "consumer_mobile", "consumer_email", "consumer_address"],
    creditKeys: ["b2b2c_business_email", "b2b2c_consumer_mobile", "b2b2c_consumer_email", "b2b2c_consumer_address", "b2b2c_crosswalk"],
    capability: "business_identity", status: "WIRED", contract: "VERIFIED",
    caller: { file: "app/actions/business-card/business-card-actions.ts", symbol: "runVersiumBusinessIdentityLeg" },
    note: "Identity / dedup evidence for a scanned vendor or agent card; never an outreach channel. Result field names pinned 2026-10-23 (EmailAddrJSONB2B, PhoneJSONB2C, EmailAddrJSONB2C, AddressB2C…); billing corrected (business_email = 2 credits, crosswalk once per consumer request).",
  },
  {
    id: "b2c_listgen_estimate", name: "B2C ListGen (Consumer Audience Builder) — Estimates API", interface: "rest", endpoint: "GET /v2/b2cListGen/estimate",
    docs: `${VERSIUM_DOCS}/estimates-api`,
    outputs: ["estimated_record_count", "estimated_records_available", "estimated_match_credits", "estimated_time_in_seconds"],
    creditKeys: null,
    capability: "audience_estimate", status: "WIRED_143D", contract: "VERIFIED",
    caller: { file: "lib/kernel/lookalike-audience.ts", symbol: "runVersiumAudienceEstimateLeg" },
    note: "A NUMBER, NOTHING ELSE (owner, wave 144 ruling 10: 'the Estimate API just returns a NUMBER (estimated matching contacts for lead-gen criteria) — no contacts purchased/imported/enriched'). FREE ('can be called as many times as requested without incurring in any charge'). The vendor's own framing is the pre-purchase step: 'useful and recommended to be used before the Job Creation API' — so the result carries the count, the records available, what the LIST JOB would bill (estimated_match_credits, shown before any purchase) and its provenance (query_id, the applied criteria, retrieved-at); the masked preview rows are never requested and never returned. 144E corrects 143D's framing of it as a look-alike-only research size: it sizes ANY lawful lead-gen criteria (geography + housing / property / mortgage facts). Filters are ALLOW-LISTED: the same API also filters on gender, ethnicity, religion, language, children, seniors, marital status and veterans — those are refused by name (versiumEstimateQueryFor). The purchase it precedes (b2c_listgen_job) stays OWNER_DECISION.",
  },
  {
    id: "b2c_listgen_job", name: "B2C ListGen — list-generation job + status + download", interface: "rest_async_job", endpoint: "POST /v2/jobs · GET /v2/jobs/{id} · GET /v2/lists/{id}/download",
    docs: `${VERSIUM_DOCS}/listgen-job-api`,
    outputs: ["CSV of consumer contact points + demographic categories"],
    creditKeys: ["cab_per_contact_point", "cab_per_demographic_category"],
    capability: null, status: "OWNER_DECISION", contract: "PARTIAL",
    caller: null,
    note: "'By submitting the API request, you agree to be charged based on the results' — irreversible spend, and a purchased consumer list carries NO consent (leads reach a first touch by direct mail / email only, CLAUDE.md §5; TCPA / CAN-SPAM apply). The owner approves money, so nothing is built that submits it unattended. The estimate above is wired so the human sees the size and the credits BEFORE deciding. TO BUILD (when approved): a staged improvement proposal carrying the estimate, a human approval, the job submit with a per-job callback token, the download into the raw-lead pipeline (raw → dedup → enrichment → gate → lead) with source 'versium_listgen', and the tenant's opt-out list uploaded to Versium Suppression Lists first.",
  },
  {
    id: "bulk_append_jobs", name: "Bulk Upload API (file-based contact / demographic append jobs)", interface: "rest_async_job", endpoint: "POST /v2/lists · POST /v2/jobs?operation=b2cContactAppend|b2cDemographicAppend",
    docs: "https://api-documentation.versium.com/page/bulk-api",
    outputs: ["appended CSV"],
    creditKeys: ["contact_email", "contact_phone", "demographic_category"],
    capability: null, status: "NOT_BUILT_NO_CALLER", contract: "PARTIAL",
    caller: null,
    note: "Same per-match credits as the real-time append. The OS enriches one record at a time, as the row arrives (immediate enrichment, inline drain). TRIGGER to build: a one-off backfill of a large imported book where the per-record cost is identical but the rate limit (20 q/s) is the constraint. `callback_url` is the only Versium webhook — see the interface note above.",
  },
  {
    id: "online_audience_append", name: "Online Audience Append (hashed identifiers for ad platforms)", interface: "rest", endpoint: "GET /v2/onlineAudience",
    docs: `${VERSIUM_DOCS}/online-audience-append-api-new`,
    outputs: ["adroll", "facebook", "google", "linkedin", "tiktok", "generic", "original (SHA-256 / MD5 hashed email, phone, name, zip)"],
    creditKeys: ["online_audience"],
    capability: "online_audience_match", status: "WIRED_144E", contract: "VERIFIED",
    caller: { file: "lib/enrichment/online-audience-store.ts", symbol: "runVersiumOnlineAudienceLeg" },
    note: "A MATCH + APPEND, NOT TARGETING (owner, wave 144 ruling 10 — 143D misfiled it POLICY_GATED as 'targeting plumbing'). It matches a person we already hold to their online profiles (if any) and appends the matched HASHED identifiers (SHA-256; MD5 for AdRoll; LinkedIn mobile-ad IDs only when UUID-shaped) to the contact: enrichment_profile.online_audience (lib/enrichment/online-audience-store.ts), with provenance and the vendor query_id. Plaintext values the vendor returns (Google Zip/Country, LinkedIn names/title/employer) are DROPPED and counted. 1 match credit per matched record (published), budget pre-flighted, booked usage 'online_audience_append'. REQUIRED GAP only: asked when the tenant runs a governed customer-list audience (facebook_custom_audiences with a consent basis) on a platform Versium serves, and only for those platforms' sections. The identifiers are 'not appropriate for direct email campaigns' (vendor) and are never an e-mail/SMS address here; DOWNSTREAM TARGETING is the separate governed act (lib/kernel/ads.ts syncAudience: consent basis, fair-housing refusal, persona basis) that may read them through online-audience-store.ts onlineAudienceMatchKeysFor (module-private until that read is wired — outside lane 144E's files). Only the asked sections are stored. Excluded from the REACH MCP, so REST is the only interface.",
  },
  {
    id: "predictive_scores", name: "Predictive Scores (wealth, DIY, online shopper, new-tech, green, travel, auto-finance, donor)", interface: "rest", endpoint: "GET /v2/predictiveScores",
    docs: `${VERSIUM_DOCS}/predictive-scores-api`,
    outputs: ["WealthScoreNorm", "DIYScoreNorm", "OnlineShopperScoreNorm", "NewTechAdopterScoreNorm", "GreenScoreNorm", "TravelScoreNorm", "AutoFinanceScoreNorm", "DonorScoreNorm"],
    creditKeys: null,
    capability: null, status: "WAITING_EXTERNAL", contract: "VERIFIED",
    caller: null,
    note: "Contract verified (inputs, eight output names, 0-99 `*ScoreNorm` result keys). The CREDIT WEIGHT IS NOT PUBLISHED — the Match Credits Value Conversion Table omits it — so the pre-flight budget gate cannot be given a worst case, and a spend gate that cannot be fed fails closed. WAITING_EXTERNAL: the rate card from the Versium account representative (or one metered call against the owner's account read off `x-credits-remaining`). Once known: capability person_propensity on the same rung; auto_finance_score (credit-adjacent) and donor_score (political / charitable) stay refused.",
  },
  {
    id: "email_validation", name: "Email Validation API", interface: "rest", endpoint: "GET /v2/emailValidation",
    docs: `${VERSIUM_DOCS}/email-validation`,
    outputs: ["validation result", "alternative email"],
    creditKeys: ["email_validation"],
    capability: "email_validation", status: "NOT_ROUTED_SURVIVOR", contract: "NOT_REQUIRED",
    caller: null,
    note: "0.5 credit = $0.025 at the credit-package ceiling; PeopleData validates at $0.01 and is the first (cheapest adequate) provider on the email_validation route. A Versium row would sit SECOND and nothing walks that route past the first provider, so it is not declared (declared-but-never-walked is the orphan this lane removes).",
  },
  {
    id: "b2b_append_family", name: "Firmographic Append · Consumer-to-Business (C2B) Append", interface: "rest", endpoint: "GET /v2/firmographic · GET /v2/c2b",
    docs: `${VERSIUM_DOCS}/firmographic-api`,
    outputs: ["company profile", "job title + employer for a consumer email / name"],
    creditKeys: ["firmographic", "c2b"],
    capability: null, status: "NOT_BUILT_NO_CALLER", contract: "PARTIAL",
    caller: null,
    note: "3 credits each ($0.15) for B2B facts. No consumer real-estate flow needs an employer (the `occupation` column already comes from the demographic categories). TRIGGER to build: vendor recruitment / commercial-lead enrichment or a platform-sales prospect enrichment that has a reader.",
  },
  {
    id: "visitor_to_company", name: "IP-to-Domain (+ Firmographic) · HEM-to-Business-Domain", interface: "rest", endpoint: "GET /v2/ip2domain · GET /v2/hemToBusinessDomain",
    docs: `${VERSIUM_DOCS}/ip-to-domain`,
    outputs: ["company domain behind a BUSINESS IP / a hashed business email"],
    creditKeys: ["ip2domain_firmographic", "hem_to_business_domain"],
    capability: null, status: "NOT_APPLICABLE", contract: "PARTIAL",
    caller: null,
    note: "Resolves business networks and business email hashes to a company. A home buyer or seller browsing a tenant site comes from a residential ISP, so it identifies no consumer lead; the site-visitor lane (lib/lead-pipeline/site-visitor-sourcer.ts) stays first-party. Relevant only to platform-level B2B prospecting.",
  },
  {
    id: "abm_persona_listgen", name: "Account-Based List (ABM) · B2B Persona list generation", interface: "rest_async_job", endpoint: "POST /v2/jobs (b2b list gen)",
    docs: `${VERSIUM_DOCS}/account-based-list-abm-1`,
    outputs: ["business contacts + business emails + online audience"],
    creditKeys: ["abm_business_email", "persona_business_email", "online_audience"],
    capability: null, status: "NOT_BUILT_NO_CALLER", contract: "PARTIAL",
    caller: null,
    note: "Paid B2B list jobs — same OWNER_DECISION shape as the consumer ListGen job. The REACH MCP excludes ABM list generation as well. TRIGGER: platform-sales / vendor-recruitment prospecting with an approval step.",
  },
  {
    id: "dataprep_dedupe", name: "Data Prep · Deduplication", interface: "rest_async_job", endpoint: "POST /v2/jobs?operation=dedupe · DataPrep API",
    docs: `${VERSIUM_DOCS}/deduplication-api-dedupe`,
    outputs: ["cleaned / deduplicated list"],
    creditKeys: null,
    capability: null, status: "NOT_ROUTED_SURVIVOR", contract: "NOT_REQUIRED",
    caller: null,
    note: "File-level hygiene. The OS dedups per record at capture (lib/contact-pipeline/contact-capture.ts) and per raw lead (lib/lead-pipeline/fuzzy-matcher.ts buildLeadIdentityKey) — in-house survivors, free and tenant-scoped.",
  },
  {
    id: "suppression_lists", name: "Suppression List API", interface: "rest", endpoint: "POST|GET|DELETE /v2/suppression-lists",
    docs: `${VERSIUM_DOCS}/suppression-management-api`,
    outputs: ["suppression list ids"],
    creditKeys: null,
    capability: null, status: "NOT_BUILT_NO_CALLER", contract: "PARTIAL",
    caller: null,
    note: "Suppresses people from Versium-GENERATED lists. It has no reader until a list-generation job exists; it is a precondition of the ListGen job above (the tenant's opt-out / DNC list is uploaded first).",
  },
  {
    id: "reach_mcp", name: "Versium REACH MCP server", interface: "mcp", endpoint: "https://app.versium.com/mcp/reach",
    docs: "https://versium.com/versium-reach-mcp/",
    outputs: ["Contact, Demographic, Firmographic, C2B, IP-to-Domain, CAB / B2B list-gen ESTIMATES, email validation"],
    creditKeys: null,
    capability: null, status: "WAITING_EXTERNAL", contract: "NOT_REQUIRED",
    caller: null,
    note: "No server-side credential model: OAuth authorization-code + PKCE only, no client_credentials grant, an unauthenticated initialize is a 401 Bearer challenge (VERSIUM_REACH_MCP.oauth — probed 2026-10-23, re-probed 2026-10-25 with identical answers). THE ACTUAL TOOL LIST (VERSIUM_REACH_MCP.tools, 20 tools, 2026-10-25): every one maps to a REST product of this matrix — four are already WIRED over REST (contact, demographic, b2b2c, b2c estimate), list-job and project/list tools spend on a purchased list (OWNER_DECISION), the rest have no caller or do not apply — and the vendor's exclusions (Online Audience Append, look-alike / ABM list generation, Data Prep) are verified ABSENT. Everything it exposes is reachable over REST with the platform key, so nothing is lost. See VERSIUM_REACH_MCP.waitingOn for the three exact dependencies.",
  },
  {
    id: "sdk", name: "Official SDK", interface: "sdk", endpoint: "—",
    docs: "https://api-documentation.versium.com/llms.txt",
    outputs: [],
    creditKeys: null,
    capability: null, status: "NOT_APPLICABLE", contract: "NOT_REQUIRED",
    caller: null,
    note: "None is published — the developer portal index lists REST references and walkthroughs only. The adapter IS the SDK for this OS (typed, normalized, metered, behind the one egress).",
  },
])

/** PURE — the products in one status (the guard and the notes read the matrix through this). */
export function versiumProductsByStatus(status: VersiumProductStatus): readonly VersiumProduct[] {
  return VERSIUM_PRODUCT_MATRIX.filter((p) => p.status === status)
}

// ─── B2C LISTGEN ESTIMATES — a FREE audience-size read, geography + housing facts only ───────────────────────
// WHAT IT IS (owner, wave 144 ruling 10 — the correction of 143D's look-alike-only framing): "The Estimate API just returns a
// NUMBER (estimated matching contacts for lead-gen criteria) — no contacts purchased/imported/enriched." The vendor's own words
// agree: "estimates of [how] many records will be returned … useful and recommended to be used before the Job Creation API".
// So the result is typed `kind: "count"`, carries `contactsReturned: 0` and the provenance of the count (query_id, the decoded
// criteria, retrieved-at), and the purchase it precedes (the ListGen JOB) is a different, OWNER_DECISION product.
// VERIFIED 2026-10-23 (re-read 2026-10-25): GET https://api.versium.com/v2/b2cListGen/estimate (api-documentation.versium.com/reference/
// estimates-api + b2c-listgen-configuration-parameters + b2c-listgen-demographic-filter-parameters). Response
// `versium.results` = { estimated_record_count, estimated_records_available, estimated_match_credits,
// estimated_time(_in_seconds), preview? }. `required_fields[]` (address | email | phone | phone_mobile | …) is a
// REQUIRED config parameter. `rcfg_show_preview` is OMITTED here: the preview is masked rows of people — an
// estimate needs a count, never a person. Repeated keys (`d_zip[]=…&d_zip[]=…`) ride the PATH's query string
// (the gateway's `query` map carries one value per key); the gateway logs the path without its query string.
//
// RESEARCH ≠ TARGETING (owner 2026-10-23; the housing Special Ad Category and the Fair Housing Act): the same endpoint
// filters on gender, ethnic group, religion, language, children, single parents, seniors, veterans, marital status,
// education and occupation. NONE of those is expressible here — the filter object has no field for them and
// `versiumEstimateQueryFor` REFUSES any other key by name — so a caller cannot size a protected-class audience
// through this function even by accident.

/** The only filters an audience estimate may carry: where, and housing / property facts. */
export interface VersiumAudienceFilters {
  /** 5-digit ZIPs (max 100). */
  zips?: readonly string[]
  /** [city, 2-letter state] (max 50). */
  cityStates?: ReadonlyArray<readonly [string, string]>
  /** 2-letter states. */
  states?: readonly string[]
  /** [county, 2-letter state] (max 20; cannot combine with a radius). */
  counties?: ReadonlyArray<readonly [string, string]>
  /** Pseudo-miles around the ZIP / city centroids (cfg_zipradius), 1-50. */
  zipRadiusMiles?: number
  /** d_ownrent: H = owner, R = renter, 9 = probable owner. */
  ownRent?: ReadonlyArray<"H" | "R" | "9">
  /** d_esthhldincome band letters A-S (A "< $10,000" … S "> $250,000"); a range is "O-S". */
  householdIncomeBand?: string
  /** d_home_value band letters A-S; a range is "K-Q". */
  homeValueBand?: string
  /** d_lor: length of residence in years, "10-20". */
  lengthOfResidenceYears?: { min: number; max: number }
  /** d_home_year: year built, "1974-1990". */
  homeBuiltYears?: { min: number; max: number }
  /** d_loantovalue: 0-100. */
  loanToValuePct?: { min: number; max: number }
  /** d_soho=Y: small office / home office households. */
  smallOfficeHome?: boolean
  /** d_refi_date: a refinance-date RANGE ("Use eight digit dates YYYYMMDD", e.g. 20160101-20170101 — the filter page,
   *  read 2026-10-25). A mortgage fact on the PROPERTY — the refinance lead-gen criterion (wave 144, lane 144E). ISO or YYYYMMDD in. */
  refinanceDateRange?: { from: string; to: string }
  /** d_dwellingtype: S = Single Family Dwelling Unit, M = Multi Family Dwelling Unit (a property fact). */
  dwellingType?: "S" | "M"
  /** required_fields[]: the contact points a counted record must carry (default ["address"] — the direct-mail channel leads are allowed). */
  requiredFields?: ReadonlyArray<"address" | "email" | "phone" | "phone_mobile">
}

/** The filter keys an estimate accepts — everything else is refused by name. */
const VERSIUM_ESTIMATE_ALLOWED_KEYS: readonly (keyof VersiumAudienceFilters)[] = Object.freeze([
  "zips", "cityStates", "states", "counties", "zipRadiusMiles", "ownRent", "householdIncomeBand", "homeValueBand",
  "lengthOfResidenceYears", "homeBuiltYears", "loanToValuePct", "smallOfficeHome", "requiredFields",
  "refinanceDateRange", "dwellingType",
] as const)

// The vendor parameters that are NOT in the allow-list above, named so a reader sees what the refusal covers
// (api-documentation.versium.com/reference/b2c-listgen-demographic-filter-parameters): d_gender, d_ethnicgroup,
// d_language, d_religion, d_presence_of_children, d_num_children, d_hhld_size, d_singleparent, d_senior_hhld,
// d_youngadult_hhld, d_workingwoman, d_hhldveteran, d_military_history, d_maritalstatus, d_education, d_occupation —
// and the political / donor filters. scripts/versium-capability-matrix-guard.ts plants each and asserts the refusal.

interface VersiumEstimateRequest {
  /** `b2cListGen/estimate?` + the repeated pairs — the PATH the gateway is called with. */
  path: string
  /** The flat (one value per key) config the gateway query map carries. */
  query: Record<string, string>
  /** Filter keys the caller passed that are not allowed — the request is refused when any exist. */
  refused: string[]
}

/** The vendor's band parameters are letter RANGES ("d_esthhldincome=O-O"): a lone letter is read as that one band. */
const BAND = /^[A-S](-[A-S])?$/
const asBandRange = (b: string): string => (b.length === 1 ? `${b}-${b}` : b)
const RANGE = (r: { min: number; max: number } | undefined, lo: number, hi: number): string | null =>
  r && Number.isFinite(r.min) && Number.isFinite(r.max) && r.min >= lo && r.max <= hi && r.min <= r.max ? `${Math.trunc(r.min)}-${Math.trunc(r.max)}` : null

/**
 * PURE — the estimate request for a filter set, or `{ refused }` naming every key outside the allow-list, or null when
 * the filters carry no geography (a nationwide estimate answers nothing and is not asked).
 */
function versiumEstimateQueryFor(filters: VersiumAudienceFilters): VersiumEstimateRequest | null {
  const refused = Object.keys(filters as Record<string, unknown>).filter((k) => !(VERSIUM_ESTIMATE_ALLOWED_KEYS as readonly string[]).includes(k))
  const pairs: string[] = []
  const push = (key: string, value: string) => pairs.push(`${key}=${encodeURIComponent(value)}`)
  const query: Record<string, string> = {}
  const zips = (filters.zips ?? []).map((z) => String(z).trim()).filter((z) => /^\d{5}$/.test(z)).slice(0, 100)
  const cityStates = (filters.cityStates ?? []).map(([c, s]) => [String(c).trim().toLowerCase(), String(s).trim().toLowerCase()] as const).filter(([c, s]) => c && /^[a-z]{2}$/.test(s)).slice(0, 50)
  const states = (filters.states ?? []).map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-z]{2}$/.test(s))
  const counties = (filters.counties ?? []).map(([c, s]) => [String(c).trim().toLowerCase(), String(s).trim().toLowerCase()] as const).filter(([c, s]) => c && /^[a-z]{2}$/.test(s)).slice(0, 20)
  if (zips.length + cityStates.length + states.length + counties.length === 0) return refused.length ? { path: "", query: {}, refused } : null
  const required = (filters.requiredFields?.length ? filters.requiredFields : ["address"]) as readonly string[]
  for (const f of new Set(required)) if (["address", "email", "phone", "phone_mobile"].includes(f)) push("required_fields[]", f)
  for (const z of zips) push("d_zip[]", z)
  for (const [c, s] of cityStates) push("d_city_state[]", `${c},${s}`)
  for (const s of states) push("d_state[]", s)
  for (const [c, s] of counties) push("d_county[]", `${c},${s}`)
  if (filters.zipRadiusMiles && Number.isFinite(filters.zipRadiusMiles) && counties.length === 0) query.cfg_zipradius = String(Math.min(50, Math.max(1, Math.trunc(filters.zipRadiusMiles))))
  for (const o of new Set(filters.ownRent ?? [])) if (o === "H" || o === "R" || o === "9") push("d_ownrent[]", o)
  if (filters.householdIncomeBand && BAND.test(filters.householdIncomeBand)) query.d_esthhldincome = asBandRange(filters.householdIncomeBand)
  if (filters.homeValueBand && BAND.test(filters.homeValueBand)) query.d_home_value = asBandRange(filters.homeValueBand)
  const lor = RANGE(filters.lengthOfResidenceYears, 0, 99); if (lor) query.d_lor = lor
  const built = RANGE(filters.homeBuiltYears, 1600, 2100); if (built) query.d_home_year = built
  const ltv = RANGE(filters.loanToValuePct, 0, 100); if (ltv) query.d_loantovalue = ltv
  if (filters.smallOfficeHome === true) query.d_soho = "Y"
  const ymd = (s: string | undefined): string | null => {
    const d = String(s ?? "").trim().replace(/-/g, "")
    return /^\d{8}$/.test(d) && Number(d.slice(4, 6)) >= 1 && Number(d.slice(4, 6)) <= 12 && Number(d.slice(6, 8)) >= 1 && Number(d.slice(6, 8)) <= 31 ? d : null
  }
  const refiFrom = ymd(filters.refinanceDateRange?.from), refiTo = ymd(filters.refinanceDateRange?.to)
  if (refiFrom && refiTo && refiFrom <= refiTo) query.d_refi_date = `${refiFrom}-${refiTo}`
  if (filters.dwellingType === "S" || filters.dwellingType === "M") query.d_dwellingtype = filters.dwellingType
  return { path: `b2cListGen/estimate?${pairs.join("&")}`, query, refused }
}

/** PURE — the criteria an estimate was ASKED with (the path's repeated pairs + the flat config), decoded — the provenance a
 *  count carries so a reader can tell WHICH population the number describes. */
function versiumEstimateCriteria(req: VersiumEstimateRequest): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const qs = req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : ""
  for (const [k, v] of new URLSearchParams(qs)) {
    const prior = out[k]
    out[k] = prior === undefined ? [v] : Array.isArray(prior) ? [...prior, v] : [prior, v]
  }
  for (const [k, v] of Object.entries(req.query)) out[k] = v
  return out
}

/** Where a count came from (wave 144, lane 144E — owner: "audience_estimate returns a COUNT with provenance"). */
export interface VersiumEstimateProvenance {
  source: "versium"
  capability: "audience.estimate"
  endpoint: "GET /v2/b2cListGen/estimate"
  docs: string
  /** The vendor's query_id — the audit join to the Versium usage report. */
  queryId: string | null
  retrievedAt: string
  /** The criteria the count describes (decoded request parameters — geography + housing / property facts only). */
  criteria: Record<string, string | string[]>
}

export interface VersiumAudienceEstimate {
  /** What this result IS: a count. Never a person, never a list, never a purchase (owner, wave 144 ruling 10). */
  kind: "count"
  estimatedRecords: number | null
  availableRecords: number | null
  /** What the LIST JOB (not this estimate) would bill in match credits — shown to the human before any purchase. */
  estimatedMatchCredits: number | null
  /** The vendor's estimate of the LIST JOB's run time (seconds) — informational, for the human deciding on a purchase. */
  estimatedTimeSeconds: number | null
  /** Always 0: an estimate imports, enriches and buys no contact. */
  contactsReturned: 0
  /** An estimate is free; this is always 0 and exists so every Versium result carries its cost. */
  cost: 0
  /** Set on an answered count (null on a refusal / skip). */
  provenance: VersiumEstimateProvenance | null
  refused: string[]
  skipped?: "unconfigured" | "no_geography" | "refused_filter"
  error?: string
}

/** One estimate request (injectable so the proof runs with zero network). */
export type VersiumEstimateCall = (path: string, query: Record<string, string>) =>
  Promise<{ ok: boolean; status: number | null; data: unknown; error?: string | null }>

/** PURE — the counts out of one estimate response (the masked preview, if the vendor sent one, is dropped). */
function parseVersiumEstimateResponse(body: unknown): { estimatedRecords: number | null; availableRecords: number | null; estimatedMatchCredits: number | null; estimatedTimeSeconds: number | null; queryId: string | null } {
  const v = (body && typeof body === "object" ? (body as Record<string, any>).versium : null) ?? {}
  const r = (v && typeof v === "object" ? v.results : null) ?? {}
  const n = (x: unknown): number | null => { const y = typeof x === "string" && x.trim() === "" ? NaN : Number(x); return Number.isFinite(y) && y >= 0 ? y : null }
  // A non-numeric field is null, never 0 (Number(null) is 0 — "the vendor said nothing" must not read as "zero people").
  const num = (x: unknown): number | null => (x === null || x === undefined || typeof x === "boolean" ? null : n(x))
  return {
    estimatedRecords: num(r.estimated_record_count), availableRecords: num(r.estimated_records_available), estimatedMatchCredits: num(r.estimated_match_credits),
    estimatedTimeSeconds: num(r.estimated_time_in_seconds), queryId: typeof v.query_id === "string" ? v.query_id : null,
  }
}

/** Versium audience-size estimate for a geography + housing-fact filter set. Free; never throws; no person data leaves. */
export async function estimateVersiumAudience(
  filters: VersiumAudienceFilters,
  /** `brokerageId` — the tenant this read is made FOR (api_response_logs attribution; wave 139 tenant scope) — never a spend. */
  deps: { call?: VersiumEstimateCall; brokerageId?: string | null } = {},
): Promise<VersiumAudienceEstimate> {
  const none: VersiumAudienceEstimate = { kind: "count", estimatedRecords: null, availableRecords: null, estimatedMatchCredits: null, estimatedTimeSeconds: null, contactsReturned: 0, cost: 0, provenance: null, refused: [] }
  const req = versiumEstimateQueryFor(filters)
  if (!req) return { ...none, skipped: "no_geography" }
  if (req.refused.length > 0) return { ...none, refused: req.refused, skipped: "refused_filter" }
  const apiKey = process.env.VERSIUM_API_KEY
  if (!apiKey && !deps.call) return { ...none, skipped: "unconfigured" }
  const call: VersiumEstimateCall = deps.call ?? (async (path, q) => {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    return callConnector<any>({
      connector: "versium",
      baseUrl: VERSIUM_API_BASE,
      path,
      method: "GET",
      query: q,
      auth: { style: "header", name: "x-versium-api-key", value: apiKey as string },
      timeoutMs: 15_000,
      ...(deps.brokerageId ? { brokerageId: deps.brokerageId } : {}),
    })
  })
  try {
    const res = await call(req.path, req.query)
    if (!res.ok) return { ...none, error: `${versiumStatusProblem(res.status)}${res.error ? ` — ${res.error}` : ""}` }
    const { queryId, ...counts } = parseVersiumEstimateResponse(res.data)
    return {
      ...none,
      ...counts,
      provenance: counts.estimatedRecords === null ? null : {
        source: "versium", capability: "audience.estimate", endpoint: "GET /v2/b2cListGen/estimate", docs: `${VERSIUM_DOCS}/estimates-api`,
        queryId, retrievedAt: new Date().toISOString(), criteria: versiumEstimateCriteria(req),
      },
    }
  } catch (e) {
    return { ...none, error: e instanceof Error ? e.message : String(e) }
  }
}
