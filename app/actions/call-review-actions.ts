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
    .in("user_type", ["broker", "broker_admin", "admin", "team_lead"])
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
