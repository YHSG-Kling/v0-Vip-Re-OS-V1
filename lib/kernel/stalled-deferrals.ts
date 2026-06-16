// lib/kernel/stalled-deferrals.ts
//
// OVER-DEFERRAL accountability (pure). The coordination feed shows managers deferring to each other
// ("you've got this") — healthy, until it isn't. When the SAME manager is deferred-to repeatedly on
// the SAME contact and nothing moves, that contact is in limbo: everyone yielded, no one acted. This
// detects that pattern so the deferred-to manager gets an "act or release" nudge. Turns visible
// coordination into accountability — the difference between a team that looks busy and one that
// actually closes the loop. Pure (no I/O), unit-tested directly.

export interface DeferralRow {
  to_manager: string | null
  contact_id: string | null
}

export interface StalledDeferral {
  toManager: string
  contactId: string
  count: number
}

export const DEFAULT_STALL_THRESHOLD = 3

/** Find (manager, contact) pairs deferred-to ≥ threshold times — the stalled-in-limbo signal. Pure. */
export function detectStalledDeferrals(rows: DeferralRow[], opts?: { threshold?: number }): StalledDeferral[] {
  const threshold = opts?.threshold ?? DEFAULT_STALL_THRESHOLD
  const counts = new Map<string, { toManager: string; contactId: string; count: number }>()
  for (const r of rows ?? []) {
    if (!r.to_manager || !r.contact_id) continue
    const key = `${r.to_manager}|${r.contact_id}`
    const e = counts.get(key) ?? { toManager: r.to_manager, contactId: r.contact_id, count: 0 }
    e.count++
    counts.set(key, e)
  }
  return [...counts.values()].filter((e) => e.count >= threshold).sort((a, b) => b.count - a.count)
}
