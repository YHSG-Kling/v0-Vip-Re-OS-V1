/**
 * app/dashboard/intelligence/movement-signals/page.tsx — EARLY MOVEMENT SIGNALS, FOR THE LEAD DESK (wave 147, lane 147Z — owner
 * ruling 3; contract C9; closes lane 147I's U1 door for movement_signals / movement_source_polls).
 *
 * The tenant's C9 movement records, newest first, each saying HOW we know it (verified / reported / inferred) — never more — and
 * the published freshness of every no-push source the watcher polls. A lead-desk person closes a record that was wrong
 * (false positive) or where the person declined help; everything else is closed by what actually happened (the reconciler).
 * Lead-desk seats only (the ONE roster, LEAD_DESK_USER_TYPES); anyone else is told so, nothing is read.
 */
import { listMovementSignalsAction } from "@/app/actions/movement-signals"
import { MovementSignalsClient } from "./movement-signals-client"

export const dynamic = "force-dynamic"

export default async function MovementSignalsPage() {
  const result = await listMovementSignalsAction({ openOnly: false })
  if (!result.success) {
    return (
      <div className="p-4 md:p-6">
        <h1 className="text-2xl font-bold text-foreground mb-2">Early movement signals</h1>
        <p role="alert" className="text-destructive">{result.error}</p>
      </div>
    )
  }
  return <MovementSignalsClient records={result.records} sources={result.sources} freshnessNote={result.freshnessNote} />
}
