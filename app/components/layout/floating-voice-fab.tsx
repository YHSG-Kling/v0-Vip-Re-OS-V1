"use client"

/**
 * <FloatingVoiceFAB> — global mic button on every staff page.
 *
 * Vision: "drives their entire day with voice". Tap from anywhere; the
 * assistant opens in voice mode with the current page's context (contactId /
 * listingId / transactionId derived from the URL) pre-injected so commands
 * like "send Sarah the new listing" work without naming Sarah.
 *
 * Tap behavior (Track B):
 *   - Short tap: opens the ElevenLabs Conversational AI voice overlay
 *     (real-time turn-taking, agent's cloned voice, kernel-validated tools).
 *   - Long press (>500ms): opens the typed-chat AI Copilot panel for noisy
 *     environments where voice isn't practical.
 *
 * Hidden on mobile when the keyboard is up (input focus detected).
 * Hidden on portal routes (contacts have their own DID widget).
 */

import { Mic, MicOff } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { useShell } from "./shell-context"

const LONG_PRESS_MS = 500

export function FloatingVoiceFAB() {
  const {
    voiceOverlayOpen, setVoiceOverlayOpen,
    aiAssistantOpen, setAiAssistantOpen,
  } = useShell()
  const pathname = usePathname()
  const [inputFocused, setInputFocused] = useState(false)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFiredRef = useRef(false)

  // Hide on portal routes (those have a DID widget instead) + auth pages
  const hidden =
    pathname.startsWith("/portal") ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/p/") ||                 // public agent profile
    pathname.startsWith("/home-value") ||         // public home-value page
    pathname.startsWith("/forms") ||              // public forms
    pathname.startsWith("/lm/") ||                // lead magnet landing pages
    pathname.startsWith("/listings/") ||          // public listing pages
    pathname.startsWith("/listing/")

  // Track focus to hide FAB when keyboard is up on mobile
  useEffect(() => {
    function onFocusIn(e: FocusEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        setInputFocused(true)
      }
    }
    function onFocusOut() {
      setInputFocused(false)
    }
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("focusout", onFocusOut)
    return () => {
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("focusout", onFocusOut)
    }
  }, [])

  if (hidden) return null

  function startPress() {
    longPressFiredRef.current = false
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true
      // Long press → typed AI Copilot panel
      setAiAssistantOpen(true)
    }, LONG_PRESS_MS)
  }

  function endPress() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    if (!longPressFiredRef.current) {
      // Short tap → ElevenLabs Conv-AI voice overlay (Track B primary)
      setVoiceOverlayOpen(!voiceOverlayOpen)
    }
  }

  function cancelPress() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  return (
    <button
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      aria-label={voiceOverlayOpen ? "Voice assistant active" : "Tap to talk; long-press to type"}
      title="Tap to talk · Long-press for typed chat"
      className={`
        fixed z-40 right-4 bottom-20 lg:bottom-6
        h-14 w-14 rounded-full shadow-lg flex items-center justify-center
        transition-all duration-200 select-none touch-none
        ${voiceOverlayOpen
          ? "bg-red-500 hover:bg-red-600 animate-pulse"
          : "bg-purple-600 hover:bg-purple-700"}
        ${inputFocused ? "opacity-30 hover:opacity-100" : "opacity-100"}
        ${aiAssistantOpen ? "right-[26rem]" : "right-4"}
      `}
    >
      {voiceOverlayOpen ? (
        <Mic className="h-6 w-6 text-white" />
      ) : (
        <MicOff className="h-6 w-6 text-white" />
      )}
    </button>
  )
}
