// app/dashboard/campaigns/repurpose/page.tsx
// Layer 9.11 — Omni-Presence Repurposer Dashboard
// Two-panel UI: Pipeline Builder (left) + Source Picker (right)

import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { RepurposeDashboardClient } from "./repurpose-dashboard-client"
import { VideoUrlRepurposeCard } from "./video-url-repurpose-card"
import { getPipelines, getRepurposeHistory } from "@/lib/repurpose/actions"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Omni-Presence Repurposer | Dashboard",
  description: "Transform your content across all social platforms with AI-powered repurposing",
}

export default async function RepurposePage() {
  try {
    const agentContext = await getAgentContext()
    const { userId, brokerageId } = agentContext
    const teamId: string | null = (agentContext as any).teamId ?? null
    const supabase = await createClient()

    // Get user profile with role
    const { data: profile } = await supabase
      .from("users")
      .select("role, first_name, last_name, user_type")
      .eq("id", userId)
      .maybeSingle()

    // Fetch pipelines and history in parallel
    const [pipelinesResult, historyResult] = await Promise.all([
      getPipelines(brokerageId ?? ""),
      getRepurposeHistory(brokerageId ?? ""),
    ])

    // Fetch available source content + connected social channels
    const [videoProjects, blogPosts, podcastEpisodes, scripts, socialAccounts] = await Promise.all([
      supabase
        .from("ai_video_projects")
        .select("id, title, video_url, status, duration_seconds, created_at")
        .eq("brokerage_id", brokerageId)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("blog_posts")
        .select("id, title, publish_status, created_at")
        .eq("brokerage_id", brokerageId)
        .in("publish_status", ["published", "draft"])
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("podcast_episodes")
        .select("id, title, status, duration_seconds, created_at")
        .eq("brokerage_id", brokerageId)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("video_scripts_library")
        .select("id, title, script_type, created_at")
        .eq("brokerage_id", brokerageId)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("social_media_accounts")
        .select("platform")
        .eq("brokerage_id", brokerageId ?? "")
        .eq("is_active", true),
    ])

    const connectedPlatforms = Array.from(
      new Set((socialAccounts.data ?? []).map((a: { platform: string }) => a.platform)),
    )

    const sources = {
      video_project: videoProjects.data || [],
      blog_post: blogPosts.data || [],
      podcast_episode: podcastEpisodes.data || [],
      script: scripts.data || [],
    }

    return (
      <Suspense fallback={<div>Loading...</div>}>
        <div className="p-6 pb-0">
          <VideoUrlRepurposeCard connectedPlatforms={connectedPlatforms} />
        </div>
        <RepurposeDashboardClient
          userId={userId}
          brokerageId={brokerageId ?? ""}
          teamId={teamId}
          userRole={profile?.role || "agent"}
          pipelines={pipelinesResult.success ? pipelinesResult.pipelines : []}
          history={historyResult.success ? historyResult.history : []}
          sources={sources}
        />
      </Suspense>
    )
  } catch (error) {
    console.error("[Repurpose] Page error:", error)
    return (
      <div className="flex flex-col gap-6 p-6">
        <h1 className="text-3xl font-bold">Omnipresence Repurposer</h1>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          Error loading dashboard. Please try again.
        </div>
      </div>
    )
  }
}
