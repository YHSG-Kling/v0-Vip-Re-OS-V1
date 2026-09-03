// lib/lead-pipeline/persona-drift-runner.ts
//
// Live side of PERSONA-DRIFT (Data Steward): find contacts/leads whose enrichment has aged past the
// freshness window and RE-QUEUE them into the existing lead_enrichment_queue, so the next
// persona-grounded touch is built on current facts — not an 18-month-old snapshot. Idempotent
// (never double-queues a record that already has a pending refresh). Read-mostly; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
// THE VERDICT IS NOT RESTATED HERE. `enrichmentNeedsRefresh` owns "is this
// enrichment stale", including the ACTIVITY-ACCELERATED arm; this file used to
// encode only the hard threshold as a SQL `lt(last_enriched_at, cutoff)` and had
// no way to express "90 days old AND they re-engaged". Two spellings of one rule
// is the §6 defect, and here the second spelling was also the weaker one — the
// accelerated arm existed, was unit-tested, and could never fire in production.
import {
  enrichmentNeedsRefresh,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_ACTIVE_AGE_DAYS,
} from "./persona-drift"
import { NOT_CONVERTED_FILTER } from "@/lib/lead-pipeline/lead-lifecycle"

type Svc = ReturnType<typeof createServiceClient>

export interface PersonaDriftRunInput {
  brokerageId: string
  now?: string
  maxAgeDays?: number
  /** Activity-accelerated threshold (days). Defaults to DEFAULT_ACTIVE_AGE_DAYS. */
  activeAgeDays?: number
  limit?: number
}

export interface PersonaDriftRunResult {
  scanned: number
  requeuedContacts: number
  requeuedLeads: number
  /** Of the requeued, how many were pulled forward by RECENT ACTIVITY rather than
   *  by the hard age threshold. Published beside the total because a count with
   *  no breakdown cannot say whether the accelerated arm ever fires (§2). */
  requeuedByActivity: number
  /** Rows the widened read returned that the verdict judged still fresh. The
   *  denominator for the number above — without it "12 requeued" has no scale. */
  judgedFresh: number
  /** A refused read, verbatim. supabase-js RESOLVES a refusal, so a swallowed
   *  one is byte-identical to "this brokerage has nothing stale" (§3). */
  errors: string[]
}

async function requeueOne(svc: Svc, brokerageId: string, key: "contact_id" | "lead_id", id: string): Promise<boolean> {
  // Idempotent: skip if this record already has a pending/processing refresh queued.
  const { data: existing } = await svc
    .from("lead_enrichment_queue")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq(key, id)
    .in("status", ["pending", "processing"])
    .limit(1)
    .maybeSingle()
  if (existing) return false
  const { error } = await svc.from("lead_enrichment_queue").insert({
    brokerage_id: brokerageId,
    [key]: id,
    status: "pending",
    enrichment_type: "skip_trace", // the operation (re-run PeopleData skip trace); constrained enum
    trigger_type: "persona_drift", // WHY it was queued (free-text)
    retry_count: 0,
    max_retries: 3,
    queued_at: new Date().toISOString(),
  })
  return !error
}

export async function runPersonaDriftRefresh(input: PersonaDriftRunInput, client?: Svc): Promise<PersonaDriftRunResult> {
  const svc = client ?? createServiceClient()
  const now = input.now ?? new Date().toISOString()
  const maxAge = input.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const activeAge = input.activeAgeDays ?? DEFAULT_ACTIVE_AGE_DAYS
  // THE READ IS WIDENED TO THE *ACCELERATED* WINDOW AND THE VERDICT NARROWS IT.
  // The SQL previously cut at `maxAge`, which made the shorter activity window
  // unreachable: a contact 120 days enriched who came back last week was never
  // even fetched. The database now returns the superset (the earlier of the two
  // thresholds) and `enrichmentNeedsRefresh` decides each row — one rule, one
  // implementation, and the SQL is a bound rather than a second copy of it.
  const readAge = Math.min(maxAge, activeAge)
  const cutoff = new Date(new Date(now).getTime() - readAge * 86_400_000).toISOString()
  const limit = input.limit ?? 100
  const out: PersonaDriftRunResult = {
    scanned: 0, requeuedContacts: 0, requeuedLeads: 0,
    requeuedByActivity: 0, judgedFresh: 0, errors: [],
  }

  // WHO CAME BACK. The accelerated arm needs an ENGAGEMENT fact, and the two
  // boards spell it differently: `leads.last_activity_at` is a first-class column
  // (the inbound router stamps it), while `contacts` has none — `last_contacted_at`
  // is US contacting THEM and would invert the meaning. So contact re-engagement
  // is read from portal_event_stream, whose `contact_id` IS written, bounded to
  // the same window the verdict would accelerate on. A contact with no portal
  // events is honestly `hasRecentActivity: false`, never assumed active.
  const activeSince = new Date(new Date(now).getTime() - activeAge * 86_400_000).toISOString()
  const activeContactIds = new Set<string>()
  const { data: portalEvents, error: portalError } = await svc
    .from("portal_event_stream")
    .select("contact_id")
    .eq("brokerage_id", input.brokerageId)
    .not("contact_id", "is", null)
    .gte("occurred_at", activeSince)
    .limit(2000)
  if (portalError) {
    // NOT fatal, but NOT silent either: without it every contact reads as
    // inactive and the accelerated arm quietly stops firing — the exact
    // "nobody looked" that must not render as "we looked and nobody came back".
    out.errors.push(`portal_event_stream read refused: ${portalError.message}`)
  }
  for (const e of (portalEvents ?? []) as any[]) {
    if (e.contact_id) activeContactIds.add(e.contact_id)
  }

  // Stale-enriched CONTACTS (enriched once, but the facts have aged past the window).
  const { data: contacts, error: contactsError } = await svc
    .from("contacts")
    .select("id, last_enriched_at")
    .eq("brokerage_id", input.brokerageId)
    .not("last_enriched_at", "is", null)
    .lt("last_enriched_at", cutoff)
    .neq("status", "archived")
    .limit(limit)
  if (contactsError) out.errors.push(`contacts read refused: ${contactsError.message}`)
  for (const c of (contacts ?? []) as any[]) {
    out.scanned++
    const hasRecentActivity = activeContactIds.has(c.id)
    const verdict = enrichmentNeedsRefresh({
      lastEnrichedAt: c.last_enriched_at, now, hasRecentActivity,
      maxAgeDays: maxAge, activeAgeDays: activeAge,
    })
    if (!verdict.needsRefresh) { out.judgedFresh++; continue }
    if (await requeueOne(svc, input.brokerageId, "contact_id", c.id)) {
      out.requeuedContacts++
      if ((verdict.ageDays ?? 0) < maxAge) out.requeuedByActivity++
    }
  }

  // Stale-enriched LEADS (pre-conversion).
  const { data: leads, error: leadsError } = await svc
    .from("leads")
    .select("id, last_enriched_at, last_activity_at")
    .eq("brokerage_id", input.brokerageId)
    .not("last_enriched_at", "is", null)
    .lt("last_enriched_at", cutoff)
    .or(NOT_CONVERTED_FILTER)
    .limit(limit)
  if (leadsError) out.errors.push(`leads read refused: ${leadsError.message}`)
  for (const l of (leads ?? []) as any[]) {
    out.scanned++
    const hasRecentActivity = typeof l.last_activity_at === "string" && l.last_activity_at >= activeSince
    const verdict = enrichmentNeedsRefresh({
      lastEnrichedAt: l.last_enriched_at, now, hasRecentActivity,
      maxAgeDays: maxAge, activeAgeDays: activeAge,
    })
    if (!verdict.needsRefresh) { out.judgedFresh++; continue }
    if (await requeueOne(svc, input.brokerageId, "lead_id", l.id)) {
      out.requeuedLeads++
      if ((verdict.ageDays ?? 0) < maxAge) out.requeuedByActivity++
    }
  }

  return out
}
