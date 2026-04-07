import { NextRequest, NextResponse } from "next/server"
import { generateVideoScript } from "@/lib/kernel/video"
import type { GenerateVideoScriptInput } from "@/lib/kernel/video"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
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
