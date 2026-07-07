// lib/platform/tenant-export.ts
// ─────────────────────────────────────────────────────────────────────────────
// TENANT DATA EXPORT — the offboarding half the lifecycle was missing. The
// suspend/cancel/archive state machine existed; what a departing (or auditing)
// tenant could never get was THEIR DATA. This assembles one JSON bundle of the
// tenant's core business records — the DSAR export was per-person; this is
// per-brokerage. Honest scope: the named core tables below (the records a
// brokerage owns operationally + must retain by law), not all ~700 platform
// tables — the bundle says exactly what it contains and what it counted.
// Retention note: exporting NEVER deletes; real-estate records keep their 3–7yr
// retention regardless of tenancy (the DSR rail handles person-level erasure).

/** Core business tables exported per tenant — every one keyed by brokerage_id. */
export const TENANT_EXPORT_TABLES = [
  "users", "agents", "teams",
  "contacts", "leads", "listings",
  "transactions", "offers", "showings", "appointments",
  "communications", "tasks", "documents",
  "vendors", "referrals",
  "marketing_campaigns", "marketing_assets",
  "commissions", "commission_records",
  "subscriptions", "billing_invoices", "support_tickets",
] as const

export interface TenantExportBundle {
  exportedAt: string
  brokerageId: string
  brokerageName: string | null
  tables: Record<string, unknown[]>
  counts: Record<string, number>
  truncated: string[]
  note: string
}

const PER_TABLE_LIMIT = 10_000

/** PURE: the bundle summary — counts + which tables hit the row cap. */
export function summarizeExport(tables: Record<string, unknown[]>): { counts: Record<string, number>; truncated: string[] } {
  const counts: Record<string, number> = {}
  const truncated: string[] = []
  for (const [name, rows] of Object.entries(tables)) {
    counts[name] = rows.length
    if (rows.length >= PER_TABLE_LIMIT) truncated.push(name)
  }
  return { counts, truncated }
}

/** Assemble the tenant bundle. Service-role read, caller must be superadmin-gated. */
export async function buildTenantExport(svc: any, brokerageId: string): Promise<TenantExportBundle> {
  const { data: brk } = await svc.from("brokerages").select("*").eq("id", brokerageId).maybeSingle()
  const tables: Record<string, unknown[]> = { brokerages: brk ? [brk] : [] }

  for (const table of TENANT_EXPORT_TABLES) {
    const { data, error } = await svc.from(table).select("*").eq("brokerage_id", brokerageId).limit(PER_TABLE_LIMIT)
    tables[table] = error ? [{ _export_error: error.message }] : (data ?? [])
  }

  const { counts, truncated } = summarizeExport(tables)
  return {
    exportedAt: new Date().toISOString(),
    brokerageId,
    brokerageName: (brk as any)?.name ?? null,
    tables,
    counts,
    truncated,
    note: `Core business records for this tenant (${TENANT_EXPORT_TABLES.length + 1} tables). ` +
      `Export does not delete anything; transaction/communication records remain under their legal retention window.` +
      (truncated.length ? ` Tables at the ${PER_TABLE_LIMIT}-row cap (paginate via API for the rest): ${truncated.join(", ")}.` : ""),
  }
}
