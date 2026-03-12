"use server"

// lib/repurpose/actions.ts
// Server actions for Layer 9.11 Omnipresence Repurposer Pipeline
// All async functions with full kernel wiring

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { generateAIResponse } from "@/lib/ai"
import { getAgentContext } from "@/lib/identity/get-agent-context"
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
        source_content_id: params.sourceId,
        output_formats: params.outputFormats,
        status: "draft",
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

    const supabase = await createClient()

    // Get pipeline
    const { data: pipeline } = await supabase
      .from("repurpose_pipelines")
      .select("*")
      .eq("id", params.pipelineId)
      .eq("brokerage_id", params.brokerageId)
      .single()

    if (!pipeline) {
      return { success: false, error: "Pipeline not found" }
    }

    // Update pipeline status to processing
    await supabase
      .from("repurpose_pipelines")
      .update({ status: "processing", started_at: new Date().toISOString() })
      .eq("id", params.pipelineId)

    // ── Fire kernel event: OMNIPRESENCE_PIPELINE_STARTED ──
    await processKernelEvent({
      event: KernelEvent.OMNIPRESENCE_PIPELINE_STARTED,
      brokerageId: params.brokerageId,
      entityType: "repurpose_pipeline",
      entityId: params.pipelineId,
    }).catch(err => console.error("[Pipeline] Event failed:", err))

    const outputs: RepurposedOutput[] = []

    // Generate content for each output format
    for (const format of pipeline.output_formats) {
      try {
        const config = OUTPUT_FORMAT_CONFIG[format]
        
        // Generate platform-specific content using AI
        const aiResponse = await generateAIResponse({
          prompt: `Create a ${config.displayName} post based on: ${pipeline.source_content_id}`,
          maxTokens: 500,
          metadata: {
            userId,
            brokerageId: params.brokerageId,
            feature: "video_script_generation",
          },
        })
        const generatedContent = aiResponse.text

        // ── Apply brand voice ──
        const brandResult = await applyBrandVoice({
          brokerageId: params.brokerageId,
          actorUserId: userId,
          actorRole: "agent",
          journeyType: "marketing",
          persona: "seller",
          messageType: "social",
          content: generatedContent,
        })

        if (brandResult.violations.length > 0) {
          outputs.push({
            outputType: format,
            outputRefTable: config.outputTable,
            outputRefId: "rejected",
            platform: config.platform,
            contentPreview: "Brand voice violation",
            status: "rejected",
          })
          continue
        }

        // ── Evaluate outbound compliance ──
        const complianceResult = await evaluateOutbound({
          actorContext: { userId, brokerageId: params.brokerageId },
          journeyType: "marketing",
          persona: "seller",
          messageType: "social",
          content: generatedContent,
          contact: { id: userId, status: "active" as const },
        })

        if (!complianceResult.allowed) {
          outputs.push({
            outputType: format,
            outputRefTable: config.outputTable,
            outputRefId: "rejected",
            platform: config.platform,
            contentPreview: "Compliance violation",
            status: "rejected",
          })
          continue
        }

        // Save repurposed content
        const { data: repurposed } = await supabase
          .from("repurposed_content_log")
          .insert({
            brokerage_id: params.brokerageId,
            pipeline_id: params.pipelineId,
            source_content_id: pipeline.source_content_id,
            source_content_type: pipeline.source_type,
            output_format: format,
            distribution_channel: config.platform,
            generated_content: generatedContent,
            status: "pending_approval",
            created_at: new Date().toISOString(),
          })
          .select()
          .single()

        outputs.push({
          outputType: format,
          outputRefTable: config.outputTable,
          outputRefId: repurposed?.id || "",
          platform: config.platform,
          contentPreview: generatedContent.substring(0, 100),
          status: "pending",
        })
      } catch (err) {
        console.error(`[Pipeline] Error generating ${format}:`, err)
      }
    }

    // Update pipeline to completed
    await supabase
      .from("repurpose_pipelines")
      .update({ 
        status: "completed", 
        completed_at: new Date().toISOString(),
        output_count: outputs.length,
      })
      .eq("id", params.pipelineId)

    // ── Fire kernel event: OMNIPRESENCE_PIPELINE_COMPLETED ──
    await processKernelEvent({
      event: KernelEvent.OMNIPRESENCE_PIPELINE_COMPLETED,
      brokerageId: params.brokerageId,
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

    // Delete associated repurposed content
    await supabase
      .from("repurposed_content_log")
      .delete()
      .eq("pipeline_id", pipelineId)

    // Delete pipeline
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
