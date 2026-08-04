import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createVideoProject } from "@/app/actions/video/create-video-project"
import type { CreateVideoProjectParams } from "@/app/actions/video/create-video-project"

/**
 * ai_video_projects_video_type_check — the DB rejects anything outside this list,
 * and a caller-supplied string reaching the insert turns a bad request into a 500.
 * Checked here because this is where untrusted input enters.
 */
const VIDEO_TYPES = [
  "listing_tour", "pre_appointment", "coming_soon", "just_listed", "open_house_promo",
  "just_sold", "agent_intro", "market_update", "education", "social_reel",
  "listing_promo", "testimonial", "welcome", "presentation_chapter", "memory_video",
  "avatar_explainer",
] as const

const SOURCE_TYPES = ["property", "campaign", "manual"] as const

export async function GET() {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Unscoped: this route knows nothing about a tenant. A user with no agents
  // row owns no projects, which is an empty list rather than a null filter.
  const agentId = await resolveAgentId(supabase, user.id)
  if (!agentId) return NextResponse.json({ projects: [] })

  const { data: projects, error } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ projects })
}

/**
 * Creates a video project through app/actions/video/create-video-project.ts —
 * the owner-designated creator. This used to call lib/kernel/video.ts's
 * createVideoProject, which was kept alive solely because it was the only path
 * carrying campaign attribution (marketing_campaign_id + source_type/source_id in
 * the video_metadata jsonb). That attribution now lives in the survivor, so this
 * route no longer needs the kernel creator, and the wrapper over it is deleted.
 *
 * Fixed on the way past:
 *  · brokerage came from the request body. An absent body.brokerageId produced a
 *    row with a NULL brokerage_id — untenanted — and a present one was never
 *    checked against the caller's own brokerage. It is now resolved server-side
 *    from users.brokerage_id (requireAuth) and a body value that disagrees is a 403.
 *  · the agents-class ai_video_projects.agent_id resolve now happens once, inside
 *    the survivor (resolveAgentIdInBrokerage), scoped to that resolved brokerage.
 */
export async function POST(request: NextRequest) {
  const supabase = await createServerClient()

  // requireAuth reads brokerage_id from the users table, never from the body.
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // A caller may still NAME a brokerage — it just has to be its own.
  if (body.brokerageId && body.brokerageId !== auth.brokerageId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  if (typeof body.title !== "string" || !body.title.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 })
  }

  const sourceType = body.sourceType ?? "manual"
  if (!SOURCE_TYPES.includes(sourceType)) {
    return NextResponse.json({ error: `sourceType must be one of ${SOURCE_TYPES.join(", ")}` }, { status: 400 })
  }

  const videoType = body.videoType ?? "listing_tour"
  if (!VIDEO_TYPES.includes(videoType)) {
    return NextResponse.json({ error: `videoType must be one of ${VIDEO_TYPES.join(", ")}` }, { status: 400 })
  }

  const script = typeof body.script === "string" ? body.script : undefined

  const params: CreateVideoProjectParams = {
    brokerageId: auth.brokerageId,
    // users-class. The survivor resolves users -> agents itself, so no
    // caller-supplied id can reach the agents-class agent_id column.
    agentUserId: auth.userId,
    title: body.title,
    script,
    // This lane creates the shell first and scripts it at
    // POST /api/video/projects/[projectId]/script — the kernel creator's behaviour.
    scriptPending: !script?.trim(),
    videoType,
    backgroundType: body.backgroundType ?? "solid",
    format: body.format ?? "vertical",
    durationSeconds: typeof body.durationSeconds === "number" ? body.durationSeconds : 60,
    captionsEnabled: body.captionsEnabled ?? true,
    listingId: body.listingId,
    // Campaign attribution — the whole reason the kernel creator outlived its
    // replacement. campaignId is validated inside the brokerage by the survivor.
    campaignId: body.campaignId,
    sourceType,
    sourceId: body.sourceId,
    description: body.description,
  }

  const created = await createVideoProject(params)
  if (!created.success || !created.project) {
    return NextResponse.json({ error: created.error ?? "Failed to create project" }, { status: 400 })
  }

  // Keys kept from the kernel's CreateVideoProjectOutput so existing consumers
  // of this route see the same field names.
  return NextResponse.json(
    {
      project: {
        projectId: created.project.id,
        id: created.project.id,
        status: created.project.status,
        createdAt: created.project.created_at,
        marketingCampaignId: created.project.marketing_campaign_id,
      },
    },
    { status: 201 }
  )
}
