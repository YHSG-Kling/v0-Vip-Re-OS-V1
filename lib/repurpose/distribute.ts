import type { SupabaseClient } from "@supabase/supabase-js"
import { generateAIResponse } from "@/lib/ai"
import { OUTPUT_FORMAT_CONFIG, type OutputFormat } from "@/lib/repurpose/types"
import { DISTRIBUTABLE_PLATFORMS, extractHashtags } from "@/lib/repurpose/shared"

// Called from the video-completion handler (poll-did-videos cron → video.generated).
// When a generated video carries repurpose distribution intent, draft one
// per-channel social post (status 'draft', approval 'pending') for the agent to
// review and publish. Uses the caller's client (service-role in the cron path).
export async function distributeRepurposedVideoAsDraft(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ success: boolean; created: number; error?: string }> {
  const { data: project } = await supabase
    .from("ai_video_projects")
    .select("id, agent_id, brokerage_id, video_url, title, video_metadata")
    .eq("id", projectId)
    .maybeSingle()

  if (!project) return { success: false, created: 0, error: "Project not found" }

  const metadata = (project.video_metadata as { repurpose?: { channels?: string[]; distribute_as_draft?: boolean; distributed?: boolean } } | null) ?? null
  const intent = metadata?.repurpose
  if (!intent?.distribute_as_draft || !Array.isArray(intent.channels) || intent.channels.length === 0) {
    return { success: true, created: 0 } // not a repurpose video — no-op
  }
  // Idempotency: never draft twice for the same project (cron re-poll / retry).
  if (intent.distributed) {
    return { success: true, created: 0 }
  }
  if (!project.video_url) return { success: false, created: 0, error: "Video not ready" }

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

  // Resolve the agent's active connected accounts → platform → account id.
  const { data: accounts } = await supabase
    .from("social_media_accounts")
    .select("id, platform")
    .eq("brokerage_id", project.brokerage_id)
    .eq("agent_id", agentsId)
    .eq("is_active", true)

  const accountByPlatform = new Map<string, string>()
  for (const a of accounts ?? []) {
    if (!accountByPlatform.has(a.platform)) accountByPlatform.set(a.platform, a.id)
  }

  // WAVE 153 (lane 153P — owner B9 omnipresence): the drafts are STAGGERED, never one simultaneous burst — each platform's
  // draft carries the slot the ONE planner gives it (lib/repurpose/omnipresence-plan.ts: the tenant's own fatigue floor
  // between platforms for the same source). The drafts still wait for a person's approval (status draft / pending).
  const { planOmnipresenceSchedule, omnipresenceSourceKey } = await import("@/lib/repurpose/omnipresence-plan")
  const { loadFollowupPolicy } = await import("@/lib/ai-isa/followup-policy")
  const gapHours = (await loadFollowupPolicy(supabase as never, project.brokerage_id)).policy.guardrails.minHoursBetweenTouches
  const sourceKey = omnipresenceSourceKey("video_project", projectId)
  const slotPlatforms = (intent.channels as OutputFormat[]).map((f) => OUTPUT_FORMAT_CONFIG[f]?.platform).filter((p): p is string => !!p && DISTRIBUTABLE_PLATFORMS.has(p) && accountByPlatform.has(p))
  const slots = new Map(planOmnipresenceSchedule({ platforms: slotPlatforms, sourceKey, carried: [], now: new Date(), gapHours }).map((s) => [s.platform, s.at]))

  let created = 0
  const seenPlatforms = new Set<string>()
  for (const fmt of intent.channels as OutputFormat[]) {
    const cfg = OUTPUT_FORMAT_CONFIG[fmt]
    if (!cfg || !DISTRIBUTABLE_PLATFORMS.has(cfg.platform)) continue
    if (seenPlatforms.has(cfg.platform)) continue // one post per platform
    seenPlatforms.add(cfg.platform)

    const accountId = accountByPlatform.get(cfg.platform)
    if (!accountId) continue // channel selected but not connected — skip

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
        media_urls: [project.video_url],
        hashtags,
        status: "draft",
        approval_status: "pending",
        scheduled_for: slots.get(cfg.platform) ?? null,
        ai_generated: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle()
    if (repurposePostErr) console.error(`[repurpose] social post NOT created: ${repurposePostErr.message}`)
    if (post) {
      created++
      // 153P: LINEAGE — the draft names the video it was cut from (and, for a refurbished URL, the original + stated licence).
      const lineage = `lineage ${sourceKey}${(intent as { source_url?: string }).source_url ? ` ← url:${(intent as { source_url?: string }).source_url} · licence ${(intent as { rights_basis?: string }).rights_basis ?? "unstated"}` : " · licence tenant_owned"}`
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
  if (markErr) return { success: true, created, error: `drafts created but the project was not marked distributed (${markErr.message}) — a retry could draft again` }

  return { success: true, created }
}
