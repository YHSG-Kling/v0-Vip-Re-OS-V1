import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import type { ManagerOutcome } from "@/lib/kernel/outcome-learning"
import { MIN_DECISIONS, TRUST_THRESHOLD } from "@/lib/kernel/outcome-learning"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

/**
 * THE TRUST METER — outcome learning, visible. Per-manager human-approval rates from
 * the gate's real history (machine vetoes/supersedes excluded), plus the human's own
 * recent rejection reasons. A manager below the trust threshold shows "initiative
 * paused" — the same state idle-hands enforces, so what the broker sees IS what the
 * system does. Server-rendered from live data; managers with no decisions yet show
 * as building trust rather than a fake 100%.
 */
export function TrustMeter({
  outcomes, feedback,
}: {
  outcomes: Record<string, ManagerOutcome>
  feedback: Record<string, string[]>
}) {
  const rows = (Object.keys(MANAGERS) as ManagerKey[])
    .map((key) => ({ key, label: MANAGERS[key].label, o: outcomes[key], fb: feedback[key] ?? [] }))
    .filter((r) => r.o && r.o.decisions > 0)
    .sort((a, b) => (b.o!.decisions - a.o!.decisions))

  if (rows.length === 0) return null

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Manager trust — your decisions, counted</h2>
        <span className="text-xs text-muted-foreground">
          human approvals only · {MIN_DECISIONS}+ decisions below {Math.round(TRUST_THRESHOLD * 100)}% pauses initiative
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(({ key, label, o, fb }) => {
          const rate = Math.round(o!.approvalRate * 100)
          const paused = o!.decisions >= MIN_DECISIONS && o!.approvalRate < TRUST_THRESHOLD
          const building = o!.decisions < MIN_DECISIONS
          return (
            <div key={key} className="rounded-md border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{label}</span>
                {paused
                  ? <Badge variant="destructive">initiative paused</Badge>
                  : building
                    ? <Badge variant="secondary">building trust</Badge>
                    : <Badge variant={rate >= 80 ? "default" : "secondary"}>{rate}% approved</Badge>}
              </div>
              <div className="mt-2 h-1.5 w-full rounded bg-muted">
                <div
                  className={`h-1.5 rounded ${paused ? "bg-destructive" : "bg-primary"}`}
                  style={{ width: `${rate}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {o!.approved} approved · {o!.rejected} rejected ({o!.decisions} decisions)
              </div>
              {fb.length > 0 && (
                <div className="mt-2 text-xs text-muted-foreground italic">
                  Your recent feedback: {fb.map((f) => `“${f}”`).join(" · ")}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
