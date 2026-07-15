// lib/kernel/self-heal-ledger.ts
//
// THE SELF-HEALING LEDGER (cron_manager) — one append-only record every
// autonomous repair writes, across BOTH domains the owner named: DATA FLOWS
// (a stuck cross-surface handoff re-run) and CONNECTORS (a healing proposal
// auto-applied). This is the spine that makes "the OS heals itself" a visible,
// auditable fact rather than a claim. Pure classifier + a thin writer.

export type SelfHealDomain = "data_flow" | "connector"
export type SelfHealOutcome = "healed" | "failed" | "escalated"

export interface FlowRemediation {
  /** True only for a deterministically SAFE, idempotent repair the OS may run unattended. */
  safe: boolean
  /** The remediation action to take when safe. */
  action: string | null
  /** Why it is (not) safe — for the ledger + honest escalation copy. */
  reason: string
}

/**
 * PURE: decide whether a detected flow break is safe to auto-remediate. Only
 * deterministic, idempotent repairs qualify — everything else escalates to a
 * human. packet_completion is the canonical safe case: re-running the
 * completion is idempotent (is-null guards) and cannot corrupt state.
 */
export function classifyFlowRemediation(flow: string): FlowRemediation {
  switch (flow) {
    case "packet_completion":
      return { safe: true, action: "complete_packet", reason: "Re-running packet completion is idempotent (is-null guarded) — safe to auto-heal." }
    default:
      return { safe: false, action: null, reason: "No proven-safe idempotent repair for this flow — escalate to a human." }
  }
}

/** Append one heal event to the ledger. Best-effort — a ledger write never fails a repair. */
export async function recordSelfHeal(svc: any, evt: {
  brokerageId: string | null
  domain: SelfHealDomain
  subject: string
  action: string
  outcome: SelfHealOutcome
  detail?: Record<string, unknown>
}): Promise<void> {
  await svc.from("self_heal_events").insert({
    brokerage_id: evt.brokerageId,
    domain: evt.domain,
    subject: evt.subject,
    action: evt.action,
    outcome: evt.outcome,
    detail: (evt.detail ?? {}) as any,
  }).then(() => {}, () => {})
}

export interface SelfHealRollup {
  windowDays: number
  healed: number
  failed: number
  escalated: number
  byDomain: Array<{ domain: SelfHealDomain; healed: number }>
}

/** Trailing-window rollup for the "the OS repaired N things" surface. */
export async function loadSelfHealRollup(svc: any, brokerageId: string | null, windowDays = 7): Promise<SelfHealRollup> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  let q = svc.from("self_heal_events").select("domain, outcome").gte("created_at", since).limit(5000)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data } = await q
  const rows = ((data ?? []) as Array<{ domain: SelfHealDomain; outcome: SelfHealOutcome }>)
  const byDomainHealed = new Map<SelfHealDomain, number>()
  let healed = 0, failed = 0, escalated = 0
  for (const r of rows) {
    if (r.outcome === "healed") { healed++; byDomainHealed.set(r.domain, (byDomainHealed.get(r.domain) ?? 0) + 1) }
    else if (r.outcome === "failed") failed++
    else if (r.outcome === "escalated") escalated++
  }
  return {
    windowDays, healed, failed, escalated,
    byDomain: [...byDomainHealed.entries()].map(([domain, h]) => ({ domain, healed: h })),
  }
}
