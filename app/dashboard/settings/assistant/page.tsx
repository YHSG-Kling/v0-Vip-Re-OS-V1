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
import { listMyTwins } from "@/app/actions/twin-studio"
import { GENERIC_VOICES } from "@/lib/voice/voice-resolver"
import { ListeningPreferencesPanel } from "./listening-preferences-panel"
import { ReplyStylePanel } from "./reply-style-panel"
import { AutoResponsePanel, type AutoResponseSettings } from "./auto-response-panel"
import { getAgentContext } from "@/lib/identity"
import { getAgentChatPreferences } from "@/app/actions/ai-chat"
import { getAutoResponseSettings } from "@/app/actions/ai-auto-response"

export const metadata = {
  title: "Assistant Voice | Settings",
  description: "Choose what your AI assistant sounds like when it talks to you.",
}

async function AssistantContent() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const [prefs, ctx, myTwins] = await Promise.all([
    getMyVoiceAvatarPrefs(),
    getAgentContext(),
    listMyTwins(),
  ])

  // THE FACES THIS AGENT MAY CHOOSE FROM — their OWN twins, ready and approved,
  // and nobody else's. updateMyAssistantAvatar re-checks exactly this server-side
  // (the picker is a convenience, not the boundary), but offering an unusable or
  // unapproved twin here would only teach the agent that the control is broken.
  const assistantAvatarChoices = myTwins.twins
    .filter((t) => t.status === "ready" && t.approvalStatus === "approved" && !!t.didAvatarId)
    .map((t) => ({
      didAvatarId: t.didAvatarId!,
      label: t.label,
      // The re-hosted bucket copy first — the D-ID-side url expires.
      previewUrl: t.avatarUrl ?? t.thumbnailUrl ?? (t.sourceType === "photo" ? t.sourceUrl : null),
      isDefault: t.isDefault,
    }))

  // Reply style is independent of the twin: an agent with no voice clone still
  // drafts replies. The old early-return hid the whole page behind twin setup,
  // so each panel now states its own prerequisite.
  const replyPrefs = ctx.agentId ? await getAgentChatPreferences(ctx.agentId) : null
  const autoResponse = await getAutoResponseSettings()

  return (
    <div className="container mx-auto px-4 py-6 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Assistant</h1>
        <p className="text-sm text-muted-foreground mt-1">
          How your AI works for <strong>you</strong> — what it sounds like in your morning brief and
          copilot, and how it writes the replies it drafts on your behalf. Separate from how your{" "}
          <em>twin</em> sounds to contacts (set up in Twin Studio).
        </p>
      </div>

      {prefs ? (
        <ListeningPreferencesPanel
          initialPrefs={prefs}
          genericVoices={GENERIC_VOICES}
          avatarChoices={assistantAvatarChoices}
        />
      ) : (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Set up your twin first so we know your voice clone, then come back here to choose how your
          own assistant sounds when it talks to you.
        </div>
      )}

      {replyPrefs && ctx.agentId ? (
        <ReplyStylePanel
          agentId={ctx.agentId}
          initialTone={replyPrefs.tone}
          initialModel={replyPrefs.preferred_model}
        />
      ) : (
        <div className="mt-6 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Reply style is set per agent. Your account isn't linked to an agent record yet, so there's
          nothing to configure here.
        </div>
      )}

      {/* Auto-response settings — same "how my AI writes to contacts" family as
          Reply Style. Read + write both live in app/actions/ai-auto-response.ts;
          the settings row is keyed by the session-resolved agent. */}
      {ctx.agentId && autoResponse.success && autoResponse.settings && (
        <AutoResponsePanel initial={autoResponse.settings as AutoResponseSettings} />
      )}
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
