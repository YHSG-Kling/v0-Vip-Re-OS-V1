"use client"

// Deprecate/sunset control for ONE feature flag — the writer half of
// feature_flags.sunset_date (built in orphan tranche X4, 2026-09-01; the
// readers in lib/kernel/0.1-feature-access.ts and
// lib/entitlements/tenant-capabilities.ts gate on this column and it had no
// writer anywhere). Small and honest: a date input plus set/clear, calling the
// superadmin-gated setFeatureSunsetDateAction.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { setFeatureSunsetDateAction } from "@/app/actions/superadmin/feature-sunset"

export function SunsetControl({ featureKey, sunsetDate }: { featureKey: string; sunsetDate: string | null }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [date, setDate] = useState<string>(sunsetDate ?? "")
  const [error, setError] = useState<string | null>(null)

  function submit(next: string | null) {
    setError(null)
    startTransition(async () => {
      const res = await setFeatureSunsetDateAction({ featureKey, sunsetDate: next })
      if (!res.ok) setError(res.error ?? "Failed to update sunset date")
      else router.refresh()
    })
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        disabled={pending}
        className="rounded border px-1 py-0.5 text-[11px] bg-background"
        aria-label={`Sunset date for ${featureKey}`}
      />
      <button
        type="button"
        disabled={pending || !date}
        onClick={() => submit(date)}
        className="rounded border px-1.5 py-0.5 text-[11px] font-medium disabled:opacity-50"
        title="Schedule this flag's sunset — readers treat it as off from this date"
      >
        Set
      </button>
      {sunsetDate && (
        <button
          type="button"
          disabled={pending}
          onClick={() => { setDate(""); submit(null) }}
          className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground disabled:opacity-50"
          title="Clear the scheduled sunset"
        >
          Clear
        </button>
      )}
      {error && <span className="text-[10px] text-red-600">{error}</span>}
    </div>
  )
}
