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

export interface TriggerProcessSummary {
  scanned:     number
  enrolled:    number
  skipped:     number
  errors:      number
}

/**
 * Scan recent lifecycle_events for matching active triggers; for each
 * match resolve the affected contact_id, check cooldown, and write a
 * touchpoint with source='trigger'.
 */
export async function processLifecycleEventTriggers(
  svc:              SupabaseClient,
  lookbackMinutes:  number = 90,
): Promise<TriggerProcessSummary> {
  const since = new Date(Date.now() - lookbackMinutes * 60_000).toISOString()
  const summary: TriggerProcessSummary = { scanned: 0, enrolled: 0, skipped: 0, errors: 0 }

  // 1. Load active lifecycle_event triggers
  const { data: triggers } = await svc
    .from("marketing_campaign_triggers")
    .select("id, brokerage_id, campaign_id, trigger_value, channel, cooldown_days, audience_filter")
    .eq("trigger_type", "lifecycle_event")
    .eq("is_active", true)

  const activeTriggers = (triggers ?? []) as Array<{
    id: string; brokerage_id: string; campaign_id: string;
    trigger_value: string; channel: string; cooldown_days: number;
    audience_filter: Record<string, unknown>;
  }>
  if (activeTriggers.length === 0) return summary

  const wantedTypes = Array.from(new Set(activeTriggers.map(t => t.trigger_value)))

  // 2. Recent events of those types
  const { data: events } = await svc
    .from("lifecycle_events")
    .select("id, event_type, entity_type, entity_id, brokerage_id, metadata, actor_user_id, created_at")
    .in("event_type", wantedTypes)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(500)

  const eventList = (events ?? []) as Array<{
    id: string; event_type: string; entity_type: string | null;
    entity_id: string; brokerage_id: string;
    metadata: Record<string, unknown> | null; created_at: string;
  }>
  summary.scanned = eventList.length

  for (const ev of eventList) {
    const matches = activeTriggers.filter(
      t => t.trigger_value === ev.event_type && t.brokerage_id === ev.brokerage_id,
    )
    if (matches.length === 0) { summary.skipped++; continue }

    // Resolve the contact_id for this event (per entity_type)
    const contactId = await resolveContactFromEvent(svc, ev.entity_type, ev.entity_id, ev.metadata)
    if (!contactId) { summary.skipped++; continue }

    for (const trig of matches) {
      // Cooldown check: skip if a touchpoint exists for this (campaign × contact)
      // within trigger.cooldown_days
      const cooldownStart = new Date(Date.now() - trig.cooldown_days * 86_400_000).toISOString()
      const { data: recent } = await svc
        .from("marketing_campaign_touchpoints")
        .select("id")
        .eq("campaign_id", trig.campaign_id)
        .eq("contact_id", contactId)
        .gte("sent_at", cooldownStart)
        .limit(1)
        .maybeSingle()
      if (recent) { summary.skipped++; continue }

      const allowedChannels = new Set([
        "email", "sms", "direct_mail", "social", "qr_scan",
        "blog", "podcast", "newsletter", "phone", "portal",
      ])
      const ch = (allowedChannels.has(trig.channel) ? trig.channel : "email") as
        Parameters<typeof recordCampaignTouchpointSafe>[0]["channel"]

      const r = await recordCampaignTouchpointSafe({
        brokerageId: trig.brokerage_id,
        campaignId:  trig.campaign_id,
        contactId,
        channel:     ch,
        source:      "trigger",
        metadata:    {
          trigger_id:        trig.id,
          source_event_id:   ev.id,
          source_event_type: ev.event_type,
        },
      })
      if (r.ok) summary.enrolled++
      else      summary.errors++
    }
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
async function resolveContactFromEvent(
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
