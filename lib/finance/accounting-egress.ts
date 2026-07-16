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

export interface AccountingPushOutcome {
  attempted: boolean
  success: boolean
  externalId?: string
  error?: string
}

async function logSync(
  svc: Svc,
  p: { brokerageId: string; syncType: "expense" | "commission" | "invoice" | "journal"; startedAt: string; success: boolean; error?: string | null },
) {
  await svc.from("accounting_sync_log").insert({
    brokerage_id: p.brokerageId,
    provider: "quickbooks",
    sync_type: p.syncType,
    status: p.success ? "completed" : "failed",
    records_synced: p.success ? 1 : 0,
    records_failed: p.success ? 0 : 1,
    started_at: p.startedAt,
    completed_at: new Date().toISOString(),
    error_summary: p.success ? null : (p.error ?? "unknown error").slice(0, 500),
  })
}

/** Push ONE brokerage-scoped expense to the brokerage's QuickBooks as a
 *  Purchase. Not connected → { attempted:false } and NO log row (nothing was
 *  attempted — never a fake 'in_progress'). Agent/team expenses must NOT ride
 *  this: those books don't roll up to the brokerage ledger (owner rule). */
export async function pushExpenseToAccounting(
  svc: Svc,
  expense: { brokerageId: string; amount: number; category: string; description?: string | null; expenseDate?: string | null },
): Promise<AccountingPushOutcome> {
  const startedAt = new Date().toISOString()
  let qbo: QuickBooksProvider | null
  try {
    qbo = await buildQuickBooksForBrokerage(expense.brokerageId, { teamId: null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logSync(svc, { brokerageId: expense.brokerageId, syncType: "expense", startedAt, success: false, error: msg })
    return { attempted: true, success: false, error: msg }
  }
  if (!qbo) return { attempted: false, success: false }

  const expenseAccountRef = await resolveExpenseAccountRef(svc, expense.brokerageId, expense.category)
  const paymentAccountRef = await resolveExpenseAccountRef(svc, expense.brokerageId, "payment_account")
  if (!expenseAccountRef || !paymentAccountRef) {
    const missing = !expenseAccountRef ? `category '${expense.category}'` : "'payment_account'"
    const msg = `No QuickBooks account mapped for ${missing} — map it in Settings → Accounting → Tax categories (provider_account_id)`
    await logSync(svc, { brokerageId: expense.brokerageId, syncType: "expense", startedAt, success: false, error: msg })
    return { attempted: true, success: false, error: msg }
  }

  const result = await qbo.createPurchase({
    amount: expense.amount,
    expenseAccountRef,
    paymentAccountRef,
    description: expense.description ?? undefined,
    txnDate: expense.expenseDate ?? undefined,
  })
  await logSync(svc, { brokerageId: expense.brokerageId, syncType: "expense", startedAt, success: result.success, error: result.error })
  return { attempted: true, success: result.success, externalId: result.externalId, error: result.error }
}

/** Push a closed commission to the brokerage's QuickBooks as an invoice
 *  (GCI is brokerage revenue — it IS the brokerage ledger, unlike agent/team
 *  expenses). Customer/item refs come from the connection's tenant metadata;
 *  missing refs fail honestly into the sync-errors UI. */
export async function pushCommissionToAccounting(
  svc: Svc,
  commission: { brokerageId: string; grossCommission: number; description?: string | null; qbCustomerRef?: string | null; qbItemRef?: string | null },
): Promise<AccountingPushOutcome> {
  const startedAt = new Date().toISOString()
  let qbo: QuickBooksProvider | null
  try {
    qbo = await buildQuickBooksForBrokerage(commission.brokerageId, { teamId: null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logSync(svc, { brokerageId: commission.brokerageId, syncType: "commission", startedAt, success: false, error: msg })
    return { attempted: true, success: false, error: msg }
  }
  if (!qbo) return { attempted: false, success: false }

  if (!commission.qbCustomerRef) {
    const msg = "No QuickBooks customer mapped for commission income — set qb_customer_id on the QuickBooks connection"
    await logSync(svc, { brokerageId: commission.brokerageId, syncType: "commission", startedAt, success: false, error: msg })
    return { attempted: true, success: false, error: msg }
  }

  const result = await qbo.createInvoice({
    customerRef: commission.qbCustomerRef,
    amount: commission.grossCommission,
    description: commission.description ?? undefined,
  })
  await logSync(svc, { brokerageId: commission.brokerageId, syncType: "commission", startedAt, success: result.success, error: result.error })
  return { attempted: true, success: result.success, externalId: result.externalId, error: result.error }
}
