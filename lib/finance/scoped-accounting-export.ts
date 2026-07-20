// lib/finance/scoped-accounting-export.ts
// ─────────────────────────────────────────────────────────────────────────────
// SCOPED BOOKS EXPORT (additive, round 36). The team and agent levels can now
// connect their OWN QuickBooks company (lib/connections/accounting-scopes.ts);
// this module is the export lane that writes their existing finance records
// into it:
//
//   • TEAM  — the monthly team P&L row (team_earnings, written by
//     lib/finance/team-pl-writer.ts) exports as a QBO SalesReceipt of the
//     team's gross commission for the period, customer = the brokerage.
//   • AGENT — a closed commission record (agent_commissions) exports as a QBO
//     SalesReceipt of the agent's take (agent_commission), customer = the
//     brokerage that paid it.
//
// SCOPE ISOLATION: both lanes load credentials with loadScopedQuickBooksCredential
// (EXACT owner match) — a team export can only ever use the TEAM's token and an
// agent export the AGENT's; there is no cascade, so neither can silently write
// into the brokerage's (or anyone else's) company. Brokerage-book exports remain
// exclusively lib/finance/accounting-egress.ts.
//
// HONESTY CONTRACT (vendor-quickbooks idiom):
//   • Not connected → { attempted:false } — callers render "Not synced"; no log,
//     no fake marker.
//   • Idempotent via the quickbooks_export_id marker column; the pre-flight read
//     INCLUDES that column so a missing migration is an honest "requires
//     migration" error BEFORE any Intuit call (an exported receipt we can't
//     record locally would double on retry).
//   • A QBO id is only recorded after Intuit actually returned one.
//
// Requires (REPORT-ONLY migration, not yet applied):
//   ALTER TABLE team_earnings      ADD COLUMN quickbooks_export_id text, ADD COLUMN quickbooks_synced_at timestamptz;
//   ALTER TABLE agent_commissions  ADD COLUMN quickbooks_export_id text, ADD COLUMN quickbooks_synced_at timestamptz;

import "server-only"
import type { createServiceClient } from "@/lib/supabase/service"
import {
  loadScopedQuickBooksCredential,
  ensureFreshQuickBooksToken,
  qboRequest,
  findOrCreateQboCustomer,
} from "@/lib/connections/accounting-scopes"

type ServiceClient = ReturnType<typeof createServiceClient>

export interface ScopedBooksPushOutcome {
  /** false ⇒ nothing was attempted (no connection / missing migration / bad input). */
  attempted: boolean
  success: boolean
  externalId?: string
  error?: string
}

function missingMigrationError(table: string): ScopedBooksPushOutcome {
  return {
    attempted: false,
    success: false,
    error: `QuickBooks export requires the scoped-accounting-export migration (${table}.quickbooks_export_id) — not yet applied.`,
  }
}

async function brokerageCustomer(
  svc: ServiceClient,
  accessToken: string,
  realmId: string,
  brokerageId: string | null,
): Promise<string> {
  let displayName = "Brokerage"
  let email: string | null = null
  if (brokerageId) {
    const { data } = await svc.from("brokerages").select("name, email").eq("id", brokerageId).maybeSingle()
    displayName = (data?.name as string | null) ?? "Brokerage"
    email = ((data as { email?: string | null } | null)?.email as string | null) ?? null
  }
  return findOrCreateQboCustomer({ accessToken, realmId, displayName, email })
}

/**
 * Export ONE team's monthly P&L row into the TEAM's own QuickBooks company as a
 * SalesReceipt (gross commission for the period). Idempotent per
 * (team, period): a row already carrying quickbooks_export_id is returned as-is.
 */
export async function pushTeamPnlToQuickBooks(
  svc: ServiceClient,
  params: { teamId: string; periodLabel: string },
): Promise<ScopedBooksPushOutcome> {
  // Pre-flight INCLUDING the marker column (missing-migration detection before any egress).
  const { data: row, error: rowErr } = await svc
    .from("team_earnings")
    .select("team_id, brokerage_id, period_label, gross_commission, quickbooks_export_id")
    .eq("team_id", params.teamId)
    .eq("period_type", "mtd")
    .eq("period_label", params.periodLabel)
    .maybeSingle()

  if (rowErr) {
    const msg = rowErr.message ?? ""
    if (/quickbooks_export_id/i.test(msg)) return missingMigrationError("team_earnings")
    return { attempted: false, success: false, error: msg || "Failed to load team P&L row" }
  }
  if (!row) return { attempted: false, success: false, error: `No team P&L row for period ${params.periodLabel}` }
  if (row.quickbooks_export_id) return { attempted: true, success: true, externalId: row.quickbooks_export_id }

  const gross = Number(row.gross_commission ?? 0)
  if (!(gross > 0)) {
    return { attempted: false, success: false, error: "Nothing to export — the period has no gross commission." }
  }

  // EXACT team-owner credential — never the brokerage's (scope isolation, see header).
  const cred = await loadScopedQuickBooksCredential(svc, "team", params.teamId)
  if (!cred) return { attempted: false, success: false }

  try {
    const accessToken = await ensureFreshQuickBooksToken(svc, cred)
    const customerId = await brokerageCustomer(svc, accessToken, cred.realmId, (row.brokerage_id as string | null) ?? null)

    const created = await qboRequest<{ SalesReceipt: { Id: string } }>({
      accessToken,
      realmId: cred.realmId,
      method: "POST",
      path: "/salesreceipt?minorversion=73",
      body: {
        CustomerRef: { value: customerId },
        Line: [
          {
            Amount: gross,
            DetailType: "SalesItemLineDetail",
            Description: `Team commission income — ${row.period_label} (VIP RE OS team P&L)`,
            SalesItemLineDetail: { ItemRef: { value: "1" } },
          },
        ],
      },
    })

    const externalId = created.SalesReceipt.Id
    const { error: updErr } = await svc
      .from("team_earnings")
      .update({ quickbooks_export_id: externalId, quickbooks_synced_at: new Date().toISOString() })
      .eq("team_id", params.teamId)
      .eq("period_type", "mtd")
      .eq("period_label", params.periodLabel)

    if (updErr) {
      return {
        attempted: true,
        success: false,
        externalId,
        error: `Receipt created in QuickBooks (id ${externalId}) but recording the sync locally failed: ${updErr.message}`,
      }
    }
    return { attempted: true, success: true, externalId }
  } catch (err) {
    return { attempted: true, success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Export ONE closed commission record into the AGENT's own QuickBooks company
 * as a SalesReceipt of the agent's take. `agentUserId` is the auth user id (the
 * agent-scope owner key); the commission must belong to that user's agent row —
 * verified server-side, so one agent can never export another's record.
 */
export async function pushAgentCommissionToQuickBooks(
  svc: ServiceClient,
  params: { agentUserId: string; commissionId: string },
): Promise<ScopedBooksPushOutcome> {
  // Ownership: auth user → agents.id.
  const { data: agentRow } = await svc
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", params.agentUserId)
    .maybeSingle()
  if (!agentRow?.id) return { attempted: false, success: false, error: "No agent profile for this user" }

  // Pre-flight INCLUDING the marker column (missing-migration detection before any egress).
  const { data: comm, error: commErr } = await svc
    .from("agent_commissions")
    // The address lives on the transaction, not the commission row — embed it.
    .select("id, agent_id, gross_commission, agent_commission, close_date, quickbooks_export_id, transactions(property_address)")
    .eq("id", params.commissionId)
    .eq("agent_id", agentRow.id)
    .maybeSingle()

  if (commErr) {
    const msg = commErr.message ?? ""
    if (/quickbooks_export_id/i.test(msg)) return missingMigrationError("agent_commissions")
    return { attempted: false, success: false, error: msg || "Failed to load commission" }
  }
  if (!comm) return { attempted: false, success: false, error: "Commission not found for this agent" }
  if (comm.quickbooks_export_id) return { attempted: true, success: true, externalId: comm.quickbooks_export_id }

  const amount = Number(comm.agent_commission ?? comm.gross_commission ?? 0)
  if (!(amount > 0)) return { attempted: false, success: false, error: "Nothing to export — the commission has no amount." }

  // EXACT agent-owner credential (owner_id = auth USER id, what the OAuth callback writes).
  const cred = await loadScopedQuickBooksCredential(svc, "agent", params.agentUserId)
  if (!cred) return { attempted: false, success: false }

  try {
    const accessToken = await ensureFreshQuickBooksToken(svc, cred)
    const customerId = await brokerageCustomer(svc, accessToken, cred.realmId, (agentRow.brokerage_id as string | null) ?? null)

    const created = await qboRequest<{ SalesReceipt: { Id: string } }>({
      accessToken,
      realmId: cred.realmId,
      method: "POST",
      path: "/salesreceipt?minorversion=73",
      body: {
        CustomerRef: { value: customerId },
        ...(comm.close_date ? { TxnDate: comm.close_date } : {}),
        Line: [
          {
            Amount: amount,
            DetailType: "SalesItemLineDetail",
            Description: `Commission income${(comm as { transactions?: { property_address?: string | null } | null }).transactions?.property_address ? ` — ${(comm as { transactions?: { property_address?: string | null } | null }).transactions!.property_address}` : ""}`,
            SalesItemLineDetail: { ItemRef: { value: "1" } },
          },
        ],
      },
    })

    const externalId = created.SalesReceipt.Id
    const { error: updErr } = await svc
      .from("agent_commissions")
      .update({ quickbooks_export_id: externalId, quickbooks_synced_at: new Date().toISOString() })
      .eq("id", params.commissionId)
      .eq("agent_id", agentRow.id)

    if (updErr) {
      return {
        attempted: true,
        success: false,
        externalId,
        error: `Receipt created in QuickBooks (id ${externalId}) but recording the sync locally failed: ${updErr.message}`,
      }
    }
    return { attempted: true, success: true, externalId }
  } catch (err) {
    return { attempted: true, success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
