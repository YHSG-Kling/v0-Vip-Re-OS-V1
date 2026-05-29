// lib/marketing/trigger-match.ts
// PURE (no I/O, no server-only) trigger-matching + cooldown logic for the marketing reactor.
// Split out from trigger-engine.ts so it is unit-testable in the tsx simulator (which cannot
// import "server-only" modules). The engine and the kernel reactor both consume these.

export interface LifecycleTrigger {
  id: string
  brokerage_id: string
  campaign_id: string
  trigger_value: string
  channel: string
  cooldown_days: number
  audience_filter: Record<string, unknown>
}

/** Triggers whose value + brokerage match this event. */
export function matchTriggersForEvent(
  triggers: LifecycleTrigger[],
  eventType: string,
  brokerageId: string,
): LifecycleTrigger[] {
  return triggers.filter(t => t.trigger_value === eventType && t.brokerage_id === brokerageId)
}

/** Is a (campaign × contact) still inside its cooldown window? cooldown_days <= 0 = never throttle. */
export function isCooldownActive(
  lastSentAtIso: string | null | undefined,
  cooldownDays: number,
  nowMs: number = Date.now(),
): boolean {
  if (!lastSentAtIso) return false
  if (!cooldownDays || cooldownDays <= 0) return false
  return (nowMs - new Date(lastSentAtIso).getTime()) < cooldownDays * 86_400_000
}
