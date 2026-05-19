import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { previewVideoProject } from "@/lib/kernel/video"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
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

  try {
    const output = await previewVideoProject({ projectId })
    return NextResponse.json({ preview: output }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load preview"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
