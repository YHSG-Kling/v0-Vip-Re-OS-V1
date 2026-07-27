import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DollarSign, Target, Trophy, TrendingUp, Receipt } from "lucide-react"
import type { Agent360 } from "@/app/actions/admin/agent-360"

/**
 * Agent 360 — the manager's read of one agent, rendered server-side beside the
 * edit form. Production, goals progress, payment receipts, gamification. The
 * commission-agreement e-sign card renders separately (existing component).
 */

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

// The live agent_goals.goal_type CHECK vocabulary.
const GOAL_LABELS: Record<string, string> = {
  gross_commission: "Gross Commission",
  transactions_closed: "Transactions Closed",
  listings_taken: "Listings Taken",
  buyer_clients: "Buyer Clients",
  new_contacts: "New Contacts",
  conversion_rate: "Conversion Rate",
  avg_days_to_close: "Avg Days to Close",
}

export function Agent360Panels({ data }: { data: Agent360 }) {
  const p = data.production
  const capPct = p.capAmount && p.capAmount > 0 && p.capProgress != null
    ? Math.min(100, Math.round((p.capProgress / p.capAmount) * 100))
    : null

  return (
    <div className="space-y-6">
      {/* Production snapshot */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile icon={<DollarSign className="h-4 w-4" />} label="YTD GCI" value={usd(p.ytdGci)} />
        <StatTile icon={<TrendingUp className="h-4 w-4" />} label="YTD Closings" value={String(p.ytdTransactions)} />
        <StatTile icon={<TrendingUp className="h-4 w-4" />} label="Active Deals" value={String(p.activeTransactions)} />
        <StatTile
          icon={<DollarSign className="h-4 w-4" />}
          label="Cap Progress"
          value={capPct != null ? `${capPct}%` : "—"}
          sub={p.capAmount ? `${usd(p.capProgress ?? 0)} of ${usd(p.capAmount)}` : "no cap set"}
        />
      </div>

      {/* Goals */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4 text-emerald-600" />
            Goals — {new Date().getFullYear()}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.goals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No goals set for this year — the agent sets them in Dashboard → Goals.
            </p>
          ) : (
            data.goals.map(g => {
              const pct = g.targetValue > 0 ? Math.min(100, Math.round((g.currentValue / g.targetValue) * 100)) : 0
              return (
                <div key={g.goalType}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium">{GOAL_LABELS[g.goalType] ?? g.goalType.replace(/_/g, " ")}</span>
                    <span className="text-muted-foreground">
                      {g.currentValue.toLocaleString()} / {g.targetValue.toLocaleString()} · {pct}%
                    </span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${pct >= 100 ? "bg-emerald-500" : pct >= 50 ? "bg-blue-500" : "bg-amber-500"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {/* Payments — receipts of what's been disbursed + what's owed */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4 text-blue-600" />
            Payments
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {usd(data.payments.totalPaid)} paid · {usd(data.payments.totalPending)} pending
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.payments.paid.length === 0 && data.payments.pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">No commission records yet.</p>
          ) : (
            <div className="divide-y">
              {[...data.payments.pending.slice(0, 5), ...data.payments.paid.slice(0, 10)].map(c => (
                <div key={c.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{usd(c.agentCommission)}</span>
                    <span className="text-xs text-muted-foreground ml-2">
                      of {usd(c.grossCommission)} gross · {new Date(c.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {c.status === "paid" ? (
                    <Badge className="bg-emerald-100 text-emerald-800 text-xs shrink-0">Paid</Badge>
                  ) : c.depositReceivedAt ? (
                    <Badge className="bg-blue-100 text-blue-800 text-xs shrink-0">Deposit received</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs shrink-0">Awaiting deposit</Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Gamification */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-500" />
            Gamification
            <Badge variant="outline" className="ml-auto text-xs">
              {data.gamification.tier} · {data.gamification.points.toLocaleString()} pts
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.gamification.badges.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {data.gamification.badges.map((b, i) => (
                <span key={i} className="inline-flex items-center gap-1 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-full px-2 py-1">
                  {b.icon && <span>{b.icon}</span>}
                  {b.name}
                  {b.tier && <span className="text-amber-600">· {b.tier}</span>}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No badges earned yet.</p>
          )}
          {data.gamification.recentPoints.length > 0 && (
            <div className="border-t pt-2 space-y-1">
              {data.gamification.recentPoints.map((r, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                  +{r.points} — {r.reason ?? "activity"} · {new Date(r.createdAt).toLocaleDateString()}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatTile({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
        <p className="text-xl font-bold mt-1">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  )
}
