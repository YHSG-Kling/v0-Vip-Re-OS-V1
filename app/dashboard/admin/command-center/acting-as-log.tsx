/**
 * ACTING-AS LOG (concierge §1.2, visibility half) — the audit trail made
 * VISIBLE governance: who assumed whose view, when. Rendered for the
 * principal on the Command Center beside the QBR; empty state is honest.
 * Server component; rows come from the lifecycle ledger.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Eye } from "lucide-react"

export interface ActingAsRow {
  actorName: string
  targetLabel: string
  at: string
}

export function ActingAsLog({ rows }: { rows: ActingAsRow[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Eye className="h-4 w-4 text-slate-600" /> Assumed views (last 14 days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No one assumed another member's view in the last two weeks.</p>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {rows.map((r, i) => (
              <li key={i}>
                <span className="font-medium">{r.actorName}</span> viewed as {r.targetLabel}
                <span className="text-muted-foreground"> · {new Date(r.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
