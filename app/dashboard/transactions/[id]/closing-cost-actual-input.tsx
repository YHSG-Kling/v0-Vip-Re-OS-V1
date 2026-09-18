"use client"

// Inline "record the actual" control for one closing-cost line — the UI half of
// app/actions/transactions/closing-cost-actual.ts (cost_breakdown_tracking.actual_amount).
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { recordClosingCostActualAction } from "@/app/actions/transactions/closing-cost-actual"

export function ClosingCostActualInput({ itemId, actual }: { itemId: string; actual: number | null }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useState<string>(actual === null ? "" : String(actual))
  const [error, setError] = useState<string | null>(null)

  const commit = () => {
    const trimmed = value.trim()
    const next = trimmed === "" ? null : Number(trimmed)
    if (next !== null && !Number.isFinite(next)) { setError("Enter a number"); return }
    if ((actual ?? null) === next) return
    startTransition(async () => {
      setError(null)
      const r = await recordClosingCostActualAction({ itemId, actualAmount: next })
      if (!r.ok) setError(r.error)
      else router.refresh()
    })
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min={0}
        step="1"
        inputMode="decimal"
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur() }}
        placeholder="actual"
        aria-label="Actual amount from the settlement statement"
        className="w-24 rounded border px-1.5 py-0.5 text-xs disabled:opacity-50"
      />
      {error ? <span className="text-[10px] text-destructive">{error}</span> : null}
    </span>
  )
}
