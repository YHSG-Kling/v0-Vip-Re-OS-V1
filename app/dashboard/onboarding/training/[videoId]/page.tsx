// ============================================================
// SYSTEM: L11-S04 — Training Video Player Page
// VIP Real Estate AI OS — Layer 11
// ============================================================
// ROUTE: app/dashboard/onboarding/training/[videoId]/page.tsx

import { redirect, notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getVideoWithProgress } from "@/app/actions/onboarding/training"
import { VideoPlayerClient } from "./video-player-client"

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ videoId: string }>
}) {
  const { videoId } = await params
  const result = await getVideoWithProgress(videoId)

  if (!result.success || !result.data) {
    return {
      title: "Video Not Found | VIP Real Estate AI OS",
    }
  }

  return {
    title: `${result.data.video.title} | Training | VIP Real Estate AI OS`,
    description: result.data.video.description || "Training video",
  }
}

export default async function VideoPlayerPage({
  params,
}: {
  params: Promise<{ videoId: string }>
}) {
  const { videoId } = await params
  const supabase = await createClient()

  // Verify session
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    redirect("/auth/login")
  }

  // Fetch video with progress
  const result = await getVideoWithProgress(videoId)

  if (!result.success || !result.data) {
    notFound()
  }

  const { video, completion, nextVideo, prevVideo, allRequiredComplete } = result.data

  return (
    <VideoPlayerClient
      video={video}
      completion={completion}
      nextVideo={nextVideo}
      prevVideo={prevVideo}
      allRequiredComplete={allRequiredComplete}
    />
  )
}
