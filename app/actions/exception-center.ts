"use server"

/**
 * app/actions/exception-center.ts — the broker's Exception Center verbs.
 * Read (open exceptions + supervised repairs), RETRY (re-run the flow scan),
 * RESOLVE / DISMISS (append-only closure), and FLAG-WRONG (the ratchet's
 * feedback loop: a vetoed repair appends 'failed', demoting that repair type
 * to supervised instantly — zero-failure autonomy is strict by design).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { composeExceptionCenter, type ExceptionCenterRead, type ExceptionLedgerRow } from "@/lib/kernel/exception-center"

const BROKER_TYPES = new Set(["broker", "broker_admin", "admin", "superadmin"])

async function resolveBroker() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!(profile as any)?.brokerage_id || !BROKER_TYPES.has(String((profile as any).user_type ?? ""))) return null
  return { userId: user.id, brokerageId: (profile as any).brokerage_id as string }
}

export async function getExceptionCenter(): Promise<
  { success: true; read: ExceptionCenterRead } | { success: false; error: string }
> {
  const caller = await resolveBroker()
  if (!caller) return { success: false, error: "Broker access required" }
  const svc = createServiceClient()
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data } = await svc.from("self_heal_events")
    .select("id, subject, action, outcome, detail, created_at")
    .eq("domain", "data_flow").eq("brokerage_id", caller.brokerageId)
    .gte("created_at", since).order("created_at", { ascending: true }).limit(1000)
  const rows: ExceptionLedgerRow[] = ((data ?? []) as any[]).map((r) => ({
    id: r.id, subject: r.subject, action: r.action ?? null, outcome: r.outcome,
    detail: (r.detail as any) ?? null, createdAt: r.created_at,
  }))
  return { success: true, read: composeExceptionCenter(rows) }
}

/** Append-only closure: 'resolved' (handled) or 'dismissed' (not an issue). */
async function closeException(eventId: string, closure: "resolved" | "dismissed"): Promise<{ success: boolean; error?: string }> {
  const caller = await resolveBroker()
  if (!caller) return { success: false, error: "Broker access required" }
  const svc = createServiceClient()
  const { data: original } = await svc.from("self_heal_events")
    .select("id, brokerage_id, subject, action, detail")
    .eq("id", eventId).eq("brokerage_id", caller.brokerageId).eq("outcome", "escalated").maybeSingle()
  if (!original) return { success: false, error: "Exception not found on your brokerage" }
  const { error } = await svc.from("self_heal_events").insert({
    brokerage_id: caller.brokerageId,
    domain: "data_flow",
    subject: (original as any).subject,
    action: (original as any).action ?? "none",
    outcome: closure,
    detail: { flow: (original as any).detail?.flow ?? null, original_event_id: eventId, by_user: caller.userId },
  })
  return error ? { success: false, error: "Could not record the closure — try again" } : { success: true }
}

export async function resolveException(eventId: string) {
  return closeException(eventId, "resolved")
}

export async function dismissException(eventId: string) {
  return closeException(eventId, "dismissed")
}

/** Re-run the full contract scan + heal pass for this brokerage, on demand. */
export async function retryDataFlows(): Promise<
  { success: true; breaks: number; healed: number } | { success: false; error: string }
> {
  const caller = await resolveBroker()
  if (!caller) return { success: false, error: "Broker access required" }
  const svc = createServiceClient()
  const { runFlowIntegrity } = await import("@/lib/kernel/flow-integrity")
  const r = await runFlowIntegrity(svc, caller.brokerageId)
  return { success: true, breaks: r.breaks, healed: r.healed }
}

/**
 * THE RATCHET'S FEEDBACK LOOP: a human vetoing a supervised repair appends
 * outcome 'failed' for that action — and because earned autonomy requires
 * ZERO recorded failures, the repair type demotes to supervised instantly.
 */
export async function flagRepairWrong(eventId: string): Promise<{ success: boolean; error?: string }> {
  const caller = await resolveBroker()
  if (!caller) return { success: false, error: "Broker access required" }
  const svc = createServiceClient()
  const { data: original } = await svc.from("self_heal_events")
    .select("id, brokerage_id, subject, action, detail")
    .eq("id", eventId).eq("brokerage_id", caller.brokerageId).eq("outcome", "healed").maybeSingle()
  if (!original || !(original as any).action) return { success: false, error: "Repair not found on your brokerage" }
  const { error } = await svc.from("self_heal_events").insert({
    brokerage_id: caller.brokerageId,
    domain: "data_flow",
    subject: (original as any).subject,
    action: (original as any).action,
    outcome: "failed",
    detail: { flow: (original as any).detail?.flow ?? null, human_flagged: true, original_event_id: eventId, by_user: caller.userId },
  })
  return error ? { success: false, error: "Could not record the veto — try again" } : { success: true }
}
