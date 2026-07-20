// lib/finance/qb-reconciliation.ts
// ─────────────────────────────────────────────────────────────────────────────
// QUICKBOOKS RECONCILIATION REPORT (round 37, owner-approved rec 5) — a PURE
// READ-SIDE reconciliation per accounting scope: what the OS ledgers show for
// a period versus what the OS RECORDED as exported to QuickBooks (the
// quickbooks_export_id / quickbooks_synced_at markers the round-36 export
// lanes stamp). Unexported rows, export coverage %, amount totals both sides.
//
// HONESTY CONTRACT (stated in QB_RECONCILIATION_HEADER and rendered on every
// surface): this is NOT a QuickBooks API pull. A live sync job would be needed
// to see edits or deletions made inside QuickBooks itself — this report
// reconciles OS-recorded exports against OS ledgers, and says so.
//
// The ledgers are EXACTLY the tables the export lanes read (no parallel
// metrics):
//   • team      → team_earnings (monthly team P&L rows;
//                 lib/finance/scoped-accounting-export.ts stamps
//                 quickbooks_export_id / quickbooks_synced_at)
//   • agent     → agent_commissions (closed commissions; same lane, same markers)
//   • vendor    → vendor_invoices (lib/connections/vendor-quickbooks.ts stamps
//                 quickbooks_invoice_id / quickbooks_synced_at, migration 1104)
//   • brokerage → business_expenses (brokerage scope) + agent_commissions in the
//                 brokerage, reconciled against accounting_sync_log — the
//                 brokerage lane (lib/finance/accounting-egress.ts) logs each
//                 push, it does NOT stamp per-row markers, so brokerage coverage
//                 is COUNT-BASED and labeled as such (status 'log_based').
//   • platform  → the company's own books are connectable, but NO export lane
//                 writes into them yet — status 'no_export_lane', honestly.
//
// Marker columns arrive with the round-36 REPORT-ONLY migrations (team_earnings
// / agent_commissions scoped-accounting-export columns; vendor_invoices m1104).
// Before they are applied the loaders return an honest 'requires_migration'
// status — never a fake 0% or a fabricated 100%.
//
// Pure math is separated from I/O so scripts/accounting-scopes-simulator.ts
// proves the exact coverage/unexported arithmetic every surface renders.

import type { createServiceClient } from "@/lib/supabase/service"
import {
  loadScopedQuickBooksCredential,
  PLATFORM_OWNER_ID,
  type AccountingScope,
} from "@/lib/connections/accounting-scopes"

type ServiceClient = ReturnType<typeof createServiceClient>

/** The one honesty statement every reconciliation surface renders. */
export const QB_RECONCILIATION_HEADER =
  "Reconciles OS ledgers against OS-recorded export markers only — not a live QuickBooks pull. " +
  "Edits or deletions made inside QuickBooks itself are not visible here; only a live sync job could see those."

export type QbReconStatus =
  | "reconciled" // marker-based scopes: per-row markers vs ledger rows
  | "log_based" // brokerage: accounting_sync_log counts vs ledger rows (no per-row markers)
  | "not_connected" // no QuickBooks connection for this scope's owner
  | "requires_migration" // marker columns not applied yet — honest, no numbers invented
  | "no_export_lane" // platform: connectable books, but nothing exports into them yet
  | "error" // the ledger read itself failed

export interface QbReconRow {
  id: string
  label: string
  amount: number
  exportId: string | null
  syncedAt: string | null
}

export interface QbReconTotals {
  totalRows: number
  exportedRows: number
  unexportedRows: number
  totalAmount: number
  /** null when the lane records counts, not row identity (brokerage log_based). */
  exportedAmount: number | null
  unexportedAmount: number | null
  /** exportedRows / totalRows, rounded; null when the period has no rows. */
  coveragePct: number | null
  /** The unexported rows themselves (capped) — the actionable list. */
  unexported: QbReconRow[]
}

export interface ScopeQbReconciliation {
  scope: AccountingScope
  ownerId: string | null
  periodStart: string
  periodEnd: string
  periodLabel: string
  /** Which OS ledger this reconciles — named so the number is traceable. */
  ledger: string
  /** true/false when the credential read answered; null when it could not. */
  connected: boolean | null
  status: QbReconStatus
  /** Plain-language verdict for the card (status-specific, honest). */
  statement: string
  totals: QbReconTotals
}

export const UNEXPORTED_LIST_CAP = 25

// ─── Pure math ───────────────────────────────────────────────────────────────

export function emptyQbReconTotals(): QbReconTotals {
  return {
    totalRows: 0,
    exportedRows: 0,
    unexportedRows: 0,
    totalAmount: 0,
    exportedAmount: 0,
    unexportedAmount: 0,
    coveragePct: null,
    unexported: [],
  }
}

/** PURE: marker-based reconciliation — a row is exported iff it carries the
 *  export marker the lane stamped. Coverage % is row-based; amounts both sides. */
export function reconcileLedgerRows(rows: QbReconRow[]): QbReconTotals {
  let exportedRows = 0
  let totalAmount = 0
  let exportedAmount = 0
  const unexported: QbReconRow[] = []
  for (const r of rows) {
    const amt = Number.isFinite(r.amount) ? r.amount : 0
    totalAmount += amt
    if (r.exportId) {
      exportedRows += 1
      exportedAmount += amt
    } else {
      unexported.push(r)
    }
  }
  const totalRows = rows.length
  return {
    totalRows,
    exportedRows,
    unexportedRows: totalRows - exportedRows,
    totalAmount,
    exportedAmount,
    unexportedAmount: totalAmount - exportedAmount,
    coveragePct: totalRows > 0 ? Math.round((exportedRows / totalRows) * 100) : null,
    unexported: unexported.slice(0, UNEXPORTED_LIST_CAP),
  }
}

/** PURE: count-based reconciliation for the brokerage lane — the sync log
 *  records HOW MANY pushes completed, not WHICH rows, so exported amounts are
 *  honestly null and coverage is capped at 100 (a completed push can't cover
 *  more rows than exist). */
export function reconcileAgainstSyncLog(
  rows: Array<{ id: string; label: string; amount: number }>,
  completedSyncs: number,
): QbReconTotals {
  const totalRows = rows.length
  const totalAmount = rows.reduce((a, r) => a + (Number.isFinite(r.amount) ? r.amount : 0), 0)
  const exportedRows = Math.min(Math.max(0, Math.floor(completedSyncs)), totalRows)
  return {
    totalRows,
    exportedRows,
    unexportedRows: totalRows - exportedRows,
    totalAmount,
    exportedAmount: null, // the log records counts, not row identity — never invent an amount
    unexportedAmount: null,
    coveragePct: totalRows > 0 ? Math.round((exportedRows / totalRows) * 100) : null,
    unexported: [], // no per-row markers ⇒ no honest per-row unexported list
  }
}

/** PURE: 'YYYY-MM' labels for every calendar month the [start, end) window touches
 *  — how team_earnings period_label rows are selected for a period. */
export function monthLabelsBetween(startIso: string, endIso: string): string[] {
  const start = new Date(startIso)
  const end = new Date(endIso)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return []
  const labels: string[] = []
  let y = start.getUTCFullYear()
  let m = start.getUTCMonth()
  // exclusive end: a window ending exactly on a month boundary does not include that month
  const last = new Date(end.getTime() - 1)
  const lastY = last.getUTCFullYear()
  const lastM = last.getUTCMonth()
  while (y < lastY || (y === lastY && m <= lastM)) {
    labels.push(`${y}-${String(m + 1).padStart(2, "0")}`)
    m += 1
    if (m > 11) { m = 0; y += 1 }
    if (labels.length > 36) break // sanity cap
  }
  return labels
}

export interface QbReconPeriod { periodStart: string; periodEnd: string; periodLabel: string }

/** Default surface window: the current month plus the two before it. */
export function defaultQbReconciliationPeriod(now: Date = new Date()): QbReconPeriod {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))
  const fmt = (d: Date) => d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
  const startLabel = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const endLabel = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    periodLabel: `${fmt(startLabel)} – ${fmt(endLabel)}`,
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

const MARKER_COLUMN_RE = /quickbooks_(export|invoice)_id|quickbooks_synced_at/i

async function readConnected(
  svc: ServiceClient,
  scope: AccountingScope,
  ownerId: string,
): Promise<boolean | null> {
  try {
    const cred = await loadScopedQuickBooksCredential(svc, scope, ownerId)
    return !!cred
  } catch {
    return null // unknown — never claim connected or disconnected on a failed read
  }
}

function statementFor(
  status: QbReconStatus,
  totals: QbReconTotals,
  ledger: string,
): string {
  switch (status) {
    case "requires_migration":
      return `The ${ledger} export-marker columns are not applied yet (round-36 report-only migration) — the OS cannot say which rows were exported until they exist. Nothing is estimated in their place.`
    case "not_connected":
      return totals.totalRows > 0
        ? `QuickBooks is not connected for this scope — ${totals.totalRows} ledger row${totals.totalRows === 1 ? "" : "s"} in the period ${totals.exportedRows > 0 ? `(${totals.exportedRows} carry markers from a past connection)` : "and none exported"}.`
        : "QuickBooks is not connected for this scope, and the period has no ledger rows — nothing to reconcile."
    case "no_export_lane":
      return "The platform's own books are connectable, but no OS export lane writes into them yet — there is nothing to reconcile. This line exists so the absence is a stated fact, not a silent gap."
    case "log_based":
      return totals.totalRows > 0
        ? `Count-based reconciliation: the brokerage lane records each push in accounting_sync_log without per-row markers, so coverage compares completed pushes (${totals.exportedRows}) to ledger rows (${totals.totalRows}). Amounts on the exported side are unknown by design — never invented.`
        : "The period has no brokerage-scope ledger rows — nothing to reconcile."
    case "error":
      return `The ${ledger} ledger could not be read — reconciliation is unavailable right now. No numbers are shown in its place.`
    case "reconciled":
      return totals.totalRows === 0
        ? `The period has no ${ledger} rows — nothing to reconcile.`
        : totals.unexportedRows === 0
          ? `Every ${ledger} row in the period carries an OS-recorded QuickBooks export marker.`
          : `${totals.unexportedRows} of ${totals.totalRows} ${ledger} row${totals.totalRows === 1 ? "" : "s"} in the period ${totals.unexportedRows === 1 ? "has" : "have"} no OS-recorded export marker.`
  }
}

function build(
  base: Omit<ScopeQbReconciliation, "statement">,
): ScopeQbReconciliation {
  return { ...base, statement: statementFor(base.status, base.totals, base.ledger) }
}

// ─── Per-scope loaders (read-side only — no Intuit calls, ever) ──────────────

/** TEAM — team_earnings monthly P&L rows vs the scoped-export markers. */
export async function loadTeamQbReconciliation(
  svc: ServiceClient,
  params: { teamId: string } & QbReconPeriod,
): Promise<ScopeQbReconciliation> {
  const ledger = "team_earnings (monthly team P&L)"
  const common = {
    scope: "team" as const,
    ownerId: params.teamId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    periodLabel: params.periodLabel,
    ledger,
  }
  const labels = monthLabelsBetween(params.periodStart, params.periodEnd)
  const { data, error } = await svc
    .from("team_earnings")
    .select("period_label, gross_commission, quickbooks_export_id, quickbooks_synced_at")
    .eq("team_id", params.teamId)
    .eq("period_type", "mtd")
    .in("period_label", labels)

  if (error) {
    const status: QbReconStatus = MARKER_COLUMN_RE.test(error.message ?? "") ? "requires_migration" : "error"
    return build({ ...common, connected: await readConnected(svc, "team", params.teamId), status, totals: emptyQbReconTotals() })
  }
  const rows: QbReconRow[] = ((data ?? []) as any[]).map((r) => ({
    id: String(r.period_label),
    label: `Team P&L ${r.period_label}`,
    amount: Number(r.gross_commission ?? 0),
    exportId: (r.quickbooks_export_id as string | null) ?? null,
    syncedAt: (r.quickbooks_synced_at as string | null) ?? null,
  }))
  const totals = reconcileLedgerRows(rows)
  const connected = await readConnected(svc, "team", params.teamId)
  return build({ ...common, connected, status: connected === false ? "not_connected" : "reconciled", totals })
}

/** AGENT — the agent's closed commissions vs the scoped-export markers.
 *  agentUserId is the AUTH user id (the agent-scope owner key); the agent row
 *  is resolved server-side so one agent can never reconcile another's ledger. */
export async function loadAgentQbReconciliation(
  svc: ServiceClient,
  params: { agentUserId: string } & QbReconPeriod,
): Promise<ScopeQbReconciliation> {
  const ledger = "agent_commissions (closed commissions)"
  const common = {
    scope: "agent" as const,
    ownerId: params.agentUserId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    periodLabel: params.periodLabel,
    ledger,
  }
  const { data: agentRow } = await svc
    .from("agents")
    .select("id")
    .eq("user_id", params.agentUserId)
    .maybeSingle()
  if (!agentRow?.id) {
    return build({ ...common, connected: null, status: "error", totals: emptyQbReconTotals() })
  }
  const { data, error } = await svc
    .from("agent_commissions")
    .select("id, close_date, gross_commission, agent_commission, quickbooks_export_id, quickbooks_synced_at")
    .eq("agent_id", agentRow.id)
    .gte("close_date", params.periodStart.slice(0, 10))
    .lt("close_date", params.periodEnd.slice(0, 10))

  if (error) {
    const status: QbReconStatus = MARKER_COLUMN_RE.test(error.message ?? "") ? "requires_migration" : "error"
    return build({ ...common, connected: await readConnected(svc, "agent", params.agentUserId), status, totals: emptyQbReconTotals() })
  }
  const rows: QbReconRow[] = ((data ?? []) as any[]).map((r) => ({
    id: String(r.id),
    label: `Commission closed ${r.close_date ?? "(no close date)"}`,
    amount: Number(r.agent_commission ?? r.gross_commission ?? 0),
    exportId: (r.quickbooks_export_id as string | null) ?? null,
    syncedAt: (r.quickbooks_synced_at as string | null) ?? null,
  }))
  const totals = reconcileLedgerRows(rows)
  const connected = await readConnected(svc, "agent", params.agentUserId)
  return build({ ...common, connected, status: connected === false ? "not_connected" : "reconciled", totals })
}

/** VENDOR — vendor_invoices vs the quickbooks_invoice_id markers (m1104). */
export async function loadVendorQbReconciliation(
  svc: ServiceClient,
  params: { vendorId: string } & QbReconPeriod,
): Promise<ScopeQbReconciliation> {
  const ledger = "vendor_invoices"
  const common = {
    scope: "vendor" as const,
    ownerId: params.vendorId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    periodLabel: params.periodLabel,
    ledger,
  }
  const { data, error } = await svc
    .from("vendor_invoices")
    .select("id, invoice_number, total_amount, created_at, quickbooks_invoice_id, quickbooks_synced_at")
    .eq("vendor_id", params.vendorId)
    .gte("created_at", params.periodStart)
    .lt("created_at", params.periodEnd)

  if (error) {
    const status: QbReconStatus = MARKER_COLUMN_RE.test(error.message ?? "") ? "requires_migration" : "error"
    return build({ ...common, connected: await readConnected(svc, "vendor", params.vendorId), status, totals: emptyQbReconTotals() })
  }
  const rows: QbReconRow[] = ((data ?? []) as any[]).map((r) => ({
    id: String(r.id),
    label: `Invoice ${r.invoice_number ?? String(r.id).slice(0, 8)}`,
    amount: Number(r.total_amount ?? 0),
    exportId: (r.quickbooks_invoice_id as string | null) ?? null,
    syncedAt: (r.quickbooks_synced_at as string | null) ?? null,
  }))
  const totals = reconcileLedgerRows(rows)
  const connected = await readConnected(svc, "vendor", params.vendorId)
  return build({ ...common, connected, status: connected === false ? "not_connected" : "reconciled", totals })
}

/** BROKERAGE — brokerage-scope expenses + the brokerage's commissions vs
 *  accounting_sync_log (the lane logs pushes; it stamps no per-row markers, so
 *  this is COUNT-BASED and says so — status 'log_based'). */
export async function loadBrokerageQbReconciliation(
  svc: ServiceClient,
  params: { brokerageId: string } & QbReconPeriod,
): Promise<ScopeQbReconciliation> {
  const ledger = "business_expenses + agent_commissions (brokerage scope)"
  const common = {
    scope: "brokerage" as const,
    ownerId: params.brokerageId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    periodLabel: params.periodLabel,
    ledger,
  }
  try {
    const [expensesRes, commissionsRes, logRes] = await Promise.all([
      // Brokerage-scope expenses: agent_id and team_id NULL IS the scope marker
      // (app/actions/financials.ts owner rule — no cross-book rollup).
      svc
        .from("business_expenses")
        .select("id, amount, expense_date")
        .eq("brokerage_id", params.brokerageId)
        .is("agent_id", null)
        .is("team_id", null)
        .gte("expense_date", params.periodStart.slice(0, 10))
        .lt("expense_date", params.periodEnd.slice(0, 10)),
      // The brokerage's closed commissions — the rows the commission push reads.
      svc
        .from("agent_commissions")
        .select("id, gross_commission, close_date, agents!inner(brokerage_id)")
        .eq("agents.brokerage_id", params.brokerageId)
        .gte("close_date", params.periodStart.slice(0, 10))
        .lt("close_date", params.periodEnd.slice(0, 10)),
      // What the lane recorded: completed QuickBooks pushes in the period.
      svc
        .from("accounting_sync_log")
        .select("status, records_synced")
        .eq("brokerage_id", params.brokerageId)
        .eq("provider", "quickbooks")
        .gte("started_at", params.periodStart)
        .lt("started_at", params.periodEnd),
    ])
    const err = expensesRes.error ?? commissionsRes.error ?? logRes.error
    if (err) {
      return build({ ...common, connected: await readConnected(svc, "brokerage", params.brokerageId), status: "error", totals: emptyQbReconTotals() })
    }
    const rows = [
      ...((expensesRes.data ?? []) as any[]).map((r) => ({
        id: String(r.id),
        label: `Expense ${r.expense_date ?? ""}`.trim(),
        amount: Number(r.amount ?? 0),
      })),
      ...((commissionsRes.data ?? []) as any[]).map((r) => ({
        id: String(r.id),
        label: `Commission closed ${r.close_date ?? ""}`.trim(),
        amount: Number(r.gross_commission ?? 0),
      })),
    ]
    const completed = ((logRes.data ?? []) as any[])
      .filter((l) => l.status === "completed")
      .reduce((a, l) => a + Math.max(1, Number(l.records_synced ?? 1)), 0)
    const totals = reconcileAgainstSyncLog(rows, completed)
    const connected = await readConnected(svc, "brokerage", params.brokerageId)
    return build({ ...common, connected, status: connected === false ? "not_connected" : "log_based", totals })
  } catch {
    return build({ ...common, connected: null, status: "error", totals: emptyQbReconTotals() })
  }
}

/** PLATFORM — connectable books, no export lane writes into them yet: the
 *  reconciliation exists to state that fact, not to invent a coverage number. */
export async function loadPlatformQbReconciliation(
  svc: ServiceClient,
  period: QbReconPeriod,
): Promise<ScopeQbReconciliation> {
  const connected = await readConnected(svc, "platform", PLATFORM_OWNER_ID)
  return build({
    scope: "platform",
    ownerId: PLATFORM_OWNER_ID,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    periodLabel: period.periodLabel,
    ledger: "(no export lane)",
    connected,
    status: "no_export_lane",
    totals: emptyQbReconTotals(),
  })
}
