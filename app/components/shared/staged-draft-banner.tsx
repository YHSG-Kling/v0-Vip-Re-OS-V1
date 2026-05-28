"use client"

/**
 * StagedDraftBanner — drop-in surface that picks up `?<param>=<uuid>` from
 * the URL and renders an actionable banner pointing at the staged draft.
 *
 * Used by content dashboards where the editor's open mechanism is too
 * complex to auto-trigger from a URL param (newsletters, marketing studio,
 * video studio). The chat's Open → button still routes here; this banner
 * tells the agent exactly which row in the list is their fresh draft +
 * scrolls to it.
 *
 * Pairs with the AI Copilot stage_* tools in /api/internal/ai-chat:
 *   - stage_newsletter_draft  → ?draft=<id>
 *   - stage_email_campaign    → ?email_draft=<id>
 *   - stage_video_project     → ?project=<id>
 *
 * The banner is dismissible. Once dismissed, the URL param stays so the
 * agent can refresh; the banner won't reappear until they navigate fresh.
 */

import { useState, useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { Sparkles, X } from "lucide-react"

interface Props {
  /** URL search-param key — e.g. "draft", "episode", "project", "campaign" */
  paramKey: string
  /** Friendly label for what was staged — e.g. "Newsletter draft", "Video project" */
  label: string
  /** Optional explainer text */
  hint?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function StagedDraftBanner({ paramKey, label, hint }: Props) {
  const searchParams = useSearchParams()
  const id = searchParams?.get(paramKey) ?? null
  const validId = id && UUID_RE.test(id) ? id : null

  const [dismissed, setDismissed] = useState(false)

  // Reset dismissal when the URL param changes (agent staged a fresh draft)
  useEffect(() => {
    setDismissed(false)
  }, [validId])

  if (!validId || dismissed) return null

  return (
    <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 mb-4 flex items-start gap-3">
      <Sparkles className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-emerald-900 dark:text-emerald-100">
          {label} staged from voice / Copilot
        </p>
        <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-0.5">
          {hint ?? `Find it in the list below — ID ends in ${validId.slice(-6)}.`}
        </p>
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="text-emerald-700 dark:text-emerald-300 hover:opacity-70 shrink-0"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
