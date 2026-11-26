// lib/vendor-governance/acquisition-economics.ts
//
// INTERNAL ACQUISITION ECONOMICS (wave 151, lane 151F; directive 151F "Internal economics and outcomes"): platform vs tenant
// cost responsibility, API usage, duplicate-avoidance savings, cost per incremental usable record, Raw Lead gate yield,
// Contact conversion — and the downstream outcomes (appointments, accepted relationships, attributed transactions) ONLY when a
// survivor reader can attribute them. "Do not pretend future transactions are guaranteed": every figure here is a measured
// count over existing ledgers, every unmeasured figure is null with its reason, and nothing projects.
//
// READERS (none re-spelled): vendor_usage_tracking (the one cost ledger — coverage platform_covered / tenant_paid, lane 139C),
// raw_scraped_leads (the one RawData intake — dedupe_status, lead_id), leads (raw_record_id, contact_id). Appointments,
// accepted relationships and attributed transactions are lib/intelligence/roi-ledger.ts loadLedgerAttribution's domain; this
// module reports them only when a caller passes that reader's result, else null + caveat. Shown on the platform connector-
// healing console beside the provider stack and the owner caps — a platform surface, never a tenant's (CLAUDE.md §5).

import { ACQUISITION_LEDGER_SYSTEM_SOURCE, type AcquisitionLedgerRow } from "./platform-acquisition-caps"

type Svc = { from: (table: string) => any }

interface AcquisitionEconomicsInput {
  ledger: readonly AcquisitionLedgerRow[]
  raw: { total: number; duplicates: number; promotedToLead: number }
  leads: { fromRaw: number; converted: number }
  /** The documented per-record price the duplicate rows would have cost had they been bought again; null = unknown. */
  duplicateUnitUsd: number | null
  outcomes: { appointments: number | null; acceptedRelationships: number | null; attributedTransactions: number | null }
  blindSpots?: string[]
}

export interface AcquisitionEconomicsReport {
  platformSpendUsd: number
  tenantSpendUsd: number
  ledgerRows: number
  apiUnits: number
  /** Duplicate rows × unit price — a saving only when a price is documented; null otherwise (never 0 as a claim). */
  duplicateAvoidanceSavingsUsd: number | null
  duplicateRows: number
  /** Platform spend ÷ usable (non-duplicate) raw records; null when nothing usable (never a divide-by-zero zero). */
  costPerUsableRecordUsd: number | null
  /** Raw rows that became a Lead ÷ raw rows. null when no raw row. */
  rawLeadGateYield: number | null
  /** Leads from raw that became a Contact ÷ those leads. null when none. */
  contactConversion: number | null
  appointments: number | null
  acceptedRelationships: number | null
  attributedTransactions: number | null
  caveats: string[]
  /** Wave 156 (156G): the fully loaded cohort finance (cost per USABLE PERSON, per promoted Lead, per qualified Contact, per closed opportunity). */
  cohort?: CohortFinance
}

const r2 = (n: number) => Math.round(n * 100) / 100
const r4 = (n: number) => Math.round(n * 10000) / 10000

/** PURE — fold the inputs into the report. Deterministic; never invents a rate from a zero denominator.
 *  @proofSeam scripts/tenant-provider-connections-guard.ts section H drives the fold (payer split, null-not-zero rates) */
function foldAcquisitionEconomics(i: AcquisitionEconomicsInput): AcquisitionEconomicsReport {
  let platform = 0, tenant = 0, units = 0, rows = 0
  for (const r of i.ledger) {
    const m = r.request_metadata ?? {}
    if (m.system_source !== ACQUISITION_LEDGER_SYSTEM_SOURCE && m.system_source !== "tenant_provider_connection") continue
    const c = Number(r.total_cost) || 0
    rows++
    units += Number((m as Record<string, unknown>).units_used ?? 0) || 0
    if ((m.coverage ?? "platform_covered") === "tenant_paid") tenant += c
    else platform += c
  }
  const usable = Math.max(0, i.raw.total - i.raw.duplicates)
  const caveats: string[] = [...(i.blindSpots ?? [])]
  if (i.duplicateUnitUsd === null) caveats.push("duplicate-avoidance savings not priced: no documented unit price was supplied")
  if (i.outcomes.appointments === null) caveats.push("appointments not attributed here — lib/intelligence/roi-ledger.ts loadLedgerAttribution is the reader")
  if (i.outcomes.acceptedRelationships === null) caveats.push("accepted relationships not attributed here — the relationship graph is the reader")
  if (i.outcomes.attributedTransactions === null) caveats.push("attributed transactions not attributed here — roi-ledger's deterministic last-touch / all-touch is the reader; nothing is projected")
  caveats.push("every figure is a measured count over existing ledgers; no future transaction is assumed")
  return {
    platformSpendUsd: r2(platform), tenantSpendUsd: r2(tenant), ledgerRows: rows, apiUnits: units,
    duplicateAvoidanceSavingsUsd: i.duplicateUnitUsd === null ? null : r2(i.raw.duplicates * i.duplicateUnitUsd),
    duplicateRows: i.raw.duplicates,
    costPerUsableRecordUsd: usable > 0 && platform > 0 ? r4(platform / usable) : null,
    rawLeadGateYield: i.raw.total > 0 ? r4(i.raw.promotedToLead / i.raw.total) : null,
    contactConversion: i.leads.fromRaw > 0 ? r4(i.leads.converted / i.leads.fromRaw) : null,
    appointments: i.outcomes.appointments, acceptedRelationships: i.outcomes.acceptedRelationships, attributedTransactions: i.outcomes.attributedTransactions,
    caveats,
  }
}

/** The platform-wide read since `sinceIso` (platform console). A refused read is a caveat and its figures stay honest. */
export async function loadAcquisitionEconomics(svc: Svc, opts: { sinceIso: string; duplicateUnitUsd: number | null }): Promise<AcquisitionEconomicsReport> {
  const blind: string[] = []
  const [{ data: ledger, error: lErr }, { data: raw, error: rErr }, { data: leads, error: ldErr }] = await Promise.all([
    svc.from("vendor_usage_tracking").select("brokerage_id, vendor_name, total_cost, request_metadata, created_at").gte("created_at", opts.sinceIso).limit(50000),
    svc.from("raw_scraped_leads").select("id, dedupe_status, lead_id").gte("created_at", opts.sinceIso).limit(50000),
    svc.from("leads").select("id, raw_record_id, contact_id").gte("created_at", opts.sinceIso).not("raw_record_id", "is", null).limit(50000),
  ])
  if (lErr) blind.push(`vendor_usage_tracking read refused (${lErr.message}) — spend figures are unknown, not zero`)
  if (rErr) blind.push(`raw_scraped_leads read refused (${rErr.message}) — raw counts are unknown, not zero`)
  if (ldErr) blind.push(`leads read refused (${ldErr.message}) — conversion is unknown, not zero`)
  const rawRows = (raw ?? []) as Array<{ dedupe_status: string | null; lead_id: string | null }>
  const leadRows = (leads ?? []) as Array<{ contact_id: string | null }>
  const report = foldAcquisitionEconomics({
    ledger: lErr ? [] : ((ledger ?? []) as AcquisitionLedgerRow[]),
    raw: { total: rawRows.length, duplicates: rawRows.filter((r) => /^duplicate/.test(r.dedupe_status ?? "")).length, promotedToLead: rawRows.filter((r) => !!r.lead_id).length },
    leads: { fromRaw: leadRows.length, converted: leadRows.filter((l) => !!l.contact_id).length },
    duplicateUnitUsd: opts.duplicateUnitUsd,
    outcomes: { appointments: null, acceptedRelationships: null, attributedTransactions: null },
    blindSpots: blind,
  })
  // Wave 156 (156G): the person-data enrichment spend booked OUTSIDE the acquisition source (Versium contact append, PeopleData,
  // BatchData skip trace, Datafiniti) is part of the fully loaded cost of a usable person — read from the SAME ledger rows.
  const enrichmentUsd = lErr ? null : personEnrichmentSpendUsd((ledger ?? []) as Array<AcquisitionLedgerRow & { vendor_name?: string | null }>)
  return {
    ...report,
    cohort: foldCohortFinance({
      subscriptionAllocationUsd: null,
      billedRequestsUsd: enrichmentUsd === null ? null : r2(report.platformSpendUsd + enrichmentUsd),
      aiToolUsd: null, validationUsd: null,
      usablePersons: null,
      promotedLeads: rErr ? null : rawRows.filter((x) => !!x.lead_id).length,
      qualifiedContacts: ldErr ? null : leadRows.filter((l) => !!l.contact_id).length,
      closedOpportunities: null,
    }),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COHORT FINANCE + COMMITMENT MODEL (wave 156, lane 156G — directive 156G "Cohort finance"; "Versium minimum modeled").
//
//   fully loaded cost per usable person = (subscription allocation + billed requests/records + AI/scraper/tool costs +
//                                          validation/corrections) ÷ unique correctly matched, fresh, licensed, actionable persons
//
// Separately: cost per promoted Lead, per AI-ISA-qualified Contact, per closed opportunity. A component nobody measured is
// NULL and named in `unknowns` — every per-unit figure is then a LOWER BOUND (complete: false), never a complete figure; a
// denominator nobody measured (no blinded match verification exists yet — the pilot is unapproved) is null, never a guessed
// match rate. Reader: app/dashboard/superadmin/connector-healing/page.tsx (platform console). Proof:
// scripts/wave156-g-provider-economics-guard.ts.
// ═════════════════════════════════════════════════════════════════════════════

/** The vendors whose ledger rows are PERSON data (append / trace / people records). RentCast is property data and is excluded. */
const PERSON_DATA_VENDORS: readonly string[] = Object.freeze(["versium", "peopledata", "batchdata", "datafiniti", "tracerfy", "datazapp", "propertyradar", "data_axle"])

/** PURE — person-data spend booked outside the acquisition source (the fold above already counts the acquisition rows). */
function personEnrichmentSpendUsd(rows: ReadonlyArray<AcquisitionLedgerRow & { vendor_name?: string | null }>): number {
  let usd = 0
  for (const r of rows) {
    const m = (r.request_metadata ?? {}) as Record<string, unknown>
    if (m.system_source === ACQUISITION_LEDGER_SYSTEM_SOURCE || m.system_source === "tenant_provider_connection") continue
    if (!PERSON_DATA_VENDORS.includes(String(r.vendor_name ?? "").toLowerCase())) continue
    if ((m.coverage ?? "platform_covered") === "tenant_paid") continue
    usd += Number(r.total_cost) || 0
  }
  return usd
}

export interface CohortFinanceInput {
  /** Monthly allocation of a signed subscription / commitment. null = no executed plan on record (unknown, not $0). */
  subscriptionAllocationUsd: number | null
  /** Billed requests / records from the cost ledger (successful calls only). null = the ledger could not be read. */
  billedRequestsUsd: number | null
  /** AI / scraper / tool costs attributable to the cohort (ai_tool_usage). null = not attributed. */
  aiToolUsd: number | null
  /** Validation and correction costs (human corrections, re-queries, bounce clean-up). null = not measured. */
  validationUsd: number | null
  /** Unique correctly matched, fresh, licensed, actionable persons. null = not measured (needs blinded verification). */
  usablePersons: number | null
  promotedLeads: number | null
  qualifiedContacts: number | null
  closedOpportunities: number | null
}

export interface CohortFinance {
  /** The sum of the KNOWN numerator components. */
  knownCostUsd: number
  /** True only when every numerator component is known — otherwise every per-unit figure is a LOWER BOUND. */
  complete: boolean
  costPerUsablePersonUsd: number | null
  costPerPromotedLeadUsd: number | null
  costPerQualifiedContactUsd: number | null
  costPerClosedOpportunityUsd: number | null
  unknowns: string[]
}

/**
 * PURE — the cohort fold. Never divides by zero; never fills an unknown with 0. Product reader: loadAcquisitionEconomics above
 * (the platform console's cohort figures).
 * @proofSeam kept exported for scripts/wave156-g-provider-economics-guard.ts §G, which drives the lower-bound and complete cases directly
 */
export function foldCohortFinance(i: CohortFinanceInput): CohortFinance {
  const parts: Array<[string, number | null]> = [
    ["subscription allocation (no executed plan on record)", i.subscriptionAllocationUsd],
    ["billed requests / records (cost ledger unreadable)", i.billedRequestsUsd],
    ["AI / scraper / tool costs (not attributed to the cohort)", i.aiToolUsd],
    ["validation / corrections (not measured)", i.validationUsd],
  ]
  const unknowns = parts.filter(([, v]) => v === null).map(([k]) => `numerator: ${k}`)
  const knownCostUsd = r2(parts.reduce((a, [, v]) => a + (v ?? 0), 0))
  const per = (d: number | null, label: string): number | null => {
    if (d === null) { unknowns.push(`denominator: ${label} not measured`); return null }
    return d > 0 ? r4(knownCostUsd / d) : null
  }
  const costPerUsablePersonUsd = per(i.usablePersons, "unique correctly matched, fresh, licensed, actionable persons (blinded match verification)")
  const costPerPromotedLeadUsd = per(i.promotedLeads, "promoted Leads")
  const costPerQualifiedContactUsd = per(i.qualifiedContacts, "AI-ISA-qualified Contacts")
  const costPerClosedOpportunityUsd = per(i.closedOpportunities, "closed opportunities (roi-ledger attribution)")
  return { knownCostUsd, complete: parts.every(([, v]) => v !== null), costPerUsablePersonUsd, costPerPromotedLeadUsd, costPerQualifiedContactUsd, costPerClosedOpportunityUsd, unknowns }
}

/**
 * A published plan, modeled — an INDICATION read from the vendor's public page, never an executed quote. `termMonths`
 * null = a prepaid block with no term (credits never expire); `overageUnitUsd` null = not published.
 */
export interface ProviderCommitmentTerm {
  provider: "versium" | "rentcast" | "datafiniti"
  plan: string
  commitmentUsd: number
  termMonths: number | null
  includedUnits: number
  overageUnitUsd: number | null
  unit: "match_credit" | "request" | "record"
  source: string
  executedQuote: false
}

export const PROVIDER_COMMITMENT_TERMS: readonly ProviderCommitmentTerm[] = Object.freeze([
  { provider: "versium", plan: "credit package 5K", commitmentUsd: 250, termMonths: null, includedUnits: 5_000, overageUnitUsd: null, unit: "match_credit", source: "versium.com/pricing (read 2026-11-25): $250 for 5,000 match credits, $0.05 → $0.02 on larger packages, never expire, business verification required", executedQuote: false },
  { provider: "versium", plan: "annual subscription 250K", commitmentUsd: 5_000, termMonths: 12, includedUnits: 250_000, overageUnitUsd: 0.02, unit: "match_credit", source: "versium.com/pricing (read 2026-11-25): \"Starting at $5,000 per year for 250,000 match credits\", \"$0.02 and lower\", overage \"at your fixed rate\", balance resets at term end; reseller / embedded use is a separate custom tier (\"Must be a registered data broker\")", executedQuote: false },
  { provider: "rentcast", plan: "Foundation", commitmentUsd: 74, termMonths: 1, includedUnits: 1_000, overageUnitUsd: 0.06, unit: "request", source: "rentcast.io/api plan table (repo read 2026-11-03, CUSTOMER-360-PROVIDER-COMPARISON §10); billed per successful request (developers.rentcast.io/reference/billing-and-pricing, read 2026-11-25)", executedQuote: false },
  { provider: "rentcast", plan: "Growth", commitmentUsd: 199, termMonths: 1, includedUnits: 5_000, overageUnitUsd: 0.03, unit: "request", source: "rentcast.io/api plan table (repo read 2026-11-03)", executedQuote: false },
  { provider: "rentcast", plan: "Scale", commitmentUsd: 449, termMonths: 1, includedUnits: 25_000, overageUnitUsd: 0.015, unit: "request", source: "rentcast.io/api (read 2026-11-25: \"25,000 per month\", \"$0.015 per request\"; $449 from the 2026-11-03 read)", executedQuote: false },
  { provider: "datafiniti", plan: "people 10k / month", commitmentUsd: 749, termMonths: 1, includedUnits: 10_000, overageUnitUsd: null, unit: "record", source: "datafiniti.co/data/people-data (read 2026-11-16; NOT shown on the page re-read 2026-11-25, which now says only \"pricing adjusts based on the number of records\") — unverified today", executedQuote: false },
])

export interface CommitmentCost {
  monthlyUsd: number | null
  effectiveUnitUsd: number | null
  /** The minimum commitment, not usage, sets the bill (usage is below the included allowance). */
  minimumBinding: boolean
  note: string
}

/**
 * PURE — what `unitsPerMonth` really costs under a plan, INCLUDING its minimum: an annual commitment is allocated per month
 * whether or not the credits are used; a prepaid block is bought whole; overage past the allowance at the published rate
 * (null → unknown, never 0). The marketing "per match" floor is the effective rate only at full use.
 */
export function costUnderCommitment(t: ProviderCommitmentTerm, unitsPerMonth: number): CommitmentCost {
  const u = Math.max(0, unitsPerMonth)
  if (t.termMonths === null) {
    const blocks = Math.max(1, Math.ceil(u / t.includedUnits))
    const usd = r2(blocks * t.commitmentUsd)
    return { monthlyUsd: usd, effectiveUnitUsd: u > 0 ? r4(usd / u) : null, minimumBinding: u < blocks * t.includedUnits, note: `${blocks} prepaid block(s) of ${t.includedUnits}` }
  }
  const fixed = t.commitmentUsd / t.termMonths
  const includedPerMonth = t.includedUnits / t.termMonths
  const over = Math.max(0, u - includedPerMonth)
  if (over > 0 && t.overageUnitUsd === null) return { monthlyUsd: null, effectiveUnitUsd: null, minimumBinding: false, note: `usage exceeds the included ${r2(includedPerMonth)}/month and no overage price is published — unknown` }
  const usd = r2(fixed + over * (t.overageUnitUsd ?? 0))
  return { monthlyUsd: usd, effectiveUnitUsd: u > 0 ? r4(usd / u) : null, minimumBinding: u < includedPerMonth, note: over > 0 ? `${r2(over)} units over the allowance at $${t.overageUnitUsd}` : `minimum commitment $${r2(fixed)}/month allocated; ${r2(includedPerMonth - u)} units unused` }
}
