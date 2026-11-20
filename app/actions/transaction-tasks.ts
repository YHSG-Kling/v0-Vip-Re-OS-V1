"use server"

/**
 * Transaction task mutations for the TC (coordinator) surfaces.
 *
 * WHY THIS EXISTS. `transaction_tasks` already had exactly one write path that
 * marks a row done: the Command Center approval registry
 * (lib/kernel/approval-sources.ts → queue "transaction_smart_task",
 * `approve: (userId) => ({ status: "completed", completed_by: userId, ... })`,
 * reached through approveAgentAction). That rail is gated to admin / broker /
 * superadmin (`requireApprover`) because it releases AI-PROPOSED work, so a
 * transaction coordinator working their own queue could not use it and the
 * coordinator dashboard's "done" control had nothing to call.
 *
 * This is the coordinator-role gate onto the SAME write shape — identical
 * columns, identical id space. `completed_by` is a **users.id** (the approval
 * registry stamps the approver's user id, and admin/staff-360 reads it back as
 * `eq("completed_by", targetUserId)`); it is NOT an agents.id.
 */

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

export interface CompleteTransactionTaskResult {
  success: boolean
  error?: string
  taskId?: string
}

/**
 * Mark one transaction_tasks row completed on behalf of the signed-in
 * coordinator. Reads happen through the RLS client, so the row is only visible
 * (and only writable) inside the caller's tenant; the explicit brokerage compare
 * below is a second, non-silent check so a mismatch is REPORTED rather than
 * turning into an empty update.
 */
export async function completeTransactionTask(
  taskId: string,
): Promise<CompleteTransactionTaskResult> {
  if (!taskId) return { success: false, error: "taskId is required" }

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) return { success: false, error: `Auth check failed: ${authError.message}` }
  if (!user) return { success: false, error: "Not authenticated" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { success: false, error: `Could not read your profile: ${profileError.message}` }
  return ledgered({ userId: user.id, brokerageId: profile?.brokerage_id ?? null }, { action: "transaction.task.complete", subject: { type: "transaction_task", id: taskId }, riskClass: "LOW_RISK_WRITE" }, async () => {

  const { data: task, error: taskError } = await supabase
    .from("transaction_tasks")
    .select("id, status, brokerage_id")
    .eq("id", taskId)
    .maybeSingle()
  if (taskError) return { success: false, error: `Could not load the task: ${taskError.message}` }
  if (!task) return { success: false, error: "Task not found, or not visible to this account" }

  // State the OBSERVED mismatch, not a guess about why.
  if (task.brokerage_id && profile?.brokerage_id && task.brokerage_id !== profile.brokerage_id) {
    return { success: false, error: "That task belongs to a different brokerage than your account" }
  }
  if (task.status === "completed") {
    return { success: true, taskId: task.id }
  }

  const nowIso = new Date().toISOString()
  const { data: updated, error: updateError } = await supabase
    .from("transaction_tasks")
    .update({
      status: "completed",
      completed_at: nowIso,
      completed_by: user.id, // users.id — same id space the approval registry stamps
      updated_at: nowIso,
    })
    .eq("id", taskId)
    .neq("status", "completed")
    .select("id")
    .maybeSingle()

  if (updateError) return { success: false, error: updateError.message }
  if (!updated) {
    return { success: false, error: "The task was not updated — no row matched the write" }
  }

  revalidatePath("/dashboard/coordinator")
  return { success: true, taskId: updated.id }
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
