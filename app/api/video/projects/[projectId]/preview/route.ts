import { NextRequest, NextResponse } from "next/server"
import { previewVideoProject } from "@/lib/kernel/video"

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    const output = await previewVideoProject({ projectId: params.projectId })
    return NextResponse.json({ preview: output }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load preview"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
