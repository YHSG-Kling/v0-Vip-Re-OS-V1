import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { submitVideoGenerationJob, loadVideoGenerationState } from "@/lib/kernel/video"
import type { SubmitVideoGenerationJobInput } from "@/lib/kernel/video"

/**
 * Resolve the caller's auth and verify they own the video project. Returns
 * either the verified auth context or an error response. Centralised here
 * because both POST and GET need it.
 */
async function authorize(projectId: string) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { ok: false as const, response: auth.response }

  const svc = createServiceClient()
  const { data: project } = await svc
    .from("video_projects")
    .select("brokerage_id")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) {
    return { ok: false as const, response: NextResponse.json({ error: "Project not found" }, { status: 404 }) }
  }
  if (project.brokerage_id !== auth.brokerageId) {
    return { ok: false as const, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  return { ok: true as const }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const gate = await authorize(projectId)
  if (!gate.ok) return gate.response

  const body = await request.json()
  const input: SubmitVideoGenerationJobInput = {
    projectId,
    scriptText: body.scriptText,
    voiceProfileId: body.voiceProfileId,
    avatarStyle: body.avatarStyle,
    avatarId: body.avatarId,
    estimatedDurationSeconds: body.estimatedDurationSeconds,
  }

  try {
    const output = await submitVideoGenerationJob(input)
    return NextResponse.json({ job: output }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to submit job"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const gate = await authorize(projectId)
  if (!gate.ok) return gate.response

  try {
    const state = await loadVideoGenerationState({ projectId })
    return NextResponse.json({ state }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load state"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
