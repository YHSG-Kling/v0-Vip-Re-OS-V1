import { NextRequest, NextResponse } from "next/server"
import { distributeVideoProject, repurposeVideoOutput } from "@/lib/kernel/video"
import type { DistributeVideoProjectInput, RepurposeVideoOutputInput } from "@/lib/kernel/video"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
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
