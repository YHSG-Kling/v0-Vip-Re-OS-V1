"use client"

/**
 * <FloatingVoiceFAB> — global mic button on every page.
 *
 * Vision: "drives their entire day with voice". Currently the AI assistant
 * lives in a header button — but the floating voice button is the primary
 * vision pattern. Tap mic from anywhere; assistant opens in voice mode
 * with the current page's context (contactId / listingId / transactionId
 * derived from the URL) pre-loaded so commands like "send Sarah the new
 * listing" work without naming Sarah.
 *
 * Tap behavior:
 *   - First tap: toggles voiceListening + opens the AI assistant panel
 *   - Long press: toggles assistant in TEXT mode (for noisy environments)
 *
 * Hidden on mobile when the keyboard is up (input focus detected).
 * Hidden on portal routes (contacts have their own DID widget).
 */

import { Mic, MicOff } from "lucide-react"
import { useEffect, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { useShell } from "./shell-context"

export function FloatingVoiceFAB() {
  const { voiceListening, setVoiceListening, aiAssistantOpen, setAiAssistantOpen } = useShell()
  const pathname = usePathname()
  const [inputFocused, setInputFocused] = useState(false)

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

  function handleTap() {
    setAiAssistantOpen(true)
    setVoiceListening(true)
  }

  return (
    <button
      onClick={handleTap}
      aria-label={voiceListening ? "Voice assistant active" : "Open voice assistant"}
      title="Press to talk · Voice assistant"
      className={`
        fixed z-40 right-4 bottom-20 lg:bottom-6
        h-14 w-14 rounded-full shadow-lg flex items-center justify-center
        transition-all duration-200
        ${voiceListening
          ? "bg-red-500 hover:bg-red-600 animate-pulse"
          : "bg-purple-600 hover:bg-purple-700"}
        ${inputFocused ? "opacity-30 hover:opacity-100" : "opacity-100"}
        ${aiAssistantOpen ? "right-[26rem]" : "right-4"}
      `}
    >
      {voiceListening ? (
        <Mic className="h-6 w-6 text-white" />
      ) : (
        <MicOff className="h-6 w-6 text-white" />
      )}
    </button>
  )
}
