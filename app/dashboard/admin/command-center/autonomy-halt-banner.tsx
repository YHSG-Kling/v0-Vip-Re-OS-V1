// AUTONOMY-HALT BANNER — the tenant-facing half of the per-tenant staff halt (cert blocker #3).
// When platform staff pause this brokerage's autonomous AI (feature_access_overrides 'autonomy'
// kill, enforced at the dispatch gate), the principal deserves an HONEST surface saying so:
// what is paused, why (the staff-entered reason, verbatim), and what still works. Rendered at
// the top of the Command Center — the room where the broker watches their AI team.
// Presentational only (server-safe); the page loads the halt via loadTenantAutonomyHalt.

import { PauseOctagon } from "lucide-react"

export function AutonomyHaltBanner({ reason, haltedAt }: { reason: string | null; haltedAt: string | null }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm" role="status">
      <p className="font-semibold text-amber-900 flex items-center gap-2">
        <PauseOctagon className="h-4 w-4" />
        Your AI team&apos;s autonomous actions are paused by VIP platform support
        {haltedAt && <span className="font-normal text-amber-800/80 text-xs">since {new Date(haltedAt).toLocaleString()}</span>}
      </p>
      <p className="mt-1 text-amber-900/90">
        {reason ?? "Autonomous AI manager sends are on hold for this brokerage."}
      </p>
      <p className="mt-1 text-xs text-amber-800/80">
        While paused, no AI manager will send anything unattended. Messages you approve from the queue — and
        anything you send yourself — still go out normally. Contact support with questions about this pause.
      </p>
    </div>
  )
}
