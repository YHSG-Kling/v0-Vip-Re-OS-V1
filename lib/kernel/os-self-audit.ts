// lib/kernel/os-self-audit.ts
// ─────────────────────────────────────────────────────────────────────────────
// OS SELF-AUDIT (cron_manager) — the OS audits itself in production the way
// the pre-launch sweeps audited the code. Build-time drift is owned by the
// guard chain (schema/vocabulary/orphan guards) and envelope stalls are owned
// by signature-chase (consolidation verdict: its client_documents leg already
// covers signed-packet chasing — a third leg here would double-nudge). This
// module watches the TWO live-data failure modes nothing else reads:
//
//  1. DECISION-LATENCY BREACH — a decision-signal task (seller hit Accept, a
//     lender posted conditions, a vendor filed a request) still pending past
//     48h. Response speed to a client's decision is the product's most
//     trust-critical latency; a breach escalates to the broker, not just the
//     agent.
//  2. STUCK BOOKING — a vendor_bookings row sitting 'booked' (never accepted,
//     never declined) past 7 days. The no-show autopilot only covers a vendor
//     who ACCEPTED then ghosted; pre-accept limbo silently stalls a deal.
//
// Deterministic, no LLM; ONE notification per finding ever (dedupe tag in the
// body, same pattern as signature-chase); honest — undated rows never count.

import type { SupabaseClient } from "@supabase/supabase-js"
import { CLIENT_DECISION_SOURCES } from "@/lib/kernel/command-center"

type Svc = SupabaseClient<any, any, any>

export const DECISION_BREACH_HOURS = 48
export const STUCK_BOOKING_DAYS = 7

/** PURE: is this pending decision task past the trust-latency line? */
export function isDecisionBreach(row: { created_at?: string | null; status?: string | null }, now: Date): boolean {
  if ((row.status ?? "") !== "pending") return false
  if (!row.created_at) return false
  const age = (now.getTime() - new Date(row.created_at).getTime()) / 3_600_000
  return !Number.isNaN(age) && age >= DECISION_BREACH_HOURS
}

/** PURE: is this booking stuck in pre-accept limbo? */
export function isStuckBooking(row: { status?: string | null; created_at?: string | null }, now: Date): boolean {
  if ((row.status ?? "") !== "booked") return false
  if (!row.created_at) return false
  const days = (now.getTime() - new Date(row.created_at).getTime()) / 86_400_000
  return !Number.isNaN(days) && days >= STUCK_BOOKING_DAYS
}

/** PURE: one finding, one tag, forever. */
export function auditTag(kind: "decision_breach" | "stuck_booking", rowId: string): string {
  return `[OS_AUDIT:${kind}] [${rowId}]`
}

export interface SelfAuditResult { scanned: number; breaches: number; stuck: number; skipped: number }

/** Rides the deal-health-scan cron. Notifies broker/admins once per finding. */
export async function runOsSelfAudit(svc: Svc, now: Date = new Date()): Promise<SelfAuditResult> {
  const r: SelfAuditResult = { scanned: 0, breaches: 0, stuck: 0, skipped: 0 }

  const notifyOnce = async (brokerageId: string, tag: string, title: string, body: string, extraUserId?: string | null) => {
    const { data: dup } = await svc.from("notifications").select("id").ilike("body", `%${tag}%`).limit(1).maybeSingle()
    if (dup) { r.skipped += 1; return false }
    const { data: brokers } = await svc.from("users").select("id")
      .eq("brokerage_id", brokerageId).in("user_type", ["broker", "admin"]).limit(3)
    const recipients = new Set(((brokers ?? []) as any[]).map((u) => u.id))
    if (extraUserId) recipients.add(extraUserId)
    if (recipients.size === 0) { r.skipped += 1; return false }
    for (const uid of recipients) {
      await svc.from("notifications").insert({
        user_id: uid, brokerage_id: brokerageId, type: "os_self_audit",
        title, body: `${body} ${tag}`.slice(0, 480), priority: "high", channel: "in_app", is_read: false,
      }).then(undefined, () => {})
    }
    return true
  }

  // 1. Decision-latency breaches.
  const decisionCutoff = new Date(now.getTime() - DECISION_BREACH_HOURS * 3_600_000).toISOString()
  const { data: tasks } = await svc.from("tasks")
    .select("id, brokerage_id, title, source, status, created_at, assigned_to_agent_id")
    .in("source", [...CLIENT_DECISION_SOURCES]).eq("status", "pending")
    .lt("created_at", decisionCutoff).limit(200)
  for (const t of ((tasks ?? []) as any[])) {
    r.scanned += 1
    if (!isDecisionBreach(t, now)) continue
    let agentUserId: string | null = null
    if (t.assigned_to_agent_id) {
      const { data: a } = await svc.from("agents").select("user_id").eq("id", t.assigned_to_agent_id).maybeSingle()
      agentUserId = (a as any)?.user_id ?? null
    }
    const ok = await notifyOnce(
      t.brokerage_id,
      auditTag("decision_breach", t.id),
      "A client decision has waited 2+ days",
      `"${t.title}" has sat unactioned past the 48h trust line — the client said yes/asked and nothing moved. Execute it or hand it off today.`,
      agentUserId,
    )
    if (ok) r.breaches += 1
  }

  // 2. Stuck bookings (pre-accept limbo).
  const bookingCutoff = new Date(now.getTime() - STUCK_BOOKING_DAYS * 86_400_000).toISOString()
  const { data: bookings } = await svc.from("vendor_bookings")
    .select("id, brokerage_id, vendor_id, service_type, status, created_at, transaction_id")
    .eq("status", "booked").lt("created_at", bookingCutoff).limit(200)
  for (const b of ((bookings ?? []) as any[])) {
    r.scanned += 1
    if (!isStuckBooking(b, now) || !b.brokerage_id) continue
    const { data: v } = await svc.from("vendors").select("name").eq("id", b.vendor_id).maybeSingle()
    const ok = await notifyOnce(
      b.brokerage_id,
      auditTag("stuck_booking", b.id),
      "A vendor never answered a booking",
      `${(v as any)?.name ?? "A vendor"} has sat on a ${String(b.service_type ?? "service").replace(/_/g, " ")} booking for ${STUCK_BOOKING_DAYS}+ days without accepting or declining — rebook with another vendor before it stalls the deal.`,
    )
    if (ok) r.stuck += 1
  }

  return r
}
