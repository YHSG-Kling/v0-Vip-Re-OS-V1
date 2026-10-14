/**
 * lib/lead-intelligence/person-spend.ts
 *
 * WHAT THIS PERSON HAS COST, FROM THE RAW ROW THROUGH CONVERSION AND AFTER (lane 87F, wave 87).
 * Owner standing ruling: "lead intelligence = history + source cost" — "…and where they came from
 * for lead cost tracking" (wave 65).
 *
 * THE GAP THIS CLOSES. Every paid enrichment call (PeopleData, BatchData skip / reverse skip trace,
 * Versium household financials, BatchData property enrichment, Tavily/Exa research) books through
 * lib/vendor-governance/meter-vendor.ts::meterVendorSpend, and until this lane that gateway had no
 * way to name a person: vendor_usage_tracking.lead_id was never set by it. So
 * lib/contact-promotion/acquisition-cost.ts — which sums enrichment spend BY lead_id — only ever saw
 * the $0 osint_free rows, and the raw-stage PeopleData match (bought before any lead existed) was
 * attributable to nobody. meterVendorSpend now takes `attribution` (lead → the lead_id column;
 * contact / raw record → request_metadata.contactId / request_metadata.rawRecordId), and THIS is the
 * one reader that folds all three keys back onto a person.
 *
 * ONE READER, TWO CALLERS (never a second copy):
 *   · lib/contact-promotion/acquisition-cost.ts — enrichment spend up to conversion, carried onto
 *     leads/contacts.acquisition_cost (so source-conversion-runner's cost-per-contact includes it);
 *   · lib/lead-intelligence/person-timeline.ts — enrichment events on the lead-desk timeline plus the
 *     spend summary (before / after conversion) the lead page renders.
 *
 * TENANCY (CLAUDE.md §4). The lead_id read is keyed on an FK the caller already resolved in-tenant;
 * the JSON-path reads (raw record / contact) are pinned to the brokerage and SKIPPED with a warning
 * when no brokerage is known — never read un-pinned.
 *
 * NEVER THROWS. A refused read is a warning and a `measured: false` summary — "nobody could read the
 * ledger" never renders as "$0 spent" (§4 fail closed).
 */

type Client = { from: (table: string) => any }

type SpendSubject = "lead" | "raw_record" | "contact"

interface PersonSpendRow {
  id: string
  vendor: string
  usageType: string | null
  costUsd: number
  occurredAt: string | null
  systemSource: string | null
  subject: SpendSubject
}

export interface PersonSpendSummary {
  /** Spend on the raw row / lead before conversion (or all of it while the person is still a lead). */
  beforeConversionUsd: number
  /** Spend on the person after they became a contact (contact enrichment, life-change checks). */
  afterConversionUsd: number
  totalUsd: number
  byVendor: Array<{ vendor: string; usd: number; calls: number }>
  /** false when any ledger read was refused — the totals are then a floor, not the truth. */
  measured: boolean
}

const SELECT = "id, vendor_name, usage_type, total_cost, created_at, system_source:request_metadata->>system_source"
const round2 = (n: number) => Math.round(n * 100) / 100

function toRows(data: unknown, subject: SpendSubject): PersonSpendRow[] {
  return ((data ?? []) as Array<Record<string, any>>).map((r) => ({
    id: String(r.id),
    vendor: (r.vendor_name as string | null) ?? "unknown",
    usageType: (r.usage_type as string | null) ?? null,
    costUsd: Number(r.total_cost) || 0,
    occurredAt: (r.created_at as string | null) ?? null,
    systemSource: (r.system_source as string | null) ?? null,
    subject,
  }))
}

/**
 * Every raw_scraped_leads.id this person's lead(s) came from: leads.raw_record_id, leads.source_raw_ids
 * and the raw rows whose lead_id points at them. Raw-stage spend is keyed on these.
 */
export async function resolvePersonRawRecordIds(
  svc: Client,
  params: { leadIds: readonly string[]; brokerageId: string | null },
): Promise<{ rawRecordIds: string[]; warnings: string[] }> {
  const warnings: string[] = []
  const ids = new Set<string>()
  if (params.leadIds.length === 0) return { rawRecordIds: [], warnings }
  if (!params.brokerageId) {
    warnings.push("no brokerage_id — raw-record lineage not resolved (never read un-pinned)")
    return { rawRecordIds: [], warnings }
  }
  const { data: leadRows, error: leadErr } = await svc.from("leads").select("id, raw_record_id, source_raw_ids")
    .eq("brokerage_id", params.brokerageId)
    .in("id", params.leadIds as string[])
  if (leadErr) warnings.push(`leads raw-id read refused: ${leadErr.message}`)
  for (const l of (leadRows ?? []) as Array<{ raw_record_id: string | null; source_raw_ids: string[] | null }>) {
    if (l.raw_record_id) ids.add(l.raw_record_id)
    for (const r of l.source_raw_ids ?? []) if (r) ids.add(r)
  }
  const { data: rawRows, error: rawErr } = await svc.from("raw_scraped_leads").select("id")
    .eq("brokerage_id", params.brokerageId)
    .in("lead_id", params.leadIds as string[])
  if (rawErr) warnings.push(`raw_scraped_leads id read refused: ${rawErr.message}`)
  for (const r of (rawRows ?? []) as Array<{ id: string }>) if (r.id) ids.add(r.id)
  return { rawRecordIds: [...ids], warnings }
}

/** Read every vendor_usage_tracking row booked for this person, by any of the three keys. Deduped by id. */
export async function readPersonVendorSpend(
  svc: Client,
  params: { brokerageId: string | null; leadIds: readonly string[]; rawRecordIds: readonly string[]; contactId: string | null },
): Promise<{ rows: PersonSpendRow[]; warnings: string[]; measured: boolean }> {
  const warnings: string[] = []
  let measured = true
  const byId = new Map<string, PersonSpendRow>()
  const take = (rows: PersonSpendRow[]) => { for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r) }

  if (params.leadIds.length > 0) {
    const { data, error } = await svc.from("vendor_usage_tracking").select(SELECT).in("lead_id", params.leadIds as string[])
    if (error) { measured = false; warnings.push(`vendor_usage_tracking (lead_id) read refused: ${error.message}`) }
    else take(toRows(data, "lead"))
  }
  const needsTenant = params.rawRecordIds.length > 0 || !!params.contactId
  if (needsTenant && !params.brokerageId) {
    measured = false
    warnings.push("no brokerage_id — raw-record and contact spend skipped (never read un-pinned)")
  } else {
    if (params.rawRecordIds.length > 0) {
      const { data, error } = await svc.from("vendor_usage_tracking").select(SELECT)
        .eq("brokerage_id", params.brokerageId)
        .in("request_metadata->>rawRecordId", params.rawRecordIds as string[])
      if (error) { measured = false; warnings.push(`vendor_usage_tracking (rawRecordId) read refused: ${error.message}`) }
      else take(toRows(data, "raw_record"))
    }
    if (params.contactId) {
      const { data, error } = await svc.from("vendor_usage_tracking").select(SELECT)
        .eq("brokerage_id", params.brokerageId)
        .eq("request_metadata->>contactId", params.contactId)
      if (error) { measured = false; warnings.push(`vendor_usage_tracking (contactId) read refused: ${error.message}`) }
      else take(toRows(data, "contact"))
    }
  }
  const rows = [...byId.values()].sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? ""))
  return { rows, warnings, measured }
}

/**
 * PURE. Split the person's spend at conversion. A row is AFTER conversion when it happened at/after
 * convertedAt; a row with no timestamp falls to its subject (contact-keyed → after, lead/raw → before).
 * No convertedAt → everything is acquisition-phase spend.
 */
export function summarizePersonSpend(rows: readonly PersonSpendRow[], convertedAt: string | null, measured = true): PersonSpendSummary {
  let before = 0
  let after = 0
  const vendors = new Map<string, { usd: number; calls: number }>()
  for (const r of rows) {
    const isAfter = convertedAt
      ? (r.occurredAt ? r.occurredAt >= convertedAt : r.subject === "contact")
      : false
    if (isAfter) after += r.costUsd
    else before += r.costUsd
    const v = vendors.get(r.vendor) ?? { usd: 0, calls: 0 }
    v.usd += r.costUsd
    v.calls += 1
    vendors.set(r.vendor, v)
  }
  return {
    beforeConversionUsd: round2(before),
    afterConversionUsd: round2(after),
    totalUsd: round2(before + after),
    byVendor: [...vendors.entries()].map(([vendor, v]) => ({ vendor, usd: round2(v.usd), calls: v.calls })).sort((a, b) => b.usd - a.usd),
    measured,
  }
}
