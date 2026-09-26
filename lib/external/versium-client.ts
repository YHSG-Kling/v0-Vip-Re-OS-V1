// lib/external/versium-client.ts
//
// VERSIUM REACH — Demographic Append API, `financial` output type ONLY (lane 85C, wave 85).
// Owner verbatim: "add marital status,household income, net worth or credit on enrichment and add
// location for contact enrichment."
//
// WHY THIS PROVIDER, AND WHY ONLY THIS OUTPUT (Exa research, 2026-09-26 — lane-85C notes):
//   · Of the four attributes, three (marital status, household income, net worth) are ALREADY BOUGHT
//     from BatchData's `demographic` dataset (see enrichment-column-map.ts HOUSEHOLD FINANCIALS). No
//     provider this repo already pays for sells a CREDIT band: PeopleData's person schema has none,
//     BatchData's 32 demographic fields have none (list_property_dataset_fields, read live).
//   · Versium's "Household, Financial & Auto" category returns `Credit Rating` (a modeled band, e.g.
//     "700-749"), `Household Income` and `Estimated Net Worth` for ONE match credit
//     (reach-help.versium.com "Match Credits Value Conversion Table"). Match credits are billed ONLY on
//     a match ("If there is no match, there is no cost" — versium.com/pricing): $0.075–$0.05
//     pay-as-you-go, $0.05–$0.02 in credit packages (API access included), under $0.02 on an annual
//     subscription; $0.04 on AWS Marketplace. VERSIUM_FINANCIAL_MATCH_COST_USD books the credit-package
//     ceiling, the same don't-understate rule peopledata-client.ts applies to PDL.
//   · Inputs: first + last + city + state (or zip), or email, or phone, or a full postal address
//     (api-documentation.versium.com "Demographic Append API") — exactly what a lead/contact carries.
//
// FCRA: Versium is not a consumer reporting agency; `Credit Rating` is a MODELED marketing estimate.
// It is stored as a band only (normalizeModeledCreditBand) and read for persona / intelligence only —
// never an eligibility, pricing or steering decision (lane-85C notes; enrichment-column-map.ts).
//
// FAIL CLOSED: no VERSIUM_API_KEY → no network call, `{ data: null, cost: 0, skipped: "unconfigured" }`.
// Egress goes through the connector gateway (the single egress path), never a bare fetch.

import { householdFinancialsFromVersium, type HouseholdFinancials } from "@/lib/lead-pipeline/enrichment-column-map"

/** Per MATCHED record, one match credit (the "Household, Financial & Auto" category). A no-match is free. */
export const VERSIUM_FINANCIAL_MATCH_COST_USD = 0.05
export const VERSIUM_NO_MATCH_COST_USD = 0

const VERSIUM_API_BASE = "https://api.versium.com/v2"

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
  const address = t(id.address), city = t(id.city), state = t(id.state), zip = t(id.zip)
  const q: Record<string, string> = {}
  if (first && last) { q.first = first; q.last = last }
  if (email) q.email = email
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

export interface VersiumFinancialResult {
  data: HouseholdFinancials | null
  cost: number
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
      query: { ...query, "output[]": "financial" },
      auth: { style: "header", name: "x-versium-api-key", value: apiKey },
    })
    if (!res.ok) return { data: null, cost: 0, error: res.error ?? `versium ${res.status ?? "network"}` }
    const results: unknown[] = res.data?.versium?.results ?? []
    const first = results[0]
    const mapped = householdFinancialsFromVersium(first)
    if (!first || Object.keys(mapped).length === 0) return { data: null, cost: VERSIUM_NO_MATCH_COST_USD }
    return { data: mapped, cost: VERSIUM_FINANCIAL_MATCH_COST_USD }
  } catch (e) {
    return { data: null, cost: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
