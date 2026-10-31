/**
 * SELF-OPTIMIZING MANAGER TEAMS (wave 108G) — the Manager Trust page's control over which optimization classes the
 * weekly team cycle may promote WITHOUT a human. Server component: the read is
 * app/actions/admin/improvement-proposals.ts getSelfOptimizationAutonomy (tenant admin, session tenant); the form
 * submits setSelfOptimizationAutonomyFormAction — a human `policy` proposal on the ONE policy path. Authority
 * policies, financial rules and compliance boundaries are never optimizable and are not listed here.
 */
import { getSelfOptimizationAutonomy, setSelfOptimizationAutonomyFormAction } from "@/app/actions/admin/improvement-proposals"

export async function SelfOptimizationPanel() {
  const res = await getSelfOptimizationAutonomy()
  if (!res.ok) {
    return (
      <section id="self-optimization" className="mx-6 mb-8 rounded-lg border border-red-200 p-4 text-sm text-red-700">
        Self-optimization settings could not be loaded: {res.error}
      </section>
    )
  }
  const d = res.data
  return (
    <section id="self-optimization" className="mx-6 mb-8 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Self-optimizing manager teams</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Each week the managers pool their evidence and co-propose bounded improvements. A checked class may be promoted
        automatically when its evaluation passes and its owner manager&apos;s autonomy and authority allow; an unchecked
        class always waits for you in Improvement proposals below. Authority, financial and compliance settings are never
        optimized. {d.openTeamProposals > 0 ? `${d.openTeamProposals} team proposal(s) are open.` : "No team proposal is open."}
      </p>
      <form action={setSelfOptimizationAutonomyFormAction} className="space-y-2">
        {d.classes.length === 0 && <p className="text-sm text-muted-foreground">No optimization class is defined yet.</p>}
        {d.classes.map((c) => (
          <label key={c.key} className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="autonomous_classes" value={c.key} defaultChecked={c.autonomous} className="mt-1" />
            <span>
              <span className="font-medium">{c.label}</span>
              <span className="block text-xs text-muted-foreground">
                Owner {c.owner} with {c.coProposers.join(", ")} · evaluated by {c.evaluator}
              </span>
            </span>
          </label>
        ))}
        <button type="submit" className="mt-2 rounded border px-3 py-1 text-sm">Save autonomous classes</button>
      </form>
    </section>
  )
}
