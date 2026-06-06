/**
 * Sprint 9 cont. — Marketing campaign trigger engine.
 *
 * Watches lifecycle_events (and buyer_stage / milestone changes) and
 * auto-enrolls matching contacts in linked campaigns by creating
 * touchpoints. Cooldown per (campaign × contact) prevents re-enrolment
 * within trigger.cooldown_days.
 *
 * Trigger types:
 *   lifecycle_event    — match by event_type (e.g. 'offer.accepted')
 *   buyer_stage        — match by contacts.buyer_stage value
 *   milestone          — match by transaction_milestones.milestone_name
 *   sphere_anniversary — handled by a separate sphere-anniversary cron;
 *                        we only persist the trigger registration here
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { recordCampaignTouchpointSafe } from "./touchpoint-recorder"
import { matchTriggersForEvent, isCooldownActive, type LifecycleTrigger } from "./trigger-match"

// Re-export the pure matchers so existing importers of trigger-engine keep working.
export { matchTriggersForEvent, isCooldownActive, type LifecycleTrigger } from "./trigger-match"

export interface TriggerProcessSummary {
  scanned:     number
  enrolled:    number
  skipped:     number
  errors:      number
}

export interface LifecycleEventInput {
  id?:          string
  event_type:   string
  entity_type:  string | null
  entity_id:    string
  brokerage_id: string
  metadata?:    Record<string, unknown> | null
}

export interface OneEventResult { matched: number; enrolled: number; skipped: number; errors: number }

const ALLOWED_TOUCHPOINT_CHANNELS = new Set([
  "email", "sms", "direct_mail", "social", "qr_scan",
  "blog", "podcast", "newsletter", "phone", "portal",
])

/** Load active lifecycle_event triggers (optionally narrowed to one brokerage). */
async function loadActiveLifecycleTriggers(svc: SupabaseClient, brokerageId?: string): Promise<LifecycleTrigger[]> {
  let q = svc
    .from("marketing_campaign_triggers")
    .select("id, brokerage_id, campaign_id, trigger_value, channel, cooldown_days, audience_filter")
    .eq("trigger_type", "lifecycle_event")
    .eq("is_active", true)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data } = await q
  return (data ?? []) as LifecycleTrigger[]
}

/**
 * Process ONE lifecycle event against the campaign triggers — the single enrollment path shared by
 * the reactive kernel reactor (fires on emit) and the safety-net cron (sweeps lifecycle_events).
 * Enrollment = a campaign touchpoint (source='trigger'); the actual sends happen downstream through
 * the channel adapters, which keep their own compliance/TCPA/brand gates. Idempotent across the two
 * callers via the per-(campaign × contact) cooldown check, so a double-fire never double-enrolls.
 */
export async function processOneLifecycleEvent(
  svc: SupabaseClient,
  ev: LifecycleEventInput,
  preloadedTriggers?: LifecycleTrigger[],
): Promise<OneEventResult> {
  const triggers = preloadedTriggers ?? await loadActiveLifecycleTriggers(svc, ev.brokerage_id)
  const matches = matchTriggersForEvent(triggers, ev.event_type, ev.brokerage_id)
  if (matches.length === 0) return { matched: 0, enrolled: 0, skipped: 1, errors: 0 }

  const contactId = await resolveContactFromEvent(svc, ev.entity_type, ev.entity_id, ev.metadata ?? null)
  if (!contactId) return { matched: matches.length, enrolled: 0, skipped: 1, errors: 0 }

  let enrolled = 0, skipped = 0, errors = 0
  for (const trig of matches) {
    const { data: recent } = await svc
      .from("marketing_campaign_touchpoints")
      .select("sent_at")
      .eq("campaign_id", trig.campaign_id)
      .eq("contact_id", contactId)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (isCooldownActive((recent?.sent_at as string | null) ?? null, trig.cooldown_days)) { skipped++; continue }

    const ch = (ALLOWED_TOUCHPOINT_CHANNELS.has(trig.channel) ? trig.channel : "email") as
      Parameters<typeof recordCampaignTouchpointSafe>[0]["channel"]

    const r = await recordCampaignTouchpointSafe({
      brokerageId: trig.brokerage_id,
      campaignId:  trig.campaign_id,
      contactId,
      channel:     ch,
      source:      "trigger",
      metadata:    {
        trigger_id:        trig.id,
        source_event_id:   ev.id ?? null,
        source_event_type: ev.event_type,
      },
    })
    if (r.ok) enrolled++
    else      errors++
  }
  return { matched: matches.length, enrolled, skipped, errors }
}

/**
 * Scan recent lifecycle_events for matching active triggers; enroll via processOneLifecycleEvent.
 * This is the SAFETY-NET sweep — the kernel reactor already enrolls on emit; this catches anything
 * the reactor missed (process restart, event emitted without going through processKernelEvent).
 */
export async function processLifecycleEventTriggers(
  svc:              SupabaseClient,
  lookbackMinutes:  number = 90,
): Promise<TriggerProcessSummary> {
  const since = new Date(Date.now() - lookbackMinutes * 60_000).toISOString()
  const summary: TriggerProcessSummary = { scanned: 0, enrolled: 0, skipped: 0, errors: 0 }

  const activeTriggers = await loadActiveLifecycleTriggers(svc)
  if (activeTriggers.length === 0) return summary

  const wantedTypes = Array.from(new Set(activeTriggers.map(t => t.trigger_value)))

  const { data: events } = await svc
    .from("lifecycle_events")
    .select("id, event_type, entity_type, entity_id, brokerage_id, metadata, actor_user_id, created_at")
    .in("event_type", wantedTypes)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(500)

  const eventList = (events ?? []) as Array<LifecycleEventInput & { created_at: string }>
  summary.scanned = eventList.length

  for (const ev of eventList) {
    const r = await processOneLifecycleEvent(svc, ev, activeTriggers)
    summary.enrolled += r.enrolled
    summary.skipped  += r.skipped
    summary.errors   += r.errors
  }

  return summary
}

/**
 * Resolve the contact_id touched by a lifecycle event.
 *
 *   contact entity → entity_id
 *   transaction    → buyer_contact_id ?? seller_contact_id ?? contact_id
 *   listing        → seller_contact_id
 *   offer          → contact_id
 */
export async function resolveContactFromEvent(
  svc:        SupabaseClient,
  entityType: string | null,
  entityId:   string,
  metadata:   Record<string, unknown> | null,
): Promise<string | null> {
  if (entityType === "contact") return entityId

  if (entityType === "transaction") {
    const { data } = await svc
      .from("transactions")
      .select("buyer_contact_id, seller_contact_id, contact_id")
      .eq("id", entityId)
      .maybeSingle()
    return ((data?.buyer_contact_id as string | null)
         ?? (data?.seller_contact_id as string | null)
         ?? (data?.contact_id as string | null)
         ?? null)
  }
  if (entityType === "listing") {
    const { data } = await svc
      .from("listings")
      .select("seller_contact_id")
      .eq("id", entityId)
      .maybeSingle()
    return (data?.seller_contact_id as string | null) ?? null
  }
  if (entityType === "offer") {
    const { data } = await svc
      .from("offers")
      .select("contact_id")
      .eq("id", entityId)
      .maybeSingle()
    return (data?.contact_id as string | null) ?? null
  }
  // metadata.contact_id last-resort
  const metaContact = metadata && typeof metadata === "object" && "contact_id" in metadata
    ? (metadata as { contact_id?: string }).contact_id
    : undefined
  return metaContact ?? null
}
