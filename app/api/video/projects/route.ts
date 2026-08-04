import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@/lib/supabase/server"
import { resolveAgentId, resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import { createVideoProject } from "@/lib/kernel/video"
import type { CreateVideoProjectInput } from "@/lib/kernel/video"

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

export async function POST(request: NextRequest) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await request.json()
  // createVideoProject writes this straight into ai_video_projects.agent_id, so
  // it must be the agents id — scoped when the body names a brokerage.
  const agentId = body.brokerageId
    ? await resolveAgentIdInBrokerage(supabase, user.id, body.brokerageId)
    : await resolveAgentId(supabase, user.id)
  if (!agentId) {
    return NextResponse.json({ error: "No agent profile for this user" }, { status: 400 })
  }

  const input: CreateVideoProjectInput = {
    agentId,
    brokerageId: body.brokerageId,
    title: body.title,
    description: body.description,
    campaignId: body.campaignId,
    sourceType: body.sourceType || "manual",
    sourceId: body.sourceId,
  }

  try {
    const output = await createVideoProject(input)
    return NextResponse.json({ project: output }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create project"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
