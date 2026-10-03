"use client"

import { useCallback } from "react"
import type { ChangeEvent, Dispatch, SetStateAction } from "react"

/**
 * useFormChange — same-body census, round 4 (2026-09-09, lane FC). Survivor
 * for the byte-identical private `handleChange` in
 * app/components/settings/BrandingForm.tsx:22,
 * app/components/settings/EmailTemplateEditor.tsx:23, and
 * app/components/settings/GeneralSettingsForm.tsx:66 — a controlled-form
 * change handler that merges `{ [e.target.name]: e.target.value }` into
 * whatever `setFormData` state the caller owns.
 */
export function useFormChange<T extends Record<string, unknown>>(setFormData: Dispatch<SetStateAction<T>>) {
  return useCallback(
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const { name, value } = e.target
      setFormData((prev) => ({ ...prev, [name]: value }))
    },
    [setFormData],
  )
}
