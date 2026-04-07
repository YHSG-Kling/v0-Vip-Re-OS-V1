import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@/lib/supabase/server"
import { createVideoProject } from "@/lib/kernel/video"
import type { CreateVideoProjectInput } from "@/lib/kernel/video"

export async function GET() {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: projects, error } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("agent_id", user.id)
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
  const input: CreateVideoProjectInput = {
    agentId: user.id,
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
