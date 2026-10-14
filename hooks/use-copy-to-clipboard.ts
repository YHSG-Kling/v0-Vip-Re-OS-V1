"use client"

import { useCallback } from "react"
import { toast } from "sonner"

/**
 * useCopyToClipboard — same-body census, round 4 (2026-09-09, lane FC).
 * Survivor for the byte-identical private `copy`/`copyText` async clipboard
 * helper in app/dashboard/marketing/podcast/components/embed-widget-tab.tsx:82
 * and .../repurpose-tab.tsx:136 — write to the clipboard, toast the given
 * label on success, toast a fixed failure message on any rejection.
 */
export function useCopyToClipboard() {
  return useCallback(async (text: string, label = "Copied") => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(label)
    } catch {
      toast.error("Could not copy")
    }
  }, [])
}
