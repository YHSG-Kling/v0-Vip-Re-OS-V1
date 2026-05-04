// Settings → Voice & Avatar (FIX 0C.7)
// Unified setup page where agents record voice → ElevenLabs clone → D-ID avatar
// linked. Used across podcast, video, AI ISA, and chat widget per kernel-OS plan.

import { Suspense } from "react"
import { redirect } from "next/navigation"
import { Loader2 } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { VoiceCloneClient } from "@/app/dashboard/videos/voice/voice-client"
import { getVoiceProfiles } from "@/app/actions/video-voice"

export const metadata = {
  title: "Voice & Avatar Setup | Settings",
  description:
    "Record your voice clone and upload your avatar — used across podcast, video, AI ISA, and chat widget.",
}

async function VoiceAvatarContent() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

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
            Voice & Avatar setup is only available for agents. Please complete your agent profile first.
          </p>
        </div>
      </div>
    )
  }

  const voiceProfiles = await getVoiceProfiles(agentData.id)
  const heygenConfigured = !!process.env.HEYGEN_API_KEY

  return (
    <VoiceCloneClient
      agentId={agentData.id}
      brokerageId={agentData.brokerage_id}
      userId={user.id}
      initialProfiles={voiceProfiles}
      heygenConfigured={heygenConfigured}
    />
  )
}

export default function VoiceAvatarSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <VoiceAvatarContent />
    </Suspense>
  )
}
