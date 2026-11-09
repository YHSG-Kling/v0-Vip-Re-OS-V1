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

export interface AcquisitionEconomicsInput {
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
}

const r2 = (n: number) => Math.round(n * 100) / 100
const r4 = (n: number) => Math.round(n * 10000) / 10000

/** PURE — fold the inputs into the report. Deterministic; never invents a rate from a zero denominator.
 *  @proofSeam scripts/tenant-provider-connections-guard.ts section H drives the fold (payer split, null-not-zero rates) */
export function foldAcquisitionEconomics(i: AcquisitionEconomicsInput): AcquisitionEconomicsReport {
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
    svc.from("vendor_usage_tracking").select("brokerage_id, total_cost, request_metadata, created_at").gte("created_at", opts.sinceIso).limit(50000),
    svc.from("raw_scraped_leads").select("id, dedupe_status, lead_id").gte("created_at", opts.sinceIso).limit(50000),
    svc.from("leads").select("id, raw_record_id, contact_id").gte("created_at", opts.sinceIso).not("raw_record_id", "is", null).limit(50000),
  ])
  if (lErr) blind.push(`vendor_usage_tracking read refused (${lErr.message}) — spend figures are unknown, not zero`)
  if (rErr) blind.push(`raw_scraped_leads read refused (${rErr.message}) — raw counts are unknown, not zero`)
  if (ldErr) blind.push(`leads read refused (${ldErr.message}) — conversion is unknown, not zero`)
  const rawRows = (raw ?? []) as Array<{ dedupe_status: string | null; lead_id: string | null }>
  const leadRows = (leads ?? []) as Array<{ contact_id: string | null }>
  return foldAcquisitionEconomics({
    ledger: lErr ? [] : ((ledger ?? []) as AcquisitionLedgerRow[]),
    raw: { total: rawRows.length, duplicates: rawRows.filter((r) => /^duplicate/.test(r.dedupe_status ?? "")).length, promotedToLead: rawRows.filter((r) => !!r.lead_id).length },
    leads: { fromRaw: leadRows.length, converted: leadRows.filter((l) => !!l.contact_id).length },
    duplicateUnitUsd: opts.duplicateUnitUsd,
    outcomes: { appointments: null, acceptedRelationships: null, attributedTransactions: null },
    blindSpots: blind,
  })
}
