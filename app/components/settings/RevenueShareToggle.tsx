"use client"

import React, { useEffect, useState } from "react"
import { getRevenueShareSetting, setRevenueShareEnabled } from "@/app/actions/settings/revenue-share-setting"

/**
 * Broker opt-in toggle for agent-to-agent (downline) revenue share. When off, the commission waterfall
 * skips the revenue-share step and the command-center revenue-share board is hidden.
 */
export function RevenueShareToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    getRevenueShareSetting().then((r) => {
      if (r.ok) setEnabled(r.enabled)
      else { setError(r.error ?? "Failed to load"); setEnabled(false) }
    })
  }, [])

  async function toggle() {
    if (enabled === null) return
    const next = !enabled
    setSaving(true); setError("")
    const r = await setRevenueShareEnabled(next)
    setSaving(false)
    if (r.ok) setEnabled(next)
    else setError(r.error ?? "Failed to save")
  }

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Agent revenue share (downline)</h2>
          <p className="text-sm text-gray-600 mt-1">
            Offer agents a share of the production of the agents they recruit (the eXp/REAL model). When on,
            the commission engine pays configured sponsors on every closing and the revenue-share board appears
            in your command center. Leave off if your brokerage doesn&apos;t offer revenue sharing.
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={enabled === null || saving}
          aria-pressed={!!enabled}
          className={
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 " +
            (enabled ? "bg-green-600" : "bg-gray-300")
          }
        >
          <span className={"inline-block h-5 w-5 transform rounded-full bg-white transition-transform " + (enabled ? "translate-x-5" : "translate-x-1")} />
        </button>
      </div>
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
    </div>
  )
}
