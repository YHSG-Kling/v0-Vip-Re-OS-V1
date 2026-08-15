"use client"

import { useEffect, useState } from "react"
import { getOpenAgentActions, type PortalStreamRow } from "@/app/actions/portal-stream"
import { AgentActionDispositionQueue } from "@/app/components/agent/AgentActionDispositionQueue"

/**
 * <OpenActionsCard> — client component that hydrates open agent-action
 * items via the brokerage-wide getOpenAgentActions reader.
 *
 * Mounted near the top of the agent dashboard so the first thing the
 * agent sees on Monday morning is the list of actions the kernel decided
 * need attention — each clearable with one keystroke (Done manually /
 * Do now / Let AI / Dismiss).
 *
 * Hides entirely on inbox-zero.
 */
export function OpenActionsCard() {
  const [rows, setRows] = useState<PortalStreamRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    getOpenAgentActions({ limit: 10 })
      .then((r) => {
        if (!cancelled && r.success) setRows(r.rows ?? [])
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (rows == null) return null      // initial load — no flash
  if (rows.length === 0) return null // inbox zero — hide

  return (
    <AgentActionDispositionQueue
      rows={rows}
      title="What needs your attention"
    />
  )
}
