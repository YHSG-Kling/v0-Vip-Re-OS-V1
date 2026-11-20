"use server"

import { bestEffort } from "@/lib/db/best-effort"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function logTransactionDelay(params: {
  transactionId: string
  delays: string[]
  reasons: string[]
  impactDays: number
  notifyClient?: boolean
}) {
  const supabase = await createClient()
  const { brokerageId, agentId, userId, isAuthenticated } = await getAgentContext()
  if (!isAuthenticated || !brokerageId) return { success: false, error: "Unauthorized" }
  return ledgered({ userId, brokerageId, agentId }, { action: "transaction.delay.log", subject: { type: "transaction", id: params.transactionId }, riskClass: params.notifyClient ? "COMMUNICATION" : "LOW_RISK_WRITE", detail: { impact_days: params.impactDays, notify_client: params.notifyClient ?? false } }, async () => {

  const { data, error } = await supabase
    .from("timeline_transparency")
    .upsert(
      {
        transaction_id: params.transactionId,
        brokerage_id: brokerageId,
        delays: params.delays,
        reason_for_delays: params.reasons,
        impact_on_closing: params.impactDays,
        communicated_to_client: params.notifyClient ?? false,
      },
      { onConflict: "transaction_id" },
    )
    .select()
    .single()

  if (error) return { success: false, error: error.message }

  if (params.notifyClient) {
    // The delay row is saved either way; only the client-facing update needs an
    // agent to sign it, and transparency_updates.agent_id will not take a null.
    if (!agentId) {
      return { success: true, delay: data, error: "Delay saved, but no agent profile on this account — the client was not notified." }
    }

    const { error: updateError } = await supabase
      .from("transparency_updates")
      .insert({
        transaction_id: params.transactionId,
        update_type: "delay_notice",
        message: `Your closing may be impacted by ${params.impactDays} day(s) due to: ${params.reasons.join(", ")}. Your agent is actively managing this.`,
        is_visible_to_client: true,
        agent_id: agentId,
      })
    if (updateError) {
      return { success: true, delay: data, error: `Delay saved, but the client notice failed: ${updateError.message}` }
    }

    void bestEffort(supabase
      .from("timeline_transparency")
      .update({ communicated_to_client: true })
      .eq("transaction_id", params.transactionId), "marks the delay as communicated after the client notice already landed")
  }

  return { success: true, delay: data }
  })
}

export async function getTransactionDelays(transactionId: string) {
  const supabase = await createClient()

  const [{ data: delays }, { data: updates }] = await Promise.all([
    supabase
      .from("timeline_transparency")
      .select("*")
      .eq("transaction_id", transactionId)
      .maybeSingle(),
    supabase
      .from("transparency_updates")
      .select("id, update_type, message, is_visible_to_client, created_at")
      .eq("transaction_id", transactionId)
      .order("created_at", { ascending: false })
      .limit(10),
  ])

  return { delays, updates: updates ?? [] }
}

/**
 * Mark a transaction's logged delays as having been communicated to the client.
 *
 * NOT a duplicate of the `void supabase…update(…)` inside `logTransactionDelay`
 * above, even though the write is the same: that one only fires when a delay is
 * being logged *and* `notifyClient` is set. This is the standalone case — the
 * agent phoned the client about a delay that was already on file. That is a real
 * distinct operation, so it is kept rather than folded in.
 *
 * 🚨 It had NO auth gate, NO tenant scope, and returned the raw PostgREST
 * response. `communicated_to_client` is a COMPLIANCE ASSERTION — the record of
 * whether the client was actually told their closing is slipping. An ungated
 * write keyed on nothing but `transaction_id` let that record be flipped to true
 * for any transaction, which is the one thing a transparency ledger must not
 * allow: it does not hide a delay, it manufactures proof that the delay was
 * disclosed.
 */
export async function markDelaysCommunicated(transactionId: string) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  return ledgered(ctx, { action: "transaction.delay.mark_communicated", subject: { type: "transaction", id: transactionId }, riskClass: "LEGAL" }, async () => {

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("timeline_transparency")
    .update({ communicated_to_client: true })
    .eq("transaction_id", transactionId)
    // Tenant anchor — logTransactionDelay always stamps brokerage_id on this row.
    .eq("brokerage_id", ctx.brokerageId)
    .select("transaction_id")

  if (error) return { success: false, error: error.message }
  // Zero rows means there is no delay record for this transaction in the caller's
  // brokerage. Claiming success would assert a disclosure against nothing.
  if (!data?.length) return { success: false, error: "No delay record found for this transaction" }

  return { success: true }
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
