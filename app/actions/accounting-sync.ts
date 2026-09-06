"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import { QuickBooksProvider, type AccountingWriteResult } from "@/lib/providers/accounting/quickbooks"

// ─── GET PROVIDER CONNECTION STATUS ──────────────────────────────────────────
export async function getProviderConnectionStatus(brokerageId: string) {
  const supabase = await createClient()

  const { data: credentials } = await supabase
    .from("integration_credentials")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .in("provider_name", ["quickbooks", "xero"])

  const quickbooks = credentials?.find((c) => c.provider_name === "quickbooks")
  const xero = credentials?.find((c) => c.provider_name === "xero")

  // The OAuth callback stores tokens OWNER-SCOPED in platform_credentials
  // (owner_type='brokerage'), not integration_credentials — read that row too so the
  // card reflects the connection the flow actually writes (exact owner match; the
  // status shown is this brokerage's own connection, never an inherited one).
  //
  // QUICKBOOKS ONLY. Xero is deliberately absent from this list: it is not a
  // connectable provider in the Connection OS (lib/connections/scope.ts —
  // CONNECTOR_PROVIDERS.financial is [quickbooks, stripe]) and so it is not an
  // admitted platform_credentials.platform value either. Asking for it here
  // returned nothing every single time; it read like "not connected yet" when it
  // was in fact unaskable. The Xero half of the card below still reads
  // integration_credentials, whose provider_name is free text and CAN hold it —
  // so nothing is lost by dropping the impossible half of this query.
  const svc = createServiceClient()
  const { data: ownerRows } = await svc
    .from("platform_credentials")
    .select("platform, account_name, account_id, is_active")
    .eq("owner_type", "brokerage")
    .eq("owner_id", brokerageId)
    .eq("platform", "quickbooks")
    .eq("is_active", true)
  const qbOwnerRow = ownerRows?.find((r) => r.platform === "quickbooks")

  // Get last sync for each provider
  const { data: lastSyncs } = await supabase
    .from("accounting_sync_log")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .in("provider", ["quickbooks", "xero"])
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(2)

  const qbLastSync = lastSyncs?.find((s) => s.provider === "quickbooks")
  const xeroLastSync = lastSyncs?.find((s) => s.provider === "xero")

  return {
    quickbooks: {
      connected: (quickbooks?.is_active ?? false) || !!qbOwnerRow,
      companyName: (qbOwnerRow?.account_name ?? quickbooks?.webhook_url) ?? null, // legacy rows kept company name in webhook_url
      lastSyncedAt: qbLastSync?.completed_at ?? null,
      credentialId: quickbooks?.id ?? null,
    },
    xero: {
      // integration_credentials only — see the owner-row note above.
      connected: xero?.is_active ?? false,
      companyName: xero?.webhook_url ?? null,
      lastSyncedAt: xeroLastSync?.completed_at ?? null,
      credentialId: xero?.id ?? null,
    },
  }
}

// ─── DISCONNECT PROVIDER ─────────────────────────────────────────────────────
export async function disconnectProvider(data: {
  provider: "quickbooks" | "xero"
  brokerageId: string
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Verify user has broker/admin role
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, role, brokerage_id")
    .eq("id", user.id)
    .single()

  // Same finance-roster gate as the write path above (accounting-sync is a
  // brokerage-wide MONEY surface; the predicate is case-insensitive and takes
  // the legacy `role` spelling on input only).
  if (!profile || !isBrokerageFinanceAdmin({ user_type: profile.user_type ?? profile.role })) {
    throw new Error("Unauthorized: broker or admin role required")
  }

  // Deactivate the credential
  const { error } = await supabase
    .from("integration_credentials")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("brokerage_id", data.brokerageId)
    .eq("provider_name", data.provider)

  if (error) throw error

  // Also deactivate the OWNER-SCOPED row the OAuth callback writes (exact owner
  // match — only this brokerage's own connection is touched).
  // This is the ACCESS REVOCATION half. The integration_credentials row above
  // is error-checked and throws; this one was not, so a refusal left the
  // OAuth token on the owner-scoped row still active while the action reported
  // the integration disconnected.
  const { error: ownerCredError } = await createServiceClient()
    .from("platform_credentials")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("owner_type", "brokerage")
    .eq("owner_id", data.brokerageId)
    .eq("platform", data.provider)
  if (ownerCredError) throw new Error(`Integration deactivated, but the stored credential is still active: ${ownerCredError.message}`)

  // Kernel event — audit row + reactor (was a bare insert nobody downstream heard).
  await emitKernelEvent({
    brokerageId: data.brokerageId,
    event: KernelEvent.INTEGRATION_DEACTIVATED,
    entityType: "integration_credentials",
    entityId: data.brokerageId,
    actorUserId: user.id,
    metadata: {
      provider: data.provider,
      disconnected_by: user.id,
    },
  })

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return { success: true }
}

// ─── GET SYNC HISTORY ────────────────────────────────────────────────────────
export async function getSyncHistory(data: {
  brokerageId: string
  provider?: string
  status?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}) {
  const supabase = await createClient()

  let query = supabase
    .from("accounting_sync_log")
    .select("*", { count: "exact" })
    .eq("brokerage_id", data.brokerageId)
    .order("started_at", { ascending: false })

  if (data.provider) {
    query = query.eq("provider", data.provider)
  }

  if (data.status) {
    query = query.eq("status", data.status)
  }

  if (data.dateFrom) {
    query = query.gte("started_at", data.dateFrom)
  }

  if (data.dateTo) {
    query = query.lte("started_at", data.dateTo)
  }

  query = query.range(data.offset ?? 0, (data.offset ?? 0) + (data.limit ?? 20) - 1)

  const { data: logs, count, error } = await query

  if (error) throw error

  return { logs: logs || [], count: count ?? 0 }
}

// ─── GET SYNC ERRORS ─────────────────────────────────────────────────────────
export async function getSyncErrors(data: {
  brokerageId: string
  syncLogId?: string
  limit?: number
  offset?: number
}) {
  const supabase = await createClient()

  let query = supabase
    .from("sync_errors")
    .select("*", { count: "exact" })
    .eq("brokerage_id", data.brokerageId)
    .order("created_at", { ascending: false })

  if (data.syncLogId) {
    query = query.eq("sync_log_id", data.syncLogId)
  }

  query = query.range(data.offset ?? 0, (data.offset ?? 0) + (data.limit ?? 50) - 1)

  const { data: errors, count, error } = await query

  if (error) throw error

  return { errors: errors || [], count: count ?? 0 }
}

// ─── RETRY SYNC ERROR ────────────────────────────────────────────────────────
export async function retrySyncError(data: {
  errorId: string
  brokerageId: string
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Get the error details
  const { data: errorRecord, error: fetchError } = await supabase
    .from("sync_errors")
    .select("*")
    .eq("id", data.errorId)
    .eq("brokerage_id", data.brokerageId)
    .single()

  if (fetchError || !errorRecord) throw new Error("Error record not found")

  // Delete the error (mark as retried by removing from table)
  const { error: deleteError } = await supabase
    .from("sync_errors")
    .delete()
    .eq("id", data.errorId)

  if (deleteError) throw deleteError

  // Log that we're re-queuing this record — audit row + reactor.
  await emitKernelEvent({
    brokerageId: data.brokerageId,
    event: KernelEvent.SYSTEM_SYNC_TRIGGERED,
    entityType: "sync_errors",
    entityId: data.errorId,
    actorUserId: user.id,
    metadata: {
      record_type: errorRecord.record_type,
      record_id: errorRecord.record_id,
      retried_by: user.id,
    },
  })

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return { success: true }
}

// ─── PUSH AN ENTRY TO QUICKBOOKS (the real write) ────────────────────────────
// The connection/sync-log/tax-category scaffolding above tracked QuickBooks but never
// called it. This dispatches a real invoice/journal write through QuickBooksProvider,
// resolving the brokerage's OAuth creds via connection-manager (any of the three stores),
// refreshing the token if near expiry, and recording the outcome in accounting_sync_log.

// Financial cascade: agent → team → brokerage → platform (most-specific QuickBooks
// connection wins). The build logic moved to lib/finance/accounting-egress.ts
// (keep-one) so logScopedExpense and the commission path share ONE egress.
async function buildQuickBooks(
  brokerageId: string,
  actor?: { agentUserId?: string | null; teamId?: string | null },
): Promise<QuickBooksProvider | null> {
  const { buildQuickBooksForBrokerage } = await import("@/lib/finance/accounting-egress")
  return buildQuickBooksForBrokerage(brokerageId, actor)
}

/**
 * Post a real invoice / journal / expense into the BROKERAGE'S QuickBooks company.
 *
 * ─── THE TENANT COMES FROM THE SESSION (§4 fix, wave 26) ────────────────────
 * This used to take `brokerageId` in `params`, gate on the caller's ROLE only,
 * and then hand that caller-supplied id to a SERVICE client (RLS bypassed) and
 * to buildQuickBooks. The role gate read `profile.brokerage_id` and never
 * compared it to `params.brokerageId`. So any broker or brokerage admin of ANY
 * tenant could post entries into ANOTHER tenant's QuickBooks company and write
 * accounting_sync_log rows under that tenant's id — verbatim the shape CLAUDE.md
 * §4 names ("Body-supplied brokerageId on a service client is the IDOR shape
 * found repeatedly here"), on the accounting egress. It was unexploited only
 * because nothing called it; wiring it as it stood would have shipped the hole.
 *
 * The parameter is GONE rather than validated: a field that must always equal
 * the session's value is not an input, and leaving it accepted-but-checked
 * invites the next caller to pass one.
 *
 * STILL UNCALLED, and here is what blocks the obvious wire (wave 26). The
 * proposed home was a "push this record" control on the sync-error row
 * (app/settings/accounting/error-log-table.tsx). It cannot be built honestly
 * from there: `sync_errors` carries only record_type / record_id / error_code /
 * error_message / payload_snapshot, and
 *   · payload_snapshot is NEVER WRITTEN — the sole writer,
 *     app/api/accounting/sync/route.ts:150, omits the column entirely; and
 *   · that writer is a stub. Its expense/commission loops increment
 *     recordsSynced without calling any provider ("Simulate sync to accounting
 *     provider // In production, this would call QuickBooks/Xero API"), so the
 *     catch that would produce an error row is unreachable.
 * A push needs an amount and an account/customer ref. Nothing on that row
 * carries them, so a per-error push would have to INVENT the figures it posts to
 * the brokerage's books. Reported instead of wired: this needs either a real
 * payload_snapshot from a real sync, or a manual-entry surface that supplies the
 * fields — a product decision, not a wiring gap.
 */
export async function pushAccountingEntry(
  params:
    | { kind: "invoice"; customerRef: string; amount: number; description?: string; currency?: string }
    | { kind: "journal"; lines: Array<{ amount: number; accountRef: string; postingType: "Debit" | "Credit" }>; description?: string }
    | { kind: "expense"; amount: number; expenseAccountRef: string; paymentAccountRef: string; description?: string; txnDate?: string },
): Promise<{ ok: true; result: AccountingWriteResult } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: profile, error: profileError } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  // supabase-js RESOLVES refusals. An unreadable profile must REFUSE, not fall
  // through to an undefined user_type that the roster would reject for the wrong
  // reason — "nobody checked" must never render as "checked and fine" (§4).
  if (profileError) {
    console.error("[accounting-sync] caller profile read refused — refusing the push:", profileError.message)
    return { ok: false, error: "Could not verify your account." }
  }
  // TRUE ADMIN GATE, brokerage-wide MONEY (accounting-sync): repointed to THE
  // finance roster (mirrors public.is_brokerage_finance_admin, m472).
  // 'superadmin' was dead — 0 live rows store that users.user_type.
  if (!isBrokerageFinanceAdmin({ user_type: profile?.user_type })) {
    return { ok: false, error: "Broker/admin role required" }
  }
  // THE TENANT, from the session and nowhere else. Fails closed when unlinked:
  // an unlinked user has no books to post into.
  const brokerageId = profile?.brokerage_id as string | null | undefined
  if (!brokerageId) {
    return { ok: false, error: "Your account is not linked to a brokerage yet." }
  }

  const startedAt = new Date().toISOString()
  const svc = createServiceClient()
  const logFailure = async (msg: string) => {
    const { error: logErr } = await svc.from("accounting_sync_log").insert({
      brokerage_id: brokerageId, provider: "quickbooks", sync_type: params.kind,
      status: "failed", records_synced: 0, records_failed: 1,
      started_at: startedAt, completed_at: new Date().toISOString(), error_summary: msg.slice(0, 500),
    })
    // A failure we could not even record is worse than the failure itself — the
    // error log the UI reads would show nothing went wrong.
    if (logErr) console.error("[accounting-sync] failure NOT recorded in accounting_sync_log:", logErr.message)
  }

  let qbo: QuickBooksProvider | null
  try {
    // Accounting writes are the BROKERAGE's books — resolve brokerage → platform only. We do NOT
    // pass the acting broker's agent scope, or a broker who linked a personal QuickBooks would post
    // brokerage invoices to their own company. (Agent/team financial connections cascade for their
    // OWN financial ops, not the brokerage ledger.)
    qbo = await buildQuickBooks(brokerageId, { teamId: null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logFailure(msg)
    return { ok: false, error: msg }
  }
  if (!qbo) {
    await logFailure("QuickBooks not connected")
    return { ok: false, error: "QuickBooks is not connected for this brokerage" }
  }

  const result =
    params.kind === "invoice"
      ? await qbo.createInvoice({ customerRef: params.customerRef, amount: params.amount, description: params.description, currency: params.currency })
      : params.kind === "expense"
        ? await qbo.createPurchase({ amount: params.amount, expenseAccountRef: params.expenseAccountRef, paymentAccountRef: params.paymentAccountRef, description: params.description, txnDate: params.txnDate })
        : await qbo.createJournalEntry({ lines: params.lines, description: params.description })

  const { error: outcomeLogErr } = await svc.from("accounting_sync_log").insert({
    brokerage_id: brokerageId, provider: "quickbooks", sync_type: params.kind,
    status: result.success ? "completed" : "failed",
    records_synced: result.success ? 1 : 0, records_failed: result.success ? 0 : 1,
    started_at: startedAt, completed_at: new Date().toISOString(),
    error_summary: result.success ? null : (result.error ?? "unknown error")?.slice(0, 500),
  })
  // The push already hit Intuit; an unrecorded outcome means the sync history
  // the operator reads disagrees with the books. Surfaced, never swallowed.
  if (outcomeLogErr) {
    console.error("[accounting-sync] push outcome NOT recorded in accounting_sync_log:", outcomeLogErr.message)
  }

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return { ok: true, result }
}

// ─── GET TAX CATEGORIES ──────────────────────────────────────────────────────
export async function getTaxCategories(brokerageId: string) {
  const supabase = await createClient()

  const { data: categories, error } = await supabase
    .from("tax_categories")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("category_name", { ascending: true })

  if (error) throw error

  return categories || []
}

// ─── UPDATE TAX CATEGORY ──────────────────────────────��──────────────────────
export async function updateTaxCategory(data: {
  categoryId: string
  brokerageId: string
  taxCode?: string
  providerAccountId?: string
  isActive?: boolean
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const updates: Record<string, unknown> = {}
  if (data.taxCode !== undefined) updates.tax_code = data.taxCode
  if (data.providerAccountId !== undefined) updates.provider_account_id = data.providerAccountId
  if (data.isActive !== undefined) updates.is_active = data.isActive

  const { error } = await supabase
    .from("tax_categories")
    .update(updates)
    .eq("id", data.categoryId)
    .eq("brokerage_id", data.brokerageId)

  if (error) throw error

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return { success: true }
}

// ─── CREATE TAX CATEGORY ─────────────────────────────────────────────────────
export async function createTaxCategory(data: {
  brokerageId: string
  categoryName: string
  taxCode?: string
  providerAccountId?: string
  appliesTo?: string[]
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: category, error } = await supabase
    .from("tax_categories")
    .insert({
      brokerage_id: data.brokerageId,
      category_name: data.categoryName,
      tax_code: data.taxCode,
      provider_account_id: data.providerAccountId,
      applies_to: data.appliesTo || [],
      is_active: true,
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return category
}

// ─── CLEAR RESOLVED ERRORS ───────────────────────────────────────────────────
export async function clearResolvedErrors(brokerageId: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Delete all errors for this brokerage (they can retry individually if needed)
  const { error } = await supabase
    .from("sync_errors")
    .delete()
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/accounting")
  return { success: true }
}

// ─── SCOPED BOOKS EXPORT (team P&L / agent commission → their OWN QuickBooks) ─
//
// WAVE 26 WIRE. lib/finance/scoped-accounting-export.ts had ZERO importers: the
// team and agent QuickBooks export lanes were fully built — scope-isolated
// credentials (EXACT owner match, no cascade), idempotent through the
// quickbooks_export_id marker, honest { attempted:false } when not connected —
// and nothing could reach them. The module's header also still claimed its
// marker-column migration was unapplied; it is applied (corrected there).
//
// Both underlying functions verify OWNERSHIP themselves (the team row must be
// the caller's led team; the commission must belong to the caller's own agent
// row), so these wrappers resolve identity from the SESSION and pass it in —
// never a caller-supplied owner.

/** Export the caller's LED TEAM's monthly P&L into the TEAM's own QuickBooks. */
export async function pushTeamPnlToQuickBooksAction(periodLabel: string): Promise<
  { ok: true; attempted: boolean; success: boolean; externalId?: string; error?: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }

  // Period is a caller input and reaches a query — pin its shape.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodLabel ?? "")) {
    return { ok: false, error: "Period must be YYYY-MM." }
  }

  // THE TEAM COMES FROM THE SESSION. resolveLedTeamId answers "which team does
  // this user LEAD", so a member cannot export their team's books and nobody can
  // name someone else's team.
  const { resolveLedTeamId } = await import("@/lib/kernel/resolve-user-team")
  const teamId = await resolveLedTeamId(supabase as never, user.id)
  if (!teamId) return { ok: false, error: "Only a team lead can export the team's books." }

  const { pushTeamPnlToQuickBooks } = await import("@/lib/finance/scoped-accounting-export")
  const outcome = await pushTeamPnlToQuickBooks(createServiceClient(), { teamId, periodLabel })

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/dashboard/financials/team")
  return { ok: true, ...outcome }
}

/** Export ONE of the caller's OWN closed commission records into their own QuickBooks. */
export async function pushAgentCommissionToQuickBooksAction(commissionId: string): Promise<
  { ok: true; attempted: boolean; success: boolean; externalId?: string; error?: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  if (!commissionId) return { ok: false, error: "A commission id is required." }

  // agentUserId is the SESSION's auth user id — the agent-scope owner key. The
  // export re-derives the agents row from it and refuses a commission that is
  // not that agent's, so one agent can never export another's record.
  const { pushAgentCommissionToQuickBooks } = await import("@/lib/finance/scoped-accounting-export")
  const outcome = await pushAgentCommissionToQuickBooks(createServiceClient(), {
    agentUserId: user.id,
    commissionId,
  })

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/dashboard/financials/agent")
  return { ok: true, ...outcome }
}
