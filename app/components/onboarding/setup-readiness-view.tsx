import Link from "next/link"
import type { SetupReadiness } from "@/lib/onboarding/setup-readiness"

/**
 * Presentational setup-readiness card (no data access, no hooks) — safe to render from both a server
 * component (SetupReadinessCard) and a client component (SetupReadinessCardClient). Renders nothing once
 * required + optional setup are fully done.
 */
export function SetupReadinessCardView({ readiness }: { readiness: SetupReadiness }) {
  if (readiness.isComplete && readiness.optionalDone === readiness.optionalTotal) return null

  const remainingRequired = readiness.items.filter((i) => i.required && !i.done)
  const complete = readiness.isComplete
  const optionalLeft = readiness.optionalTotal - readiness.optionalDone

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{complete ? "Finish polishing your setup" : "Complete your setup"}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {complete
              ? `Required setup done — ${optionalLeft} optional item${optionalLeft === 1 ? "" : "s"} left to sharpen your AI team.`
              : `${readiness.requiredDone} of ${readiness.requiredTotal} required steps done — a few more and your AI team is working for you.`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-2xl font-bold tabular-nums">{readiness.pct}%</div>
          <div className="text-[11px] text-muted-foreground">ready</div>
        </div>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={"h-full rounded-full " + (complete ? "bg-green-500" : "bg-indigo-500")} style={{ width: `${readiness.pct}%` }} />
      </div>

      {readiness.nextAction && (
        <Link href={readiness.nextAction.href} className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2 hover:bg-indigo-50">
          <div className="min-w-0">
            <p className="text-sm font-medium text-indigo-900">Next: {readiness.nextAction.label}</p>
            <p className="truncate text-xs text-indigo-700/80">{readiness.nextAction.why}</p>
          </div>
          <span className="shrink-0 text-sm font-semibold text-indigo-700">Go →</span>
        </Link>
      )}

      {remainingRequired.length > 1 && (
        <ul className="mt-3 space-y-1">
          {remainingRequired.slice(1, 4).map((i) => (
            <li key={i.key} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />{i.label}
            </li>
          ))}
        </ul>
      )}

      <Link href="/dashboard/getting-started" className="mt-3 inline-block text-xs font-medium text-indigo-600 hover:underline">
        View your full setup guide & platform overview →
      </Link>
    </div>
  )
}
