"use client"

import { cn } from "@/lib/utils"

interface Offer {
  id: string
  offer_number: string | null
  offer_price: number
  earnest_money: number | null
  closing_date: string | null
  financing_type: string | null
  down_payment_percent: number | null
  appraisal_contingency_days: number | null
  financing_contingency_days: number | null
  inspection_period_days: number | null
  escalation_clause: boolean | null
  escalation_cap: number | null
  appraisal_gap: number | null
  closing_cost_contribution: number | null
  seller_net_estimate: number | null
  current_round: number | null
  offer_type: string | null
  parent_offer_id: string | null
}

interface Props {
  offers: Offer[]
  listPrice: number
  aiResult: Record<string, unknown> | null
}

function fmt(n: number | null | undefined) {
  return n != null ? `$${Number(n).toLocaleString()}` : "—"
}

function fmtDays(n: number | null | undefined) {
  return n != null ? `${n}d` : "None"
}

// Returns index of the "best" value (highest or lowest as appropriate)
function bestIndex(values: (number | null)[], higher = true): number {
  const nums = values.map((v) => v ?? (higher ? -Infinity : Infinity))
  const best = higher ? Math.max(...nums) : Math.min(...nums)
  return nums.indexOf(best)
}

type Row = {
  label: string
  group: string
  getValue: (o: Offer) => string
  rawValue: (o: Offer) => number | null
  higherIsBetter: boolean
}

const ROWS: Row[] = [
  // Financial
  { label: "Offer Price",          group: "Financial",     getValue: (o) => fmt(o.offer_price),           rawValue: (o) => o.offer_price,               higherIsBetter: true  },
  { label: "Earnest Money",        group: "Financial",     getValue: (o) => fmt(o.earnest_money),         rawValue: (o) => o.earnest_money,             higherIsBetter: true  },
  { label: "Down Payment",         group: "Financial",     getValue: (o) => o.down_payment_percent != null ? `${o.down_payment_percent}%` : "—", rawValue: (o) => o.down_payment_percent, higherIsBetter: true },
  { label: "Seller Concessions",   group: "Financial",     getValue: (o) => fmt(o.closing_cost_contribution), rawValue: (o) => o.closing_cost_contribution, higherIsBetter: false },
  { label: "Net to Seller",        group: "Financial",     getValue: (o) => fmt(o.seller_net_estimate),   rawValue: (o) => o.seller_net_estimate,       higherIsBetter: true  },
  // Timeline
  { label: "Closing Date",         group: "Timeline",      getValue: (o) => o.closing_date ? new Date(o.closing_date).toLocaleDateString() : "—", rawValue: (o) => o.closing_date ? new Date(o.closing_date).getTime() : null, higherIsBetter: false },
  { label: "Inspection Period",    group: "Timeline",      getValue: (o) => fmtDays(o.inspection_period_days), rawValue: (o) => o.inspection_period_days, higherIsBetter: false },
  // Contingencies
  { label: "Financing Contingency", group: "Contingencies", getValue: (o) => fmtDays(o.financing_contingency_days), rawValue: (o) => o.financing_contingency_days, higherIsBetter: false },
  { label: "Appraisal Contingency", group: "Contingencies", getValue: (o) => fmtDays(o.appraisal_contingency_days), rawValue: (o) => o.appraisal_contingency_days, higherIsBetter: false },
  { label: "Escalation Clause",    group: "Contingencies", getValue: (o) => o.escalation_clause ? `Yes (cap ${fmt(o.escalation_cap)})` : "No", rawValue: (o) => o.escalation_clause ? 1 : 0, higherIsBetter: true },
  { label: "Appraisal Gap",        group: "Contingencies", getValue: (o) => fmt(o.appraisal_gap),         rawValue: (o) => o.appraisal_gap,             higherIsBetter: true  },
]

export function OfferComparisonMatrix({ offers, listPrice, aiResult }: Props) {
  if (offers.length < 2) return null

  const groups = [...new Set(ROWS.map((r) => r.group))]
  const rankedIds = (aiResult?.ranked_offer_ids as string[] | undefined) ?? []

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-muted/40">
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-48 sticky left-0 bg-muted/40">
              Term
            </th>
            {offers.map((o, idx) => (
              <th key={o.id} className="px-4 py-3 text-center font-medium text-foreground min-w-[160px]">
                <div className="flex flex-col items-center gap-1">
                  <span>{o.offer_number ?? `Offer ${idx + 1}`}</span>
                  {o.offer_type === "counter" && (
                    <span className="text-xs font-normal text-muted-foreground">Round {o.current_round}</span>
                  )}
                  {rankedIds.length > 0 && (
                    <span className={cn(
                      "text-xs font-semibold px-1.5 py-0.5 rounded-full",
                      rankedIds[0] === o.id
                        ? "bg-green-100 text-green-700"
                        : "bg-muted text-muted-foreground"
                    )}>
                      #{rankedIds.indexOf(o.id) + 1}
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const groupRows = ROWS.filter((r) => r.group === group)
            return groupRows.map((row, ri) => {
              const rawValues = offers.map((o) => row.rawValue(o))
              const bestIdx = rawValues.every((v) => v == null) ? -1 : bestIndex(rawValues, row.higherIsBetter)

              return (
                <tr
                  key={row.label}
                  className={cn(
                    ri === 0 ? "border-t-2 border-border" : "border-t border-border/50",
                    "hover:bg-muted/20 transition-colors"
                  )}
                >
                  <td className="px-4 py-2.5 text-muted-foreground sticky left-0 bg-background">
                    {ri === 0 && (
                      <span className="block text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-0.5">
                        {group}
                      </span>
                    )}
                    {row.label}
                  </td>
                  {offers.map((o, oi) => (
                    <td
                      key={o.id}
                      className={cn(
                        "px-4 py-2.5 text-center font-medium",
                        oi === bestIdx && rawValues[oi] != null
                          ? "bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400"
                          : "text-foreground"
                      )}
                    >
                      {row.getValue(o)}
                    </td>
                  ))}
                </tr>
              )
            })
          })}
        </tbody>
      </table>
    </div>
  )
}
