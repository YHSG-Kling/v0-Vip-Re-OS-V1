// EXCEPTIONS FIRST (wave 108, lane 108D) — the Command Center leads with ONE sentence ("N activities
// occurred since your last visit. You need to care about M.") and the ranked exceptions, each with
// severity, why, evidence and its one action door. Everything the OS handled on its own collapses
// under "Handled automatically" WITH its counts; a category that could not be read is said, never
// shown as clear. Pure presentation over lib/kernel/exceptions-first.ts ExceptionsFirstView.

import type { ExceptionsFirstView } from "@/lib/kernel/exceptions-first"

const SEVERITY_STYLE: Record<string, string> = {
  critical: "border-red-300 bg-red-50/70 dark:bg-red-950/20",
  high: "border-amber-300 bg-amber-50/60 dark:bg-amber-950/20",
  medium: "border-slate-200 bg-background",
}
const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-amber-600 text-white",
  medium: "bg-slate-600 text-white",
}

export function ExceptionsFirstPanel({ view }: { view: ExceptionsFirstView }) {
  const a = view.activity
  const notClear = view.categories.filter((c) => c.status !== "published")
  return (
    <section className="rounded-lg border-2 border-slate-300 p-4 space-y-3" aria-labelledby="exceptions-first-heading">
      <h2 id="exceptions-first-heading" className="text-lg font-semibold">{view.headline}</h2>
      <p className="text-xs text-muted-foreground">
        Counted: {a.denominator}{a.status === "counted" && a.blindSpots.length > 0 ? ` · blind spots: ${a.blindSpots.join(" · ")}` : ""}
      </p>

      {view.exceptions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing in the {view.categories.filter((c) => c.status === "published").length} categories that could be read needs you right now.
        </p>
      ) : (
        <ol className="space-y-2">
          {view.exceptions.map((x) => (
            <li key={x.key} className={`rounded-md border p-3 ${SEVERITY_STYLE[x.severity]}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  <span className="mr-2 text-muted-foreground">{x.rank}.</span>
                  {x.title}
                </p>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[x.severity]}`}>{x.severity}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{x.why}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                <a className="font-medium text-primary underline" href={x.door.href}>{x.door.label} →</a>
                <span className="text-muted-foreground" title={x.evidence.ids?.join(", ") ?? ""}>
                  Evidence: {x.evidence.count} in {x.evidence.table} ({x.evidence.filter}) via {x.evidence.via}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}

      {notClear.length > 0 && (
        <ul className="text-xs text-muted-foreground space-y-0.5">
          {notClear.map((c) => (
            <li key={c.key}>
              <span className={c.status === "refused" ? "text-red-700 font-medium" : "font-medium"}>{c.label}: {c.status === "refused" ? "could not be read" : "not shown in this scope"}</span>
              {" "}— {c.reason} <span className="opacity-70">(reader: {c.reader})</span>
            </li>
          ))}
        </ul>
      )}

      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Handled automatically — {view.handledAutomatically.total == null ? "count unavailable" : `${view.handledAutomatically.total.toLocaleString("en-US")} activit${view.handledAutomatically.total === 1 ? "y" : "ies"}`}
        </summary>
        {view.handledAutomatically.buckets.length > 0 && (
          <ul className="mt-2 grid grid-cols-1 gap-1 text-xs md:grid-cols-2">
            {view.handledAutomatically.buckets.map((b) => (
              <li key={b.key} className="flex justify-between gap-2">
                <span>{b.label}</span>
                <span className="text-muted-foreground">
                  {b.count.toLocaleString("en-US")} ({Object.entries(b.byStatus).map(([s, n]) => `${n} ${s}`).join(", ")})
                </span>
              </li>
            ))}
            {view.handledAutomatically.unbucketed > 0 && (
              <li className="flex justify-between gap-2"><span>Counted, not bucketed (row cap)</span><span className="text-muted-foreground">{view.handledAutomatically.unbucketed.toLocaleString("en-US")}</span></li>
            )}
          </ul>
        )}
        <ul className="mt-2 text-xs text-muted-foreground">
          {view.categories.filter((c) => c.status === "published").map((c) => (
            <li key={c.key}>{c.label}: {c.count === 0 ? "nothing needs you" : `${c.count} above`}{c.blindSpot ? ` · ${c.blindSpot}` : ""}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">The managers&apos; per-manager standup is below, collapsed.</p>
      </details>
    </section>
  )
}
