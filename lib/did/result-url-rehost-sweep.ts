// lib/did/result-url-rehost-sweep.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SAFETY NET — a NIGHTLY sweep for any row that still carries a raw D-ID
// result URL (`*.d-id.com`) in a column downstream code will hand to a browser,
// an email, or a public page.
//
// D-ID FACT (docs.d-id.com, verified 2026-09-14): `/talks` and `/clips`
// `result_url` is an S3 URI / short-lived PRESIGNED URL — third-party
// integration threads report a plain "Access Denied" once it expires. D-ID
// does not promise indefinite storage. This repo's happy paths already
// re-host every render the moment it completes:
//   - app/api/cron/poll-did-videos (video render) → lib/remotion/media-host.ts
//     hostRenderedMedia, and FAILS CLOSED (stays 'generating', never stores
//     the vendor URL) when the re-host itself fails — see that file's header.
//   - lib/did/avatar-completion.ts applyAvatarOutcome (avatar/twin creation,
//     called by both the webhook and poll-did-avatars) → rehostAvatarImage,
//     same fail-closed contract (falls back to null, not the vendor URL, on a
//     re-host failure — though its comment records the fallback WAS reachable
//     historically over a missing bucket, see that file's header).
//
// So under the current code a *new* row should never carry a d-id.com URL.
// This sweep exists for what "should never" does not cover: legacy rows
// written before either fail-closed contract existed, a future regression in
// either path, or a hand-rolled `.update()` that bypasses both (this module's
// sibling guard, scripts/twin-lifecycle-simulator.ts, statically asserts no
// such write-site exists in source — this sweep is the RUNTIME backstop for
// live rows, which a source scan cannot see).
//
// OWNER RULING (wave 62): "vercel cron usage and billing should be
// considered … we don't want the charges outweighing the build" — every new
// cron must be justified against invocations/day. This one is DAILY
// (CRON_REGISTRY: "0 9 * * *"), not sub-5-minute: a row that slipped through
// with a live D-ID URL has a MULTI-HOUR window before that URL expires (the
// integration-thread number the avatar-pipeline-hardening guard already
// cites is "a few hours"), so a once-a-day pass catches it well inside that
// window without adding a per-minute invocation. Folded into the existing
// dispatcher heartbeat (CRON_REGISTRY), not a new platform cron entry.
//
// REUSES THE ONE REHOST HELPER (§6) — lib/remotion/media-host.ts's
// hostRenderedMedia for video/thumbnail bytes (same bucket class the render
// path already uses) and lib/did/avatar-completion.ts's rehostAvatarImage for
// avatar/twin image bytes. Neither is re-implemented here.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { hostRenderedMedia } from "@/lib/remotion/media-host"
import { rehostAvatarImage } from "@/lib/did/avatar-completion"
import { collectError } from "@/lib/errors/collect-error"

type Svc = ReturnType<typeof createServiceClient>

/** The tell. D-ID's result/image/thumbnail URLs are always on this host —
 *  matched against BOTH the apex and the documented API subdomain named in
 *  the owner's fact sheet, so a bare `d-id.com` string in an unrelated field
 *  is not what this looks for (it looks for it as a URL host substring). */
const DID_URL_MARKERS = ["d-id.com", "api.d-id.com"] as const

function isDidUrl(url: string | null | undefined): url is string {
  if (!url) return false
  return DID_URL_MARKERS.some((m) => url.includes(m))
}

export interface RehostSweepResult {
  scanned: number
  rehosted: number
  failed: number
  stillStuck: Array<{ table: string; id: string; reason: string }>
}

/**
 * Re-host a rendered VIDEO's video_url/thumbnail_url when either still points
 * at D-ID. Mirrors poll-did-videos' own persist step (fetch → hostRenderedMedia),
 * scoped to the same `video-assets` bucket that path already writes to.
 */
async function sweepVideoProjects(svc: Svc): Promise<RehostSweepResult> {
  const result: RehostSweepResult = { scanned: 0, rehosted: 0, failed: 0, stillStuck: [] }

  const { data: rows, error } = await svc
    .from("ai_video_projects")
    .select("id, agent_id, video_url, thumbnail_url")
    .eq("status", "completed")
    .or(
      DID_URL_MARKERS.map((m) => `video_url.ilike.%${m}%,thumbnail_url.ilike.%${m}%`).join(","),
    )
    .limit(50)

  if (error) {
    await collectError({
      workflowName: "did_result_url_rehost_sweep",
      errorMessage: `ai_video_projects scan refused: ${error.message}`,
      errorType: "database",
      fileInfo: { path: "lib/did/result-url-rehost-sweep.ts", line: 0, function: "sweepVideoProjects" },
    })
    return result
  }

  for (const row of (rows ?? []) as Array<{ id: string; agent_id: string | null; video_url: string | null; thumbnail_url: string | null }>) {
    result.scanned++
    const agentFolder = row.agent_id ?? "shared"
    const patch: Record<string, string> = {}

    try {
      if (isDidUrl(row.video_url)) {
        const res = await fetch(row.video_url)
        if (!res.ok) throw new Error(`video fetch HTTP ${res.status}`)
        const bytes = Buffer.from(await res.arrayBuffer())
        patch.video_url = await hostRenderedMedia(
          svc, `agent-videos/${agentFolder}/${row.id}.sweep-rehost.mp4`, bytes, "video/mp4",
        )
      }
      if (isDidUrl(row.thumbnail_url)) {
        const res = await fetch(row.thumbnail_url)
        if (!res.ok) throw new Error(`thumbnail fetch HTTP ${res.status}`)
        const bytes = Buffer.from(await res.arrayBuffer())
        patch.thumbnail_url = await hostRenderedMedia(
          svc, `agent-videos/${agentFolder}/${row.id}.sweep-rehost-thumb.jpg`, bytes, "image/jpeg",
        )
      }
      if (Object.keys(patch).length === 0) continue

      const { error: updateError } = await svc.from("ai_video_projects").update(patch).eq("id", row.id)
      if (updateError) throw new Error(`row update refused: ${updateError.message}`)
      result.rehosted++
    } catch (e: any) {
      result.failed++
      const reason = e?.message ?? String(e)
      result.stillStuck.push({ table: "ai_video_projects", id: row.id, reason })
      await collectError({
        workflowName: "did_result_url_rehost_sweep",
        errorMessage: `ai_video_projects ${row.id}: ${reason}`,
        errorType: "external_service",
        fileInfo: { path: "lib/did/result-url-rehost-sweep.ts", line: 0, function: "sweepVideoProjects" },
      })
    }
  }
  return result
}

/**
 * Re-host a twin/avatar's avatar_url/thumbnail_url (agent_avatar_assets) and
 * its mirror on agent_voice_profiles when either still points at D-ID.
 * Reuses rehostAvatarImage verbatim (the same helper applyAvatarOutcome calls
 * on the happy path) — not a second image-download implementation.
 */
async function sweepAvatarAssets(svc: Svc): Promise<RehostSweepResult> {
  const result: RehostSweepResult = { scanned: 0, rehosted: 0, failed: 0, stillStuck: [] }

  const { data: rows, error } = await svc
    .from("agent_avatar_assets")
    .select("id, agent_id, is_default, avatar_url, thumbnail_url")
    .eq("status", "ready")
    .or(
      DID_URL_MARKERS.map((m) => `avatar_url.ilike.%${m}%,thumbnail_url.ilike.%${m}%`).join(","),
    )
    .limit(50)

  if (error) {
    await collectError({
      workflowName: "did_result_url_rehost_sweep",
      errorMessage: `agent_avatar_assets scan refused: ${error.message}`,
      errorType: "database",
      fileInfo: { path: "lib/did/result-url-rehost-sweep.ts", line: 0, function: "sweepAvatarAssets" },
    })
    return result
  }

  for (const row of (rows ?? []) as Array<{ id: string; agent_id: string | null; is_default: boolean; avatar_url: string | null; thumbnail_url: string | null }>) {
    result.scanned++
    const staleUrl = isDidUrl(row.avatar_url) ? row.avatar_url : row.thumbnail_url
    if (!isDidUrl(staleUrl)) continue

    try {
      const rehosted = await rehostAvatarImage(svc as never, row.id, staleUrl)
      if (!rehosted) throw new Error("rehostAvatarImage returned null (bucket write or download failed)")

      const { error: updateError } = await svc.from("agent_avatar_assets")
        .update({ avatar_url: rehosted, thumbnail_url: rehosted, updated_at: new Date().toISOString() })
        .eq("id", row.id)
      if (updateError) throw new Error(`row update refused: ${updateError.message}`)

      if (row.is_default && row.agent_id) {
        await svc.from("agent_voice_profiles")
          .update({ avatar_url: rehosted })
          .eq("agent_id", row.agent_id)
      }
      result.rehosted++
    } catch (e: any) {
      result.failed++
      const reason = e?.message ?? String(e)
      result.stillStuck.push({ table: "agent_avatar_assets", id: row.id, reason })
      await collectError({
        workflowName: "did_result_url_rehost_sweep",
        errorMessage: `agent_avatar_assets ${row.id}: ${reason}`,
        errorType: "external_service",
        fileInfo: { path: "lib/did/result-url-rehost-sweep.ts", line: 0, function: "sweepAvatarAssets" },
      })
    }
  }

  // agent_voice_profiles rows that carry a stale D-ID avatar_url but are NOT
  // mirrored from a default agent_avatar_assets row above (legacy profiles
  // predating Twin Studio) — same helper, keyed on the profile's own id.
  const { data: profiles, error: profileError } = await svc
    .from("agent_voice_profiles")
    .select("id, agent_id, avatar_url")
    .or(DID_URL_MARKERS.map((m) => `avatar_url.ilike.%${m}%`).join(","))
    .limit(50)

  if (profileError) {
    await collectError({
      workflowName: "did_result_url_rehost_sweep",
      errorMessage: `agent_voice_profiles scan refused: ${profileError.message}`,
      errorType: "database",
      fileInfo: { path: "lib/did/result-url-rehost-sweep.ts", line: 0, function: "sweepAvatarAssets" },
    })
    return result
  }

  for (const p of (profiles ?? []) as Array<{ id: string; agent_id: string; avatar_url: string | null }>) {
    if (!isDidUrl(p.avatar_url)) continue
    result.scanned++
    try {
      const rehosted = await rehostAvatarImage(svc as never, p.agent_id, p.avatar_url)
      if (!rehosted) throw new Error("rehostAvatarImage returned null (bucket write or download failed)")
      const { error: updateError } = await svc.from("agent_voice_profiles")
        .update({ avatar_url: rehosted })
        .eq("id", p.id)
      if (updateError) throw new Error(`row update refused: ${updateError.message}`)
      result.rehosted++
    } catch (e: any) {
      result.failed++
      const reason = e?.message ?? String(e)
      result.stillStuck.push({ table: "agent_voice_profiles", id: p.id, reason })
      await collectError({
        workflowName: "did_result_url_rehost_sweep",
        errorMessage: `agent_voice_profiles ${p.id}: ${reason}`,
        errorType: "external_service",
        fileInfo: { path: "lib/did/result-url-rehost-sweep.ts", line: 0, function: "sweepAvatarAssets" },
      })
    }
  }

  return result
}

export async function runDidResultUrlRehostSweep(
  svc: Svc = createServiceClient(),
): Promise<{ videoProjects: RehostSweepResult; avatarAssets: RehostSweepResult }> {
  const [videoProjects, avatarAssets] = await Promise.all([
    sweepVideoProjects(svc),
    sweepAvatarAssets(svc),
  ])
  return { videoProjects, avatarAssets }
}
