/**
 * lib/kernel/approval-sla.ts
 *
 * Pure approval-SLA evaluation, shared by the Command Center loader and the
 * content-approval source registry. A proposed action / pending item that sits
 * unactioned past the breach window escalates so a human steps in instead of it
 * silently rotting. Deadline-aware: customer-facing items (a release vs the
 * seller's appointment, a post vs its scheduled slot) also escalate as the
 * deadline nears — but escalation only ever HOLDS; nothing auto-fires.
 *
 * Lives in its own module (not command-center.ts) so the registry can import it
 * without a cycle. Defaults: due at 12h age, breached at 24h age; deadline mode
 * due at 48h-to-deadline, breached at 24h-to-deadline.
 */
export type ApprovalSlaLevel = "ok" | "due" | "breached"

export function evaluateApprovalSla(
  proposedAt: string | null,
  now: Date = new Date(),
  opts: { dueHours?: number; breachHours?: number; deadlineIso?: string | null; dueBeforeHours?: number; breachBeforeHours?: number } = {},
): { ageHours: number; level: ApprovalSlaLevel } {
  const dueHours = opts.dueHours ?? 12
  const breachHours = opts.breachHours ?? 24
  if (!proposedAt) return { ageHours: 0, level: "ok" }
  const ageMs = now.getTime() - new Date(proposedAt).getTime()
  const ageHours = Math.max(0, Math.round((ageMs / 3_600_000) * 10) / 10)
  let level: ApprovalSlaLevel = ageHours >= breachHours ? "breached" : ageHours >= dueHours ? "due" : "ok"

  if (opts.deadlineIso) {
    const hoursToDeadline = (new Date(opts.deadlineIso).getTime() - now.getTime()) / 3_600_000
    const breachBefore = opts.breachBeforeHours ?? 24
    const dueBefore = opts.dueBeforeHours ?? 48
    const dl: ApprovalSlaLevel = hoursToDeadline <= breachBefore ? "breached" : hoursToDeadline <= dueBefore ? "due" : "ok"
    const rank: Record<ApprovalSlaLevel, number> = { breached: 0, due: 1, ok: 2 }
    if (rank[dl] < rank[level]) level = dl
  }
  return { ageHours, level }
}
