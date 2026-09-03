// lib/marketing/trigger-match.ts
// PURE (no I/O, no server-only) trigger-matching + cooldown logic for the marketing reactor.
// Split out from trigger-engine.ts so it is unit-testable in the tsx simulator (which cannot
// import "server-only" modules).
//
// STATUS (ruled 2026-09-03, wave 26 lane L3): KEPT, NOT WIRED. The engine this was split from
// no longer exists, and the path it served — "System B", marketing_campaign_triggers — was
// RETIRED by ruling in lib/kernel/event-reactor.ts (header + the "(B) … RETIRED (fold step 2)"
// block): campaign_sequences via lib/kernel/event-fanout.ts enrollMatchingSequences is the SOLE
// enrollment spine, and an event reaches it only through lib/kernel/emit.ts emitKernelEvent.
// Subscribing these two functions at the reactor would re-open the retired path, so they are
// deliberately not subscribed. SURVIVOR for matchTriggersForEvent: the campaign_sequences
// trigger_event query inside enrollMatchingSequences. SURVIVOR for isCooldownActive: the
// already-active-enrollment skip in the same function (no per-(campaign×contact) re-enrol
// window exists there today — if one is wanted, port this 9-line predicate onto it and delete
// this module). Kept on disk because scripts/scraper-simulator.ts:92 imports both as pure
// reactor assertions, and that script is behind the scraping fence.

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
