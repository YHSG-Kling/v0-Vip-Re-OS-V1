"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateAIResponse } from "@/lib/ai"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { buildComplianceSystemBlocks, postcheckScript } from "@/lib/video/script-compliance"

// Every function in this file used to be unauthenticated. Caller could
// generate AI video scripts attributed to any organization (burning AI
// budget), check/update/delete any video by id, and pull any user's
// video queue. Now: session is required + organization ownership is
// verified.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

// Verify the (organizationId, organizationType) refers to caller's brokerage
// (or a team within caller's brokerage). Returns ok on success.
async function verifyOrgAccess(
  organizationId: string,
  organizationType: "brokerage" | "team",
  callerBrokerageId: string,
): Promise<boolean> {
  const svc = createServiceClient()
  if (organizationType === "brokerage") {
    return organizationId === callerBrokerageId
  }
  // team — must belong to caller's brokerage
  const { data: team } = await svc
    .from("teams")
    .select("brokerage_id")
    .eq("id", organizationId)
    .maybeSingle()
  return !!team && team.brokerage_id === callerBrokerageId
}

// Helper: verify the video belongs to caller's brokerage
async function verifyVideoAccess(videoQueueId: string, callerBrokerageId: string): Promise<
  | { ok: true; video: { id: string; organization_id: string; organization_type: string; user_id: string } }
  | { ok: false }
> {
  const svc = createServiceClient()
  const { data: video } = await svc
    .from("video_generation_queue")
    .select("id, organization_id, organization_type, user_id")
    .eq("id", videoQueueId)
    .maybeSingle()
  if (!video) return { ok: false }
  const allowed = await verifyOrgAccess(
    video.organization_id as string,
    video.organization_type as "brokerage" | "team",
    callerBrokerageId,
  )
  if (!allowed) return { ok: false }
  return { ok: true, video: video as any }
}

// Generate AI script from URL
export async function generateVideoScript(params: {
  url: string
  contentCategory: string
  organizationId: string
  organizationType: "brokerage" | "team"
  userId?: string  // ignored — derived from session
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!(await verifyOrgAccess(params.organizationId, params.organizationType, auth.brokerageId))) {
    return { success: false, error: "Forbidden" }
  }

  const supabase = createServiceClient()

  try {
    // Fetch organization compliance rules
    const { data: org } = await supabase
      .from(params.organizationType === "brokerage" ? "brokerages" : "teams")
      .select("compliance_rules")
      .eq("id", params.organizationId)
      .single()

    if (!org) throw new Error("Organization not found")

    // Brand voice + ThemFirst + Fair Housing, injected proactively — the same
    // blocks the /dashboard/videos/create wizard uses. This path had the
    // bespoke checkCompliance() pass below but nothing that told the model
    // what the brokerage's voice is, so it generated off-brand copy and then
    // graded it.
    const complianceBlocks = await buildComplianceSystemBlocks(auth.brokerageId)

    // Use AI to generate script from URL content
    const response = await generateAIResponse({
      system: complianceBlocks.join("\n\n"),
      prompt: `Create a 75-word engaging voiceover script for a ${params.contentCategory} video based on this URL: ${params.url}

Requirements:
- Professional yet conversational tone
- Follow real estate compliance: no discriminatory language
- Include required disclaimers: ${org?.compliance_rules?.required_disclaimers?.join(", ") || "Licensed Real Estate Agent"}
- Focus on benefits and features
- Make it compelling for social media

Return ONLY the script text, no formatting or labels.`,
      metadata: {
        userId: auth.userId,
        brokerageId: auth.brokerageId,
        feature: "video_script_generation",
      },
    })

    // Create video queue entry — stamp user_id + organization from session/verified params
    const { data: videoQueue, error } = await supabase
      .from("video_generation_queue")
      .insert({
        user_id: auth.userId,
        organization_id: params.organizationId,
        organization_type: params.organizationType,
        source_url: params.url,
        content_category: params.contentCategory,
        ai_generated_script: response.text,
        edited_script: response.text,
        script_status: "pending",
        compliance_approved: false,
      })
      .select()
      .single()

    if (error) throw error

    // Run compliance check (bespoke AI pass — writes compliance_flags + script_status)
    await checkCompliance(videoQueue.id)

    // Kernel gate, on top of the AI pass. These two are not redundant: the AI
    // check is a judgement call over a prompt, the kernel gate is the
    // deterministic rule array shared with every other outbound surface, and
    // it writes the compliance_events audit row. A deterministic Fair Housing
    // hit is not overridable by the AI's opinion, so it forces the row back to
    // needs_revision even if checkCompliance had just approved it.
    const kernelWarnings = await postcheckScript(
      { userId: auth.userId, brokerageId: auth.brokerageId },
      response.text,
      params.contentCategory === "property_listing" ? "seller" : "buyer",
    )

    if (kernelWarnings?.length) {
      const { data: current } = await supabase
        .from("video_generation_queue")
        .select("compliance_flags")
        .eq("id", videoQueue.id)
        .maybeSingle()

      const existingFlags = Array.isArray(current?.compliance_flags) ? current.compliance_flags : []
      const kernelFlags = kernelWarnings.map((issue) => ({
        severity: issue.startsWith("FairHousing:") ? "violation" : "warning",
        issue,
        suggestion: "Regenerate or edit the script to clear this before rendering.",
        source: "kernel_gate",
      }))
      const hasViolation = kernelFlags.some((f) => f.severity === "violation")

      const { error: mergeError } = await supabase
        .from("video_generation_queue")
        .update({
          compliance_flags: [...existingFlags, ...kernelFlags],
          ...(hasViolation
            ? { compliance_check_passed: false, script_status: "needs_revision" }
            : {}),
        })
        .eq("id", videoQueue.id)

      if (mergeError) {
        console.error("[link-to-video] Failed to merge kernel compliance flags:", mergeError)
      }
    }

    revalidatePath("/content-studio")
    return { success: true, videoQueue, complianceWarnings: kernelWarnings }
  } catch (error) {
    console.error("[link-to-video] Generate video script error:", error)
    return { success: false, error: "Failed to generate script" }
  }
}

// Check script compliance — burns paid AI inference
export async function checkCompliance(videoQueueId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const supabase = createServiceClient()

  try {
    const { data: video } = await supabase
      .from("video_generation_queue")
      .select("*")  // brokerages has no compliance_rules column — the embed failed the whole query
      .eq("id", videoQueueId)
      .single()

    if (!video) throw new Error("Video not found")

    const script = video.edited_script || video.ai_generated_script
    const complianceRules = video.brokerages?.compliance_rules || {}

    // Use AI to check compliance
    const complianceResponse = await generateAIResponse({
      prompt: `Analyze this real estate video script for compliance violations:

Script: "${script}"

Check for:
1. Fair Housing Act violations (mentions of race, religion, familial status, national origin, sex, disability)
2. Discriminatory language: ${complianceRules.restricted_keywords?.join(", ")}
3. Required disclaimers present: ${complianceRules.required_disclaimers?.join(", ")}
4. Copyright/trademark concerns
5. NAR Code of Ethics adherence

Return JSON: {
  "passed": boolean,
  "flags": [{"severity": "warning"|"violation", "issue": string, "suggestion": string}],
  "score": number 0-100
}`,
      metadata: {
        userId: auth.userId,
        brokerageId: video.organization_id,
        feature: "video_script_generation",
      },
    })

    const complianceResult = JSON.parse(complianceResponse.text)

    await supabase
      .from("video_generation_queue")
      .update({
        compliance_check_passed: complianceResult.passed && complianceResult.score >= 75,
        compliance_flags: complianceResult.flags,
        script_status: complianceResult.passed ? "approved" : "needs_revision",
      })
      .eq("id", videoQueueId)

    revalidatePath("/content-studio")
    return { success: true, compliance: complianceResult }
  } catch (error) {
    console.error("[link-to-video] Check compliance error:", error)
    return { success: false, error: "Failed to check compliance" }
  }
}

// Update script
export async function updateVideoScript(videoQueueId: string, editedScript: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const supabase = createServiceClient()

  try {
    const { error } = await supabase
      .from("video_generation_queue")
      .update({
        edited_script: editedScript,
        script_status: "pending",
      })
      .eq("id", videoQueueId)

    if (error) throw error

    // Re-run compliance check
    await checkCompliance(videoQueueId)

    revalidatePath("/content-studio")
    return { success: true }
  } catch (error) {
    console.error("[link-to-video] Update video script error:", error)
    return { success: false, error: "Failed to update script" }
  }
}

// Start video generation
export async function startVideoGeneration(videoQueueId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const supabase = createServiceClient()

  try {
    // THIS BUTTON USED TO SET A STATUS AND NOTHING ELSE.
    //
    // It wrote status='generating_audio' and returned "Video generation
    // started" — but no renderer was ever invoked and no row existed for one to
    // find. The Content Studio table then showed "Generating Audio" forever, and
    // its Download control was gated on a 'completed' this path could not reach.
    // The script was real, the compliance check was real, and the middle was
    // missing entirely.
    //
    // The render rail is ai_video_projects: /api/did/generate-video submits the
    // job, poll-did-videos drives it to completed/failed, and
    // video-pipeline-reaper fails anything that stalls. The queue row reaches a
    // terminal state through its project_id via the m365 trigger — so all this
    // has to do is put the work on that rail.
    const { data: queued, error: readError } = await supabase
      .from("video_generation_queue")
      .select("id, project_id, edited_script, ai_generated_script, source_url, content_category, compliance_approved, user_id, organization_id")
      .eq("id", videoQueueId)
      .maybeSingle()

    if (readError) {
      console.error("[link-to-video] Queue read error:", readError)
      return { success: false, error: "Could not load the video" }
    }
    if (!queued) return { success: false, error: "Video not found" }

    const script = (queued.edited_script || queued.ai_generated_script || "").trim()
    if (!script) {
      return { success: false, error: "There is no script to render yet — generate or edit one first." }
    }
    // The compliance check already exists on this table and had no gate reading
    // it. A script that has not cleared it must not reach a paid render.
    if (queued.compliance_approved !== true) {
      return {
        success: false,
        error: "This script has not passed the compliance check yet. Review it before generating the video.",
      }
    }

    // Adopt an existing project on a re-run rather than creating a second one.
    let projectId = queued.project_id as string | null
    if (!projectId) {
      // Through the CANONICAL creator, not a hand-rolled insert — it resolves
      // the video provider and stamps the provider columns too, and it keeps
      // ai_video_projects.agent_id written from one place. That column is
      // mid-migration (FK users(id) today, scheduled to re-point to agents(id);
      // see scripts/agent-id-repoint-guard.ts), so a second writer passing a
      // users id would have grown a backlog that may only shrink.
      const { createVideoProject } = await import("@/app/actions/video/create-video-project")
      const created = await createVideoProject({
        brokerageId:     auth.brokerageId ?? "",
        agentUserId:     queued.user_id ?? auth.userId,
        title:           `Link-to-video: ${queued.source_url ?? "untitled"}`.slice(0, 200),
        script,
        videoType:       "avatar_explainer",
        backgroundType:  "solid",
        format:          "vertical",
        durationSeconds: 60,
        captionsEnabled: true,
      })

      if (!created.success || !created.project) {
        console.error("[link-to-video] Project create error:", created.error)
        return { success: false, error: created.error ?? "Could not start the render" }
      }
      projectId = created.project.id

      const { error: linkError } = await supabase
        .from("video_generation_queue")
        .update({ project_id: projectId })
        .eq("id", videoQueueId)
      if (linkError) {
        console.error("[link-to-video] Queue/project link error:", linkError)
        return { success: false, error: "Could not start the render" }
      }
    }

    // Submit the job. generateVideo resolves the agent's own D-ID twin from
    // agentUserId and REFUSES rather than rendering a stock stranger when the
    // agent has no avatar configured — so a missing twin reaches the agent as an
    // instruction instead of a wrong face.
    const { generateVideo } = await import("@/lib/did")
    const render = await generateVideo({
      script,
      agentUserId: queued.user_id ?? auth.userId,
      brokerageId: auth.brokerageId ?? "",
    })

    if (render.status === "error" || !render.videoId) {
      const reason = render.note ?? "the video provider refused the job"
      await supabase
        .from("ai_video_projects")
        .update({ status: "failed", error_message: `Render not started: ${reason}` })
        .eq("id", projectId)
      // The queue row follows to 'failed' through the m365 trigger.
      revalidatePath("/content-studio")
      return { success: false, error: reason }
    }

    // Exactly what poll-did-videos selects on: status='generating' AND
    // provider_job_id NOT NULL AND provider_metadata->>provider='did'.
    // mode 'talk' because lib/did/index.ts posts to /talks.
    const { error: stampError } = await supabase
      .from("ai_video_projects")
      .update({
        status:            "generating",
        provider_job_id:   render.videoId,
        provider_status:   "processing",
        provider_metadata: { provider: "did", mode: "talk", talk_id: render.videoId },
        error_message:     null,
      })
      .eq("id", projectId)

    if (stampError) {
      console.error("[link-to-video] Provider stamp error:", stampError)
      return { success: false, error: "The render started but could not be tracked — please retry." }
    }

    revalidatePath("/content-studio")
    return { success: true, message: "Video generation started", projectId }
  } catch (error) {
    console.error("[link-to-video] Start video generation error:", error)
    return { success: false, error: "Failed to start video generation" }
  }
}

export async function getVideoQueue(_userId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  try {
    // Read queue for caller's brokerage (org_id matches brokerage_id when
    // organization_type='brokerage'; we also include team-scoped rows whose
    // team belongs to caller's brokerage via a separate query).
    const { data: brokerageVideos, error } = await supabase
      .from("video_generation_queue")
      // The rendered file lives on the PROJECT, not the queue row — the queue has
      // no output column at all, which is why the Content Studio's Download
      // control was removed as unbackable. Embedding the project restores it.
      .select("*, ai_video_projects(video_url, thumbnail_url, status, error_message)")
      .eq("organization_id", auth.brokerageId)
      .eq("organization_type", "brokerage")
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) {
      if (error.code === "PGRST205" || error.message?.includes("Could not find the table")) {
        return []
      }
      console.error("[link-to-video] Get video queue error:", error)
      return []
    }

    // Add team videos where the team belongs to caller's brokerage
    const { data: teams } = await supabase
      .from("teams")
      .select("id")
      .eq("brokerage_id", auth.brokerageId)
    const teamIds = (teams ?? []).map((t: any) => t.id)
    let teamVideos: any[] = []
    if (teamIds.length > 0) {
      const { data: tv } = await supabase
        .from("video_generation_queue")
        .select("*, ai_video_projects(video_url, thumbnail_url, status, error_message)")
        .in("organization_id", teamIds)
        .eq("organization_type", "team")
        .order("created_at", { ascending: false })
        .limit(50)
      teamVideos = tv ?? []
    }

    return [...(brokerageVideos ?? []), ...teamVideos]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 50)
  } catch (error) {
    console.error("[link-to-video] Get video queue error:", error)
    return []
  }
}

// Get single video details
export async function getVideoDetails(videoQueueId: string) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) throw new Error("Forbidden")

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("video_generation_queue")
    .select("*, video_processing_log(*), video_social_publishes(*)")
    .eq("id", videoQueueId)
    .single()

  if (error) throw error
  return data
}

// Generate social caption — paid AI
export async function generateSocialCaption(videoQueueId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const supabase = createServiceClient()

  try {
    const { data: video } = await supabase.from("video_generation_queue").select("*").eq("id", videoQueueId).single()

    if (!video) throw new Error("Video not found")

    const captionResponse = await generateAIResponse({
      prompt: `Create an engaging social media caption for this video:

Category: ${video.content_category}
Script: ${video.edited_script || video.ai_generated_script}

Requirements:
- Attention-grabbing hook
- 3-5 relevant hashtags
- Clear call-to-action
- Compliant with real estate advertising rules
- Maximum 200 characters

Return only the caption text.`,
      metadata: {
        userId: auth.userId,
        brokerageId: auth.brokerageId,
        feature: "video_script_generation",
      },
    })

    await supabase.from("video_generation_queue").update({ social_caption: captionResponse.text }).eq("id", videoQueueId)

    revalidatePath("/content-studio")
    return { success: true, caption: captionResponse.text }
  } catch (error) {
    console.error("[link-to-video] Generate social caption error:", error)
    return { success: false, error: "Failed to generate caption" }
  }
}

// Delete video
export async function deleteVideo(videoQueueId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const supabase = createServiceClient()

  try {
    const { error } = await supabase.from("video_generation_queue").delete().eq("id", videoQueueId)

    if (error) throw error

    revalidatePath("/content-studio")
    return { success: true }
  } catch (error) {
    console.error("[link-to-video] Delete video error:", error)
    return { success: false, error: "Failed to delete video" }
  }
}

// Get user organizations — derives from session, not from caller param
export async function getUserOrganizations(_userId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  try {
    // organization_members was a writer-less legacy table (burn-down round 6 repoint) — orgs are
    // rebuilt from users.brokerage_id (brokerage org) + team_members via the user's agents row (team orgs).
    const orgs: Array<{ id: string; name: string; type: "brokerage" | "team" }> = []

    const { data: brokerage } = await supabase
      .from("brokerages")
      .select("id, name")
      .eq("id", auth.brokerageId)
      .maybeSingle()
    if (brokerage) orgs.push({ id: brokerage.id as string, name: (brokerage.name as string) ?? "Unknown", type: "brokerage" })

    const { data: agentRow } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", auth.userId)
      .maybeSingle()
    if (agentRow?.id) {
      const { data: memberships } = await supabase
        .from("team_members")
        .select("team_id")
        .eq("agent_id", agentRow.id)
        .eq("is_active", true)
      const teamIds = [...new Set((memberships ?? []).map((m: any) => m.team_id).filter(Boolean))]
      if (teamIds.length) {
        const { data: teams } = await supabase
          .from("teams")
          .select("id, name")
          .in("id", teamIds)
          .is("deleted_at", null)
        for (const t of teams ?? []) {
          orgs.push({ id: t.id as string, name: (t.name as string) ?? "Unknown", type: "team" })
        }
      }
    }

    return orgs
  } catch (error) {
    console.error("[link-to-video] Get user organizations error:", error)
    return []
  }
}
