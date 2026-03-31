import { NextRequest, NextResponse } from "next/server"
import { submitVideoGenerationJob, loadVideoGenerationState } from "@/lib/kernel/video"
import type { SubmitVideoGenerationJobInput } from "@/lib/kernel/video"

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const body = await request.json()
  const input: SubmitVideoGenerationJobInput = {
    projectId: params.projectId,
    scriptText: body.scriptText,
    voiceProfileId: body.voiceProfileId,
    avatarStyle: body.avatarStyle,
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
  { params }: { params: { projectId: string } }
) {
  try {
    const state = await loadVideoGenerationState({ projectId: params.projectId })
    return NextResponse.json({ state }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load state"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
