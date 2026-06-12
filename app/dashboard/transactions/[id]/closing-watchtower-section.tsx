// app/dashboard/transactions/[id]/closing-watchtower-section.tsx
//
// TITLE & CLOSING WATCHTOWER — server-rendered date-chain status on the deal
// detail page. Renders the standard residential chain (inspection → appraisal →
// loan commitment → clear-to-close → closing) from the deal's REAL
// transaction_milestones rows with per-step severity badges and the recomputed
// binding constraint / slack (lib/kernel/title-closing-watchtower pure core —
// the same math the hourly cron alerts on). Deals with no recorded closing date
// say so honestly; nothing is fabricated.

import {
  buildDateChain,
  computeCriticalPath,
  fmtChainDate,
  type ChainSeverity,
} from "@/lib/kernel/title-closing-watchtower"

const SEVERITY_BADGE: Record<ChainSeverity, { label: string; className: string }> = {
  ok:      { label: "On track", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  tight:   { label: "Tight",    className: "bg-amber-100 text-amber-800 border-amber-200" },
  at_risk: { label: "At risk",  className: "bg-red-100 text-red-800 border-red-200" },
}

export function ClosingWatchtowerSection({
  milestones,
  now,
}: {
  milestones: Array<{ milestone_name: string; target_date: string | null; status: string | null }>
  now?: Date
}) {
  const chain = buildDateChain(milestones)
  const hasAnyDate = chain.some((s) => s.date)
  if (!hasAnyDate) return null // no date chain recorded — nothing honest to show

  const path = computeCriticalPath(chain, now ?? new Date())

  return (
    <section className="border-b bg-background px-4 py-3 sm:px-6" data-testid="closing-watchtower">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Title &amp; Closing Watchtower</h2>
        {path ? (
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[path.severity].className}`}>
            {SEVERITY_BADGE[path.severity].label}
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
            No closing date on file
          </span>
        )}
        {path?.bindingLabel && (
          <span className="text-xs text-muted-foreground">
            Binding constraint: {path.bindingLabel}
            {path.slackDays !== null && ` · ${path.slackDays}d slack`}
            {` · closing ${fmtChainDate(path.closingDate)} (${path.daysToClosing}d out)`}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
        {(path ? path.steps : chain.map((s) => ({ ...s, slackDays: null as number | null, severity: null as ChainSeverity | null }))).map((s) => (
          <div key={s.key} className="flex items-center gap-1.5 text-xs">
            <span className="font-medium">{s.label}</span>
            <span className="text-muted-foreground">{fmtChainDate(s.date)}</span>
            {s.completed ? (
              <span className="inline-flex items-center rounded-full border px-1.5 py-px text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">Done</span>
            ) : s.severity ? (
              <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] ${SEVERITY_BADGE[s.severity].className}`}>
                {SEVERITY_BADGE[s.severity].label}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}
