import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { distributeVideoProject, repurposeVideoOutput } from "@/lib/kernel/video"
import type { DistributeVideoProjectInput, RepurposeVideoOutputInput } from "@/lib/kernel/video"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  // Auth + project ownership — distribute/repurpose actions touch external
  // accounts (YouTube, FB, IG, etc.) and trigger billable AI repurposing.
  // Was previously open to the world.
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { projectId } = await params

  const svc = createServiceClient()
  const { data: project } = await svc
    .from("ai_video_projects")
    .select("brokerage_id")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
  if (project.brokerage_id !== auth.brokerageId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await request.json()

  if (body.action === "distribute") {
    const input: DistributeVideoProjectInput = {
      projectId,
      channels: body.channels,
      title: body.title,
      description: body.description,
      tags: body.tags,
    }

    try {
      const output = await distributeVideoProject(input)
      return NextResponse.json({ distribution: output }, { status: 200 })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to distribute"
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  if (body.action === "repurpose") {
    const input: RepurposeVideoOutputInput = {
      projectId,
      formats: body.formats,
    }

    try {
      const output = await repurposeVideoOutput(input)
      return NextResponse.json({ artifacts: output }, { status: 200 })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to repurpose"
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 })
}
