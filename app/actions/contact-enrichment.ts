"use server"

/**
 * app/actions/contact-enrichment.ts — THE SESSION DOOR onto contact enrichment.
 *
 * The work moved to lib/enrichment/contact-enrichment-core.ts, which takes the
 * tenant as an argument. This file resolves the tenant from the SESSION and
 * calls in there; app/api/cron/contact-enrichment is the UNATTENDED door onto
 * the same functions and passes the brokerage id explicitly.
 *
 * WHY THE SPLIT EXISTS. An earlier wave anchored getUnenrichedContacts /
 * getContactsNeedingLifeChangeCheck on getAgentContext() and left a comment
 * admitting the cost — "the enrichment cron has no session; under RLS the anon
 * client returned nothing anyway". The nightly run has processed zero contacts
 * and reported success ever since. A session gate on a function an unattended
 * caller depends on does not secure it; it silently switches it off. The
 * unattended caller needs its own door onto the library, never a fake identity.
 *
 * THE OWNER'S RULING, which every entry point below now honours:
 *   "contact enrichment should happen as soon as a new contact comes in and also
 *    check if a life change or other change happens for the contact but not if
 *    they have an active listing or an active transaction; just before or after."
 * The suppression lives in lib/enrichment/deal-suppression.ts:isContactInLiveDeal
 * and is consulted inside the core, so it cannot be skipped by adding a new
 * caller here.
 *
 * `"use server"` makes every export in this file a public HTTP endpoint, so
 * there are no exported helpers — only gated async actions.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  enrichContactRecord,
  runLifeChangeCheck,
  listUnenrichedContacts,
  listContactsDueForLifeChangeCheck,
  type EnrichmentSource,
} from "@/lib/enrichment/contact-enrichment-core"

/**
 * Enrich a single contact with PeopleData, OSINT and validation.
 *
 * Skips when already enriched (unless `forceRefresh`), when the contact has an
 * active listing or an active transaction, and when the brokerage is over its
 * monthly vendor budget.
 */
export async function enrichContact(
  contactId: string,
  options: {
    forceRefresh?: boolean
    source?: EnrichmentSource
  } = {},
): Promise<{ success: boolean; enriched: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, enriched: false, error: "Unauthorized" }
  }

  const result = await enrichContactRecord({
    contactId,
    brokerageId: ctx.brokerageId,
    source: options.source ?? "manual",
    forceRefresh: options.forceRefresh,
  })

  return { success: result.success, enriched: result.enriched, error: result.error }
}

/** Upper bound on one batch. Each id costs a PeopleData call + an OSINT call. */
const ENRICH_BATCH_MAX = 200

/**
 * Enrich multiple contacts (for imports/bulk operations).
 *
 * GATED, TENANT-FILTERED AND CAPPED (was none of the three — see the wave-2
 * burn-down, docs/orphan-burndown-w2s1.md). `"use server"` makes this a public
 * HTTP endpoint and it took an unbounded caller-supplied array of contact ids
 * with no session; every id costs a PeopleData record AND a fan of OSINT scrapes,
 * so an anonymous caller could bill the platform for arbitrarily many external
 * lookups and point them at other tenants' contacts.
 *
 *  - **Session gate.**
 *  - **Tenant filter before spending anything.** Ids are resolved against
 *    `contacts` scoped to the caller's brokerage; ids that are not the caller's
 *    are counted as `failed` rather than dropped, so fishing with foreign uuids
 *    gives no signal about whether they exist.
 *  - **Cap** of ENRICH_BATCH_MAX ids per call.
 *
 * The scope read destructures `error` — a refused lookup must not be mistaken
 * for "none of these are yours", because here that difference is the difference
 * between refusing and spending money.
 *
 * Live-deal suppression is enforced per contact inside enrichContactRecord, so a
 * bulk import cannot enrich a contact whose deal went live mid-batch.
 */
export async function enrichContactsBatch(
  contactIds: string[],
  options: { source?: EnrichmentSource } = {},
): Promise<{ success: number; failed: number; skipped: number; error?: string }> {
  let success = 0
  let failed = 0
  let skipped = 0

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return { success: 0, failed: 0, skipped: 0 }
  }
  if (contactIds.length > ENRICH_BATCH_MAX) {
    return {
      success: 0,
      failed: 0,
      skipped: 0,
      error: `Batch too large — enrich at most ${ENRICH_BATCH_MAX} contacts at a time`,
    }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: 0, failed: 0, skipped: 0, error: "Unauthorized" }
  }

  const requested = [...new Set(contactIds.filter((id) => typeof id === "string" && id.length > 0))]

  const supabase = await createClient()
  const { data: ownRows, error: scopeError } = await supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", ctx.brokerageId)
    .in("id", requested)

  if (scopeError) {
    return { success: 0, failed: 0, skipped: 0, error: "Could not verify those contacts; nothing was enriched" }
  }

  const ownIds = new Set((ownRows ?? []).map((r) => r.id as string))
  // Anything the caller asked for that is not theirs is a failure, not a skip —
  // and it costs no vendor call.
  failed += requested.length - ownIds.size

  for (const contactId of ownIds) {
    const result = await enrichContactRecord({
      contactId,
      brokerageId: ctx.brokerageId,
      source: options.source ?? "import",
    })
    if (result.success) {
      if (result.enriched) success++
      else skipped++
    } else {
      failed++
    }

    // Rate limiting - wait 500ms between API calls
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return { success, failed, skipped }
}

/**
 * Check for a life change on an existing contact. OSINT only — no PeopleData
 * record is bought. Suppressed while the contact is in a live deal.
 */
export async function checkContactLifeChanges(
  contactId: string,
): Promise<{ success: boolean; changesFound: number; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, changesFound: 0, error: "Unauthorized" }
  }

  const result = await runLifeChangeCheck({
    contactId,
    brokerageId: ctx.brokerageId,
    trigger: "manual",
  })

  return { success: result.success, changesFound: result.changesFound, error: result.error }
}

/**
 * Contacts in the caller's brokerage that have never been enriched and are not
 * in a live deal. The unattended sweep does NOT come through here — it calls
 * lib/enrichment/contact-enrichment-core.ts:listUnenrichedContacts with the
 * brokerage id it is iterating.
 */
export async function getUnenrichedContacts(limit = 25): Promise<{ contacts: any[]; count: number }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { contacts: [], count: 0 }

  const { contacts, error } = await listUnenrichedContacts({ brokerageId: ctx.brokerageId, limit })
  if (error) return { contacts: [], count: 0 }
  return { contacts, count: contacts.length }
}

/** Already-enriched contacts whose life-change check has gone stale (30 days). */
export async function getContactsNeedingLifeChangeCheck(limit = 25): Promise<{ contacts: any[]; count: number }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { contacts: [], count: 0 }

  const { contacts, error } = await listContactsDueForLifeChangeCheck({ brokerageId: ctx.brokerageId, limit })
  if (error) return { contacts: [], count: 0 }
  return { contacts, count: contacts.length }
}

/**
 * Health of the enrichment QUEUE itself for the Data Health panel.
 *
 * The queue's writers (lib/lead-pipeline/enrichment-orchestrator.ts) stamp
 * error_message on every failure/suppression and enrichment_cost on every
 * paid lookup — but until this reader existed nothing ever showed either:
 * the drain read only status/retry_count, so a failing vendor and its spend
 * were both invisible. Tenant from session (§4); rows are the caller's own
 * brokerage only. Read-only — this touches nothing in the orchestrator's
 * scraping-source logic.
 *
 * WHAT WAS ASKED AND WHAT CAME BACK (wave 26 lane C5). Two more columns the
 * queue's writers stamp and nothing read:
 *   · enrichments_needed — the list the queuer computed (email_append,
 *     phone_append, life_events, …; lib/enrichment/lead-enrichment-core.ts:282,
 *     contact-enrichment-core.ts:293/:406). Without it a failure row said
 *     "skip_trace failed" and never WHICH gap it was trying to close.
 *   · enrichment_results — the orchestrator's own account of what each lane did
 *     (lane, person_enrichment: not_applicable | withheld_budget | no_match |
 *     peopledata, free_osint; lib/lead-pipeline/enrichment-orchestrator.ts:245,
 *     :371, :393, :429, :672, :824). A 'failed' row still carries the free
 *     lane's answer, so the pane can say "the paid lookup found no match but
 *     the OSINT lane did reach X" instead of a bare error string.
 * Both are selected here and rendered by the Data Health panel
 * (app/dashboard/admin/data-health/enrichment-backlog-panel.tsx).
 */
export interface EnrichmentQueueFailureRow {
  id: string
  enrichment_type: string | null
  error_message: string | null
  retry_count: number | null
  queued_at: string | null
  /** What the queuer asked for — lead_enrichment_queue.enrichments_needed (text[]). */
  enrichments_needed: string[] | null
  /** What the drain recorded — lead_enrichment_queue.enrichment_results (jsonb). */
  enrichment_results: Record<string, unknown> | null
}

export async function getEnrichmentQueueHealth(limit = 10): Promise<{
  recentFailures: EnrichmentQueueFailureRow[]
  spend30d: number
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { recentFailures: [], spend30d: 0, error: "Unauthorized" }
  }

  const supabase = await createClient()
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const [failuresRes, costRes] = await Promise.all([
    supabase
      .from("lead_enrichment_queue")
      .select("id, enrichment_type, error_message, retry_count, queued_at, enrichments_needed, enrichment_results")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("status", "failed")
      .order("queued_at", { ascending: false })
      .limit(limit),
    supabase
      .from("lead_enrichment_queue")
      .select("enrichment_cost")
      .eq("brokerage_id", ctx.brokerageId)
      .gte("queued_at", since)
      .not("enrichment_cost", "is", null),
  ])

  // §3: a refused read must render as "unavailable", not as a clean zero —
  // a zero spend figure on a refused read would be a false bill of health.
  if (failuresRes.error || costRes.error) {
    const message = failuresRes.error?.message ?? costRes.error?.message ?? "read failed"
    console.error("[contact-enrichment] queue health read failed:", message)
    return { recentFailures: [], spend30d: 0, error: message }
  }

  const spend30d = (costRes.data ?? []).reduce(
    (sum, r: { enrichment_cost: number | null }) => sum + (typeof r.enrichment_cost === "number" ? r.enrichment_cost : 0),
    0,
  )
  const recentFailures: EnrichmentQueueFailureRow[] = (failuresRes.data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    enrichment_type: (r.enrichment_type as string | null) ?? null,
    error_message: (r.error_message as string | null) ?? null,
    retry_count: (r.retry_count as number | null) ?? null,
    queued_at: (r.queued_at as string | null) ?? null,
    enrichments_needed: Array.isArray(r.enrichments_needed) ? (r.enrichments_needed as string[]) : null,
    enrichment_results:
      r.enrichment_results && typeof r.enrichment_results === "object" && !Array.isArray(r.enrichment_results)
        ? (r.enrichment_results as Record<string, unknown>)
        : null,
  }))
  return { recentFailures, spend30d }
}

/**
 * Recent life changes for agent notification. Life events live in
 * contacts.life_events (a jsonb array) — there is no contact_enrichment_data
 * table.
 *
 * TENANT ANCHOR ADDED. This read had no brokerage filter at all: it selected
 * contacts by `last_life_event_detected` across the whole table and returned
 * names, emails, phones and inferred life events (divorce, bankruptcy, death in
 * family) for every tenant on the platform. `agentId` was the only optional
 * narrowing and it is caller-supplied, so passing someone else's agents.id read
 * their book. Both call sites (the agent dashboard and
 * app/actions/lifetime-customers.ts) are session surfaces, so nothing legitimate
 * relied on the cross-tenant behaviour.
 *
 * `agentId` is now a filter WITHIN the caller's brokerage, not an identity claim.
 */
export async function getRecentLifeChanges(agentId?: string, daysBack = 7): Promise<any[]> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return []

  const supabase = await createClient()
  const cutoffDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()

  let query = supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, agent_id, life_events, last_life_event_detected")
    .eq("brokerage_id", ctx.brokerageId)
    .not("life_events", "is", null)
    .gte("last_life_event_detected", cutoffDate)
    .order("last_life_event_detected", { ascending: false })
    .limit(50)

  // contacts.agent_id is agents.id — a disjoint id space from users.id. The
  // caller passes an agents.id; it is never coerced from ctx.userId.
  if (agentId) query = query.eq("agent_id", agentId)

  const { data: contacts, error } = await query

  if (error) {
    console.error("[ContactEnrichment] Error getting recent life changes:", error)
    return []
  }
  if (!contacts || contacts.length === 0) return []

  return contacts
    .map((contact) => {
      const lifeEvents = (contact.life_events as any[]) || []
      return lifeEvents
        .filter((event: any) => {
          const detectedAt = new Date(event.detected_at || contact.last_life_event_detected || 0)
          return detectedAt >= new Date(cutoffDate)
        })
        .map((event: any) => ({
          ...event,
          contact_id: contact.id,
          contact: {
            id: contact.id,
            first_name: contact.first_name,
            last_name: contact.last_name,
            email: contact.email,
            phone: contact.phone,
            agent_id: contact.agent_id,
          },
          detected_at: event.detected_at || contact.last_life_event_detected,
        }))
    })
    .flat()
}

/**
 * Mark a detected life change as notified.
 *
 * FINISHED IN AN EARLIER WAVE (was a no-op that reported success): it logged the
 * id and returned `{ success: true }` without touching anything, so every render
 * re-surfaced the same divorce/bankruptcy/relocation notification forever while
 * the endpoint claimed it had been handled.
 *
 * The signature is `(contactId, eventType)`, not `(changeId)`, because the array
 * elements this codebase writes are `{ type, details, detected_at, confidence }`
 * — there is no id on them, and the de-duplication in the life-change checker
 * keys on the event TYPE. That is the key that exists rather than one that does
 * not.
 *
 * Read-modify-write on a jsonb array is not atomic. Acceptable here — the only
 * field set is an idempotent `notified_at` marker, so a lost update re-shows one
 * notification rather than corrupting anything — but stated rather than left to
 * be discovered.
 */
export async function markLifeChangeNotified(
  contactId: string,
  eventType: string,
): Promise<{ success: boolean; error?: string }> {
  if (!contactId || !eventType) {
    return { success: false, error: "contactId and eventType are required" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()

  const { data: contact, error: readError } = await supabase
    .from("contacts")
    .select("life_events")
    .eq("id", contactId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (readError) return { success: false, error: "Could not read the contact" }
  if (!contact) return { success: false, error: "Contact not found" }

  const rawEvents: unknown = contact.life_events
  const events: any[] = Array.isArray(rawEvents) ? rawEvents : []
  let matched = false
  const updated = events.map((e) => {
    if (e?.type !== eventType || e?.notified_at) return e
    matched = true
    return { ...e, notified_at: new Date().toISOString() }
  })

  if (!matched) {
    return { success: false, error: "No un-notified life event of that type on this contact" }
  }

  const { error: writeError } = await supabase
    .from("contacts")
    .update({ life_events: updated })
    .eq("id", contactId)
    .eq("brokerage_id", ctx.brokerageId)

  if (writeError) return { success: false, error: writeError.message }
  return { success: true }
}

// TOMBSTONE (§6 one-vocabulary, lane E2 2026-08-28) — the "backward
// compatibility" alias `enrichContactData` was deleted. Duplicate SPELLING of
// the canonical name — SURVIVOR: `enrichContact` (this file, above). A
// stripped-source census found zero callers outside the app/actions/index.ts
// barrel, which itself has zero importers.

/**
 * Enrichment data + recent life changes for one contact. All enrichment data
 * lives directly on the contacts row.
 *
 * TENANT ANCHOR ADDED. This was a bare PK lookup, so any authenticated caller
 * (and, before the session gate, any caller at all) could read another tenant's
 * contact's household income, marital status, court records and property
 * records by uuid. The brokerage filter makes a foreign uuid indistinguishable
 * from a non-existent one.
 */
export async function getContactInsights(contactId: string): Promise<{
  enrichment: any | null
  lifeChanges: any[]
  lastEnriched: string | null
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { enrichment: null, lifeChanges: [], lastEnriched: null, error: "Unauthorized" }
  }

  // Enrichment columns read back for the insights panel (kept out of the query
  // chain so the scope on the query itself stays auditable).
  const ENRICHMENT_COLUMNS =
    "id, enriched_at, enrichment_source, confidence_score, data_source, " +
    "age_range, gender, marital_status, household_income, home_owner_status, " +
    "home_value_estimate, length_of_residence, occupation, education_level, " +
    "linkedin_url, facebook_url, twitter_url, instagram_url, life_events, " +
    "last_life_event_detected, public_records, court_records, property_records"

  const supabase = await createClient()

  const { data: contactRow, error: contactError } = await supabase
    .from("contacts")
    .select(ENRICHMENT_COLUMNS)
    .eq("id", contactId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  // Dynamic select string defeats supabase-js column inference — the shape is
  // exactly ENRICHMENT_COLUMNS.
  const contact = contactRow as Record<string, any> | null

  if (contactError) {
    return { enrichment: null, lifeChanges: [], lastEnriched: null, error: contactError.message }
  }

  const lifeChanges = (contact?.life_events as any[]) || []

  const enrichment = contact
    ? {
        age_range: contact.age_range,
        gender: contact.gender,
        marital_status: contact.marital_status,
        household_income: contact.household_income,
        home_owner_status: contact.home_owner_status,
        home_value_estimate: contact.home_value_estimate,
        length_of_residence: contact.length_of_residence,
        occupation: contact.occupation,
        education_level: contact.education_level,
        linkedin_url: contact.linkedin_url,
        facebook_url: contact.facebook_url,
        twitter_url: contact.twitter_url,
        instagram_url: contact.instagram_url,
        public_records: contact.public_records,
        court_records: contact.court_records,
        property_records: contact.property_records,
        data_source: contact.data_source,
        confidence_score: contact.confidence_score,
      }
    : null

  return { enrichment, lifeChanges, lastEnriched: contact?.enriched_at || null }
}
