"use server"

// ============================================================================
// VIDEO KERNEL — SERVER ACTION SURFACE
//
// This file is deliberately ONE action wide. It used to export a 4-line
// try/catch wrapper for all nine lib/kernel/video commands. Eight of those
// nine had no caller anywhere in app/, lib/ or hooks/ — and each one was a
// live, UNAUTHENTICATED RPC endpoint (a "use server" export is callable by
// anyone with a session; none of them checked who was asking, so a caller
// could pass an arbitrary agentId/brokerageId straight into the kernel).
//
// The kernel commands themselves are NOT dead — they are reached through the
// authorized route handlers, which run requireAuth() before dispatching:
//   createVideoProject          → POST   /api/video/projects
//   generateVideoScript         → POST   /api/video/projects/[projectId]/script
//   submitVideoGenerationJob    → POST   /api/video/projects/[projectId]/generate
//   loadVideoGenerationState    → GET    /api/video/projects/[projectId]/generate
//   previewVideoProject         → GET    /api/video/projects/[projectId]/preview
//   distributeVideoProject      → POST   /api/video/projects/[projectId]/publish
//   repurposeVideoOutput        → POST   /api/video/projects/[projectId]/publish
// The wrappers were a second, weaker door onto the same rooms, so they went.
// ============================================================================

import { distributeVideoProject } from "@/lib/kernel/video"
import type {
  DistributeVideoProjectInput,
  DistributeVideoProjectOutput,
} from "@/lib/kernel/video"

/**
 * Distribute a finished video project to social channels.
 * Caller: app/dashboard/videos/library/page.tsx → handleDistribute()
 */
export async function distributeVideoProjectAction(
  input: DistributeVideoProjectInput
): Promise<{ success: boolean; data?: DistributeVideoProjectOutput; error?: string }> {
  try {
    const data = await distributeVideoProject(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to distribute" }
  }
}
