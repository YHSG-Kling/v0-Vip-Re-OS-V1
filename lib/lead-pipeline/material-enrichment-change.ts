// lib/lead-pipeline/material-enrichment-change.ts
//
// MATERIAL ENRICHMENT CHANGE detector (pure). A persona-drift re-enrichment usually just refreshes
// the row — but sometimes it returns a genuinely NEW fact: they became a homeowner, changed jobs,
// or a life event landed. Those aren't "refresh the copy" moments, they're OPPORTUNITY moments the
// life-event detector (referral-radar) already knows how to act on. This compares the OLD vs NEW
// enrichment profile and reports whether something material changed — so the orchestrator can stamp
// the existing fresh-event signal (last_life_event_detected) and let the right manager pick it up,
// instead of duplicating life-event logic here.
//
// Pure (no I/O), unit-tested directly.

export interface ProfileLike {
  home_owner_status?: string | null
  job_title?: string | null
  employer?: string | null
  marital_status?: string | null
  life_events?: Array<{ type?: string | null } | string> | null
  [k: string]: unknown
}

export interface MaterialChange {
  changed: boolean
  changes: string[]
}

function norm(v: unknown): string {
  return (v ?? "").toString().trim().toLowerCase()
}

function lifeEventTypes(p: ProfileLike | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const e of p?.life_events ?? []) {
    const t = typeof e === "string" ? e : (e?.type ?? "")
    const k = norm(t)
    if (k) out.add(k)
  }
  return out
}

/** Compare old vs new enrichment; report material changes worth a re-engage handoff. Pure. */
export function materialEnrichmentChange(
  oldP: ProfileLike | null | undefined,
  newP: ProfileLike | null | undefined,
): MaterialChange {
  const changes: string[] = []
  if (!newP) return { changed: false, changes }

  // Home ownership flip (renter↔owner) — a real move-up/first-purchase signal.
  const oldOwn = norm(oldP?.home_owner_status), newOwn = norm(newP.home_owner_status)
  if (newOwn && oldOwn && newOwn !== oldOwn) changes.push(`home_owner_status: ${oldOwn} → ${newOwn}`)

  // Job / employer change — buying-power + relocation signal.
  const oldJob = norm(oldP?.job_title) || norm(oldP?.employer)
  const newJob = norm(newP.job_title) || norm(newP.employer)
  if (newJob && oldJob && newJob !== oldJob) changes.push("job change")

  // Marital status change — used internally to TIME outreach (never surfaced as copy).
  const oldM = norm(oldP?.marital_status), newM = norm(newP.marital_status)
  if (newM && oldM && newM !== oldM) changes.push(`marital_status: ${oldM} → ${newM}`)

  // A NEW life event type appeared (not present before).
  const before = lifeEventTypes(oldP)
  for (const t of lifeEventTypes(newP)) {
    if (!before.has(t)) changes.push(`new life event: ${t}`)
  }

  return { changed: changes.length > 0, changes }
}
