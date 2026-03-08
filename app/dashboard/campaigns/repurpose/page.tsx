// app/dashboard/campaigns/repurpose/page.tsx
// Layer 9.11 — Omni-Presence Repurposer Dashboard
// Two-panel UI: Pipeline Builder (left) + Source Picker (right)

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { RepurposeDashboardClient } from "./repurpose-dashboard-client"
import { getPipelines, getRepurposeHistory } from "@/lib/repurpose/pipeline-executor"

export const metadata = {
  title: "Omni-Presence Repurposer | Dashboard",
  description: "Transform your content across all social platforms with AI-powered repurposing",
}

export default async function RepurposePage() {
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Get user profile with brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, team_id, role, first_name, last_name, user_type")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) {
    redirect("/onboarding")
  }

  // Fetch pipelines
  const pipelines = await getPipelines(profile.brokerage_id)

  // Fetch repurpose history
  const history = await getRepurposeHistory(profile.brokerage_id, 50)

  // Fetch available source content
  const [videoProjects, blogPosts, podcastEpisodes, scripts] = await Promise.all([
    supabase
      .from("ai_video_projects")
      .select("id, title, video_url, status, duration_seconds, created_at")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("blog_posts")
      .select("id, title, publish_status, created_at")
      .eq("brokerage_id", profile.brokerage_id)
      .in("publish_status", ["published", "draft"])
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("podcast_episodes")
      .select("id, title, status, duration_seconds, created_at")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("video_scripts_library")
      .select("id, title, script_type, created_at")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(20),
  ])

  const sources = {
    video_project: videoProjects.data || [],
    blog_post: blogPosts.data || [],
    podcast_episode: podcastEpisodes.data || [],
    script: scripts.data || [],
  }

  return (
    <RepurposeDashboardClient
      userId={user.id}
      brokerageId={profile.brokerage_id}
      teamId={profile.team_id}
      userRole={profile.role || "agent"}
      pipelines={pipelines}
      history={history}
      sources={sources}
    />
  )
}
