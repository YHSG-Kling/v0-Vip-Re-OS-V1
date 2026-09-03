// app/dashboard/campaigns/repurpose/page.tsx
// Layer 9.11 — Omni-Presence Repurposer Dashboard
// Two-panel UI: Pipeline Builder (left) + Source Picker (right)

import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { RepurposeDashboardClient } from "./repurpose-dashboard-client"
import { VideoUrlRepurposeCard } from "./video-url-repurpose-card"
import { NewsletterTeasersCard, type NewsletterTeaser } from "./newsletter-teasers-card"
import { getPipelines, getRepurposeHistory } from "@/lib/repurpose/actions"
import { VIDEO_FINISHED_STATUSES } from "@/lib/video/video-pipeline-reaper-policy"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Omni-Presence Repurposer | Dashboard",
  description: "Transform your content across all social platforms with AI-powered repurposing",
}

// Map the short ?source= token used by deep-links (e.g. the Podcast Studio's
// "Send to Omnipresence") onto the canonical SourceType the client understands.
const SOURCE_TOKEN_TO_TYPE: Record<string, string> = {
  podcast: "podcast_episode",
  podcast_episode: "podcast_episode",
  video: "video_project",
  video_project: "video_project",
  blog: "blog_post",
  blog_post: "blog_post",
  script: "script",
}

export default async function RepurposePage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; episodeId?: string; sourceId?: string }>
}) {
  try {
    const sp = await searchParams
    const initialSourceType = sp.source ? SOURCE_TOKEN_TO_TYPE[sp.source] ?? null : null
    const initialSourceId = sp.episodeId ?? sp.sourceId ?? null
    const agentContext = await getAgentContext()
    const { userId, brokerageId, agentId, userType } = agentContext
    const teamId: string | null = (agentContext as any).teamId ?? null
    // newsletter_teasers.agent_id says WHOSE podcast a teaser promotes
    // (app/actions/podcast-generation.ts:1502 stamps the episode owner). The
    // page was brokerage-scoped only, so an agent was offered paste-ready copy
    // promoting a colleague's episode. Office-wide roles (CLAUDE.md §4 tenant
    // roster) keep the whole office's list; everyone else sees their own.
    const OFFICE_WIDE_ROLES = new Set(["broker", "broker_admin", "broker_owner", "team_lead", "admin"])
    const teasersOfficeWide = OFFICE_WIDE_ROLES.has(userType)
    const supabase = await createClient()

    // Get user profile with role
    const { data: profile } = await supabase
      .from("users")
      .select("first_name, last_name, user_type")
      .eq("id", userId)
      .maybeSingle()

    // Fetch pipelines and history in parallel
    const [pipelinesResult, historyResult] = await Promise.all([
      getPipelines(brokerageId ?? ""),
      getRepurposeHistory(brokerageId ?? ""),
    ])

    // Fetch available source content + connected social channels
    const [videoProjects, blogPosts, podcastEpisodes, scripts, socialAccounts, newsletterTeasers] = await Promise.all([
      supabase
        .from("ai_video_projects")
        .select("id, title, video_url, status, duration_seconds, created_at")
        .eq("brokerage_id", brokerageId)
        // A finished video, not just a `completed` one — a distributed or
        // uploaded asset is equally repurposable. See VIDEO_FINISHED_STATUSES.
        .in("status", VIDEO_FINISHED_STATUSES as unknown as string[])
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
        // A finished episode is repurposable whether it's completed or already
        // published — matches the Podcast Studio's own Repurpose tab, so an
        // episode sent over via "Send to Omnipresence" actually appears here.
        .in("status", ["completed", "published"])
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
      (() => {
        const q = supabase
          .from("newsletter_teasers")
          .select("id, content, source_type, source_id, status, agent_id, created_at")
          .eq("brokerage_id", brokerageId ?? "")
        // Fail closed: a non-office-wide viewer with no agents.id sees none,
        // never everyone's.
        const scoped = teasersOfficeWide ? q : agentId ? q.eq("agent_id", agentId) : q.limit(0)
        return scoped.order("created_at", { ascending: false }).limit(20)
      })(),
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
        <div className="p-6 pb-0 space-y-6">
          <VideoUrlRepurposeCard connectedPlatforms={connectedPlatforms} />
          <NewsletterTeasersCard teasers={(newsletterTeasers.data as NewsletterTeaser[] | null) ?? []} />
        </div>
        <RepurposeDashboardClient
          userId={userId}
          brokerageId={brokerageId ?? ""}
          teamId={teamId}
          userRole={profile?.user_type || "agent"}
          pipelines={pipelinesResult.success ? pipelinesResult.pipelines : []}
          history={historyResult.success ? historyResult.history : []}
          sources={sources}
          initialSourceType={initialSourceType}
          initialSourceId={initialSourceId}
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
