/**
 * PORTAL MESSAGE EGRESS — the ledgered insert of a client_portal_messages row (wave 98, lane 98B).
 *
 * WHY THIS FILE EXISTS (orphan doctrine case 2 — no duplicate, BUILD): email / SMS / mail have ONE
 * egress (lib/providers/dispatch.ts) and it is wrapped in the action ledger. A portal message had
 * no egress at all — ~30 modules insert client_portal_messages directly — so "the AI messaged the
 * client" left no agent_action_ledger row. This is the one send helper; the SENDERS that reach a
 * client (the portal send action, the staff copilot's send_portal_message tool, the journey
 * celebration handler, the universal-inbox portal reply) route through it. The remaining direct
 * inserters are listed in docs/architecture/OS-BLUEPRINT-GAP-MAP.md (row 11) as still open.
 *
 * The row is written exactly as the caller built it (the caller already authorised the write and
 * picked the client: a session client for RLS-scoped staff, the service client after a gate).
 * Never throws; the insert's refusal is returned, read, and settled 'failed'.
 */
import { withActionLedger, type ActionContext, type ActionReasonCode, type LedgerClient } from "@/lib/kernel/action-ledger"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Writer = { from: (table: string) => any }

export interface PortalMessageLedger {
  actor: ActionContext["actor"]
  reasonCode?: ActionReasonCode | null
  reasonDetail?: string | null
  /** The unit of "once" — e.g. `journey:stage_completed:<stage>`. Omit for a human's free-form send. */
  cycle?: string | null
  systemSource?: string | null
}

export interface PortalMessageInsertResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  error: { message: string; code?: string } | null
}

/**
 * Insert one client_portal_messages row inside withActionLedger. `row` must carry brokerage_id
 * and contact_id (both NOT NULL on the table); `select` is the column list to return.
 */
export async function insertPortalMessage(
  writer: Writer,
  row: Record<string, unknown> & { brokerage_id: string; contact_id: string },
  ledger: PortalMessageLedger,
  opts?: { select?: string; ledgerClient?: LedgerClient },
): Promise<PortalMessageInsertResult> {
  const select = opts?.select ?? "id"
  return withActionLedger<PortalMessageInsertResult>({
    brokerageId: row.brokerage_id,
    action: "comms.portal.send",
    channel: "portal",
    actor: ledger.actor,
    subject: { type: "contact", id: row.contact_id },
    reasonCode: ledger.reasonCode ?? null,
    reasonDetail: ledger.reasonDetail ?? null,
    cycle: ledger.cycle ?? null,
    riskClass: "COMMUNICATION",
    systemSource: ledger.systemSource ?? null,
  }, async () => {
    // The row is STAMPED with its tenant + person — named here so the write's tenancy is readable
    // at the call (scripts/tenant-scope-guard.ts reads the chain, not the caller's object).
    const { data, error } = await writer.from("client_portal_messages")
      .insert({ ...row, brokerage_id: row.brokerage_id, contact_id: row.contact_id })
      .select(select).maybeSingle()
    return { data: data ?? null, error: error ?? (data ? null : { message: "insert returned no row" }) }
  }, {
    settle: (r) => r.error || !r.data
      ? { status: "failed", outcome: "insert_refused", provider: "portal", error: r.error?.message ?? "no row" }
      : { status: "executed", outcome: "delivered_to_portal", provider: "portal", providerRef: (r.data as { id?: string }).id ?? null, costUsd: 0 },
    replay: (claim) => claim.kind === "replay"
      ? { data: { id: claim.entry.provider_ref }, error: null }
      : { data: null, error: { message: claim.kind === "refused" ? claim.error : `portal message ${claim.kind === "unknown" ? "outcome unknown" : "already in flight"} — not re-sent`, code: "action_ledger_gate" } },
  }, opts?.ledgerClient ? { client: opts.ledgerClient } : undefined)
}
