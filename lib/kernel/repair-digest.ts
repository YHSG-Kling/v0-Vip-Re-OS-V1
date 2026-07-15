// lib/kernel/repair-digest.ts
//
// THE REPAIR-PATTERN DIGEST (cron_manager) — the ledger turned into an
// engineering compass. A repair that fires ONCE is a save; a repair that
// fires WEEKLY is a root cause waiting to be fixed at the rail. Weekly read
// to platform staff: which contracts fire most, which probation repairs are
// one clean heal from earning autonomy, which repairs a human vetoed, and
// which tenants generate disproportionate drift. Plus the SPOKEN self-heal
// brief for the week-in-review — the voice admin reporting the OS's own
// maintenance in one calm sentence.

import type { SupabaseClient } from "@supabase/supabase-js"
import { FLOW_CONTRACTS, EARNED_AUTONOMY_HEALS, type ActionStats } from "@/lib/kernel/self-heal-ledger"

type Svc = SupabaseClient<any, any, any>

export interface DigestLedgerRow {
  action: string | null
  outcome: string
  brokerageId: string | null
  flow: string | null
}

export interface RepairDigest {
  totalHealed: number
  totalEscalated: number
  totalVetoed: number
  /** flows by heal volume, desc — the root-cause priority list */
  topFlows: Array<{ flow: string; healed: number; escalated: number }>
  /** probation actions within 2 clean heals of earning silence (and zero failures) */
  nearEarned: Array<{ action: string; healed: number; remaining: number }>
  /** tenants generating the most drift, desc (null-brokerage platform events excluded) */
  noisiestTenants: Array<{ brokerageId: string; events: number }>
  lines: string[]
}

/** PURE: fold a window of ledger rows into the digest. */
export function composeRepairDigest(rows: DigestLedgerRow[], allTimeStats: Record<string, ActionStats>): RepairDigest {
  const byFlow = new Map<string, { healed: number; escalated: number }>()
  const byTenant = new Map<string, number>()
  let totalHealed = 0, totalEscalated = 0, totalVetoed = 0

  for (const r of rows) {
    const flow = r.flow ?? r.action ?? "unknown"
    const f = byFlow.get(flow) ?? { healed: 0, escalated: 0 }
    if (r.outcome === "healed") { f.healed++; totalHealed++ }
    else if (r.outcome === "escalated") { f.escalated++; totalEscalated++ }
    else if (r.outcome === "failed") totalVetoed++
    byFlow.set(flow, f)
    if (r.brokerageId) byTenant.set(r.brokerageId, (byTenant.get(r.brokerageId) ?? 0) + 1)
  }

  const topFlows = [...byFlow.entries()]
    .map(([flow, v]) => ({ flow, ...v }))
    .filter((x) => x.healed + x.escalated > 0)
    .sort((a, b) => (b.healed + b.escalated) - (a.healed + a.escalated))
    .slice(0, 5)

  const nearEarned: RepairDigest["nearEarned"] = []
  for (const [, contract] of Object.entries(FLOW_CONTRACTS)) {
    if (contract.tier !== "probation" || !contract.action) continue
    const s = allTimeStats[contract.action]
    if (!s || s.failed > 0 || s.healed === 0 || s.healed >= EARNED_AUTONOMY_HEALS) continue
    const remaining = EARNED_AUTONOMY_HEALS - s.healed
    if (remaining <= 2) nearEarned.push({ action: contract.action, healed: s.healed, remaining })
  }

  const noisiestTenants = [...byTenant.entries()]
    .map(([brokerageId, events]) => ({ brokerageId, events }))
    .sort((a, b) => b.events - a.events)
    .slice(0, 3)

  const lines: string[] = []
  lines.push(`Self-heal week: ${totalHealed} repaired, ${totalEscalated} escalated${totalVetoed > 0 ? `, ${totalVetoed} veto/failure(s)` : ""}.`)
  if (topFlows.length > 0) {
    const top = topFlows[0]
    lines.push(`Most active contract: ${top.flow} (${top.healed + top.escalated}×) — a repair that fires weekly is a root cause; harden that rail.`)
  }
  for (const n of nearEarned) {
    lines.push(`${n.action} is ${n.remaining} clean heal${n.remaining === 1 ? "" : "s"} from earned autonomy (${n.healed}/${EARNED_AUTONOMY_HEALS}).`)
  }
  if (noisiestTenants.length > 0) {
    lines.push(`Highest-drift tenant: ${noisiestTenants[0].brokerageId} (${noisiestTenants[0].events} events).`)
  }
  return { totalHealed, totalEscalated, totalVetoed, topFlows, nearEarned, noisiestTenants, lines }
}

/** PURE: the ONE spoken sentence for the week-in-review — calm, honest, silent when nothing happened. */
export function composeSelfHealBrief(input: { healed: number; openExceptions: number; isBrokerVoice: boolean }): string {
  if (input.healed === 0 && input.openExceptions === 0) return ""
  const parts: string[] = []
  if (input.healed > 0) {
    parts.push(`Behind the scenes, the OS quietly repaired ${input.healed} data handoff${input.healed === 1 ? "" : "s"} before ${input.healed === 1 ? "it" : "they"} could slow anyone down.`)
  }
  if (input.isBrokerVoice && input.openExceptions > 0) {
    parts.push(`${input.openExceptions} item${input.openExceptions === 1 ? " needs" : "s need"} your eyes in the Exception Center.`)
  }
  return parts.join(" ")
}

/** Weekly platform digest — first deal-health-scan tick of each ISO week sends it (deduped). */
export async function runRepairPatternDigest(svc: Svc, now: Date = new Date()): Promise<{ sent: boolean; reason?: string }> {
  const { isoWeekOf } = await import("@/lib/kernel/week-in-review")
  const isoWeek = isoWeekOf(now)
  const tag = `[REPAIR_DIGEST] [${isoWeek}]`
  const { data: dup } = await svc.from("notifications").select("id")
    .eq("type", "repair_pattern_digest").ilike("body", `%${tag}%`).limit(1).maybeSingle()
  if (dup) return { sent: false, reason: "already sent this week" }

  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString()
  const { data } = await svc.from("self_heal_events")
    .select("action, outcome, brokerage_id, detail").eq("domain", "data_flow")
    .gte("created_at", since).limit(5000)
  const rows: DigestLedgerRow[] = ((data ?? []) as any[]).map((r) => ({
    action: r.action ?? null, outcome: r.outcome, brokerageId: r.brokerage_id ?? null, flow: (r.detail as any)?.flow ?? null,
  }))
  if (rows.length === 0) return { sent: false, reason: "quiet week — nothing to digest" }

  const { loadFlowActionStats } = await import("@/lib/kernel/self-heal-ledger")
  const digest = composeRepairDigest(rows, await loadFlowActionStats(svc))

  const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
  await notifyPlatformStaff(svc as any, {
    type: "repair_pattern_digest",
    title: `Self-heal digest: ${digest.totalHealed} repaired, ${digest.totalEscalated} escalated this week`,
    body: `${digest.lines.join(" ")} ${tag}`.slice(0, 480),
    entityType: "self_heal_events",
    priority: "medium",
  })
  return { sent: true }
}
