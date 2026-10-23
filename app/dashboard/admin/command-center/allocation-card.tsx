/**
 * RESOURCE ALLOCATION card (wave 106, lane 106A) — the ONE Command Center surface for the allocation
 * recommender (lib/kernel/resource-allocation.ts). "Not automatically at first. Recommendation mode
 * first." (owner): it lists the OPEN recommendations (lead assignment / marketing budget) awaiting a
 * human and links to the Manager Trust page where the improvement-proposals panel decides them. Read
 * only; the page gates the render to the tenant-admin roster (isAdminOrBroker) — agents never see it.
 */

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Scale } from "lucide-react"
import type { AllocationBoard } from "@/lib/kernel/resource-allocation"
import { recommendMarketingAllocationFormAction } from "@/app/actions/admin/improvement-proposals"

const KIND_LABEL: Record<AllocationBoard["latest"][number]["kind"], string> = {
  lead_assignment: "Lead assignment",
  marketing_allocation: "Marketing budget",
}

export function AllocationCard({ board }: { board: AllocationBoard }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2"><Scale className="h-4 w-4" /> Resource allocation — recommendation mode</span>
          <Link href="/dashboard/admin/manager-trust" className="text-xs font-normal text-blue-600 hover:underline">Decide on Manager Trust →</Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {board.degraded ? (
          <p className="text-muted-foreground">The proposal store is not available yet — recommendations are not being recorded.</p>
        ) : board.open === 0 ? (
          <p className="text-muted-foreground">No open recommendations. The chain runs on every routed lead and records only a held lead or a pick that differs from your rules.</p>
        ) : (
          <>
            <p>
              <span className="font-semibold">{board.open}</span> awaiting a decision ·{" "}
              {board.byKind.lead_assignment} lead assignment · {board.byKind.marketing_allocation} marketing budget
            </p>
            <ul className="space-y-1">
              {board.latest.map((r) => (
                <li key={r.id} className="rounded border bg-muted/20 px-2 py-1">
                  <span className="text-xs uppercase text-muted-foreground">{KIND_LABEL[r.kind]} · {r.status}</span>
                  <div>{r.summary || r.subjectKey}</div>
                </li>
              ))}
            </ul>
          </>
        )}
        {/* THE MARKETING DOOR — a budget question, answered as a proposal (never spent here). */}
        <form action={recommendMarketingAllocationFormAction} className="flex items-center gap-2 pt-1">
          <label htmlFor="allocation-budget" className="text-xs text-muted-foreground">Recommend a split for $</label>
          <input id="allocation-budget" name="budgetUsd" type="number" min={1} step={50} defaultValue={2000} className="h-8 w-28 rounded border bg-background px-2 text-sm" />
          <button type="submit" className="h-8 rounded border px-3 text-xs hover:bg-muted">Recommend</button>
        </form>
        <p className="text-xs text-muted-foreground">Nothing here is applied until a person approves it. Switch modes under Settings → policy key resource_allocation.</p>
      </CardContent>
    </Card>
  )
}
