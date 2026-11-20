import type { SupabaseClient } from "@supabase/supabase-js"
import { generateAIResponse } from "@/lib/ai"
import { OUTPUT_FORMAT_CONFIG, type OutputFormat } from "@/lib/repurpose/types"
import { DISTRIBUTABLE_PLATFORMS, extractHashtags } from "@/lib/repurpose/shared"

// Called from the video-completion handler (poll-did-videos cron → video.generated).
// When a generated video carries repurpose distribution intent, draft one
// per-channel social post (status 'draft', approval 'pending') for the agent to
// review and publish. Uses the caller's client (service-role in the cron path).
//
// WAVE 155 (lane 155G — owner R6 / R9; directive G1): THE VARIANT IS CHOSEN BY THE REAL RENDER AND THE CONNECTED PERMISSION.
// MEASURED AT BASE d2d6468c: every named channel got `media_urls: [project.video_url]` — a column read, not a verified-playable
// render; a horizontal cut went to TikTok; a video went to Instagram, whose publisher here posts images only; a client-addressed
// or in-house video could be drafted for public social; a granted permission was never read. Now, before any draft:
//   · the video is PUBLIC marketing by THE one verdict (lib/video/public-video.ts classifyPublicVideo — a personal / client /
//     in-house / MLS-only video is refused by its reason; it is delivered through the door, never posted);
//   · the media is READY by THE one resolver (lib/video/playable-video.ts resolvePlayableVideo — a script or a failed / in-flight
//     render is not a video; nothing is marked distributed, so the real render's event retries);
//   · each platform passes THE variant contract (lib/video/media-variant-contract.ts) on the render's own format / duration and
//     the sender's connected account: refused by name, an `api_publish` draft (pending its own approval), or an EXPORT / HANDOFF
//     lineage row (an approved file a person posts — never a social_posts row the cron could "publish");
//   · the draft names its lineage: the creator owner, the service actor that executed the job (video_metadata.media_job), and the
//     variant's route / permission / notes on post_brief.
export interface DistributeDeps {
  /** @proofSeam scripts/artifact-production-guard.ts — production: resolvePlayableVideo (lib/video/playable-video.ts). */
  playable?: (projectId: string) => Promise<{ state: "ready"; videoUrl: string; thumbnailUrl: string | null } | { state: "in_progress" } | { state: "none"; reason: string }>
}

const PRIVATE_VIDEO_REASONS: ReadonlySet<string> = new Set(["personal_or_client_kind", "addressed_to_a_contact", "education_module_video", "in_house_audience", "mls_only_cut"])

export async function distributeRepurposedVideoAsDraft(
  supabase: SupabaseClient,
  projectId: string,
  deps: DistributeDeps = {},
): Promise<{ success: boolean; created: number; handoffs?: number; refused?: Array<{ platform: string; reason: string }>; error?: string }> {
  const { data: project, error: projectErr } = await supabase
    .from("ai_video_projects")
    .select("id, agent_id, brokerage_id, video_url, title, video_metadata, video_type, contact_id, audience_type, usage_intent, approval_status, status, compliance_status, format, duration_seconds")
    .eq("id", projectId)
    .maybeSingle()

  if (projectErr) return { success: false, created: 0, error: `project unreadable: ${projectErr.message}` }
  if (!project) return { success: false, created: 0, error: "Project not found" }

  const metadata = (project.video_metadata as { repurpose?: { channels?: string[]; distribute_as_draft?: boolean; distributed?: boolean }; media_job?: Record<string, unknown> } | null) ?? null
  const intent = metadata?.repurpose
  if (!intent?.distribute_as_draft || !Array.isArray(intent.channels) || intent.channels.length === 0) {
    return { success: true, created: 0 } // not a repurpose video — no-op
  }
  // Idempotency: never draft twice for the same project (cron re-poll / retry).
  if (intent.distributed) {
    return { success: true, created: 0 }
  }
  // A PRIVATE VIDEO NEVER GOES TO PUBLIC SOCIAL — the one public-video verdict, privacy reasons only (approval / finish are the
  // drafts' and the resolver's questions). It is delivered to its one recipient through the door (lib/video/client-video-delivery.ts).
  const { classifyPublicVideo } = await import("@/lib/video/public-video")
  const verdict = classifyPublicVideo(project as never)
  if (!verdict.public && PRIVATE_VIDEO_REASONS.has(verdict.reason)) {
    return { success: false, created: 0, error: `not public marketing (${verdict.reason}) — a private video is delivered through the door, never drafted for public social` }
  }
  // THE MEDIA IS THE VERIFIED-PLAYABLE RENDER, never a column read. Not ready = nothing drafted, nothing marked distributed.
  const playable = await (deps.playable ?? (async (id: string) => (await import("@/lib/video/playable-video")).resolvePlayableVideo({ videoProjectId: id }, supabase as never)))(projectId)
  if (playable.state !== "ready") return { success: false, created: 0, error: playable.state === "in_progress" ? "Video not ready — the render is still in flight" : `no playable render — a script or a failed render is not a video (${playable.reason})` }
  const videoUrl = playable.videoUrl

  // Since m366 ai_video_projects.agent_id is the SAME class social_media_accounts
  // /social_posts.agent_id FK, so it carries straight through. The AI-usage
  // metadata still wants a users id, so that one hop is resolved here.
  const agentsId = project.agent_id as string | null
  if (!agentsId) return { success: false, created: 0, error: "Agent not found" }
  const { data: agentRow, error: agentErr } = await supabase
    .from("agents")
    .select("user_id")
    .eq("id", agentsId)
    .eq("brokerage_id", project.brokerage_id)
    .maybeSingle()
  if (agentErr) return { success: false, created: 0, error: agentErr.message }
  const agentUserId = (agentRow?.user_id as string | null) ?? null
  if (!agentUserId) return { success: false, created: 0, error: "Agent not found" }

  // Resolve the agent's active connected accounts → platform → account id (+ the granted scope, read by the variant contract).
  const { data: accounts, error: accountsErr } = await supabase
    .from("social_media_accounts")
    .select("id, platform, scope")
    .eq("brokerage_id", project.brokerage_id)
    .eq("agent_id", agentsId)
    .eq("is_active", true)
  if (accountsErr) return { success: false, created: 0, error: `connected accounts unreadable: ${accountsErr.message}` }

  const accountByPlatform = new Map<string, string>()
  const scopeByPlatform = new Map<string, string | null>()
  for (const a of accounts ?? []) {
    if (!accountByPlatform.has(a.platform)) { accountByPlatform.set(a.platform, a.id); scopeByPlatform.set(a.platform, (a as { scope?: string | null }).scope ?? null) }
  }

  // THE VARIANT PER PLATFORM — the real render's format / duration against each connected account (one verdict per platform).
  const { decidePlatformVariant } = await import("@/lib/video/media-variant-contract")
  type Verdict = ReturnType<typeof decidePlatformVariant>
  const variantFor = new Map<string, Verdict>()
  const refused: Array<{ platform: string; reason: string }> = []
  for (const fmt of intent.channels as OutputFormat[]) {
    const p = OUTPUT_FORMAT_CONFIG[fmt]?.platform
    if (!p || !DISTRIBUTABLE_PLATFORMS.has(p) || variantFor.has(p)) continue
    const v = decidePlatformVariant({ platform: p, account: accountByPlatform.has(p) ? { isActive: true, scope: scopeByPlatform.get(p) ?? null } : null, media: { kind: "video", playable: true, aspect: (project.format as string | null) ?? null, durationSeconds: typeof project.duration_seconds === "number" ? project.duration_seconds : null } })
    variantFor.set(p, v)
    if (!v.ok) refused.push({ platform: p, reason: v.reason })
  }
  const apiOk = (p: string) => { const v = variantFor.get(p); return !!v && v.ok && v.route === "api_publish" }
  const mediaJob = (metadata?.media_job ?? null) as { creator_owner?: unknown; executed_by?: unknown; master_post_id?: unknown; topic_id?: unknown } | null

  // WAVE 153 (lane 153P — owner B9 omnipresence): the drafts are STAGGERED, never one simultaneous burst — each platform's
  // draft carries the slot the ONE planner gives it (lib/repurpose/omnipresence-plan.ts: the tenant's own fatigue floor
  // between platforms for the same source). The drafts still wait for a person's approval (status draft / pending).
  const { planOmnipresenceSchedule, omnipresenceSourceKey } = await import("@/lib/repurpose/omnipresence-plan")
  const { loadFollowupPolicy } = await import("@/lib/ai-isa/followup-policy")
  const gapHours = (await loadFollowupPolicy(supabase as never, project.brokerage_id)).policy.guardrails.minHoursBetweenTouches
  const sourceKey = omnipresenceSourceKey("video_project", projectId)
  const slotPlatforms = (intent.channels as OutputFormat[]).map((f) => OUTPUT_FORMAT_CONFIG[f]?.platform).filter((p): p is string => !!p && DISTRIBUTABLE_PLATFORMS.has(p) && accountByPlatform.has(p) && apiOk(p))
  const slots = new Map(planOmnipresenceSchedule({ platforms: slotPlatforms, sourceKey, carried: [], now: new Date(), gapHours }).map((s) => [s.platform, s.at]))

  let created = 0
  let handoffs = 0
  const seenPlatforms = new Set<string>()
  for (const fmt of intent.channels as OutputFormat[]) {
    const cfg = OUTPUT_FORMAT_CONFIG[fmt]
    if (!cfg || !DISTRIBUTABLE_PLATFORMS.has(cfg.platform)) continue
    if (seenPlatforms.has(cfg.platform)) continue // one post per platform
    seenPlatforms.add(cfg.platform)

    const accountId = accountByPlatform.get(cfg.platform)
    if (!accountId) continue // channel selected but not connected — skip (recorded in `refused`)
    const variant = variantFor.get(cfg.platform)
    if (!variant || !variant.ok) continue // refused by the variant contract — named in `refused`, nothing drafted
    if (variant.route === "export_handoff") {
      // NO PUBLISHING API FOR THIS MEDIA HERE → an approved EXPORT / HANDOFF: one lineage row naming the file a person posts once
      // the video is approved. Never a social_posts row (the cron would hand a video to an image publisher) and never "published".
      const { error: handoffErr } = await supabase.from("repurposed_content_log").insert({
        brokerage_id: project.brokerage_id, source_type: "video_project", source_id: projectId, output_type: fmt,
        output_ref_table: "ai_video_projects", output_ref_id: projectId, platform_target: cfg.platform,
        status: "generated", approval_status: "pending_review", created_by: agentUserId,
        notes: `EXPORT / HANDOFF — ${variant.why}. The approved file is posted on ${cfg.platform} by a person; never published by API. lineage ${omnipresenceSourceKey("video_project", projectId)}${variant.notes.length ? ` · ${variant.notes.join(" · ")}` : ""}`.slice(0, 1000),
      })
      if (handoffErr) refused.push({ platform: cfg.platform, reason: `the handoff row was refused (${handoffErr.message})` })
      else handoffs++
      continue
    }

    // THE CONTENT KIT is the caption source of record (built once at video
    // completion, gated, one voice across channels). The per-platform
    // generation below survives only as the legacy fallback for videos that
    // finished before the kit existed.
    let content = project.title ?? "New video"
    const kit = (metadata as any)?.content_kit
    if (kit?.built_at) {
      const { kitCaptionFor } = await import("@/lib/marketing/video-content-kit")
      const kitCaption = kitCaptionFor(kit, cfg.platform)
      const tags = Array.isArray(kit.hashtags) ? kit.hashtags.map((h: string) => `#${h}`).join(" ") : ""
      content = [kitCaption, tags].filter(Boolean).join("\n\n") || content
    } else {
      try {
        const cap = await generateAIResponse({
          prompt: `Write a platform-native ${cfg.displayName} caption for a real estate agent's short video, with a clear call to action and a few relevant non-discriminatory hashtags. Keep it concise.`,
          maxTokens: 300,
          metadata: { userId: agentUserId, brokerageId: project.brokerage_id, feature: "video_script_generation" },
        })
        content = (cap.text ?? content).trim() || content
      } catch {
        // fall back to the title if caption generation fails
      }
    }

    // Keep hashtags only in the hashtags[] column; strip the inline #tags from
    // the body so a publisher that appends hashtags[] can't double them up.
    const hashtags = extractHashtags(content)
    const body = content.replace(/(^|\s)#[\p{L}0-9_]+/gu, "").replace(/\s{2,}/g, " ").trim() || content

    const { data: post, error: repurposePostErr } = await supabase
      .from("social_posts")
      .insert({
        brokerage_id: project.brokerage_id,
        agent_id: agentsId,
        social_account_id: accountId,
        platform: cfg.platform,
        post_type: "custom",
        content: body,
        media_urls: [videoUrl],
        hashtags,
        status: "draft",
        approval_status: "pending",
        scheduled_for: slots.get(cfg.platform) ?? null,
        ai_generated: true,
        // 155G: who OWNS the piece (the creator) apart from who EXECUTED the job (the service actor), and the variant's route.
        user_id: agentUserId,
        post_brief: {
          source: "video_repurpose", video_project_id: projectId,
          variant: { route: variant.route, format: variant.format, permission: variant.permission, notes: variant.notes },
          ...(mediaJob ? { creator_owner: mediaJob.creator_owner ?? null, executed_by: mediaJob.executed_by ?? null, master_post_id: mediaJob.master_post_id ?? null, topic_id: mediaJob.topic_id ?? null } : {}),
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle()
    if (repurposePostErr) console.error(`[repurpose] social post NOT created: ${repurposePostErr.message}`)
    if (post) {
      created++
      // 153P: LINEAGE — the draft names the video it was cut from (and, for a refurbished URL, the original + stated license).
      const lineage = `lineage ${sourceKey}${(intent as { source_url?: string }).source_url ? ` ← url:${(intent as { source_url?: string }).source_url} · license ${(intent as { rights_basis?: string }).rights_basis ?? "unstated"}` : " · license tenant_owned"}`
      const { error: logErr } = await supabase.from("repurposed_content_log").insert({
        brokerage_id: project.brokerage_id, source_type: "video_project", source_id: projectId, output_type: fmt,
        output_ref_table: "social_posts", output_ref_id: (post as { id: string }).id, platform_target: cfg.platform,
        status: "generated", approval_status: "pending_review", notes: lineage.slice(0, 1000), created_by: agentUserId,
      })
      if (logErr) console.error(`[repurpose] lineage row NOT written for post ${(post as { id: string }).id}: ${logErr.message}`)
    }
  }

  // Mark distributed so a cron re-poll / retry can't draft duplicates.
  const { error: markErr } = await supabase
    .from("ai_video_projects")
    .update({ video_metadata: { ...(metadata ?? {}), repurpose: { ...intent, distributed: true } } })
    .eq("id", projectId)
  if (markErr) return { success: true, created, handoffs, refused, error: `drafts created but the project was not marked distributed (${markErr.message}) — a retry could draft again` }

  return { success: true, created, handoffs, refused }
}
