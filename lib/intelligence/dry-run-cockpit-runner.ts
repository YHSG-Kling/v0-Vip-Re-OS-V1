// lib/intelligence/dry-run-cockpit-runner.ts
//
// Loader for DRY-RUN TOMORROW — assembles the planned touches a broker can preview before they fire:
// active enrollments whose next step is due within the window, resolved to a channel + the contact's
// real consent state, then run through the same gates the executor uses. Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { assemblePlannedDay, type PlannedTouchInput, type PlannedDaySummary } from "./dry-run-cockpit"
import { touchpointManagerForChannel } from "@/lib/campaign-sequences/touchpoint-bridge"
import { pickStepVariant } from "@/lib/campaign-sequences/ab-variant"
import { CONTACT_CONSENT_COLUMNS, CONTACT_PREFERENCE_COLUMN } from "@/lib/compliance/contact-channel-gate"

type Svc = ReturnType<typeof createServiceClient>

export async function getPlannedDay(svc: Svc, brokerageId: string, untilHours = 24, limit = 100): Promise<PlannedDaySummary> {
  const cutoff = new Date(Date.now() + untilHours * 3_600_000).toISOString()
  const { data: enrollments } = await svc
    .from("sequence_enrollments")
    .select("id, sequence_id, contact_id, current_step, next_step_at, ab_variant")
    .eq("brokerage_id", brokerageId)
    .eq("status", "active")
    .not("contact_id", "is", null)
    .lte("next_step_at", cutoff)
    .order("next_step_at", { ascending: true })
    .limit(limit)

  const touches: PlannedTouchInput[] = []
  for (const e of (enrollments ?? []) as any[]) {
    const { data: stepRows } = await svc
      .from("campaign_sequence_steps")
      .select("channel, ab_variant")
      .eq("sequence_id", e.sequence_id)
      .eq("step_number", (e.current_step ?? 0) + 1)
      .eq("is_active", true)
    const step = pickStepVariant(stepRows as any[], e.ab_variant)
    if (!step?.channel) continue

    const { data: seq } = await svc.from("campaign_sequences").select("name").eq("id", e.sequence_id).maybeSingle()
    const { data: c } = await svc.from("contacts")
      .select(`first_name, last_name, ${CONTACT_PREFERENCE_COLUMN}, ${CONTACT_CONSENT_COLUMNS}`)
      .eq("id", e.contact_id).maybeSingle()

    touches.push({
      contactId: e.contact_id,
      contactName: c ? `${(c as any).first_name ?? ""} ${(c as any).last_name ?? ""}`.trim() || null : null,
      channel: step.channel,
      scheduledAt: e.next_step_at,
      sequenceName: (seq as any)?.name ?? null,
      manager: touchpointManagerForChannel(step.channel),
      consent: (c ?? {}) as any,
    })
  }
  return assemblePlannedDay(touches)
}
