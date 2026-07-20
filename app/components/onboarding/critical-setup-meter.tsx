"use client"

/**
 * THE SETUP METER (owner round 42) — renders the per-tenant critical-setup
 * readiness from lib/onboarding/critical-setup.ts: % complete by category with
 * the honest why-lines for every gap, each linking to the EXISTING settings
 * surface that fills it.
 *
 * Variants:
 *   • "full"    — the brokerage principal's "Finish your setup" card
 *                 (Command Center + the first onboarding surface step).
 *   • "compact" — the per-agent strip on the agent dashboard.
 *
 * DISMISSAL HONESTY: an item can be dismissed (localStorage, per item key) —
 * that only hides its ROW. The category math and overall % come from the
 * server-composed readiness and are NEVER recomputed around dismissals, so a
 * dismissed-but-unconfigured item still counts against the meter.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import type { CriticalSetupReadiness, CriticalCategory } from "@/lib/onboarding/critical-setup"

const DISMISS_KEY = "critical-setup-dismissed:v1"

const CATEGORY_LABELS: Record<CriticalCategory, string> = {
  territory: "Territory", routing: "Lead routing", voice: "Brand & voice",
  connections: "Connections", egress: "Autonomy & egress", seats: "Seats & team",
  billing: "Billing", profile: "Profile & inventory",
}

function loadDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [])
  } catch { return new Set() }
}

function saveDismissed(keys: Set<string>) {
  try { window.localStorage.setItem(DISMISS_KEY, JSON.stringify(Array.from(keys))) } catch { /* UI-only */ }
}

export function CriticalSetupMeter({
  readiness,
  variant = "full",
  heading,
}: {
  readiness: CriticalSetupReadiness
  variant?: "full" | "compact"
  heading?: string
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  useEffect(() => { setDismissed(loadDismissed()) }, [])

  // Fully configured → a single quiet done-line (full) or nothing (compact).
  if (readiness.totalItems === 0) return null
  if (readiness.overallPct >= 100) {
    if (variant === "compact") return null
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 text-sm text-emerald-800">
        <span className="font-semibold">Setup complete</span>
        <span> — all {readiness.totalItems} critical items are configured. Every engine has what it needs.</span>
      </div>
    )
  }

  const dismiss = (key: string) => {
    const next = new Set(dismissed); next.add(key)
    setDismissed(next); saveDismissed(next)
  }

  const gapRows = readiness.categories.flatMap((c) =>
    c.gaps.map((g) => ({ ...g, category: c.category })),
  )
  const visibleGaps = gapRows.filter((g) => !dismissed.has(g.key))
  const hiddenCount = gapRows.length - visibleGaps.length

  if (variant === "compact") {
    const next = visibleGaps[0] ?? gapRows[0]
    return (
      <div className="rounded-lg border bg-card p-3 text-sm" data-testid="critical-setup-meter-compact">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="font-semibold">Critical setup — {readiness.overallPct}%</span>
            <span className="text-muted-foreground"> · {readiness.configuredItems}/{readiness.totalItems} configured</span>
            {next && (
              <p className="mt-1 truncate text-muted-foreground" title={next.why}>
                Next: {next.title} — {next.why}
              </p>
            )}
          </div>
          {next && (
            <Link
              href={next.settingHref}
              className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
            >
              Set up
            </Link>
          )}
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${readiness.overallPct}%` }} />
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-card p-4" data-testid="critical-setup-meter">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{heading ?? "Finish your setup"}</h3>
          <p className="text-xs text-muted-foreground">
            {readiness.configuredItems} of {readiness.totalItems} critical items configured — each gap below names
            exactly what stays dead until it&apos;s done.
          </p>
        </div>
        <span className="text-lg font-semibold tabular-nums">{readiness.overallPct}%</span>
      </div>

      {/* per-category bars */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {readiness.categories.map((c) => (
          <div key={c.category} className="rounded-md border p-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">{CATEGORY_LABELS[c.category]}</span>
              <span className="tabular-nums text-muted-foreground">{c.done}/{c.total}</span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${c.pct >= 100 ? "bg-emerald-500" : "bg-primary"}`}
                style={{ width: `${c.pct}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* gap rows with the honest why-lines */}
      {visibleGaps.length > 0 && (
        <ul className="mt-3 space-y-2">
          {visibleGaps.map((g) => (
            <li key={g.key} className="flex items-start justify-between gap-3 rounded-md border border-amber-200/60 bg-amber-50/40 p-2 dark:border-amber-900/40 dark:bg-amber-950/20">
              <div className="min-w-0">
                <p className="text-sm font-medium">{g.title}</p>
                <p className="text-xs text-muted-foreground">{g.why}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Link href={g.settingHref} className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent">
                  Set up
                </Link>
                <button
                  type="button"
                  onClick={() => dismiss(g.key)}
                  className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent"
                  title="Hide this row (it still counts against the meter until configured)"
                  aria-label={`Dismiss ${g.title}`}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {hiddenCount > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {hiddenCount} dismissed item{hiddenCount === 1 ? "" : "s"} still count{hiddenCount === 1 ? "s" : ""} against
          the meter until configured.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => { setDismissed(new Set()); saveDismissed(new Set()) }}
          >
            Show all
          </button>
        </p>
      )}
    </div>
  )
}
