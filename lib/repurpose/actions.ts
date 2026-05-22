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
import { scheduleSocialPost } from "@/app/actions/social-media-automation"
import type {
  SourceType,
  OutputFormat,
  PipelineConfig,
  PipelineExecution,
  RepurposedOutput,
  ExecutePipelineResult,
  SavePipelineResult
} from "@/lib/repurpose/types"
import { OUTPUT_FORMAT_CONFIG } from "@/lib/repurpose/types"

// Platforms accepted by social_posts.platform CHECK constraint — only these can
// be auto-distributed. Other output formats (email/blog/quote_graphic) generate
// copy but have no distribution backend yet.
const DISTRIBUTABLE_PLATFORMS = new Set(["facebook", "instagram", "linkedin", "twitter", "tiktok", "youtube", "pinterest"])

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

function buildRepurposePrompt(args: {
  format: OutputFormat
  sourceUrl: string | null
  sourceLabel: string
  branding: AgentBranding
}): string {
  const cfg = OUTPUT_FORMAT_CONFIG[args.format]
  const limit = cfg.maxLength ? `Keep it under ${cfg.maxLength} characters.` : "Keep it concise and platform-native."
  const aspect = cfg.aspectRatio ? ` The source video is intended for a ${cfg.aspectRatio} ${cfg.displayName} format.` : ""
  const source = args.sourceUrl ? `the video at ${args.sourceUrl}` : args.sourceLabel
  return [
    `You are writing a ${cfg.displayName} caption for real estate agent ${args.branding.agentName}` +
      (args.branding.brokerageName ? ` of ${args.branding.brokerageName}` : "") + ".",
    `Repurpose ${source} into a platform-native ${cfg.displayName} caption.${aspect}`,
    `Write in the agent's first-person voice, add a clear call to action, and include a few relevant, non-discriminatory hashtags.`,
    `Do NOT make claims about specific properties, prices, or guarantees. Follow fair-housing rules.`,
    limit,
  ].join(" ")
}

function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\p{L}0-9_]+/gu) ?? []
  return Array.from(new Set(matches.map((h) => h.slice(1)))).slice(0, 15)
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
export async function createRepurposePipeline(params: {
  pipelineName: string
  sourceType: SourceType
  sourceId: string
  outputFormats: OutputFormat[]
  brokerageId: string
  agentUserId?: string
  teamId?: string
  /** External source video URL (used by the video_url source type). */
  sourceUrl?: string
}): Promise<SavePipelineResult> {
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

    const sourceUrl: string | null = pipeline.output_config?.sourceUrl ?? null
    const rawSourceId: string = pipeline.output_config?.sourceId ?? ""
    // repurposed_content_log.source_id is NOT NULL. Use the original content row
    // id when present, otherwise the pipeline id (links the log back to this run).
    const sourceId: string = isValidUUID(rawSourceId) ? rawSourceId : params.pipelineId
    const sourceLabel = `this ${pipeline.source_type.replace(/_/g, " ")}`

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
          prompt: buildRepurposePrompt({ format: format as OutputFormat, sourceUrl, sourceLabel, branding }),
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
            await logRepurpose(supabase, { brokerageId, sourceType: pipeline.source_type, sourceId, outputType: format, outputRefTable: null, outputRefId: null, platformTarget: config.platform, status: "generated", approvalStatus: "draft", notes: `Generated but not distributed — no connected ${config.platform} account`, createdBy: userId })
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
            await logRepurpose(supabase, { brokerageId, sourceType: pipeline.source_type, sourceId, outputType: format, outputRefTable: null, outputRefId: null, platformTarget: config.platform, status: "failed", approvalStatus: "rejected", notes: scheduled.error ?? "Failed to schedule", createdBy: userId })
            continue
          }

          await logRepurpose(supabase, { brokerageId, sourceType: pipeline.source_type, sourceId, outputType: format, outputRefTable: "social_posts", outputRefId: scheduled.data.id, platformTarget: config.platform, status: "scheduled", approvalStatus: "approved", notes: generatedContent, createdBy: userId })
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
        await logRepurpose(supabase, { brokerageId, sourceType: pipeline.source_type, sourceId, outputType: format, outputRefTable: config.outputTable, outputRefId: null, platformTarget: config.platform, status: "generated", approvalStatus: "pending_review", notes: generatedContent, createdBy: userId })
        outputs.push({ outputType: format, outputRefTable: config.outputTable, outputRefId: "", platform: config.platform, contentPreview: generatedContent.substring(0, 100), status: "pending" })
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
