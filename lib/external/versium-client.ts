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

import { householdFinancialsFromVersium, buildVersiumDemographicProfile, type HouseholdFinancials } from "@/lib/lead-pipeline/enrichment-column-map"

// ─── OUR CAPABILITY CONTRACT (wave 96, lane 96B — owner blueprint: "Versium behind OUR normalized
// capability contract, never raw vendor shapes leaking; provenance per field") ──────────────────
// Every public result below is OUR shape: normalized values + a provenance stamp. The raw Versium
// response body never leaves this file (appendVersiumDemographics used to hand its caller the raw
// result rows; it now maps them here through enrichment-column-map.ts::buildVersiumDemographicProfile,
// the ONE vocabulary, and returns the profile). Credentials are read HERE only (process.env.
// VERSIUM_API_KEY) — never a parameter, never in agent/tool context.

/** The capabilities this adapter serves, named as the platform asks for them (not as Versium's
 *  endpoints are named). The ledger rows a caller books carry the same name in metadata.capability. */
type VersiumCapability = "person.enrich_contact" | "person.enrich_demographics" | "person.enrich_financial"

/** Provenance for a value this adapter returned — written beside the value where it is stored. */
export interface VersiumProvenance {
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
  return { source: "versium", capability, retrievedAt, matchConfidence: matchConfidenceOf(row) }
}

/** One match credit — the credit-package ceiling (don't understate a bill). A no-match is free. */
export const VERSIUM_MATCH_CREDIT_USD = 0.05
/** Per MATCHED record on the `financial` output type: exactly one match credit. */
export const VERSIUM_FINANCIAL_MATCH_COST_USD = VERSIUM_MATCH_CREDIT_USD
export const VERSIUM_NO_MATCH_COST_USD = 0

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
      ...(parsed.data ? { provenance: { source: "versium" as const, capability: "person.enrich_financial" as const, retrievedAt: new Date().toISOString(), matchConfidence: parsed.matchLevel } } : {}),
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
//   · UNRESOLVED (no live call this lane): the contact output's field names — read defensively
//     ("Email Address" / "Email", "Phone" / "Mobile Phone" / "Phone Number"); match_counts[output] is
//     what was billed, a match with no count is one credit.
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
  out.cost = out.credits > 0 ? Math.round(out.credits * VERSIUM_MATCH_CREDIT_USD * 100) / 100 : VERSIUM_NO_MATCH_COST_USD
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
  out.cost = credits > 0 ? Math.round(credits * VERSIUM_MATCH_CREDIT_USD * 100) / 100 : VERSIUM_NO_MATCH_COST_USD
  return out
}
