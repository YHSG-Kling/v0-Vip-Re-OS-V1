"use client"

/**
 * <FloatingChatFAB> — D-ID avatar chat button on every staff page.
 *
 * Vision: "💬 DID avatar chat — visual mode for desk work + client demos".
 * Sibling to the existing FloatingVoiceFAB (audio-only). Tapping opens a
 * floating overlay where the agent sees their cloned avatar respond to
 * typed questions, with a voice-mode toggle for live conversation.
 *
 * Hides on portal routes (contacts have their own PortalChatLauncher
 * mounted by /portal/[contactId]/layout.tsx) and on auth pages.
 *
 * The overlay reuses the existing AgentsWidget (D-ID + ElevenLabs voice
 * clone + custom-LLM route) by passing the agent's own user_id as the
 * synthetic context — the custom-LLM route handles missing contact rows
 * gracefully and operates as a general desk assistant.
 */

import { MessageSquare } from "lucide-react"
import { usePathname } from "next/navigation"
import { useShell } from "./shell-context"

export function FloatingChatFAB() {
  const { avatarChatOpen, setAvatarChatOpen } = useShell()
  const pathname = usePathname()

  // Hide on portal routes (those have a PortalChatLauncher) and auth pages
  const hidden =
    !pathname ||
    pathname.startsWith("/portal") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/buyer-intake")

  if (hidden) return null

  return (
    <button
      type="button"
      onClick={() => setAvatarChatOpen(!avatarChatOpen)}
      aria-label="Open AI chat assistant"
      title="Open AI chat assistant — visual avatar"
      className={`
        fixed z-40 right-6 bottom-24 sm:bottom-28
        rounded-full shadow-lg
        h-14 w-14 sm:h-12 sm:w-12
        flex items-center justify-center
        transition-all duration-200
        ${avatarChatOpen
          ? "bg-violet-700 text-white"
          : "bg-violet-600 text-white hover:bg-violet-700"}
      `}
    >
      <MessageSquare className="h-5 w-5" />
    </button>
  )
}
