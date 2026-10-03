"use client"

/**
 * app/dashboard/admin/billing/revenue-summary-card.tsx
 *
 * PLATFORM revenue summary — MRR / ARR / churn across every tenant, aggregated
 * by subscription tier. This is the surface `loadRevenueSummaryAction` was
 * written for: the action existed with a superadmin gate on it and no caller,
 * so the only cross-tenant revenue read in the product was unreachable.
 *
 * SCOPE: this is deliberately mounted ONLY when the billing workspace has
 * resolved the viewer as platform superadmin. The gate is not decorative —
 * `loadRevenueSummaryAction` re-checks (user_type superadmin OR
 * platform_role='superadmin') server-side and refuses everyone else, so a
 * tenant billing admin who reached this component would get "Forbidden",
 * never another brokerage's numbers.
 */

import { useState, useTransition } from "react"
import { loadRevenueSummaryAction } from "@/app/actions/admin/billing"

type SummaryRow = {
  aggregateKey: string
  count: number
  mrrCents: number
  arrCents: number
  churnRate: number
}

function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

/** ISO date N days back / today, as the action's date validator expects. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

export function RevenueSummaryCard() {
  const [isPending, startTransition] = useTransition()
  const [rows, setRows] = useState<SummaryRow[] | null>(null)
  const [total, setTotal] = useState<{ mrrCents: number; arrCents: number; churnRate: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [windowDays, setWindowDays] = useState(90)

  function load(days: number): void {
    setWindowDays(days)
    startTransition(async () => {
      setError(null)
      const result = await loadRevenueSummaryAction({
        dateRange: { from: isoDaysAgo(days), to: new Date().toISOString() },
        aggregateBy: "tier",
      })
      // The action RETURNS its refusal ("Forbidden: superadmin only",
      // "Invalid date format", a failed subscriptions read) rather than
      // throwing. Rendering an empty table for a refusal would report
      // "no revenue" for a query that was never allowed to run.
      if (!result.success) {
        setRows(null)
        setTotal(null)
        setError(result.error ?? "Revenue summary could not be loaded.")
        return
      }
      setRows(result.summary ?? [])
      setTotal(result.total ?? null)
    })
  }

  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Platform revenue</h3>
          <p className="text-xs text-gray-600">MRR / ARR / churn across all tenants, by tier</p>
        </div>
        <div className="flex gap-1">
          {[30, 90, 365].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => load(d)}
              disabled={isPending}
              className={`px-2 py-1 text-xs rounded border ${
                windowDays === d && rows !== null ? "bg-gray-900 text-white" : "bg-white text-gray-700"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {isPending && <p className="mt-4 text-sm text-gray-500">Loading…</p>}

      {error && !isPending && (
        <p className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>
      )}

      {!isPending && !error && rows === null && (
        <p className="mt-4 text-sm text-gray-500">Pick a window to load the summary.</p>
      )}

      {!isPending && !error && rows !== null && (
        <>
          {total && (
            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="rounded border p-3">
                <p className="text-xs text-gray-500">MRR</p>
                <p className="text-lg font-semibold">{money(total.mrrCents)}</p>
              </div>
              <div className="rounded border p-3">
                <p className="text-xs text-gray-500">ARR</p>
                <p className="text-lg font-semibold">{money(total.arrCents)}</p>
              </div>
              <div className="rounded border p-3">
                <p className="text-xs text-gray-500">Churn</p>
                <p className="text-lg font-semibold">{pct(total.churnRate)}</p>
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500">
              No subscriptions were created in this window.
            </p>
          ) : (
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="py-1">Tier</th>
                  <th className="py-1 text-right">Subs</th>
                  <th className="py-1 text-right">MRR</th>
                  <th className="py-1 text-right">ARR</th>
                  <th className="py-1 text-right">Churn</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.aggregateKey} className="border-t">
                    <td className="py-1.5">{r.aggregateKey ?? "untiered"}</td>
                    <td className="py-1.5 text-right">{r.count}</td>
                    <td className="py-1.5 text-right">{money(r.mrrCents)}</td>
                    <td className="py-1.5 text-right">{money(r.arrCents)}</td>
                    <td className="py-1.5 text-right">{pct(r.churnRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
