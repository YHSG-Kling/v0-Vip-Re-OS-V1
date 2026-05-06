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

interface ShellContextValue {
  inboxOpen: boolean
  setInboxOpen: (open: boolean) => void
  toggleInbox: () => void

  aiAssistantOpen: boolean
  setAiAssistantOpen: (open: boolean) => void
  toggleAiAssistant: () => void

  voiceListening: boolean
  setVoiceListening: (listening: boolean) => void

  mobileSidebarOpen: boolean
  setMobileSidebarOpen: (open: boolean) => void
  toggleMobileSidebar: () => void
}

const ShellContext = createContext<ShellContextValue | null>(null)

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [inboxOpen, setInboxOpen] = useState(false)
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false)
  const [voiceListening, setVoiceListening] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  const toggleInbox = useCallback(() => setInboxOpen((prev) => !prev), [])
  const toggleAiAssistant = useCallback(() => setAiAssistantOpen((prev) => !prev), [])
  const toggleMobileSidebar = useCallback(() => setMobileSidebarOpen((prev) => !prev), [])

  // Register global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if typing in an input/textarea/contenteditable
      const target = e.target as HTMLElement
      const isTyping =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      if (isTyping) return

      // Skip if a modifier is pressed (let Cmd+K, etc. flow through)
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === "u" || e.key === "U") {
        e.preventDefault()
        toggleInbox()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [toggleInbox])

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
