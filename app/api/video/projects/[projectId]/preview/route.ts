import { NextRequest, NextResponse } from "next/server"
import { previewVideoProject } from "@/lib/kernel/video"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params
    const output = await previewVideoProject({ projectId })
    return NextResponse.json({ preview: output }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load preview"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
