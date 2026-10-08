"use server"

// app/actions/video/topic-video-cadence.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT'S TOPIC-VIDEO CADENCE (wave 83, lane 83B). Owner, verbatim: "an agent
// needs to stay top of mind for their market so one video a week, doesn't seem
// like enough." The autonomous topic-pool runner (lib/video/topic-video-runner.ts)
// reads brokerage_settings.settings.topic_video_cadence; these two doors let the
// tenant's admin SEE and SET it. jsonb key beside the learned-rule ledger
// (lib/video/body-visual-rule-ledger.ts) — no column, no CHECK, no migration.
// Tenant from the SESSION (requireTenantAdminOrSoloOwner), never the body; the
// value is bounded by the ONE resolver (topic-video.ts resolveTopicVideoCadence);
// every write is COUNTED (CLAUDE.md §3 — an update that matches nothing resolves).
import { mergeBrokerageSettings } from "@/lib/settings/brokerage-settings-merge"
import { createServiceClient } from "@/lib/supabase/service"
import { requireTenantAdminOrSoloOwner } from "@/lib/auth/require-caller"
import {
  TOPIC_VIDEO_CADENCE_DEFAULT, TOPIC_VIDEO_CADENCE_KEY, TOPIC_VIDEO_CADENCE_MAX, TOPIC_VIDEO_CADENCE_MIN,
  resolveTopicVideoCadence, topicVideosPerWeek, type TopicVideoCadence,
} from "@/lib/video/topic-video"

export interface TopicVideoCadenceView {
  cadence: TopicVideoCadence
  /** This week's count after the seasonal lift — also the week's approval load (every video waits for a person). */
  thisWeek: number
  bounds: { min: number; max: number; default: number }
}

function view(cadence: TopicVideoCadence): TopicVideoCadenceView {
  return {
    cadence,
    thisWeek: topicVideosPerWeek(cadence, new Date().getUTCMonth()),
    bounds: { min: TOPIC_VIDEO_CADENCE_MIN, max: TOPIC_VIDEO_CADENCE_MAX, default: TOPIC_VIDEO_CADENCE_DEFAULT.perWeek },
  }
}

export async function getTopicVideoCadenceAction(): Promise<{ ok: true; view: TopicVideoCadenceView } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  const { data, error } = await createServiceClient().from("brokerage_settings")
    .select("settings").eq("brokerage_id", auth.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `topic-video cadence could not be read: ${error.message}` }
  const settings = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
  return { ok: true, view: view(resolveTopicVideoCadence(settings[TOPIC_VIDEO_CADENCE_KEY])) }
}

export async function setTopicVideoCadenceAction(input: { perWeek?: number; seasonalLift?: boolean; enabled?: boolean }): Promise<{ ok: true; view: TopicVideoCadenceView } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  const svc = createServiceClient()
  // 86C: merged BY KEY through the one settings writer, computed from the settings the database
  // holds at write time (version-checked) — never a whole-object overwrite of other features' keys.
  let cadence = resolveTopicVideoCadence(undefined)
  const write = await mergeBrokerageSettings(svc, auth.brokerageId, (settings) => {
    const current = resolveTopicVideoCadence(settings[TOPIC_VIDEO_CADENCE_KEY])
    cadence = resolveTopicVideoCadence({
      perWeek: typeof input?.perWeek === "number" ? input.perWeek : current.perWeek,
      seasonalLift: typeof input?.seasonalLift === "boolean" ? input.seasonalLift : current.seasonalLift,
      enabled: typeof input?.enabled === "boolean" ? input.enabled : current.enabled,
    })
    return { [TOPIC_VIDEO_CADENCE_KEY]: { ...cadence, updatedAt: new Date().toISOString(), updatedBy: auth.userId } }
  }, { policy: { type: "user", userId: auth.userId, reason: "topic video cadence set" } })
  if (!write.ok) return { ok: false, error: `topic-video cadence was not saved: ${write.error}` }
  return { ok: true, view: view(cadence) }
}
