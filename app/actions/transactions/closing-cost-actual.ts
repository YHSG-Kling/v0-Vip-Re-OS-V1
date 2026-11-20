"use server"

// THE WRITER for cost_breakdown_tracking.actual_amount (wave 46, 2026-09-09).
// The closing-cost card (app/dashboard/transactions/[id]/transaction-detail-client.tsx)
// reads actual_amount beside estimated_amount, but nothing ever wrote it — the
// opposite-missing census filed it as a read with no writer. The estimate is
// AI-generated at contract; the ACTUAL is what the settlement statement says, and
// the coordinator records it line by line as the statement lands. Tenant comes
// from the session (§4): the row must belong to the caller's brokerage or the
// UPDATE matches nothing, and a zero-row match is reported, never swallowed (§3).
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function recordClosingCostActualAction(input: {
  itemId: string
  actualAmount: number | null
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.itemId) return { ok: false, error: "itemId is required" }
  if (input.actualAmount !== null && !(Number.isFinite(input.actualAmount) && input.actualAmount >= 0)) {
    return { ok: false, error: "actualAmount must be a non-negative number or null" }
  }

  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: profile, error: profileError } = await session
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (profileError) return { ok: false, error: profileError.message }
  const brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  if (!brokerageId) return { ok: false, error: "No brokerage on this session" }
  return ledgered({ userId: user.id, brokerageId }, { action: "transaction.closing_cost_actual.record", subject: { type: "cost_breakdown_item", id: input.itemId }, riskClass: "FINANCIAL", detail: { cleared: input.actualAmount === null } }, async () => {

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("cost_breakdown_tracking")
    .update({
      actual_amount: input.actualAmount,
      // cost_breakdown_tracking.status CHECK: confirmed | estimated | paid (wave 152, 152K — row 45 census): "actual"
      // refused the whole UPDATE, so an actual closing cost was never saved (actual_amount included). An entered actual
      // is CONFIRMED; "paid" stays the payment fact's word.
      status: input.actualAmount === null ? "estimated" : "confirmed",
    })
    .eq("id", input.itemId)
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: "Closing-cost line not found in your brokerage" }
  return { ok: true }
  })
}

/**
 * WAVE 155 (lane 155R9, G12): ONE agent_action_ledger receipt per session write — ledgerSessionAction
 * (lib/kernel/action-ledger.ts) does the claim → run → settle. Who and which tenant come from the SESSION (CLAUDE.md §4);
 * "session" resolves them through getAgentContext. NO idempotency key: a person's second save runs again and leaves a
 * second receipt. The export's value comes back unchanged; a refused claim (only a malformed action name, caught by
 * test:action-ledger §14) throws instead of returning a value of another shape. No session tenant → the write runs exactly
 * as before, unrecorded (agent_action_ledger.brokerage_id is NOT NULL — there is no valid row to write).
 * @proofSeam scripts/ledger-receipts-transaction2-guard.ts
 */
async function ledgered<T>(
  who: { userId?: string | null; brokerageId?: string | null; agentId?: string | null } | null | undefined | "session",
  what: { action: string; subject: { type: string; id?: string | null; ref?: string | null }; riskClass: string; detail?: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<T> {
  const seat = who === "session" ? await (await import("@/lib/identity/get-agent-context")).getAgentContext() : who
  if (!seat?.userId || !seat.brokerageId) return run()
  const id = what.subject.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(what.subject.id) ? what.subject.id : null
  const subject = { type: what.subject.type, id, ref: id ? what.subject.ref ?? null : what.subject.ref ?? what.subject.id ?? null }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  let ran = false
  const r = await ledgerSessionAction({ brokerageId: seat.brokerageId, action: what.action, actor: { type: "user", userId: seat.userId, agentId: seat.agentId ?? null }, subject, riskClass: what.riskClass, reasonCode: "HUMAN_REQUESTED", detail: what.detail ?? null }, async () => { ran = true; return run() })
  if (!ran) throw new Error((r as { error?: string }).error ?? "action ledger refused the claim")
  return r as T
}
