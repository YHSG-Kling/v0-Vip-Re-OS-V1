// lib/recruiting/license-readiness-sweep.ts
//
// AUTONOMOUS LICENSE / CE / ETHICS READINESS SWEEP (recruiting_manager owns the agent lifecycle). The
// offer-time gate (proactive-checks) catches a lapse only when an agent is mid-transaction — too late.
// This sweeps the brokerage's active agents on a schedule and, BEFORE a lapse bites, proposes ONE gated
// reminder to the agent (renew your license / finish CE / do ethics) and escalates a hard BLOCKER to the
// broker so the brokerage isn't exposed by an unlicensed agent transacting. Reuses the canonical
// evaluator (no drift with the gate) + the gated client-message rail (nothing auto-sends). Idempotent
// per (agent, standing-issue-set) so a new issue re-notifies but the same set never spams.

import { createServiceClient } from "@/lib/supabase/service"
import { evaluateLicenseReadiness, readinessIssueKey, type LicenseReadiness, type ReadinessIssue } from "@/lib/compliance/license-readiness"

type Svc = ReturnType<typeof createServiceClient>

/** Pure: the agent-facing readiness reminder copy — lists only REAL issues, blockers first. */
export function buildReadinessReminder(readiness: LicenseReadiness, agentName: string): { subject: string; body: string } {
  const name = (agentName || "there").trim()
  const hasBlocker = readiness.blockers.length > 0
  const lines: string[] = [`Hi ${name},`]
  lines.push(hasBlocker
    ? `A compliance item needs your attention before you can keep transacting:`
    : `A quick heads-up so nothing interrupts your business:`)
  const bullet = (i: ReadinessIssue) => `• ${i.title} — ${i.detail}`
  for (const b of readiness.blockers) lines.push(bullet(b))
  for (const w of readiness.warnings) lines.push(bullet(w))
  lines.push(`Update your license and CE in Settings → Profile, and reply here if you need help.`)
  lines.push(`— Your Brokerage`)
  return {
    subject: hasBlocker ? "Action needed: your license / CE status" : "Heads-up: license / CE coming due",
    body: lines.join("\n\n"),
  }
}

export interface ReadinessSweepResult { scanned: number; reminded: number; blocked: number }

/**
 * Sweep active agents' regulatory readiness. Proposes one gated reminder per agent whose standing issue
 * set changed, and notifies the broker on any BLOCKER. Best-effort; never throws into the caller.
 */
export async function sweepLicenseReadiness(
  svc: Svc,
  params: { brokerageId: string; now?: Date },
): Promise<ReadinessSweepResult> {
  const out: ReadinessSweepResult = { scanned: 0, reminded: 0, blocked: 0 }
  const now = params.now ?? new Date()

  const { data: agents } = await svc
    .from("agents")
    .select("id, user_id, license_expiry, ce_hours_required, ce_hours_completed, ce_cycle_end_date, ethics_due_date, users(first_name, last_name)")
    .eq("brokerage_id", params.brokerageId)
    .not("user_id", "is", null)
    .limit(1000)

  for (const a of (agents ?? []) as any[]) {
    out.scanned++
    const readiness = evaluateLicenseReadiness({
      licenseExpiry: a.license_expiry ?? null,
      ceHoursRequired: a.ce_hours_required ?? null,
      ceHoursCompleted: a.ce_hours_completed ?? null,
      ceCycleEndDate: a.ce_cycle_end_date ?? null,
      ethicsDueDate: a.ethics_due_date ?? null,
    }, now)
    if (readiness.blockers.length === 0 && readiness.warnings.length === 0) continue

    const issueKey = readinessIssueKey(readiness)
    const dedupeTag = `LICENSE READINESS — agent:${a.id} — ${issueKey}`

    // Idempotency — one pending reminder per (agent, standing issue set). A NEW/changed issue set makes
    // a new tag, so it re-notifies; the same set doesn't spam.
    const { data: prior } = await svc
      .from("agent_client_messages")
      .select("id")
      .eq("brokerage_id", params.brokerageId)
      .eq("entity_type", "agent").eq("entity_id", a.id)
      .eq("agent_kind", "recruiting_manager")
      .ilike("rationale", `${dedupeTag}%`)
      .in("status", ["proposed", "approved"])
      .limit(1).maybeSingle()
    if (prior) continue

    const u = Array.isArray(a.users) ? a.users[0] : a.users
    const agentName = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || "there"
    const msg = buildReadinessReminder(readiness, agentName)
    try {
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId: params.brokerageId, agentKind: "recruiting_manager", entityType: "agent", entityId: a.id,
        recipientContactId: null, audience: "agent",
        subject: msg.subject, body: msg.body,
        rationale: `${dedupeTag} — review before it reaches the agent.`,
        channel: "portal",
      }, svc)
      if (res.ok) out.reminded++
    } catch { /* best-effort */ }

    // A hard blocker exposes the brokerage — escalate to broker/admins (deduped by the same issue tag).
    if (readiness.blockers.length > 0) {
      out.blocked++
      // MULTI-MANAGER HANDOFF — the Recruiting Manager (owns agents) hands the regulatory exposure to
      // the Compliance Officer (owns the ledger), who records it in compliance_flags for audit. Deduped
      // per open (agent, exposure) by publishManagerSignal; visible on the "managers talking" feed.
      try {
        const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
        await publishManagerSignal({
          brokerageId: params.brokerageId, fromManager: "recruiting_manager", toManager: "compliance_officer",
          signalType: "license_lapsing",
          message: `${agentName} has a license/CE/ethics blocker — regulatory exposure if they transact.`,
          entityType: "agent", entityId: a.id,
          payload: { codes: readiness.blockers.map((b) => b.code), agentName },
        }, svc)
      } catch { /* best-effort — the broker notification below still fires */ }
      try {
        const { data: mgrs } = await svc.from("users").select("id")
          .eq("brokerage_id", params.brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(10)
        for (const m of (mgrs ?? []) as Array<{ id: string }>) {
          const { data: seen } = await svc.from("notifications").select("id")
            .eq("user_id", m.id).eq("entity_type", "agent").eq("entity_id", a.id).eq("type", "license_readiness_blocker")
            .gte("created_at", new Date(now.getTime() - 7 * 86_400_000).toISOString()).limit(1).maybeSingle()
          if (seen) continue
          await svc.from("notifications").insert({
            user_id: m.id, brokerage_id: params.brokerageId, type: "license_readiness_blocker",
            title: `${agentName}'s license/CE is blocking — compliance exposure`,
            body: readiness.blockers.map((b) => b.title).join("; "),
            entity_type: "agent", entity_id: a.id, priority: "high", is_read: false,
          })
        }
      } catch { /* best-effort */ }
    }
  }
  return out
}

/** Autonomous: sweep every brokerage (rides the daily compliance-monitoring cron). */
export async function sweepAllLicenseReadiness(svc: Svc, now?: Date): Promise<{ brokerages: number; reminded: number; blocked: number }> {
  const out = { brokerages: 0, reminded: 0, blocked: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try {
      const r = await sweepLicenseReadiness(svc, { brokerageId: b.id, now })
      out.reminded += r.reminded; out.blocked += r.blocked
    } catch { /* keep sweeping */ }
  }
  return out
}
