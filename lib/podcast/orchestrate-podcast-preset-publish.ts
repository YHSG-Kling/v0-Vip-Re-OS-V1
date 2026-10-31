/**
 * lib/podcast/orchestrate-podcast-preset-publish.ts
 *
 * Wave 38 — podcast preset publisher. A preset links to an existing
 * podcast_episodes row + a list of target distribution channels
 * (Spotify, Apple Podcasts, YouTube Music, etc.). On dispatch we
 * write one podcast_distribution_log row per target — the existing
 * publish-podcast-episodes cron picks them up on its tick.
 *
 * v1 doesn't generate net-new audio; that's the existing podcast-
 * weekly-auto cron's job. Presets are for COORDINATED PUSH of an
 * already-rendered episode (e.g., the brokerage's flagship monthly
 * episode lands on every channel in a bundle alongside an email +
 * social post + voicedrop announcing it).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface OrchestratePodcastPresetPublishArgs {
  brokerageId: string
  presetId:    string
  teamId?:     string | null
  agentUserId?: string | null
  systemSource?: string
}

export interface OrchestratePodcastPresetPublishResult {
  success:        boolean
  presetName?:    string
  episodeId?:     string | null
  channelsCount?: number
  distributionLogIds?: string[]
  error?:         string
}

interface PresetRow {
  id: string
  brokerage_id: string
  name: string
  podcast_episode_id: string | null
  target_distribution_channels: string[] | null
  is_active: boolean
}

export async function orchestratePodcastPresetPublish(
  args: OrchestratePodcastPresetPublishArgs,
  deps: { client?: ReturnType<typeof createServiceClient> } = {},
): Promise<OrchestratePodcastPresetPublishResult> {
  const svc = deps.client ?? createServiceClient()

  // §3: a refused read is a refusal, never "not found" (supabase-js RESOLVES errors).
  const { data: presetData, error: presetErr } = await svc.from("podcast_episode_presets")
    .select("id, brokerage_id, name, podcast_episode_id, target_distribution_channels, is_active")
    .eq("id", args.presetId)
    .maybeSingle()
  if (presetErr) return { success: false, error: `preset_read_refused: ${presetErr.message}` }
  const preset = presetData as PresetRow | null
  if (!preset) return { success: false, error: "preset_not_found" }
  if (preset.brokerage_id !== args.brokerageId) return { success: false, error: "tenant_mismatch", presetName: preset.name }
  if (!preset.is_active) return { success: false, error: "preset_deactivated", presetName: preset.name }
  if (!preset.podcast_episode_id) return { success: false, error: "no_episode_linked", presetName: preset.name }

  // Verify the episode is in tenant + ready to distribute.
  // Wave 144 (lane 144H, owner ruling 18 — approved creative keeps its human approval): "ready" used to be read and never
  // checked, so a preset staged distribution rows for an episode still pending_review. The SAME gate the distributor
  // (app/api/cron/distribute-podcast-episodes) applies now holds at this write: finished AND approved by a human.
  const { data: episode, error: episodeErr } = await svc.from("podcast_episodes")
    .select("id, brokerage_id, status, approval_status")
    .eq("id", preset.podcast_episode_id)
    .maybeSingle()
  if (episodeErr) return { success: false, error: `episode_read_refused: ${episodeErr.message}`, presetName: preset.name }
  const ep = episode as { id: string; brokerage_id: string | null; status: string | null; approval_status: string | null } | null
  if (!ep) return { success: false, error: "episode_not_found", presetName: preset.name }
  if (ep.brokerage_id !== args.brokerageId) return { success: false, error: "episode_tenant_mismatch", presetName: preset.name }
  if (ep.approval_status !== "approved") return { success: false, error: `episode_not_approved: the episode is ${ep.approval_status ?? "unreviewed"} — a human approves it before any channel receives it`, presetName: preset.name }
  if (!["completed", "published"].includes(String(ep.status ?? ""))) return { success: false, error: `episode_not_ready: status ${ep.status ?? "unknown"} — only a finished episode is distributed`, presetName: preset.name }

  const channels = preset.target_distribution_channels ?? []
  if (channels.length === 0) {
    return { success: false, error: "no_target_channels", presetName: preset.name }
  }

  // Stage distribution log rows. The existing publish-podcast cron
  // walks pending entries here and dispatches per platform.
  // pass 14 (variable-insert sweep): the live columns are podcast_episode_id /
  // channel_name / distribution_status — the old episode_id/status keys were
  // phantom and every preset publish errored.
  const rows = channels.map((channel) => ({
    brokerage_id:        args.brokerageId,
    podcast_episode_id:  ep.id,
    channel_name:        channel,
    distribution_status: "pending",
    created_at:          new Date().toISOString(),
  }))

  const { data: inserted, error } = await svc.from("podcast_distribution_log")
    .insert(rows)
    .select("id")
  if (error) return { success: false, error: error.message, presetName: preset.name }

  return {
    success:         true,
    presetName:      preset.name,
    episodeId:       ep.id,
    channelsCount:   channels.length,
    distributionLogIds: ((inserted ?? []) as Array<{ id: string }>).map((r) => r.id),
  }
}
