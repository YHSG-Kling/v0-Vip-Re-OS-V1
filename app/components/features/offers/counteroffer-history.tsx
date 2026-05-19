"use client"

/**
 * app/components/features/offers/counteroffer-history.tsx
 *
 * Renders the full negotiation chain for a single offer.
 * Counter history is stored in the `offers` table via parent_offer_id + offer_type='counter'.
 * Data is passed from the server — no client-side fetching.
 */

import { cn }       from "@/lib/utils"
import type { OfferRow } from "@/lib/kernel/offer-types"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(value: number | null) {
  if (value === null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value)
}

function formatDate(iso: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// ─── Status pill ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  draft:     "bg-muted text-muted-foreground border-border",
  pending:   "bg-amber-50 text-amber-700 border-amber-200",
  submitted: "bg-blue-50 text-blue-700 border-blue-200",
  sent:      "bg-blue-50 text-blue-700 border-blue-200",
  countered: "bg-purple-50 text-purple-700 border-purple-200",
  accepted:  "bg-green-50 text-green-700 border-green-200",
  rejected:  "bg-red-50 text-red-700 border-red-200",
  withdrawn: "bg-muted text-muted-foreground border-border",
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
      STATUS_STYLES[status] ?? "bg-muted text-muted-foreground border-border"
    )}>
      {status}
    </span>
  )
}

// ─── Offer type label ─────────────────────────────────────────────────────────

function OfferTypeLabel({ type, round }: { type: string | null; round: number | null }) {
  if (type === "counter") return (
    <span className="text-xs font-semibold text-purple-700">Counter Round {round ?? "?"}</span>
  )
  return <span className="text-xs font-semibold text-foreground">Original Offer</span>
}

// ─── Single history row ───────────────────────────────────────────────────────

function HistoryRow({
  row,
  isCurrent,
}: {
  row: OfferRow
  isCurrent: boolean
}) {
  return (
    <div className={cn(
      "flex flex-col gap-2 rounded-lg border p-4 transition-colors",
      isCurrent
        ? "border-primary/30 bg-primary/5"
        : "border-border bg-background hover:bg-muted/30"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <OfferTypeLabel type={row.offer_type ?? null} round={row.current_round ?? null} />
          {isCurrent && (
            <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              Current
            </span>
          )}
        </div>
        <StatusPill status={row.status} />
      </div>

      {/* Key terms grid */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Offer Price</dt>
          <dd className="text-sm font-semibold text-foreground">{formatCurrency(row.offer_price)}</dd>
        </div>
        {row.earnest_money !== null ? (
          <div>
            <dt className="text-xs text-muted-foreground">Earnest Money</dt>
            <dd className="text-sm font-medium">{formatCurrency(row.earnest_money)}</dd>
          </div>
        ) : null}
        {row.closing_date && (
          <div>
            <dt className="text-xs text-muted-foreground">Closing Date</dt>
            <dd className="text-sm font-medium">{formatDate(row.closing_date)}</dd>
          </div>
        )}
        {row.financing_type && (
          <div>
            <dt className="text-xs text-muted-foreground">Financing</dt>
            <dd className="text-sm font-medium capitalize">{row.financing_type}</dd>
          </div>
        )}
        {row.responded_at && (
          <div>
            <dt className="text-xs text-muted-foreground">Responded</dt>
            <dd className="text-sm font-medium">{formatDate(row.responded_at)}</dd>
          </div>
        )}
        {row.submitted_at && (
          <div>
            <dt className="text-xs text-muted-foreground">Submitted</dt>
            <dd className="text-sm font-medium">{formatDate(row.submitted_at)}</dd>
          </div>
        )}
      </dl>

      {/* Contingencies */}
      {Array.isArray(row.contingencies) && row.contingencies.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {row.contingencies.map((c) => (
            <span
              key={c}
              className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground capitalize"
            >
              {c.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}

      {/* Notes */}
      {(row.notes || row.buyer_notes) && (
        <p className="text-xs text-muted-foreground leading-relaxed border-t border-border pt-2 mt-1">
          {row.notes ?? row.buyer_notes}
        </p>
      )}

      {/* AI recommendation */}
      {row.ai_recommendation && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 leading-relaxed mt-1">
          <span className="font-semibold">AI Note: </span>{row.ai_recommendation}
        </div>
      )}
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

interface CounterOfferHistoryProps {
  history:        OfferRow[]
  currentOfferId: string
}

export function CounterOfferHistory({ history, currentOfferId }: CounterOfferHistoryProps) {
  if (!history || history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
        <p className="text-sm text-muted-foreground">No negotiation history for this offer.</p>
        <p className="text-xs text-muted-foreground">Counter-offers will appear here when issued.</p>
      </div>
    )
  }

  // Sort: original first, then counters ascending by round
  const sorted = [...history].sort((a, b) => {
    const aRound = a.offer_type === "counter" ? (a.current_round ?? 99) : 0
    const bRound = b.offer_type === "counter" ? (b.current_round ?? 99) : 0
    return aRound - bRound
  })

  const priceRange = {
    min: Math.min(...sorted.map((r) => r.offer_price)),
    max: Math.max(...sorted.map((r) => r.offer_price)),
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 px-4 py-3">
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Negotiation Summary</p>
          <p className="text-sm font-medium text-foreground">
            {sorted.length} {sorted.length === 1 ? "round" : "rounds"} — from{" "}
            <span className="font-semibold">{formatCurrency(priceRange.min)}</span>
            {priceRange.min !== priceRange.max && (
              <> to <span className="font-semibold">{formatCurrency(priceRange.max)}</span></>
            )}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {sorted.filter((r) => r.offer_type === "counter").length} counter-offer(s)
        </span>
      </div>

      {/* Timeline */}
      <div className="relative space-y-3">
        {/* Connector line */}
        {sorted.length > 1 && (
          <div className="absolute left-4 top-8 bottom-8 w-px bg-border" aria-hidden />
        )}
        {sorted.map((row) => (
          <HistoryRow
            key={row.id}
            row={row}
            isCurrent={row.id === currentOfferId}
          />
        ))}
      </div>
    </div>
  )
}
