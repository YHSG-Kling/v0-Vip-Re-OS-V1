// app/dashboard/transactions/[id]/financing-pit-stop-section.tsx
//
// FINANCING PIT STOP — server-rendered RATE/lender status on the deal detail page.
// Complementary to the Title & Closing Watchtower section (which renders the DATE
// chain): this works the RATE/lender side. It shows whether the deal is in the
// FINANCING WINDOW (financing milestone approaching, or the buyer's pre-approval going
// stale — REAL stored dates only), the lender race status, and the known lender
// quote(s) ranked by lowest EFFECTIVE COST with a severity badge. Rates are labeled
// ESTIMATES (not commitments). Deals with no financing date AND no pre-approval expiry
// say so honestly — nothing is fabricated. Pure core shared with the 6h cron.

import {
  financingWindow,
  rankLenderQuotes,
  type FinancingDates,
  type LenderQuote,
  type FinancingTrigger,
} from "@/lib/kernel/financing-pit-stop"

function fmtRate(n: number | null): string {
  if (n == null) return "—"
  return `${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`
}

const TRIGGER_LABEL: Record<FinancingTrigger, string> = {
  financing_deadline: "Financing milestone approaching",
  preapproval_stale: "Pre-approval going stale",
}

export function FinancingPitStopSection({
  financingDeadline,
  preApprovalExpiresAt,
  isCashBuyer,
  lenderQuotes,
  now,
}: {
  financingDeadline: string | null
  preApprovalExpiresAt: string | null
  isCashBuyer: boolean | null
  /** The deal's known lender quote(s) — transaction_lenders rows (real columns). */
  lenderQuotes: LenderQuote[]
  now?: Date
}) {
  const dates: FinancingDates = { financingDeadline, preApprovalExpiresAt, isCashBuyer }

  // No financing date AND no pre-approval expiry → nothing honest to show.
  if (!financingDeadline && !preApprovalExpiresAt) return null

  const w = financingWindow(dates, now ?? new Date())
  const ranked = rankLenderQuotes(lenderQuotes)
  const best = ranked.find((q) => q.rate != null) ?? null

  // Severity: in-window with a primary trigger under pressure → amber; an already-stale
  // pre-approval → red; not yet in the window → neutral.
  const stalePreApproval = w.daysToPreApprovalExpiry != null && w.daysToPreApprovalExpiry < 0
  const badge = !w.inWindow
    ? { label: "Monitoring", className: "bg-muted text-muted-foreground" }
    : stalePreApproval
      ? { label: "Refresh now", className: "bg-red-100 text-red-800 border-red-200" }
      : { label: "In financing window", className: "bg-amber-100 text-amber-800 border-amber-200" }

  return (
    <section className="border-b bg-background px-4 py-3 sm:px-6" data-testid="financing-pit-stop">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Financing Pit Stop</h2>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}>
          {badge.label}
        </span>
        {w.inWindow && w.triggers.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {w.triggers.map((t) => TRIGGER_LABEL[t]).join(" · ")}
            {w.daysToFinancingDeadline != null && w.daysToFinancingDeadline >= 0 && ` · financing in ${w.daysToFinancingDeadline}d`}
            {w.daysToPreApprovalExpiry != null && (
              w.daysToPreApprovalExpiry < 0
                ? ` · pre-approval stale ${Math.abs(w.daysToPreApprovalExpiry)}d`
                : ` · pre-approval in ${w.daysToPreApprovalExpiry}d`
            )}
          </span>
        )}
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        {ranked.length > 0 ? (
          <>
            <span className="font-medium text-foreground">Lender quotes ranked by effective cost</span>
            <span className="ml-1">(estimates, not commitments):</span>
          </>
        ) : (
          <span>No lender quotes on file yet — the rate-refresh race surfaces them as lenders respond.</span>
        )}
      </div>

      {ranked.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
          {ranked.map((q, i) => (
            <div key={q.id} className="flex items-center gap-1.5 text-xs">
              <span className="font-medium">{q.lenderName ?? "Lender"}</span>
              <span className="inline-flex items-center rounded-full border px-1.5 py-px text-[10px] bg-muted text-muted-foreground">
                {q.source === "on_file" ? "on file" : "bench"}
              </span>
              <span className="text-muted-foreground">{fmtRate(q.rate)}</span>
              {q.rate != null && Number.isFinite(q.effectiveRate) && (
                <span className="text-muted-foreground">(≈{fmtRate(q.effectiveRate)} eff.)</span>
              )}
              {i === 0 && q.rate != null && (
                <span className="inline-flex items-center rounded-full border px-1.5 py-px text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
                  Lowest cost
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {best && (
        <div className="mt-1 text-xs text-muted-foreground">
          Best estimate so far: <span className="font-medium text-foreground">{best.lenderName ?? "a preferred lender"}</span> at {fmtRate(best.rate)} — an estimate, not a final offer.
        </div>
      )}
    </section>
  )
}
