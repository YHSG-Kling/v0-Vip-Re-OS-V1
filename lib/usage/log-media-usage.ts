/**
 * lib/usage/log-media-usage.ts
 *
 * Records a chargeable media event (D-ID minutes, ElevenLabs chars, Vapi
 * minutes, etc.) and increments the brokerage's monthly counter.
 *
 * Two writes happen in one call:
 *   1. usage_events  — per-event audit row: which agent / contact / session
 *      triggered it, with quantity + cost snapshot
 *   2. usage_counters — brokerage's monthly aggregate for cap enforcement +
 *      dashboard rollups
 *
 * Logging failures NEVER throw — usage tracking is observability, not the
 * critical path. Caller code keeps running on a logging error.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { currentUsagePeriod } from "./period"

export type MediaMetric =
  | "live_avatar_minutes"
  | "live_avatar_sessions"
  | "tts_characters"
  | "voice_clones_created"
  | "avatars_created"
  | "ai_voice_minutes"
  | "video_minutes"
  | "live_assistant_minutes"
  | "live_assistant_sessions"

export interface LogMediaUsageParams {
  brokerageId: string
  metric: MediaMetric
  quantity: number
  /** agents.id (NOT users.id). Optional when the event isn't agent-scoped. */
  agentId?: string | null
  teamId?: string | null
  userId?: string | null
  contactId?: string | null
  /** Vendor session id — D-ID session, Vapi call sid, etc. */
  sessionRef?: string | null
  /** Surface that triggered the event — 'portal_widget', 'twin_studio_clone', 'isa_outbound', etc. */
  feature?: string | null
  /** Cost snapshot in cents. */
  costCents?: number | null
  metadata?: Record<string, unknown>
}

/**
 * Write the event row + increment the monthly counter. Idempotent failure —
 * never throws.
 */
export async function logMediaUsage(params: LogMediaUsageParams): Promise<void> {
  if (!params.brokerageId || !params.metric || params.quantity < 0) return

  const supabase = createServiceClient()

  // 1. Per-event audit row
  await supabase.from("usage_events").insert({
    brokerage_id: params.brokerageId,
    team_id: params.teamId ?? null,
    agent_id: params.agentId ?? null,
    user_id: params.userId ?? null,
    metric: params.metric,
    quantity: params.quantity,
    contact_id: params.contactId ?? null,
    session_ref: params.sessionRef ?? null,
    feature: params.feature ?? null,
    cost_cents: params.costCents ?? null,
    metadata: params.metadata ?? {},
  }).then(() => {}, (e) => console.warn("[usage] event insert failed", e))

  // 2. Monthly counter — UPSERT with delta increment
  // Period: calendar month UTC. UNIQUE(brokerage_id, period_start, period_end, metric).
  // Canonical UTC period — lib/usage/period.ts is the one definition (#190).
  const { periodStartIso, periodEndIso } = currentUsagePeriod()

  // Read-modify-write — small race risk if two events land in the same ms,
  // acceptable for a usage counter (we don't bill off it directly; we bill
  // off usage_events). For higher-precision, this would become a Postgres
  // function with row-level locking.
  const { data: existing } = await supabase
    .from("usage_counters")
    .select("id, value")
    .eq("brokerage_id", params.brokerageId)
    .eq("period_start", periodStartIso)
    .eq("metric", params.metric)
    .maybeSingle()

  if (existing) {
    await supabase
      .from("usage_counters")
      .update({ value: (existing.value ?? 0) + Math.ceil(params.quantity) })
      .eq("id", existing.id)
      .then(() => {}, (e) => console.warn("[usage] counter update failed", e))
  } else {
    await supabase
      .from("usage_counters")
      .insert({
        brokerage_id: params.brokerageId,
        period_start: periodStartIso,
        period_end: periodEndIso,
        metric: params.metric,
        value: Math.ceil(params.quantity),
      })
      .then(() => {}, (e) => console.warn("[usage] counter insert failed", e))
  }

  // 3. THE BILLING METER — `billing_usage.video_minutes`.
  //
  // WHY A THIRD WRITE AND NOT A JOIN OFF THE TWO ABOVE: `billing_usage` is a
  // DIFFERENT rail from `usage_counters`, with different readers, and it had NO
  // WRITER AT ALL. Its two live surfaces — the tenant's usage bars
  // (app/settings/billing/usage-section.tsx via app/actions/billing.ts
  // getBillingUsage) and the overage projection
  // (app/components/features/admin/overage-calculator.tsx via
  // calculateOverageExposure) — read five columns nothing in the product ever
  // wrote, so both showed zero for every tenant, forever. An overage exposure
  // computed from an unwritten meter reads as "no exposure", which is the one
  // wrong answer that costs money.
  //
  // Only `video_minutes` maps: it is the one media metric `billing_usage` has a
  // column for (live schema: ai_calls_count, video_minutes, storage_bytes,
  // scraper_calls, active_agents). The avatar/TTS/voice metrics stay on
  // usage_counters alone rather than being silently folded into a column that
  // does not mean them.
  //
  // `units` is a DELTA. Never restate a running total here.
  if (params.metric === "video_minutes") {
    const { recordUsageEvent } = await import("@/lib/kernel/billing")
    const metered = await recordUsageEvent({
      brokerageId: params.brokerageId,
      metric: "video_minutes",
      units: Math.ceil(params.quantity),
    })
    // Same posture as the two writes above: usage logging is observability and
    // must not break the caller. But the refusal is REPORTED rather than
    // discarded — a meter that silently stops recording is what produced the
    // zeroed surfaces in the first place.
    if (!metered.success) {
      console.warn("[usage] billing_usage video_minutes not recorded:", metered.error)
    }
  }
}
