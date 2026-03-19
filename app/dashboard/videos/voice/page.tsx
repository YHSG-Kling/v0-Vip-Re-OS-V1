import { Suspense } from "react"
import { redirect } from "next/navigation"
import { Loader2 } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { VoiceCloneClient } from "./voice-client"
import { getVoiceProfiles } from "@/app/actions/video-voice"

export const metadata = {
  title: "Voice Clone | Videos",
  description: "Create and manage AI voice clones for video generation",
}

async function VoiceContent() {
  const supabase = await createClient()

  // Get current user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect("/login")
  }

  // Get user's agent record — CRITICAL: agent_voice_profiles uses agents.id
  const { data: agentData } = await supabase
    .from("agents")
    .select("id, brokerage_id, user_id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!agentData) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md p-8">
          <h2 className="text-xl font-semibold text-foreground mb-2">Agent Profile Required</h2>
          <p className="text-muted-foreground">
            Voice cloning is only available for agents. Please complete your agent profile setup first.
          </p>
        </div>
      </div>
    )
  }

  // Fetch voice profiles for this agent
  const voiceProfiles = await getVoiceProfiles(agentData.id)

  return (
    <VoiceCloneClient
      agentId={agentData.id}
      brokerageId={agentData.brokerage_id}
      userId={user.id}
      initialProfiles={voiceProfiles}
    />
  )
}

export default function VoiceClonePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <VoiceContent />
    </Suspense>
  )
}
