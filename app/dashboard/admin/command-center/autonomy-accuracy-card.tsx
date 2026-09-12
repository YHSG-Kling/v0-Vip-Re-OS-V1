import Link from "next/link"
import { ShieldCheck, Gauge, PauseCircle } from "lucide-react"
import type { AutonomyAccuracySummary } from "@/lib/managers/accuracy-gate"

/**
 * The Command Center governance glance: autonomy is EARNED by measured
 * prediction accuracy, not toggled. Shows the compact read (earned / supervised
 * / held) with a link to the full per-domain report on Manager Trust. Additive —
 * an honest "still learning" state until any domain has a verdict.
 */
export function AutonomyAccuracyCard({ summary }: { summary: AutonomyAccuracySummary }) {
  const { earned, supervised, gathering, held, holdWindowDays, hasSignal } = summary

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <h3 className="text-sm font-semibold">Autonomy is earned</h3>
        </div>
        <Link href="/dashboard/admin/manager-trust" className="text-xs text-blue-600 hover:underline">
          Manager Trust →
        </Link>
      </div>

      {hasSignal ? (
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            <span className="font-semibold">{earned}</span>
            <span className="text-muted-foreground">earned</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Gauge className="h-4 w-4 text-amber-600" />
            <span className="font-semibold">{supervised}</span>
            <span className="text-muted-foreground">supervised</span>
          </span>
          {gathering > 0 && (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className="font-semibold">{gathering}</span>
              <span>gathering signal</span>
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <PauseCircle className={`h-4 w-4 ${held > 0 ? "text-red-600" : "text-muted-foreground"}`} />
            <span className="font-semibold">{held}</span>
            <span className="text-muted-foreground">held ({holdWindowDays}d)</span>
          </span>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          Still learning — no domain has enough prediction history yet to earn autonomous action.
          {held > 0 && ` ${held} send${held === 1 ? "" : "s"} held for review in the last ${holdWindowDays} days.`}
        </p>
      )}
    </div>
  )
}
