"use client"

/**
 * ShellContext — global state for the universal shell.
 *
 * Exposes open/close state for the unified inbox slide-out, the AI Copilot
 * panel toggle, and voice/chat assistant triggers. Wired into AppShell so
 * any descendant page or component can call `useShell()` to open these
 * surfaces from anywhere — header buttons, ⌘K verbs, contextual CTAs.
 *
 * Keyboard shortcuts registered globally:
 *   `U`       — toggle unified inbox slide-out
 *   `Cmd+K`   — command palette (already registered elsewhere)
 *   `?`       — keyboard help (future)
 */

import { createContext, useContext, useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"

interface ShellContextValue {
  inboxOpen: boolean
  setInboxOpen: (open: boolean) => void
  toggleInbox: () => void

  aiAssistantOpen: boolean
  setAiAssistantOpen: (open: boolean) => void
  toggleAiAssistant: () => void

  voiceListening: boolean
  setVoiceListening: (listening: boolean) => void

  // Track B — on-the-go ElevenLabs Conversational AI overlay (separate from
  // the typed-chat AI panel above). Opens when the FAB is short-tapped.
  voiceOverlayOpen: boolean
  setVoiceOverlayOpen: (open: boolean) => void

  mobileSidebarOpen: boolean
  setMobileSidebarOpen: (open: boolean) => void
  toggleMobileSidebar: () => void
}

const ShellContext = createContext<ShellContextValue | null>(null)

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [inboxOpen, setInboxOpen] = useState(false)
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false)
  const [voiceListening, setVoiceListening] = useState(false)
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  const toggleInbox = useCallback(() => setInboxOpen((prev) => !prev), [])
  const toggleAiAssistant = useCallback(() => setAiAssistantOpen((prev) => !prev), [])
  const toggleMobileSidebar = useCallback(() => setMobileSidebarOpen((prev) => !prev), [])

  const router = useRouter()

  // Register global keyboard shortcuts. Bare-key shortcuts (no modifier) are
  // ignored when typing in an input/textarea/contenteditable.
  //
  // Shortcuts:
  //   U → toggle unified inbox
  //   N → new contact (CRM with create dialog)
  //   F → find — open command palette focused on search
  //   G → gameplan — agent dashboard with brief in focus
  //   C → call queue — AI ISA console
  //   ? → keyboard help (future)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isTyping =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      if (isTyping) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const key = e.key.toLowerCase()
      switch (key) {
        case "u":
          e.preventDefault()
          toggleInbox()
          break
        case "n":
          e.preventDefault()
          router.push("/crm?action=new_contact")
          break
        case "f":
          e.preventDefault()
          // Trigger Cmd+K palette via synthetic keydown so the existing
          // CommandPalette listener picks it up
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
          )
          break
        case "g":
          e.preventDefault()
          router.push("/dashboard/agent")
          break
        case "c":
          e.preventDefault()
          router.push("/dashboard/isa")
          break
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [toggleInbox, router])

  return (
    <ShellContext.Provider
      value={{
        inboxOpen,
        setInboxOpen,
        toggleInbox,
        aiAssistantOpen,
        setAiAssistantOpen,
        toggleAiAssistant,
        voiceListening,
        setVoiceListening,
        voiceOverlayOpen,
        setVoiceOverlayOpen,
        mobileSidebarOpen,
        setMobileSidebarOpen,
        toggleMobileSidebar,
      }}
    >
      {children}
    </ShellContext.Provider>
  )
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext)
  if (!ctx) {
    throw new Error("useShell must be used within <ShellProvider>")
  }
  return ctx
}
