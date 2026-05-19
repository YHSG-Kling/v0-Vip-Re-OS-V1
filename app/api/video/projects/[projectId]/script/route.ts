import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { generateVideoScript } from "@/lib/kernel/video"
import type { GenerateVideoScriptInput } from "@/lib/kernel/video"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  // Auth + project ownership — script generation is an AI call ($) per
  // request. Was previously unauthenticated.
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { projectId } = await params

  const svc = createServiceClient()
  const { data: project } = await svc
    .from("video_projects")
    .select("brokerage_id")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
  if (project.brokerage_id !== auth.brokerageId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await request.json()
  const input: GenerateVideoScriptInput = {
    projectId,
    contentStrategy: body.contentStrategy,
    tone: body.tone,
    duration: body.duration,
  }

  try {
    const output = await generateVideoScript(input)
    return NextResponse.json({ script: output }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate script"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
