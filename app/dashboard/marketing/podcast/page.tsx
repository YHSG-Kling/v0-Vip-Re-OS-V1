import { Suspense } from "react"
import { PodcastDashboard } from "./podcast-dashboard"
import { getPodcastEpisodes } from "@/app/actions/podcast-generation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"

export const metadata = {
  title: "Podcast Studio | VIP Agents AI",
  description: "AI-powered podcast creation and distribution for real estate agents",
}

export default async function PodcastPage() {
  // Resolve agent context + load initial data server-side
  let agentId = ""
  let brokerageId = ""
  let userType = "agent"
  let initialEpisodes: any[] = []
  let totalPlays = 0

  let hasVoiceClone = false

  try {
    const ctx = await getAgentContext()
    agentId = ctx?.agentId ?? ""
    brokerageId = ctx?.brokerageId ?? ""
    userType = ctx?.userType ?? "agent"

    const [episodesResult, supabase] = await Promise.all([
      getPodcastEpisodes(),
      createClient(),
    ])

    if (episodesResult.success) {
      initialEpisodes = episodesResult.episodes || []
    }

    // Query total play events for this agent's episodes
    if (initialEpisodes.length > 0) {
      const episodeIds = initialEpisodes.map((e) => e.id)
      const { count } = await supabase
        .from("podcast_analytics_events")
        .select("id", { count: "exact", head: true })
        .in("episode_id", episodeIds)
        .eq("event_type", "play")
      totalPlays = count ?? 0
    }

    // Check if agent has a voice clone configured
    if (agentId) {
      const { data: userRow } = await supabase
        .from("users")
        .select("heygen_voice_id")
        .eq("id", agentId)
        .maybeSingle()
      hasVoiceClone = !!userRow?.heygen_voice_id
    }
  } catch (error) {
    console.error("[Podcast] Failed to load initial data:", error)
  }

  return (
    <div className="flex flex-col h-full">
      <Suspense fallback={<PodcastLoadingSkeleton />}>
        <PodcastDashboard
          agentId={agentId}
          brokerageId={brokerageId}
          initialEpisodes={initialEpisodes}
          totalPlays={totalPlays}
          userType={userType}
          hasVoiceClone={hasVoiceClone}
        />
      </Suspense>
    </div>
  )
}

function PodcastLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div className="h-8 w-48 bg-gray-200 rounded animate-pulse" />
        <div className="h-10 w-32 bg-gray-200 rounded animate-pulse" />
      </div>
      <div className="h-10 w-full max-w-md bg-gray-200 rounded animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-48 bg-gray-200 rounded-xl animate-pulse" />
        ))}
      </div>
    </div>
  )
}
