"use client"

/**
 * <FloatingChatFAB> — text-only AI chat button on every staff page.
 *
 * The agent does NOT want to see or hear their own cloned avatar/voice
 * talking back to them — that's uncanny-valley territory. So this FAB
 * opens the existing typed-chat <InternalAIAssistant> panel (same brain,
 * same page context, just text). The visual D-ID avatar widget stays
 * mounted in the contact PORTAL only, where customers DO want to see
 * their agent's avatar.
 *
 * Hides on portal routes (those have a customer-facing PortalChatLauncher
 * with the avatar) and on auth pages.
 *
 * Trigger pattern: dispatches `vip:toggle-ai-assistant` on the window —
 * InternalAIAssistant listens for it and toggles its panel open. Avoids
 * threading a controlled `open` prop through every layout caller.
 */

import { MessageSquare } from "lucide-react"
import { usePathname } from "next/navigation"

export function FloatingChatFAB() {
  const pathname = usePathname()

  const hidden =
    !pathname ||
    pathname.startsWith("/portal") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/buyer-intake")

  if (hidden) return null

  function open() {
    window.dispatchEvent(new CustomEvent("vip:toggle-ai-assistant"))
  }

  return (
    <button
      type="button"
      onClick={open}
      aria-label="Open AI chat assistant (text)"
      title="Open AI chat assistant — text only"
      className="
        fixed z-40 right-6 bottom-24 sm:bottom-28
        rounded-full shadow-lg
        h-14 w-14 sm:h-12 sm:w-12
        flex items-center justify-center
        transition-all duration-200
        bg-violet-600 text-white hover:bg-violet-700
      "
    >
      <MessageSquare className="h-5 w-5" />
    </button>
  )
}
