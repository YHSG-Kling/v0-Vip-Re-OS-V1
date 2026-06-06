// lib/workflow-orchestrator/run-dedupe.ts
// PURE (no I/O) idempotency decision for chain runs. Extracted so it is unit-testable in the tsx
// simulator. Prevents the expensive flagship chains (CMA + chapter-video renders + drip enrollment)
// from running twice when the same lifecycle event reaches the engine more than once — e.g. a retry,
// or both a direct server-action call AND (future) the kernel reactor firing for one occurrence.

export interface ExistingRun {
  id: string
  status: string
  trigger_event_id: string | null
}

const ACTIVE_STATUSES = new Set(["running", "paused", "needs_approval"])

/**
 * Decide whether to reuse an existing run instead of starting a new one.
 *   1. Same source event (trigger_event_id) already started a run → reuse it (exact idempotency).
 *   2. An already-active run exists for this chain+entity+trigger → don't start a concurrent dup.
 * Returns the run to reuse, or null to start a fresh run (e.g. a genuinely new occurrence).
 */
export function findReusableRun(
  existing: ExistingRun[],
  triggerEventId: string | null | undefined,
): ExistingRun | null {
  if (triggerEventId) {
    const exact = existing.find(r => r.trigger_event_id === triggerEventId)
    if (exact) return exact
  }
  return existing.find(r => ACTIVE_STATUSES.has(r.status)) ?? null
}
