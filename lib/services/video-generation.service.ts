
import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { handleError, ValidationError, NotFoundError } from "@/lib/errors"
import { AI_CONFIG } from "@/lib/constants"

/**
 * Consolidated Video Generation Service
 * Merges functionality from:
 * - app/actions/video-generation.ts
 * - app/actions/listing-video.ts
 * - app/actions/link-to-video.ts
 * - app/actions/video-content.ts
 */

export interface VideoProjectParams {
  agentId: string
  projectType: "listing_tour" | "agent_intro" | "market_update" | "testimonial" | "social_snippet"
  listingId?: string
  script?: string
  duration?: number
  style?: "professional" | "casual" | "luxury" | "modern"
}

export interface VideoGenerationResult {
  success: boolean
  projectId?: string
  videoUrl?: string
  status?: string
  error?: string
}

/**
 * Create a new video project
 */
export async function createVideoProject(params: VideoProjectParams): Promise<VideoGenerationResult> {
  try {
    if (!isValidUUID(params.agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    console.log("[v0] Creating video project:", params.projectType)

    const supabase = await createClient()

    // Get listing details if provided
    let listingData: any = null
    if (params.listingId && isValidUUID(params.listingId)) {
      const { data } = await supabase
        .from("listings")
        .select("*, listing_photos(*)")
        .eq("id", params.listingId)
        .single()
      listingData = data
    }

    // Generate script if not provided
    let script = params.script
    if (!script && listingData) {
      script = await generateVideoScript({
        listing: listingData,
        projectType: params.projectType,
        style: params.style || "professional"
      })
    }

    // Create video project
    const { data: project, error } = await supabase
      .from("ai_video_projects")
      .insert({
        agent_id: params.agentId,
        listing_id: params.listingId,
        video_type: params.projectType,
        script,
        duration_seconds: params.duration || 60,
        status: "queued",
        metadata: {
          style: params.style,
          created_from: "consolidated_service"
        }
      })
      .select()
      .single()

    if (error) throw error

    // Queue for generation
    await queueVideoGeneration(project.id)

    return {
      success: true,
      projectId: project.id,
      status: "queued"
    }
  } catch (error) {
    return handleError(error, "createVideoProject")
  }
}

/**
 * Generate AI video script based on listing data
 */
async function generateVideoScript(params: {
  listing: any
  projectType: string
  style: string
}): Promise<string> {
  const { listing, projectType, style } = params

  // Build script based on type
  if (projectType === "listing_tour") {
    return `Welcome to ${listing.address}! This stunning ${listing.bedrooms} bedroom, ${listing.bathrooms} bathroom ${listing.property_type} offers ${listing.square_feet} square feet of luxurious living space. ${listing.description || ''} Priced at $${listing.price?.toLocaleString()}, this property won't last long. Schedule your showing today!`
  }

  if (projectType === "social_snippet") {
    return `🏡 Just Listed! ${listing.bedrooms}BR/${listing.bathrooms}BA in ${listing.city}. ${listing.price ? `$${listing.price.toLocaleString()}` : 'Contact for price'}. DM for details!`
  }

  return `Check out this amazing property at ${listing.address}!`
}

/**
 * Queue video for generation using HeyGen or similar service
 */
async function queueVideoGeneration(projectId: string): Promise<void> {
  const supabase = await createClient()

  // In production, this would call HeyGen API or other video service
  // For now, we'll mark it as processing and simulate completion
  
  await supabase
    .from("ai_video_projects")
    .update({ 
      status: "processing",
      processing_started_at: new Date().toISOString()
    })
    .eq("id", projectId)

  console.log(`[v0] Video project ${projectId} queued for generation`)
}

/**
 * Get video project status
 */
export async function getVideoProjectStatus(projectId: string): Promise<{
  status: string
  progress: number
  videoUrl?: string
  error?: string
}> {
  try {
    if (!isValidUUID(projectId)) {
      throw new ValidationError("Invalid project ID")
    }

    const supabase = await createClient()

    const { data: project, error } = await supabase
      .from("ai_video_projects")
      .select("*")
      .eq("id", projectId)
      .single()

    if (error || !project) {
      throw new NotFoundError("Video project not found")
    }

    return {
      status: project.status,
      progress: calculateProgress(project),
      videoUrl: project.video_url,
      error: project.error_message
    }
  } catch (error) {
    console.error("[v0] Get video status error:", error)
    return { status: "error", progress: 0 }
  }
}

function calculateProgress(project: any): number {
  if (project.status === "ready") return 100
  if (project.status === "processing") return 50
  if (project.status === "queued") return 10
  return 0
}

/**
 * Batch generate videos for listing (multiple formats)
 */
export async function generateListingVideoPackage(params: {
  agentId: string
  listingId: string
}): Promise<VideoGenerationResult[]> {
  try {
    if (!isValidUUID(params.agentId) || !isValidUUID(params.listingId)) {
      throw new ValidationError("Invalid agent or listing ID")
    }

    const videoTypes: Array<"listing_tour" | "social_snippet"> = ["listing_tour", "social_snippet"]
    const results: VideoGenerationResult[] = []

    for (const type of videoTypes) {
      const result = await createVideoProject({
        agentId: params.agentId,
        listingId: params.listingId,
        projectType: type,
        style: "professional"
      })
      results.push(result)
    }

    return results
  } catch (error) {
    console.error("[v0] Generate listing video package error:", error)
    return []
  }
}

/**
 * Get all videos for a listing
 */
export async function getListingVideos(listingId: string): Promise<any[]> {
  try {
    if (!isValidUUID(listingId)) {
      return []
    }

    const supabase = await createClient()

    const { data: videos } = await supabase
      .from("ai_video_projects")
      .select("*")
      .eq("listing_id", listingId)
      .order("created_at", { ascending: false })

    return videos || []
  } catch (error) {
    console.error("[v0] Get listing videos error:", error)
    return []
  }
}

/**
 * Delete video project
 */
export async function deleteVideoProject(projectId: string, agentId: string): Promise<{ success: boolean }> {
  try {
    if (!isValidUUID(projectId) || !isValidUUID(agentId)) {
      throw new ValidationError("Invalid project or agent ID")
    }

    const supabase = await createClient()

    const { error } = await supabase
      .from("ai_video_projects")
      .delete()
      .eq("id", projectId)
      .eq("agent_id", agentId)

    if (error) throw error

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteVideoProject")
  }
}
