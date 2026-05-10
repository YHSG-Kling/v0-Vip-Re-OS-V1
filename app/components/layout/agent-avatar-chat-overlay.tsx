"use client"

/**
 * <AgentAvatarChatOverlay> — visual desk assistant for staff users.
 *
 * Reuses the existing AgentsWidget (D-ID streaming avatar + ElevenLabs
 * voice clone + custom-LLM route at /api/did/custom-llm). The widget
 * was originally built for the buyer/seller portal; here we mount it
 * agent-facing by passing the agent's own user_id as the synthetic
 * context. The custom-LLM route handles unrecognized contact ids
 * gracefully and operates as a general desk assistant.
 *
 * Slot is collapsed/floating: bottom-right card, large enough to see
 * the avatar but not blocking the main page.
 *
 * Show/hide controlled by useShell().avatarChatOpen so the chat FAB and
 * any ⌘K verbs can open it from anywhere.
 */

import { Suspense, lazy } from "react"
import { X, Loader2 } from "lucide-react"
import { useShell } from "./shell-context"
import { Button } from "@/components/ui/button"

// Lazy-load the heavy D-ID SDK — it's ~150KB and we only want it on demand
const AgentsWidget = lazy(() =>
  import("@/app/components/features/ai-avatar-chat/AgentsWidget").then(m => ({
    default: m.AgentsWidget,
  })),
)

interface Props {
  agentUserId?:    string
  agentFirstName?: string
}

export function AgentAvatarChatOverlay({ agentUserId, agentFirstName }: Props) {
  const { avatarChatOpen, setAvatarChatOpen } = useShell()

  if (!avatarChatOpen) return null

  return (
    <div
      className="fixed z-50 right-6 bottom-44 sm:bottom-48 w-[360px] max-w-[calc(100vw-3rem)]
                 rounded-2xl shadow-2xl border bg-background overflow-hidden flex flex-col"
      style={{ height: "min(560px, calc(100vh - 12rem))" }}
    >
      <div className="flex items-center justify-between px-4 py-2 border-b bg-violet-50 dark:bg-violet-950/30">
        <span className="text-sm font-semibold">AI Avatar Assistant</span>
        <Button variant="ghost" size="sm" onClick={() => setAvatarChatOpen(false)} className="h-7 w-7 p-0">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-hidden">
        {agentUserId ? (
          <Suspense fallback={
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading avatar…
            </div>
          }>
            <AgentsWidget
              contactId={agentUserId}
              agentFirstName={agentFirstName ?? "Agent"}
              onFallbackToText={() => setAvatarChatOpen(false)}
            />
          </Suspense>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground p-4 text-center">
            Sign in to use the avatar chat.
          </div>
        )}
      </div>
    </div>
  )
}
