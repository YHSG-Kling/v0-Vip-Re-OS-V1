"use server"

// lib/repurpose/actions.ts
// Server actions for Layer 9.11 Omnipresence Repurposer Pipeline
// All async functions with full kernel wiring

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { evaluateKernelOutbound, isComplianceBlocked } from "@/lib/kernel/adapters/compliance"
import { applyKernelBrandVoice, isBrandVoiceBlocked } from "@/lib/kernel/adapters/brand-voice"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { generateAIResponse } from "@/lib/ai"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { scheduleSocialPost, getConnectedAccounts } from "@/app/actions/social-media-automation"
import { createVideoProject } from "@/app/actions/video/create-video-project"
import { generateBlogPost } from "@/app/actions/blog"
import { createPodcastEpisode, generatePodcastAudio } from "@/app/actions/podcast-generation"
import { transcribeFromUrl } from "@/lib/repurpose/transcribe"
import { DISTRIBUTABLE_PLATFORMS, extractHashtags } from "@/lib/repurpose/shared"
import type {
  SourceType,
  OutputFormat,
  PipelineConfig,
  RepurposedOutput,
  ExecutePipelineResult,
  SavePipelineResult
} from "@/lib/repurpose/types"
import { OUTPUT_FORMAT_CONFIG } from "@/lib/repurpose/types"

interface AgentBranding {
  agentName: string
  brokerageName: string
  publicSlug: string | null
}

async function loadAgentBranding(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  brokerageId: string,
): Promise<AgentBranding> {
  const [{ data: user }, { data: brokerage }, { data: agent }] = await Promise.all([
    supabase.from("users").select("first_name, last_name").eq("id", userId).maybeSingle(),
    supabase.from("brokerages").select("name").eq("id", brokerageId).maybeSingle(),
    supabase.from("agents").select("public_slug").eq("user_id", userId).eq("brokerage_id", brokerageId).maybeSingle(),
  ])
  const agentName = `${user?.first_name ?? ""} ${user?.last_name ?? ""}`.trim() || "your agent"
  return { agentName, brokerageName: brokerage?.name ?? "", publicSlug: agent?.public_slug ?? null }
}

/**
 * Load the content the user actually picked on the Execute tab.
 *
 * WHY THIS EXISTS. The dashboard requires a source selection — the Execute
 * button is disabled without one, and the run summary shows its title — and then
 * never sent it to the server. executePipeline fell back to
 * pipeline.output_config.sourceId, which the Create-Pipeline dialog stores as ""
 * because that dialog collects a source TYPE and has no item picker. So every
 * run built its prompt from the phrase "this podcast episode" and nothing else:
 * the model was asked to repurpose a piece of content it had never been shown.
 * The outputs then went out through scheduleSocialPost to real connected
 * accounts, and the log recorded the PIPELINE id as source_id, so history could
 * not say what had been repurposed either.
 *
 * Every table and column below is confirmed against the live schema; these are
 * the same four source tables the Execute tab lists.
 */
async function loadRepurposeSource(
  supabase: Awaited<ReturnType<typeof createClient>>,
  brokerageId: string,
  sourceType: SourceType,
  sourceId: string,
): Promise<{ title: string | null; mediaUrl: string | null; body: string | null } | null> {
  const one = (table: string, cols: string) =>
    supabase.from(table).select(cols).eq("id", sourceId).eq("brokerage_id", brokerageId).maybeSingle()

  if (sourceType === "video_project") {
    const { data } = await one("ai_video_projects", "title, video_url, script_content")
    const r = data as any
    return r ? { title: r.title, mediaUrl: r.video_url, body: r.script_content } : null
  }
  if (sourceType === "podcast_episode") {
    const { data } = await one("podcast_episodes", "title, audio_url, script, description")
    const r = data as any
    return r ? { title: r.title, mediaUrl: r.audio_url, body: r.script ?? r.description } : null
  }
  if (sourceType === "blog_post") {
    const { data } = await one("blog_posts", "title, content, excerpt")
    const r = data as any
    return r ? { title: r.title, mediaUrl: null, body: r.content ?? r.excerpt } : null
  }
  if (sourceType === "script") {
    const { data } = await one("video_scripts_library", "title, script_content")
    const r = data as any
    return r ? { title: r.title, mediaUrl: null, body: r.script_content } : null
  }
  // newsletter / social_post / video_url have no picker on the Execute tab.
  return null
}

function buildRepurposePrompt(args: {
  format: OutputFormat
  sourceUrl: string | null
  sourceLabel: string
  /** The real words of the source. Without it the model is guessing. */
  sourceText?: string | null
  branding: AgentBranding
}): string {
  const cfg = OUTPUT_FORMAT_CONFIG[args.format]
  const limit = cfg.maxLength ? `Keep it under ${cfg.maxLength} characters.` : "Keep it concise and platform-native."
  const aspect = cfg.aspectRatio ? ` The source video is intended for a ${cfg.aspectRatio} ${cfg.displayName} format.` : ""
  const source = args.sourceUrl ? `the video at ${args.sourceUrl}` : args.sourceLabel
  // Cap the excerpt: a long blog post would otherwise dominate the prompt and
  // push the format instructions out of the model's attention.
  const excerpt = args.sourceText?.trim()
    ? `Here is the source content to work from — base the caption on what it actually says, not on the topic in general:\n"""\n${args.sourceText.trim().slice(0, 6000)}\n"""`
    : ""
  return [
    `You are writing a ${cfg.displayName} caption for real estate agent ${args.branding.agentName}` +
      (args.branding.brokerageName ? ` of ${args.branding.brokerageName}` : "") + ".",
    `Repurpose ${source} into a platform-native ${cfg.displayName} caption.${aspect}`,
    excerpt,
    `Write in the agent's first-person voice, add a clear call to action, and include a few relevant, non-discriminatory hashtags.`,
    `Do NOT make claims about specific properties, prices, or guarantees. Follow fair-housing rules.`,
    limit,
  ].filter(Boolean).join(" ")
}

async function logRepurpose(
  supabase: Awaited<ReturnType<typeof createClient>>,
  row: {
    brokerageId: string
    sourceType: string
    sourceId: string | null
    outputType: string
    outputRefTable: string | null
    outputRefId: string | null
    platformTarget: string
    status: string
    approvalStatus: string
    notes: string
    createdBy: string
  },
): Promise<void> {
  await supabase.from("repurposed_content_log").insert({
    brokerage_id: row.brokerageId,
    source_type: row.sourceType,
    source_id: row.sourceId,
    output_type: row.outputType,
    output_ref_table: row.outputRefTable,
    output_ref_id: row.outputRefId,
    platform_target: row.platformTarget,
    status: row.status,
    approval_status: row.approvalStatus,
    notes: row.notes.slice(0, 1000),
    created_by: row.createdBy,
    created_at: new Date().toISOString(),
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CREATE REPURPOSE PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * THE PIPELINE DEFINITION, TIED TO ITS DECLARED CONTRACT.
 *
 * `pipelineName`, `sourceType`, `outputFormats` and `autoApprove` are not
 * restated here — they are taken from `PipelineConfig`
 * (lib/repurpose/types.ts:27), which is the module's declared shape for a
 * pipeline definition. It had been written, exported, and then never referenced
 * by anything, while this signature spelled the same four fields out again; two
 * declarations of one contract drift the moment either is edited, which is what
 * CLAUDE.md §6 rules out.
 *
 * `id` is omitted because this call CREATES the row. `brandVoiceOverride` and
 * `hashtagPresets` are omitted deliberately and the omission is the finding, not
 * an oversight: the repurpose dashboard's `Pipeline.output_config` type declares
 * `brand_voice_override` and `hashtag_presets`, and NOTHING in this file writes
 * either — the insert below stores only `formats`, `sourceId`, `autoApprove` and
 * an optional `sourceUrl`. Accepting them here would fabricate a wire that ends
 * nowhere; naming them in the Omit records that the reader has no writer yet.
 *
 * On `autoApprove`: "Skip manual review for generated content" — the switch on
 * the Create Pipeline dialog. It was collected and never sent: repurpose_pipelines
 * has no such column (verified live), and the client did not pass it either, so
 * the toggle governed nothing and every output landed in pending_review
 * regardless. It is carried in output_config, which already holds the pipeline's
 * other settings, rather than growing the table for one boolean.
 */
export async function createRepurposePipeline(
  params: Omit<PipelineConfig, "id" | "brandVoiceOverride" | "hashtagPresets"> & {
    sourceId: string
    brokerageId: string
    agentUserId?: string
    teamId?: string
    /** External source video URL (used by the video_url source type). */
    sourceUrl?: string
  },
): Promise<SavePipelineResult> {
  try {
    const agentContext = await getAgentContext()
    const { userId, brokerageId: contextBrokerageId } = agentContext

    // ── Kernel Gate: canAccessFeature ──
    const access = await canAccessFeature(userId, "omnipresence_repurposer")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const supabase = await createClient()

    // Create pipeline record
    const { data: pipeline, error } = await supabase
      .from("repurpose_pipelines")
      .insert({
        brokerage_id: params.brokerageId || contextBrokerageId,
        agent_user_id: params.agentUserId || userId,
        team_id: params.teamId,
        pipeline_name: params.pipelineName,
        source_type: params.sourceType,
        output_config: {
          formats: params.outputFormats,
          sourceId: params.sourceId,
          autoApprove: params.autoApprove === true,
          ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
        },
        is_active: true,
        created_by: userId,
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    // ── Increment feature usage ──
    await incrementFeatureUsage(userId, "omnipresence_repurposer")

    revalidatePath("/dashboard/campaigns/repurpose")

    return { success: true, pipelineId: pipeline.id }
  } catch (error: any) {
    console.error("[Pipeline] Create error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. EXECUTE REPURPOSE PIPELINE WITH KERNEL WIRING
// ═══════════════════════════════════════════════════════════════════════════════
export async function executePipeline(params: {
  pipelineId: string
  brokerageId: string
  /** The content the user picked on the Execute tab. Optional so a programmatic
   *  run can still fall back to the pipeline's stored source. */
  sourceType?: SourceType
  sourceId?: string
}): Promise<ExecutePipelineResult> {
  try {
    const agentContext = await getAgentContext()
    const { userId, brokerageId: contextBrokerageId } = agentContext

    // ── Kernel Gate: canAccessFeature ──
    const access = await canAccessFeature(userId, "omnipresence_repurposer")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available", blockedReason: "Access denied" }
    }

    // Tenant scope is derived from the session, never trusted from the client.
    const brokerageId = contextBrokerageId || params.brokerageId
    if (!brokerageId) {
      return { success: false, error: "No brokerage context" }
    }

    const supabase = await createClient()

    // Get pipeline
    const { data: pipeline } = await supabase
      .from("repurpose_pipelines")
      .select("*")
      .eq("id", params.pipelineId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (!pipeline) {
      return { success: false, error: "Pipeline not found" }
    }

    await supabase
      .from("repurpose_pipelines")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", params.pipelineId)

    // ── Fire kernel event: OMNIPRESENCE_PIPELINE_STARTED ──
    await processKernelEvent({
      event: KernelEvent.OMNIPRESENCE_PIPELINE_STARTED,
      brokerageId,
      entityType: "repurpose_pipeline",
      entityId: params.pipelineId,
    }).catch(err => console.error("[Pipeline] Event failed:", err))

    // The user's selection wins; the pipeline's stored source is the fallback
    // for a programmatic run.
    const runSourceType: SourceType = (params.sourceType ?? pipeline.source_type) as SourceType
    const storedUrl: string | null = pipeline.output_config?.sourceUrl ?? null
    const rawSourceId: string = params.sourceId ?? pipeline.output_config?.sourceId ?? ""

    // REFUSE rather than generate type-only filler. A run with no resolvable
    // source used to produce captions about nothing and schedule them to real
    // social accounts, reporting "Pipeline executed successfully!".
    if (!isValidUUID(rawSourceId) && !storedUrl) {
      return { success: false, error: "Pick the content to repurpose — this run had no source." }
    }

    const source = isValidUUID(rawSourceId)
      ? await loadRepurposeSource(supabase, brokerageId, runSourceType, rawSourceId)
      : null
    if (isValidUUID(rawSourceId) && !source) {
      return { success: false, error: "That source content was not found in your brokerage." }
    }

    const sourceUrl: string | null = source?.mediaUrl ?? storedUrl
    const sourceText: string | null = source?.body ?? null
    // repurposed_content_log.source_id is NOT NULL. Use the original content row
    // id when present, otherwise the pipeline id (links the log back to this run).
    const sourceId: string = isValidUUID(rawSourceId) ? rawSourceId : params.pipelineId
    const sourceLabel = source?.title
      ? `"${source.title}"`
      : `this ${runSourceType.replace(/_/g, " ")}`

    // Load the agent's branding so the AI rewrites copy in their voice, and the
    // set of connected social accounts so each platform routes to a real channel.
    const [branding, { data: accountRows }] = await Promise.all([
      loadAgentBranding(supabase, userId, brokerageId),
      supabase
        .from("social_media_accounts")
        .select("id, platform")
        .eq("brokerage_id", brokerageId)
        .eq("is_active", true),
    ])
    const accountByPlatform = new Map<string, string>()
    for (const a of accountRows ?? []) {
      if (!accountByPlatform.has(a.platform)) accountByPlatform.set(a.platform, a.id)
    }

    const outputs: RepurposedOutput[] = []

    // Generate platform-tailored copy for each output format, then distribute
    // the source video to every connected social channel (omnipresence).
    for (const format of (pipeline.output_config?.formats ?? [])) {
      try {
        const config = OUTPUT_FORMAT_CONFIG[format as OutputFormat]
        if (!config) continue

        const aiResponse = await generateAIResponse({
          prompt: buildRepurposePrompt({ format: format as OutputFormat, sourceUrl, sourceLabel, sourceText, branding }),
          maxTokens: 500,
          metadata: { userId, brokerageId, feature: "video_script_generation" },
        })
        const generatedContent = (aiResponse.text ?? "").trim()
        if (!generatedContent) {
          outputs.push({ outputType: format, outputRefTable: config.outputTable, outputRefId: "", platform: config.platform, contentPreview: "AI returned no content", status: "failed" })
          continue
        }

        const isDistributable = DISTRIBUTABLE_PLATFORMS.has(config.platform)

        if (isDistributable) {
          // Distribute via the canonical poster — it runs brand voice + compliance,
          // verifies account ownership, and schedules the real social_posts row.
          const accountId = accountByPlatform.get(config.platform)
          if (!accountId) {
            outputs.push({ outputType: format, outputRefTable: "social_posts", outputRefId: "", platform: config.platform, contentPreview: `No connected ${config.platform} account`, status: "skipped" })
            await logRepurpose(supabase, { brokerageId, sourceType: runSourceType, sourceId, outputType: format, outputRefTable: null, outputRefId: null, platformTarget: config.platform, status: "generated", approvalStatus: "draft", notes: `Generated but not distributed — no connected ${config.platform} account`, createdBy: userId })
            continue
          }

          const scheduled = await scheduleSocialPost({
            platform: config.platform,
            postType: "custom",
            content: generatedContent,
            mediaUrls: sourceUrl ? [sourceUrl] : undefined,
            hashtags: extractHashtags(generatedContent),
            scheduledFor: new Date().toISOString(),
            socialAccountId: accountId,
          })

          if (!scheduled.success || !scheduled.data?.id) {
            outputs.push({ outputType: format, outputRefTable: "social_posts", outputRefId: "", platform: config.platform, contentPreview: scheduled.error ?? "Failed to schedule", status: "failed" })
            await logRepurpose(supabase, { brokerageId, sourceType: runSourceType, sourceId, outputType: format, outputRefTable: null, outputRefId: null, platformTarget: config.platform, status: "failed", approvalStatus: "rejected", notes: scheduled.error ?? "Failed to schedule", createdBy: userId })
            continue
          }

          await logRepurpose(supabase, { brokerageId, sourceType: runSourceType, sourceId, outputType: format, outputRefTable: "social_posts", outputRefId: scheduled.data.id, platformTarget: config.platform, status: "scheduled", approvalStatus: "approved", notes: generatedContent, createdBy: userId })
          outputs.push({ outputType: format, outputRefTable: "social_posts", outputRefId: scheduled.data.id, platform: config.platform, contentPreview: generatedContent.substring(0, 100), status: "scheduled" })
          continue
        }

        // Non-distributable formats (email/blog/quote graphic): run the brand voice
        // + compliance gates and log the generated copy. No auto-distribution backend.
        const brandResult = await applyKernelBrandVoice({
          brokerageId, actorUserId: userId, actorRole: "agent",
          journeyType: "marketing", persona: "seller", messageType: "social", content: generatedContent,
        })
        if (isBrandVoiceBlocked(brandResult)) {
          outputs.push({ outputType: format, outputRefTable: config.outputTable, outputRefId: "", platform: config.platform, contentPreview: "Brand voice violation", status: "rejected" })
          continue
        }
        const complianceResult = await evaluateKernelOutbound({
          actorContext: { userId, role: "agent", brokerageId },
          journeyType: "marketing", persona: "seller", messageType: "social", content: generatedContent,
          contact: { id: userId, status: "active" },
        })
        if (isComplianceBlocked(complianceResult)) {
          outputs.push({ outputType: format, outputRefTable: config.outputTable, outputRefId: "", platform: config.platform, contentPreview: "Compliance violation", status: "rejected" })
          continue
        }
        // THE READ SIDE OF THE AUTO-APPROVE SWITCH. Both literals are in the
        // live approval_status CHECK — nothing is widened. Compliance still
        // gates above: auto-approve skips the human review queue, never the
        // compliance evaluation.
        const autoApprove = pipeline.output_config?.autoApprove === true
        await logRepurpose(supabase, { brokerageId, sourceType: runSourceType, sourceId, outputType: format, outputRefTable: config.outputTable, outputRefId: null, platformTarget: config.platform, status: "generated", approvalStatus: autoApprove ? "approved" : "pending_review", notes: generatedContent, createdBy: userId })
        outputs.push({ outputType: format, outputRefTable: config.outputTable, outputRefId: "", platform: config.platform, contentPreview: generatedContent.substring(0, 100), status: autoApprove ? "approved" : "pending" })
      } catch (err) {
        console.error(`[Pipeline] Error generating ${format}:`, err)
      }
    }

    await supabase
      .from("repurpose_pipelines")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", params.pipelineId)

    // ── Fire kernel event: OMNIPRESENCE_PIPELINE_COMPLETED ──
    await processKernelEvent({
      event: KernelEvent.OMNIPRESENCE_PIPELINE_COMPLETED,
      brokerageId,
      entityType: "repurpose_pipeline",
      entityId: params.pipelineId,
    }).catch(err => console.error("[Pipeline] Event failed:", err))

    // ── Increment feature usage ──
    await incrementFeatureUsage(userId, "omnipresence_repurposer")

    revalidatePath("/dashboard/campaigns/repurpose")

    return { success: true, pipelineId: params.pipelineId, outputs }
  } catch (error: any) {
    console.error("[Pipeline] Execute error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. GET PIPELINES
// ═══════════════════════════════════════════════════════════════════════════════
export async function getPipelines(brokerageId: string) {
  try {
    const agentContext = await getAgentContext()
    const supabase = await createClient()

    const { data: pipelines, error } = await supabase
      .from("repurpose_pipelines")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) throw error

    return { success: true, pipelines: pipelines || [] }
  } catch (error: any) {
    console.error("[Pipeline] Get error:", error)
    return { success: false, error: error.message, pipelines: [] }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. GET REPURPOSE HISTORY
// ═══════════════════════════════════════════════════════════════════════════════
export async function getRepurposeHistory(brokerageId: string) {
  try {
    const supabase = await createClient()

    const { data: history, error } = await supabase
      .from("repurposed_content_log")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(100)

    if (error) throw error

    return { success: true, history: history || [] }
  } catch (error: any) {
    console.error("[Pipeline] History error:", error)
    return { success: false, error: error.message, history: [] }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. TOGGLE PIPELINE ACTIVE STATUS
// ═══════════════════════════════════════════════════════════════════════════════
export async function togglePipelineActive(
  userId: string,
  pipelineId: string,
  brokerageId: string,
  isActive: boolean
) {
  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from("repurpose_pipelines")
      .update({ is_active: isActive })
      .eq("id", pipelineId)
      .eq("agent_user_id", userId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    revalidatePath("/dashboard/campaigns/repurpose")

    return { success: true }
  } catch (error: any) {
    console.error("[Pipeline] Toggle error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. DELETE PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════
export async function deletePipeline(userId: string, pipelineId: string, brokerageId: string) {
  try {
    const supabase = await createClient()

    // repurposed_content_log entries are historical (and may reference live
    // scheduled posts), so they are intentionally retained — they are not keyed
    // to a pipeline. Delete only the pipeline definition.
    const { error } = await supabase
      .from("repurpose_pipelines")
      .delete()
      .eq("id", pipelineId)
      .eq("agent_user_id", userId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    revalidatePath("/dashboard/campaigns/repurpose")

    return { success: true }
  } catch (error: any) {
    console.error("[Pipeline] Delete error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. REPURPOSE A VIDEO URL (ad-hoc omnipresence run)
// ═══════════════════════════════════════════════════════════════════════════════
// Owner flow: paste a source video URL → AI rewrites platform-tailored copy in
// the agent's voice → the video is scheduled to each connected social channel.
// Reuses createRepurposePipeline + executePipeline so there is one engine.
export async function repurposeVideoUrl(params: {
  sourceUrl: string
  outputFormats: OutputFormat[]
  pipelineName?: string
}): Promise<ExecutePipelineResult> {
  const url = params.sourceUrl?.trim()
  if (!url || !/^https?:\/\/\S+$/i.test(url)) {
    return { success: false, error: "Enter a valid http(s) video URL" }
  }
  if (!params.outputFormats?.length) {
    return { success: false, error: "Select at least one channel" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  const created = await createRepurposePipeline({
    pipelineName: params.pipelineName?.trim() || `Video URL repurpose ${new Date().toISOString().slice(0, 10)}`,
    sourceType: "video_url",
    sourceId: "",
    sourceUrl: url,
    outputFormats: params.outputFormats,
    brokerageId: ctx.brokerageId,
  })
  if (!created.success || !created.pipelineId) {
    return { success: false, error: created.error ?? "Could not create repurpose run" }
  }

  return executePipeline({ pipelineId: created.pipelineId, brokerageId: ctx.brokerageId })
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. REPURPOSE A VIDEO URL INTO A NEW BRANDED VIDEO (omnipresence, async)
// ═══════════════════════════════════════════════════════════════════════════════
// Flow: paste video URL → transcript (Whisper on a direct media file, else a
// pasted transcript) → AI rewrites it into the agent's branded short script →
// create an ai_video_projects row → return the D-ID payload for the client to
// kick off generation. Generation is async; when the poll-did-videos cron sets
// video_url, the completion handler drafts per-channel social posts for review
// (see lib/repurpose/distribute.ts, wired in app/actions/video-content.ts).

function buildVideoScriptPrompt(args: { transcript: string; branding: AgentBranding }): string {
  return [
    `Rewrite the following transcript into a punchy ~150-word first-person video script for real estate agent ${args.branding.agentName}` +
      (args.branding.brokerageName ? ` of ${args.branding.brokerageName}` : "") + ".",
    `Match a warm, professional brand voice, open with a hook, and end with a clear call to action.`,
    `Do NOT invent specific properties, prices, or guarantees. Follow fair-housing rules (no language about protected classes).`,
    `Return ONLY the spoken script text, no headings or stage directions.`,
    `Transcript:\n${args.transcript.slice(0, 6000)}`,
  ].join(" ")
}

export interface RepurposeToVideoResult {
  success: boolean
  projectId?: string
  status?: "generating"
  /** Client posts this to /api/did/generate-video to start the render. */
  didPayload?: {
    video_project_id: string
    script: string
    elevenlabs_voice_id: string
    did_avatar_id?: string
    agent_photo_url?: string | null
    agent_video_url?: string | null
    intro_video_url?: string
    outro_video_url?: string
  }
  needsSetup?: "social" | "voice"
  needsTranscript?: boolean
  redirectTo?: string
  error?: string
}

export async function repurposeUrlToBrandedVideo(input: {
  sourceUrl: string
  transcript?: string
  channels: OutputFormat[]
  title?: string
}): Promise<RepurposeToVideoResult> {
  const url = input.sourceUrl?.trim()
  if (!url || !/^https?:\/\/\S+$/i.test(url)) {
    return { success: false, error: "Enter a valid http(s) video URL" }
  }
  if (!input.channels?.length) {
    return { success: false, error: "Select at least one channel" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.agentId) {
    return { success: false, error: "Not authenticated" }
  }

  const access = await canAccessFeature(ctx.userId, "omnipresence_repurposer")
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Feature not available" }
  }

  // Gate A — must have at least one connected social account.
  const accounts = await getConnectedAccounts(ctx.agentId)
  if (accounts.length === 0) {
    return { success: false, needsSetup: "social", redirectTo: "/settings/integrations", error: "Connect a social account before repurposing." }
  }

  const supabase = await createClient()

  // Gate B — must have a voice clone + an avatar source (D-ID hard-fails otherwise).
  const { data: voice } = await supabase
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_avatar_id, did_video_url, did_photo_url")
    .eq("agent_id", ctx.agentId)
    .eq("brokerage_id", ctx.brokerageId)
    .order("is_default", { ascending: false })
    .limit(1)
    .maybeSingle()
  const avatarSource = voice?.did_avatar_id || voice?.did_video_url || voice?.did_photo_url
  if (!voice?.elevenlabs_voice_id || !avatarSource) {
    return { success: false, needsSetup: "voice", redirectTo: "/dashboard/videos/voice", error: "Set up your voice clone and avatar before generating videos." }
  }

  // Transcript: a pasted transcript wins; otherwise transcribe a direct media file.
  let transcript = input.transcript?.trim() ?? ""
  if (!transcript) {
    const t = await transcribeFromUrl(url)
    if (!t.success) {
      const hint = t.reason === "not_media"
        ? "Couldn't read that link automatically (e.g. a YouTube page). Paste the transcript to continue."
        : `Couldn't transcribe the video (${t.message}). Paste the transcript to continue.`
      return { success: false, needsTranscript: true, error: hint }
    }
    transcript = t.transcript
  }

  // Rewrite into a branded script, then run the brand-voice + compliance gates.
  const branding = await loadAgentBranding(supabase, ctx.userId, ctx.brokerageId)
  const scriptResp = await generateAIResponse({
    prompt: buildVideoScriptPrompt({ transcript, branding }),
    maxTokens: 600,
    metadata: { userId: ctx.userId, brokerageId: ctx.brokerageId, feature: "video_script_generation" },
  })
  const script = (scriptResp.text ?? "").trim()
  if (!script) {
    return { success: false, error: "Could not generate a script from the transcript" }
  }

  const brand = await applyKernelBrandVoice({
    brokerageId: ctx.brokerageId, actorUserId: ctx.userId, actorRole: "agent",
    journeyType: "marketing", persona: "seller", messageType: "social", content: script,
  })
  if (isBrandVoiceBlocked(brand)) {
    return { success: false, error: "Generated script violates brand voice — try a different source." }
  }
  const comp = await evaluateKernelOutbound({
    actorContext: { userId: ctx.userId, role: "agent", brokerageId: ctx.brokerageId },
    journeyType: "marketing", persona: "seller", messageType: "social", content: script,
    contact: { id: ctx.userId, status: "active" },
  })
  if (isComplianceBlocked(comp)) {
    return { success: false, error: "Generated script failed a compliance check." }
  }

  // Create the video project (draft) — generation is kicked off client-side.
  // NOTE: ai_video_projects.agent_id FKs to users.id (not agents.id), matching
  // the existing create flow which passes the user id.
  const created = await createVideoProject({
    brokerageId: ctx.brokerageId,
    agentUserId: ctx.userId,
    title: input.title?.trim() || `Repurposed video ${new Date().toISOString().slice(0, 10)}`,
    script,
    videoType: "social_reel",
    backgroundType: "solid",
    backgroundColorHex: "#ffffff",
    format: "vertical",
    durationSeconds: 60,
    captionsEnabled: true,
  })
  if (!created.success || !created.project) {
    return { success: false, error: created.error ?? "Could not create the video project" }
  }
  const projectId = created.project.id

  // Persist the distribution intent so the completion hook drafts per-channel posts.
  await supabase
    .from("ai_video_projects")
    .update({
      video_metadata: {
        ...((created.project as { video_metadata?: Record<string, unknown> }).video_metadata ?? {}),
        repurpose: { channels: input.channels, source_url: url, distribute_as_draft: true },
      },
    })
    .eq("id", projectId)

  // Intro/outro stock clips (applied by the poll cron via ffmpeg concat). Optional.
  const { data: clips } = await supabase
    .from("video_assets")
    .select("video_url, category")
    .eq("brokerage_id", ctx.brokerageId)
    .in("category", ["intro", "outro"])
    .order("created_at", { ascending: false })
    .limit(10)
  const introUrl = clips?.find((c) => c.category === "intro")?.video_url ?? null
  const outroUrl = clips?.find((c) => c.category === "outro")?.video_url ?? null

  return {
    success: true,
    projectId,
    status: "generating",
    didPayload: {
      video_project_id: projectId,
      script,
      elevenlabs_voice_id: voice.elevenlabs_voice_id,
      ...(voice.did_avatar_id ? { did_avatar_id: voice.did_avatar_id } : {}),
      agent_photo_url: voice.did_avatar_id ? null : voice.did_photo_url ?? null,
      agent_video_url: voice.did_avatar_id ? null : voice.did_video_url ?? null,
      ...(introUrl ? { intro_video_url: introUrl } : {}),
      ...(outroUrl ? { outro_video_url: outroUrl } : {}),
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. "NO VIDEO" OUTPUT MODES — repurpose a URL into a blog post or a podcast
// ═══════════════════════════════════════════════════════════════════════════════

// Shared: pasted transcript wins; otherwise transcribe a direct media file.
async function acquireTranscript(
  url: string,
  pasted?: string,
): Promise<{ ok: true; transcript: string } | { ok: false; error: string }> {
  const t = pasted?.trim()
  if (t) return { ok: true, transcript: t }
  const r = await transcribeFromUrl(url)
  if (!r.success) {
    const hint = r.reason === "not_media"
      ? "Couldn't read that link automatically (e.g. a YouTube page). Paste the transcript to continue."
      : `Couldn't transcribe the video (${r.message}). Paste the transcript to continue.`
    return { ok: false, error: hint }
  }
  return { ok: true, transcript: r.transcript }
}

export interface RepurposeBlogResult {
  success: boolean
  postId?: string
  needsTranscript?: boolean
  error?: string
}

export async function repurposeUrlToBlogPost(input: {
  sourceUrl: string
  transcript?: string
  title?: string
}): Promise<RepurposeBlogResult> {
  const url = input.sourceUrl?.trim()
  if (!url || !/^https?:\/\/\S+$/i.test(url)) return { success: false, error: "Enter a valid http(s) video URL" }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const tr = await acquireTranscript(url, input.transcript)
  if (!tr.ok) return { success: false, needsTranscript: true, error: tr.error }

  // Derive a few SEO keywords from the transcript (blog generator needs them).
  let keywords: string[] = []
  try {
    const kw = await generateAIResponse({
      prompt: `Extract 3-5 concise SEO keywords (comma-separated, no # symbols) for a real estate blog post based on this transcript:\n${tr.transcript.slice(0, 3000)}`,
      maxTokens: 60,
      metadata: { userId: ctx.userId, brokerageId: ctx.brokerageId, feature: "blog_post_generation" },
    })
    keywords = Array.from(
      new Set((kw.text ?? "").split(",").map((s) => s.trim().replace(/^#+/, "")).filter(Boolean)),
    ).slice(0, 5)
  } catch {
    /* fall back below */
  }
  if (keywords.length === 0) keywords = ["real estate"]

  const res = await generateBlogPost(ctx.userId, {
    brokerageId: ctx.brokerageId,
    agentUserId: ctx.userId,
    title: input.title?.trim() || undefined,
    keywords,
    sourceContent: tr.transcript,
    generateCoverImage: true,
  })
  return { success: res.success, postId: res.postId, error: res.error }
}

export interface RepurposePodcastResult {
  success: boolean
  episodeId?: string
  needsTranscript?: boolean
  error?: string
}

export async function repurposeUrlToPodcast(input: {
  sourceUrl: string
  transcript?: string
  title?: string
}): Promise<RepurposePodcastResult> {
  const url = input.sourceUrl?.trim()
  if (!url || !/^https?:\/\/\S+$/i.test(url)) return { success: false, error: "Enter a valid http(s) video URL" }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const tr = await acquireTranscript(url, input.transcript)
  if (!tr.ok) return { success: false, needsTranscript: true, error: tr.error }

  // Rewrite the transcript into a branded first-person podcast monologue.
  const supabase = await createClient()
  const branding = await loadAgentBranding(supabase, ctx.userId, ctx.brokerageId)
  const scriptResp = await generateAIResponse({
    prompt:
      `Rewrite this transcript into a natural ~2-minute first-person podcast monologue script for real estate agent ${branding.agentName}` +
      (branding.brokerageName ? ` of ${branding.brokerageName}` : "") +
      `. Conversational and engaging, no stage directions or headings, fair-housing safe (no language about protected classes), and avoid inventing specific properties/prices.\nTranscript:\n${tr.transcript.slice(0, 6000)}`,
    maxTokens: 900,
    metadata: { userId: ctx.userId, brokerageId: ctx.brokerageId, feature: "podcast_generation" },
  })
  const script = (scriptResp.text ?? "").trim()
  if (!script) return { success: false, error: "Could not generate a podcast script" }

  const created = await createPodcastEpisode({
    title: input.title?.trim() || `Repurposed episode ${new Date().toISOString().slice(0, 10)}`,
    script,
    category: "market_update",
  })
  if (!created.success || !created.episode?.id) {
    return { success: false, error: created.error ?? "Could not create the podcast episode" }
  }

  // Render the audio (TTS → storage). The episode exists even if audio fails
  // (e.g. the agent hasn't set up a voice clone yet).
  const audio = await generatePodcastAudio(created.episode.id).catch(() => null)
  return {
    success: true,
    episodeId: created.episode.id,
    error: audio && !audio.success ? audio.error : undefined,
  }
}
