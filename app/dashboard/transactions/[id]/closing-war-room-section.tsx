// app/dashboard/transactions/[id]/closing-war-room-section.tsx
//
// CLOSING-DAY WAR ROOM — the final-mile cockpit, server-rendered on the deal page
// when the deal is inside the closing window (closing_date within N days). One calm
// surface showing every clear-to-close CONDITION with an honest status badge, the
// REUSED date-chain critical-path timeline, the wire/EMD confirmation, and the OPEN
// ITEMS the Deal Coordinator must drive to done. Pure core (lib/kernel/closing-war-room
// + the watchtower critical path) does all the work; this renders real data, no
// placeholders. Outside the window (or no closing date) it renders nothing.

import {
  buildConditions,
  closingReadiness,
  assembleOpenItems,
  daysToClose,
  inClosingWindow,
  type WarRoomSignals,
  type ConditionStatus,
  type OpenItem,
} from "@/lib/kernel/closing-war-room"
import {
  buildDateChain,
  computeCriticalPath,
  fmtChainDate,
  type ChainSeverity,
} from "@/lib/kernel/title-closing-watchtower"

const STATUS_BADGE: Record<ConditionStatus, { label: string; className: string }> = {
  done:    { label: "Done",      className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  open:    { label: "Open",      className: "bg-amber-100 text-amber-800 border-amber-200" },
  unknown: { label: "Unconfirmed", className: "bg-muted text-muted-foreground border-border" },
}

const SEVERITY_BADGE: Record<ChainSeverity, { label: string; className: string }> = {
  ok:      { label: "On track", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  tight:   { label: "Tight",    className: "bg-amber-100 text-amber-800 border-amber-200" },
  at_risk: { label: "At risk",  className: "bg-red-100 text-red-800 border-red-200" },
}

const ITEM_SEVERITY_BADGE: Record<OpenItem["severity"], string> = {
  urgent: "bg-red-100 text-red-800 border-red-200",
  high:   "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low:    "bg-muted text-muted-foreground border-border",
}

export function ClosingWarRoomSection({
  milestones,
  lender,
  titleEscrow,
  signatures,
  docAudit = null,
  tasks,
  pendingActions,
  closeDate,
  now,
  windowDays,
}: {
  milestones: WarRoomSignals["milestones"]
  lender: WarRoomSignals["lender"]
  titleEscrow: WarRoomSignals["titleEscrow"]
  signatures: WarRoomSignals["signatures"]
  docAudit?: WarRoomSignals["docAudit"]
  tasks: Array<{ id: string; title: string | null; status: string | null; priority: string | null; due_date: string | null; assigned_to: string | null }>
  pendingActions: Array<{ id: string; headline: string | null; severity: string | null; due_date: string | null; suggested_recipient: string | null; status: string | null }>
  closeDate: string | null
  now?: Date
  windowDays?: number
}) {
  const at = now ?? new Date()
  const chain = buildDateChain(milestones)
  const path = computeCriticalPath(chain, at)
  const closingDate = path?.closingDate ?? closeDate

  // The war room only surfaces inside the closing window — otherwise the watchtower /
  // pit-stop sections upstream carry the deal. Honest: no closing date → nothing here.
  if (!inClosingWindow(closingDate, at, windowDays)) return null

  const signals: WarRoomSignals = { milestones, lender, titleEscrow, signatures, docAudit }
  const conditions = buildConditions(signals, chain)
  const readiness = closingReadiness(conditions)
  const openItems = assembleOpenItems({ conditions, tasks, pendingActions })
  const dtc = daysToClose(closingDate, at)

  const headlineClass = readiness.ready
    ? "bg-emerald-100 text-emerald-800 border-emerald-200"
    : "bg-amber-100 text-amber-800 border-amber-200"

  return (
    <section className="border-b bg-background px-4 py-4 sm:px-6" data-testid="closing-war-room">
      {/* Header — the one-glance verdict */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Closing-Day War Room</h2>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${headlineClass}`}>
          {readiness.ready ? "Clear to close" : `${readiness.blockers.length} blocker${readiness.blockers.length === 1 ? "" : "s"}`}
        </span>
        <span className="text-xs text-muted-foreground">
          {readiness.doneCount}/{readiness.requiredCount} conditions met
          {closingDate ? ` · closing ${fmtChainDate(closingDate)}${dtc !== null ? ` (${dtc}d out)` : ""}` : ""}
          {readiness.unknownCount > 0 ? ` · ${readiness.unknownCount} unconfirmed` : ""}
        </span>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-3">
        {/* Conditions checklist */}
        <div className="lg:col-span-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Clear-to-close conditions</h3>
          <ul className="mt-2 divide-y rounded-md border">
            {conditions.map((c) => (
              <li key={c.key} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{c.label}</span>
                    <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] ${STATUS_BADGE[c.status].className}`}>
                      {STATUS_BADGE[c.status].label}
                    </span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{c.detail}</div>
                </div>
                {c.status !== "done" && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">owner: {c.owner}</span>
                )}
              </li>
            ))}
          </ul>
        </div>

        {/* Critical-path timeline (REUSED watchtower core) */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Day-of timeline</h3>
          <div className="mt-2 rounded-md border p-3">
            {path ? (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${SEVERITY_BADGE[path.severity].className}`}>
                    {SEVERITY_BADGE[path.severity].label}
                  </span>
                  {path.bindingLabel && (
                    <span className="text-[10px] text-muted-foreground">
                      Binding: {path.bindingLabel}{path.slackDays !== null ? ` · ${path.slackDays}d slack` : ""}
                    </span>
                  )}
                </div>
                <ol className="space-y-1">
                  {path.steps.map((s) => (
                    <li key={s.key} className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium">{s.label}</span>
                      <span className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">{fmtChainDate(s.date)}</span>
                        {s.completed ? (
                          <span className="inline-flex items-center rounded-full border px-1.5 py-px text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">Done</span>
                        ) : s.severity ? (
                          <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] ${SEVERITY_BADGE[s.severity].className}`}>
                            {SEVERITY_BADGE[s.severity].label}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No closing date on file — timeline unavailable.</p>
            )}
          </div>

          {/* Wire / EMD confirmation strip */}
          <div className="mt-3 rounded-md border p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Wire &amp; earnest money</h3>
            <ul className="mt-2 space-y-1">
              {conditions
                .filter((c) => c.key === "earnest_money" || c.key === "wire_closing_scheduled")
                .map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">{c.label}</span>
                    <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] ${STATUS_BADGE[c.status].className}`}>
                      {STATUS_BADGE[c.status].label}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Open items — the drive-to-done list */}
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Open items {openItems.length > 0 ? `(${openItems.length})` : ""}
        </h3>
        {openItems.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Nothing open — every tracked condition and task is done.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {openItems.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-medium ${ITEM_SEVERITY_BADGE[item.severity]}`}>
                    {item.severity}
                  </span>
                  <span className="truncate text-sm">{item.headline}</span>
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {item.owner}{item.dueDate ? ` · due ${fmtChainDate(item.dueDate)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
