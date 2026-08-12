"use client"

// The per-brokerage drill-down on the support console. This is the door onto
// `app/actions/vendor-budget.ts:getPlatformVendorBudget`, which had no caller —
// so `getVendorSpendBreakdown` (the per-VENDOR figures) was computed by nothing
// and platform staff triaging a brokerage at 98% of its ceiling could see the
// total but never which vendor was burning it.
//
// PRIVACY CONTRACT (lib/vendor-governance/budget-visibility.ts): vendor names and
// dollar figures are PLATFORM-ONLY. The gate lives in the action
// (`isPlatformStaff(actor.userType)`), not here — this component just refuses to
// render anything it was not handed.

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { ChevronDown, ChevronRight } from "lucide-react"
import { getPlatformVendorBudget } from "@/app/actions/vendor-budget"
import type { BudgetView } from "@/lib/vendor-governance/budget-visibility"

interface SpendRow {
  brokerageId: string
  name: string
  planTier: string
  spent: number
  budget: number
  percent: number
  level: string
}

export function VendorBreakdownRow({
  row,
  badge,
}: {
  row: SpendRow
  badge: { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<BudgetView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (!next || view || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await getPlatformVendorBudget(row.brokerageId)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setView(res.view)
    } catch (err: any) {
      setError(err?.message ?? "Could not load the vendor breakdown")
    } finally {
      setLoading(false)
    }
  }

  // Only the platform-scoped view carries vendor names; a brokerage-scoped view
  // would mean the action redacted, and there is nothing to show.
  const vendors = view && view.scope === "platform" ? (view.vendors ?? []) : []

  // HOW WELL THE NUMBERS ARE KNOWN. The budget gate FAILS OPEN by design: when
  // the plan-tier read or the month-to-date ledger read is refused it returns a
  // verdict anyway, with `budget` set to the platform's solo_agent default and
  // `percent` computed against it. Rendered plain, that is indistinguishable
  // from a figure somebody actually read — a support agent triaging "98% of
  // ceiling" would be triaging arithmetic on an assumption. A flag no surface
  // shows is the same defect one layer out, so this is the surface.
  const confidence = view && view.scope === "platform" ? view.confidence : "measured"
  const CONFIDENCE_NOTE: Record<string, string> = {
    assumed_ceiling:
      "Ceiling ASSUMED, not read — this brokerage's plan tier could not be read, so the limit above is the platform default and the percentage is computed against it.",
    unmeasured:
      "NOT MEASURED — the month-to-date spend ledger could not be read. The gate failed open, so this verdict allowed the spend without measuring it; the figures above are not a measurement.",
  }

  return (
    <>
      <tr className="border-b last:border-0">
        <td className="py-2 pr-4">
          <button
            type="button"
            onClick={toggle}
            className="inline-flex items-center gap-1 hover:underline"
            aria-expanded={open}
            aria-label={`Vendor breakdown for ${row.name}`}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {row.name}
          </button>
        </td>
        <td className="py-2 pr-4 text-muted-foreground">{row.planTier}</td>
        <td className="py-2 pr-4 text-right tabular-nums">${row.spent.toFixed(2)}</td>
        <td className="py-2 pr-4 text-right tabular-nums">${row.budget.toFixed(0)}</td>
        <td className="py-2 pr-4 text-right tabular-nums">{row.percent}%</td>
        <td className="py-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </td>
      </tr>
      {open && (
        <tr className="border-b last:border-0 bg-muted/30">
          <td colSpan={6} className="py-2 px-6">
            {loading ? (
              <p className="text-xs text-muted-foreground">Loading vendor breakdown…</p>
            ) : error ? (
              <p className="text-xs text-red-600">Breakdown unavailable: {error}</p>
            ) : (
              <>
                {confidence !== "measured" && (
                  <p className="mb-2 text-xs font-medium text-amber-700">
                    {CONFIDENCE_NOTE[confidence]}
                  </p>
                )}
                {vendors.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No per-vendor spend recorded for this brokerage this month.
                  </p>
                ) : (
                  <ul className="text-xs space-y-1">
                    {vendors.map((v) => (
                      <li key={v.vendor} className="flex justify-between max-w-sm">
                        <span>{v.vendor}</span>
                        <span className="tabular-nums">${v.spent.toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
