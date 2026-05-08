/**
 * Settings → Assistant Voice
 *
 * Controls what the AGENT THEMSELVES hears in their own AI assistant
 * (morning brief, copilot replies, on-the-go voice). Decoupled from how
 * the agent appears to CONTACTS — that's Twin Studio.
 */

import { Suspense } from "react"
import { redirect } from "next/navigation"
import { Loader2 } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { getMyVoiceAvatarPrefs } from "@/app/actions/voice-avatar-settings"
import { GENERIC_VOICES } from "@/lib/voice/voice-resolver"
import { ListeningPreferencesPanel } from "./listening-preferences-panel"

export const metadata = {
  title: "Assistant Voice | Settings",
  description: "Choose what your AI assistant sounds like when it talks to you.",
}

async function AssistantContent() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const prefs = await getMyVoiceAvatarPrefs()

  if (!prefs) {
    return (
      <div className="text-center py-12 text-sm text-muted-foreground">
        Set up your twin first so we know your voice clone, then come back here to choose how your
        own assistant sounds when it talks to you.
      </div>
    )
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Assistant Voice</h1>
        <p className="text-sm text-muted-foreground mt-1">
          What your AI assistant sounds like when it talks to <strong>you</strong> — your morning
          brief, copilot replies, voice command bar. Separate from how your <em>twin</em> sounds
          to contacts (set up in Twin Studio).
        </p>
      </div>

      <ListeningPreferencesPanel
        initialPrefs={prefs}
        genericVoices={GENERIC_VOICES}
      />
    </div>
  )
}

export default function AssistantSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[40vh] flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <AssistantContent />
    </Suspense>
  )
}
