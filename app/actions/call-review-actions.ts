"use server"

/**
 * app/actions/call-review-actions.ts — production audit fix: the call-review
 * page's "Flag for Compliance" and "Share with Coach" buttons were INERT
 * (server component, no handlers) — a compliance escalation that did nothing.
 * Both now ride rails that already exist: the flag lands on compliance_flags
 * (the SAME ledger the Compliance Officer's board + the curriculum author's
 * gap miner read), and the share notifies the brokerage's broker/team leads
 * with a link to this review. Session-authed; brokerage-scoped.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { BROKERAGE_FINANCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

async function resolveCaller(): Promise<{ userId: string; brokerageId: string } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: row } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!(row as any)?.brokerage_id) return null
  return { userId: user.id, brokerageId: (row as any).brokerage_id }
}

export async function flagCallForCompliance(input: {
  callId: string
  note?: string
}): Promise<{ success: boolean; error?: string }> {
  const caller = await resolveCaller()
  if (!caller) return { success: false, error: "Not authenticated" }
  return ledgered(caller, { action: "compliance.call.flag", subject: { type: "voice_call", ref: input.callId }, riskClass: "LOW_RISK_WRITE" }, async () => {

  const svc = createServiceClient()
  const note = (input.note ?? "").trim().slice(0, 500)
  const { error } = await svc.from("compliance_flags").insert({
    brokerage_id: caller.brokerageId,
    user_id: caller.userId,
    violation_type: "call_review_flag",
    content_type: "voice_call",
    flagged_content: `Call ${input.callId} flagged from the call-review page${note ? `: ${note}` : ""}. Review: /dashboard/voice/review/${input.callId}`,
    severity: "medium",
    // LIVE CHECK vocabulary: flagged/reviewed/resolved/overridden (not 'open').
    status: "flagged",
    detected_at: new Date().toISOString(),
  })
  if (error) return { success: false, error: "Could not record the flag — try again." }
  return { success: true }
  })
}

export async function shareCallWithCoach(input: {
  callId: string
}): Promise<{ success: boolean; error?: string; notified?: number }> {
  const caller = await resolveCaller()
  if (!caller) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  // The coaching audience the coaching loop already targets: broker / team leads.
  const { data: leaders } = await svc.from("users")
    .select("id, user_type")
    .eq("brokerage_id", caller.brokerageId)
    .in("user_type", [...BROKERAGE_FINANCE_ADMIN_USER_TYPES, "team_lead"])
    .limit(20)

  const targets = ((leaders ?? []) as Array<{ id: string }>).filter((u) => u.id !== caller.userId)
  if (targets.length === 0) {
    return { success: false, error: "No broker or team lead found to share with — add one under Team settings." }
  }

  let notified = 0
  for (const t of targets) {
    const { error } = await svc.from("notifications").insert({
      brokerage_id: caller.brokerageId,
      user_id: t.id,
      type: "call_review_share",
      title: "A call review was shared with you for coaching",
      body: `An agent shared a call for your coaching eye. Open the review: /dashboard/voice/review/${input.callId}`,
      priority: "medium",
    })
    if (!error) notified++
  }
  return notified > 0 ? { success: true, notified } : { success: false, error: "Could not notify — try again." }
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
