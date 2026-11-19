// lib/finance/accounting-egress.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ACCOUNTING EGRESS (keep-one consolidation). Two parallel QuickBooks
// paths had drifted: app/actions/accounting-sync.ts held the REAL provider
// dispatch (buildQuickBooks → QuickBooksProvider → accounting_sync_log), while
// app/actions/ai-financial-management.ts held a FAKE one that wrote
// quickbooks_sync_log rows 'in_progress' and returned synced:true WITHOUT ever
// calling Intuit — the permanent source of the Integration Guardian's
// silent-gap alarms. This lib is the single home: connection resolution +
// token refresh, tenant-configured account mapping (tax_categories.
// provider_account_id — NEVER a fabricated account id), and the honest
// accounting_sync_log lifecycle (completed/failed with completed_at, or NO row
// when nothing was attempted). quickbooks_sync_log is retired.

import "server-only"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
import { QuickBooksProvider } from "@/lib/providers/accounting/quickbooks"

type Svc = ReturnType<typeof createServiceClient>

/** Resolve the brokerage's QuickBooks connection (financial cascade: agent →
 *  team → brokerage → platform) and return a live provider, refreshing the
 *  OAuth token when near expiry. Returns null when not connected. */
export async function buildQuickBooksForBrokerage(
  brokerageId: string,
  actor?: { agentUserId?: string | null; teamId?: string | null },
): Promise<QuickBooksProvider | null> {
  const conn = await resolveScopedConnection("quickbooks", {
    agentUserId: actor?.agentUserId ?? null,
    teamId: actor?.teamId ?? null,
    brokerageId,
  })
  // Token columns are canonical; older QBO rows kept tokens in `config`.
  const accessToken = conn?.accessToken ?? ((conn?.config as any)?.access_token as string | undefined) ?? null
  if (!conn || !accessToken) return null
  const refreshToken = conn.refreshToken ?? ((conn.config as any)?.refresh_token as string | undefined) ?? ""
  const clientId = process.env.QUICKBOOKS_CLIENT_ID
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error("QuickBooks app credentials not configured (QUICKBOOKS_CLIENT_ID/SECRET)")
  const realmId = ((conn.config as any)?.realmId as string) || ((conn.config as any)?.realm_id as string) || conn.accountId || ""
  if (!realmId) throw new Error("QuickBooks connection missing realmId (company id)")

  const provider = new QuickBooksProvider({ accessToken, refreshToken, realmId, clientId, clientSecret })

  const expIso = ((conn.config as any)?.tokenExpiresAt as string) ?? ((conn.config as any)?.token_expires_at as string) ?? null
  if (expIso && refreshToken) {
    const exp = Date.parse(expIso)
    if (!Number.isNaN(exp) && exp <= Date.now() + 5 * 60_000) {
      const fresh = await provider.refreshAccessToken()
      if (conn.source !== "integration_credentials") {
        const svc = createServiceClient()
        await svc
          .from(conn.source)
          .update({ access_token: fresh.accessToken, refresh_token: fresh.refreshToken, token_expires_at: fresh.tokenExpiresAt })
          .eq("id", conn.credentialId)
      }
    }
  }
  return provider
}

/** Tenant-configured QBO account for an expense category — tax_categories.
 *  provider_account_id, matched on category_name (case-insensitive). NO
 *  hardcoded fallback: an unmapped category is an honest failure the sync
 *  errors UI surfaces, never a write to a made-up ledger account. */
async function resolveExpenseAccountRef(svc: Svc, brokerageId: string, category: string): Promise<string | null> {
  const { data } = await svc
    .from("tax_categories")
    .select("category_name, provider_account_id")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .limit(200)
  const want = category.trim().toLowerCase()
  for (const row of ((data ?? []) as Array<{ category_name: string | null; provider_account_id: string | null }>)) {
    if ((row.category_name ?? "").trim().toLowerCase() === want && row.provider_account_id) return row.provider_account_id
  }
  return null
}

/**
 * WAVE 153 (lane 153A) — THE BUSINESS UNIT. A multi-location tenant's office expense must land in the connected books
 * under that office, not dissolve into the company total. The mapping is TENANT-CONFIGURED on the office itself
 * (`locations.settings.accounting.quickbooks_department_id` — QuickBooks' Location/Department dimension), written
 * through the existing office editor (app/actions/admin/locations.ts updates `settings`). Never inferred from a name.
 *   · no office on the expense (main office / single-office tenant)   → no business unit (the company itself);
 *   · the tenant maps NO office at all (it does not track locations in its books) → pushed without one, and the
 *     payload snapshot records that the books do not track offices;
 *   · the tenant maps SOME offices but not this one                    → an honest BUSINESS_UNIT_NOT_MAPPED sync error
 *     (never filed under the company by default — that would misstate both the office's and the company's books).
 * A refused read is a refusal (the push is not attempted with a guessed unit).
 */
async function resolveBusinessUnit(svc: Svc, brokerageId: string, locationId: string | null):
  Promise<{ ok: true; tracked: boolean; departmentRef: string | null } | { ok: false; error: string }> {
  if (!locationId) return { ok: true, tracked: false, departmentRef: null }
  const { data, error } = await svc.from("locations").select("id, settings").eq("brokerage_id", brokerageId)
  if (error) return { ok: false, error: `office mapping read refused: ${error.message}` }
  const refOf = (settings: unknown): string | null => {
    const v = ((settings as { accounting?: { quickbooks_department_id?: unknown } } | null)?.accounting?.quickbooks_department_id)
    return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null
  }
  const rows = (data ?? []) as Array<{ id: string; settings: unknown }>
  const tracked = rows.some((r) => refOf(r.settings) !== null)
  const mine = rows.find((r) => r.id === locationId)
  return { ok: true, tracked, departmentRef: mine ? refOf(mine.settings) : null }
}

export interface AccountingPushOutcome {
  attempted: boolean
  success: boolean
  externalId?: string
  error?: string
}

type EgressErrorCode = "CONNECTION_FAILED" | "ACCOUNT_NOT_MAPPED" | "CUSTOMER_NOT_MAPPED" | "PROVIDER_REFUSED" | "BUSINESS_UNIT_NOT_MAPPED"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One accounting_sync_log row per attempted push — and, on a FAILED push, one sync_errors row naming the record.
 *
 *  WAVE 152 (integrator, after lane 152K retired the fake bulk route app/api/accounting/sync/route.ts): that route was the
 *  only code that ever wrote sync_errors, and it wrote rows for records it had never tried to send. With it gone the
 *  Sync errors panel (app/actions/accounting-sync.ts getSyncErrors / retrySyncError, app/settings/accounting) read a table
 *  NOBODY wrote — while this module's own doc comments promised "an honest failure the sync errors UI surfaces". No
 *  duplicate writer exists, so the missing half is BUILT here (orphan doctrine §1.2): the real push path files the real
 *  failure, linked to its log row, with the record id when the caller has one and a payload snapshot (amounts and
 *  mapping keys only — never a token) so a retry knows what was being sent. */
async function logSync(
  svc: Svc,
  p: {
    brokerageId: string
    syncType: "expense" | "commission" | "invoice" | "journal"
    startedAt: string
    success: boolean
    error?: string | null
    errorCode?: EgressErrorCode
    recordId?: string | null
    payload?: Record<string, unknown> | null
  },
) {
  let syncLogId: string | null = null
  await sentinelWrite(svc, svc.from("accounting_sync_log").insert({
    brokerage_id: p.brokerageId,
    provider: "quickbooks",
    sync_type: p.syncType,
    status: p.success ? "completed" : "failed",
    records_synced: p.success ? 1 : 0,
    records_failed: p.success ? 0 : 1,
    started_at: p.startedAt,
    completed_at: new Date().toISOString(),
    error_summary: p.success ? null : (p.error ?? "unknown error").slice(0, 500),
  }).select("id").single().then((r) => { syncLogId = ((r.data as { id?: string } | null)?.id) ?? null; return r }),
  { table: "accounting_sync_log", flow: "accounting_egress_log", brokerageId: p.brokerageId, reason: "sync log of a push that already happened (or failed) at QuickBooks; the caller already has the push result" })
  if (p.success) {
    // THE COMPLETION HALF (wave 155, lane 155B2 — wave 154 gap row 19). KernelEvent.SYSTEM_SYNC_COMPLETED had a consumer
    // (lib/kernel/event-reactor.ts branch 22: Data Steward → Finance Manager) and no writer since the fake bulk route was
    // retired (wave 152K); its START counterpart SYSTEM_SYNC_TRIGGERED is still emitted by app/actions/accounting-sync.ts. A REAL
    // completion is this landed 'completed' row — so it is announced here, ONCE per row: the entity is the row's own id and the
    // dedupe key names it (a re-run of logSync for another push is another row). Tenant: the push's brokerage (the caller's
    // verified one). No row id (the log insert was refused) → nothing is announced; the refusal is already ledgered above.
    if (syncLogId) await announceSyncCompleted(svc, p.brokerageId, syncLogId, p.syncType)
    return
  }
  await sentinelWrite(svc, svc.from("sync_errors").insert({
    sync_log_id: syncLogId,
    brokerage_id: p.brokerageId,
    record_type: p.syncType,
    record_id: p.recordId && UUID_RE.test(p.recordId) ? p.recordId : null,
    error_code: p.errorCode ?? "PROVIDER_REFUSED",
    error_message: (p.error ?? "unknown error").slice(0, 1000),
    payload_snapshot: p.payload ?? null,
  }), { table: "sync_errors", flow: "accounting_egress_errors", brokerageId: p.brokerageId, reason: "the failed push already returned its error to the caller; this row is what the Sync errors panel shows and retries" })
}

/** One SYSTEM_SYNC_COMPLETED per landed 'completed' accounting_sync_log row (see logSync). Through the ONE kernel emitter
 *  (lib/kernel/emit.ts — row + reactor fan-out), on the push's own client. Never throws: the push already happened. */
async function announceSyncCompleted(svc: Svc, brokerageId: string, syncLogId: string, syncType: string): Promise<void> {
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    const { KernelEvent } = await import("@/lib/kernel/events")
    const r = await emitKernelEvent({
      brokerageId,
      event: KernelEvent.SYSTEM_SYNC_COMPLETED,
      entityType: "accounting_sync_log",
      entityId: syncLogId,
      actorUserId: null,
      metadata: { provider: "quickbooks", sync_type: syncType, records_synced: 1, sync_log_id: syncLogId },
      dedupeKey: `system_sync_completed:${syncLogId}`,
      dedupeWindowSec: 7 * 86_400,
      client: svc,
    })
    if (r.error) console.error(`[accounting-egress] sync completion not announced for ${syncLogId}: ${r.error}`)
  } catch (e) {
    console.error(`[accounting-egress] sync completion announce threw for ${syncLogId}:`, e instanceof Error ? e.message : e)
  }
}

/** Push ONE brokerage-scoped expense to the brokerage's QuickBooks as a
 *  Purchase. Not connected → { attempted:false } and NO log row (nothing was
 *  attempted — never a fake 'in_progress'). Agent/team expenses must NOT ride
 *  this: those books don't roll up to the brokerage ledger (owner rule). */
export async function pushExpenseToAccounting(
  svc: Svc,
  expense: { brokerageId: string; amount: number; category: string; description?: string | null; expenseDate?: string | null; expenseId?: string | null; locationId?: string | null },
): Promise<AccountingPushOutcome> {
  const startedAt = new Date().toISOString()
  const failed = { recordId: expense.expenseId ?? null, payload: { amount: expense.amount, category: expense.category, expense_date: expense.expenseDate ?? null, location_id: expense.locationId ?? null } as Record<string, unknown> }
  let qbo: QuickBooksProvider | null
  try {
    qbo = await buildQuickBooksForBrokerage(expense.brokerageId, { teamId: null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logSync(svc, { brokerageId: expense.brokerageId, syncType: "expense", startedAt, success: false, error: msg, errorCode: "CONNECTION_FAILED", ...failed })
    return { attempted: true, success: false, error: msg }
  }
  if (!qbo) return { attempted: false, success: false }

  const expenseAccountRef = await resolveExpenseAccountRef(svc, expense.brokerageId, expense.category)
  const paymentAccountRef = await resolveExpenseAccountRef(svc, expense.brokerageId, "payment_account")
  if (!expenseAccountRef || !paymentAccountRef) {
    const missing = !expenseAccountRef ? `category '${expense.category}'` : "'payment_account'"
    const msg = `No QuickBooks account mapped for ${missing} — map it in Settings → Accounting → Tax categories (provider_account_id)`
    await logSync(svc, { brokerageId: expense.brokerageId, syncType: "expense", startedAt, success: false, error: msg, errorCode: "ACCOUNT_NOT_MAPPED", ...failed })
    return { attempted: true, success: false, error: msg }
  }

  const unit = await resolveBusinessUnit(svc, expense.brokerageId, expense.locationId ?? null)
  if (!unit.ok) {
    await logSync(svc, { brokerageId: expense.brokerageId, syncType: "expense", startedAt, success: false, error: unit.error, errorCode: "BUSINESS_UNIT_NOT_MAPPED", ...failed })
    return { attempted: true, success: false, error: unit.error }
  }
  failed.payload.business_unit = unit.departmentRef ?? (expense.locationId ? (unit.tracked ? "unmapped" : "books_do_not_track_offices") : "company")
  if (expense.locationId && unit.tracked && !unit.departmentRef) {
    const msg = "This office has no QuickBooks location mapped while other offices do — map it in Settings → Offices so the expense lands under the right office"
    await logSync(svc, { brokerageId: expense.brokerageId, syncType: "expense", startedAt, success: false, error: msg, errorCode: "BUSINESS_UNIT_NOT_MAPPED", ...failed })
    return { attempted: true, success: false, error: msg }
  }

  // The purchase carries the office's department when one is mapped. (The provider's Purchase builder sending
  // DepartmentRef is lane 153G's file — Outside-lane request in lane 153A's notes; the snapshot above records the unit.)
  const purchase: Parameters<QuickBooksProvider["createPurchase"]>[0] & { departmentRef?: string } = {
    amount: expense.amount,
    expenseAccountRef,
    paymentAccountRef,
    description: expense.description ?? undefined,
    txnDate: expense.expenseDate ?? undefined,
    ...(unit.departmentRef ? { departmentRef: unit.departmentRef } : {}),
  }
  const result = await qbo.createPurchase(purchase)
  await logSync(svc, { brokerageId: expense.brokerageId, syncType: "expense", startedAt, success: result.success, error: result.error, errorCode: "PROVIDER_REFUSED", ...failed })
  return { attempted: true, success: result.success, externalId: result.externalId, error: result.error }
}

/** Push a closed commission to the brokerage's QuickBooks as an invoice
 *  (GCI is brokerage revenue — it IS the brokerage ledger, unlike agent/team
 *  expenses). Customer/item refs come from the connection's tenant metadata;
 *  missing refs fail honestly into the sync-errors UI. */
export async function pushCommissionToAccounting(
  svc: Svc,
  commission: { brokerageId: string; grossCommission: number; description?: string | null; qbCustomerRef?: string | null; qbItemRef?: string | null; commissionId?: string | null },
): Promise<AccountingPushOutcome> {
  const startedAt = new Date().toISOString()
  const failed = { recordId: commission.commissionId ?? null, payload: { gross_commission: commission.grossCommission, customer_mapped: !!commission.qbCustomerRef } }
  let qbo: QuickBooksProvider | null
  try {
    qbo = await buildQuickBooksForBrokerage(commission.brokerageId, { teamId: null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logSync(svc, { brokerageId: commission.brokerageId, syncType: "commission", startedAt, success: false, error: msg, errorCode: "CONNECTION_FAILED", ...failed })
    return { attempted: true, success: false, error: msg }
  }
  if (!qbo) return { attempted: false, success: false }

  if (!commission.qbCustomerRef) {
    const msg = "No QuickBooks customer mapped for commission income — set qb_customer_id on the QuickBooks connection"
    await logSync(svc, { brokerageId: commission.brokerageId, syncType: "commission", startedAt, success: false, error: msg, errorCode: "CUSTOMER_NOT_MAPPED", ...failed })
    return { attempted: true, success: false, error: msg }
  }

  const result = await qbo.createInvoice({
    customerRef: commission.qbCustomerRef,
    amount: commission.grossCommission,
    description: commission.description ?? undefined,
  })
  await logSync(svc, { brokerageId: commission.brokerageId, syncType: "commission", startedAt, success: result.success, error: result.error, errorCode: "PROVIDER_REFUSED", ...failed })
  return { attempted: true, success: result.success, externalId: result.externalId, error: result.error }
}
