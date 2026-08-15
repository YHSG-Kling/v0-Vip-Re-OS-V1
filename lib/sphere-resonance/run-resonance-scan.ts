/**
 * SPHERE RESONANCE ENGINE
 *
 * Daily cron walks contacts where `last_life_event_detected` is in the last
 * 7 days and the event hasn't been resonated yet. For each new event:
 *   1. Map the event_type to a touchpoint type
 *   2. Use existing aiGenerateTouchpoint() to draft a personalized message
 *   3. Insert into predictive_listing_actions queue (reuses PLS auto-send
 *      infrastructure: capability gate, review window, cancel-able)
 *
 * Cost: one AI call per fired event (~$0.005). For 5000 contacts with
 * ~2% triggering monthly = ~3300 events/year = ~$17/year per brokerage.
 *
 * Capability gate: `sphere_resonance_auto_touch` (extends ISA capability
 * catalog). Default off, opt-in. Without it, opportunities surface in
 * dashboard for manual review only — no auto-queue.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { aiGenerateTouchpoint } from "@/app/actions/ai-sphere-management"
import { isCapabilityEnabled } from "@/app/actions/ai-isa-settings"

type LifeEventType =
  | "job_change"
  | "job_change_to_non_local"
  | "marriage"
  | "new_baby"
  | "kids_graduated"
  | "empty_nester"
  | "retirement"
  | "divorce_filing"
  | "foreclosure_filing"
  | "death_in_household"
  | "inheritance"

type TouchpointType =
  | "anniversary"
  | "birthday"
  | "check_in"
  | "market_update"
  | "holiday"
  | "referral_ask"

const SENSITIVE_EVENTS = new Set<LifeEventType>([
  "divorce_filing",
  "foreclosure_filing",
  "death_in_household",
  "inheritance",
])

/** Map detected life event → appropriate touchpoint type for aiGenerateTouchpoint. */
const EVENT_TO_TOUCHPOINT: Partial<Record<LifeEventType, TouchpointType>> = {
  job_change: "check_in",
  job_change_to_non_local: "check_in",
  marriage: "check_in",
  new_baby: "check_in",
  kids_graduated: "check_in",
  empty_nester: "check_in",
  retirement: "check_in",
}

interface RunOptions {
  brokerageId?: string
  lookbackDays?: number
  maxContactsPerBrokerage?: number
}

export async function runDailySphereResonanceScan(opts?: RunOptions): Promise<{
  brokeragesProcessed: number
  contactsScanned: number
  eventsResonated: number
  autoQueued: number
  surfacedOnly: number
  sensitiveSkipped: number
  errors: number
}> {
  const supabase = createServiceClient()
  const lookbackDays = opts?.lookbackDays ?? 7
  const limit = opts?.maxContactsPerBrokerage ?? 500

  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()

  // 1. Brokerage list
  const brokerageQ = supabase.from("brokerages").select("id")
  const { data: brokerages } = opts?.brokerageId
    ? await brokerageQ.eq("id", opts.brokerageId)
    : await brokerageQ
  if (!brokerages) return zeroResult()

  let summary = zeroResult()

  for (const b of brokerages as Array<{ id: string }>) {
    try {
      const r = await processBrokerageResonance(b.id, cutoff, limit)
      summary.brokeragesProcessed++
      summary.contactsScanned += r.contactsScanned
      summary.eventsResonated += r.eventsResonated
      summary.autoQueued += r.autoQueued
      summary.surfacedOnly += r.surfacedOnly
      summary.sensitiveSkipped += r.sensitiveSkipped
    } catch {
      summary.errors++
    }
  }

  return summary
}

async function processBrokerageResonance(
  brokerageId: string,
  cutoff: string,
  contactLimit: number
): Promise<{
  contactsScanned: number
  eventsResonated: number
  autoQueued: number
  surfacedOnly: number
  sensitiveSkipped: number
}> {
  const supabase = createServiceClient()

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, brokerage_id, agent_id, life_events, last_life_event_detected, contact_persona")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .not("agent_id", "is", null)
    .not("life_events", "is", null)
    .gte("last_life_event_detected", cutoff)
    .limit(contactLimit)

  if (!contacts || contacts.length === 0) {
    return { contactsScanned: 0, eventsResonated: 0, autoQueued: 0, surfacedOnly: 0, sensitiveSkipped: 0 }
  }

  const autoTouchEnabled = await isCapabilityEnabled(brokerageId, "predictive_listing_auto_touch")

  let eventsResonated = 0
  let autoQueued = 0
  let surfacedOnly = 0
  let sensitiveSkipped = 0

  for (const c of contacts as Array<{
    id: string
    agent_id: string | null
    life_events: Array<{ event: string; date?: string; source: string }> | null
  }>) {
    const events = (c.life_events ?? []) as Array<{ event: string; date?: string; source: string }>
    if (events.length === 0) continue

    // Find recent events not yet resonated
    for (const evt of events) {
      const eventTypeKey = evt.event as LifeEventType
      const eventDate = evt.date ? new Date(evt.date) : null
      if (eventDate && eventDate.getTime() < Date.now() - 30 * 24 * 60 * 60 * 1000) continue

      // Idempotency: have we already resonated this exact event for this contact?
      const evidenceKey = `sphere_resonance:${eventTypeKey}:${evt.date ?? "undated"}`
      const { data: existing } = await supabase
        .from("predictive_listing_actions")
        .select("id")
        .eq("contact_id", c.id)
        .eq("brokerage_id", brokerageId)
        .ilike("cancel_reason", `%${evidenceKey}%`)
        .limit(1)
        .maybeSingle()
      // Also check triggering_signals jsonb for the same evidence key
      const { data: existingByJson } = await supabase
        .from("predictive_listing_actions")
        .select("id")
        .eq("contact_id", c.id)
        .eq("brokerage_id", brokerageId)
        .contains("triggering_signals", [{ evidenceKey }])
        .limit(1)
        .maybeSingle()
      if (existing || existingByJson) continue

      // Sensitive events — surface for human review only, never auto-touch
      if (SENSITIVE_EVENTS.has(eventTypeKey)) {
        sensitiveSkipped++
        await supabase.from("predictive_listing_actions").insert({
          contact_id: c.id,
          agent_id: c.agent_id,
          brokerage_id: brokerageId,
          action_type: "manual_touch",
          triggering_signals: [
            { key: eventTypeKey, label: humanizeEvent(eventTypeKey), evidenceKey, sensitive: true, source: evt.source, date: evt.date },
          ],
          status: "pending_review",
          // No scheduled_send_at — agent must take action
          cancel_reason: evidenceKey,  // used for idempotency lookup
        })
        surfacedOnly++
        continue
      }

      // Non-sensitive event — generate AI touchpoint
      const touchpointType = EVENT_TO_TOUCHPOINT[eventTypeKey] ?? "check_in"
      let messageBody = ""
      try {
        if (c.agent_id) {
          const result = await aiGenerateTouchpoint({
            agentId: c.agent_id,
            contactId: c.id,
            touchpointType,
          })
          if ((result as { success?: boolean; message?: string }).success) {
            messageBody = (result as { message?: string }).message ?? ""
          }
        }
      } catch {
        messageBody = `Hi — saw the ${humanizeEvent(eventTypeKey).toLowerCase()} news. Just thinking of you. If there's anything I can help with, let me know.`
      }

      const queueAuto = autoTouchEnabled
      await supabase.from("predictive_listing_actions").insert({
        contact_id: c.id,
        agent_id: c.agent_id,
        brokerage_id: brokerageId,
        action_type: queueAuto ? "auto_touch" : "manual_touch",
        triggering_signals: [
          { key: eventTypeKey, label: humanizeEvent(eventTypeKey), evidenceKey, source: evt.source, date: evt.date },
        ],
        channel: "email",
        message_body: messageBody,
        status: "pending_review",
        // For auto-mode: schedule with 24h review window. For manual mode: no schedule (agent picks).
        scheduled_send_at: queueAuto
          ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          : null,
        cancel_reason: evidenceKey,
      })
      eventsResonated++
      if (queueAuto) autoQueued++
      else surfacedOnly++
    }
  }

  return {
    contactsScanned: contacts.length,
    eventsResonated,
    autoQueued,
    surfacedOnly,
    sensitiveSkipped,
  }
}

function humanizeEvent(e: string): string {
  return e
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

function zeroResult() {
  return {
    brokeragesProcessed: 0,
    contactsScanned: 0,
    eventsResonated: 0,
    autoQueued: 0,
    surfacedOnly: 0,
    sensitiveSkipped: 0,
    errors: 0,
  }
}
