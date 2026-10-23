"use client"

import { useCallback } from "react"
import type { KeyboardEvent } from "react"

/**
 * useEnterToSubmit — same-body census, round 4 (2026-09-09, lane FC).
 * Survivor for the byte-identical private `handleKeyDown` in
 * app/components/portal/MessageComposer.tsx:77 and
 * app/components/shared/internal-ai-assistant.tsx:897 — Enter without Shift
 * submits (`preventDefault` + call `onSubmit`); Shift+Enter is left alone so
 * it still inserts a newline in a textarea.
 */
export function useEnterToSubmit<E extends HTMLElement = HTMLElement>(onSubmit: () => void) {
  return useCallback(
    (e: KeyboardEvent<E>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        onSubmit()
      }
    },
    [onSubmit],
  )
}
