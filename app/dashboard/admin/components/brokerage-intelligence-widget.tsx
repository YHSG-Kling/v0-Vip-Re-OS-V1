import Link from "next/link"
import { Brain, ArrowRight, Sparkles } from "lucide-react"
import { getBrokerageInsights } from "@/app/actions/brokerage-intelligence"

/**
 * <BrokerageIntelligenceWidget> — admin landing card.
 *
 * Server component. Shows the top 3 open insights ranked by lift_pct.
 * Click-through to /dashboard/admin/intelligence-mesh for full triage.
 *
 * Visible only when the user is broker / broker_admin / admin / superadmin
 * / team_lead (action enforces this; the empty result hides the card).
 */
export async function BrokerageIntelligenceWidget() {
  const res = await getBrokerageInsights({ status: "open", limit: 3 })
  if (!res.success || !res.insights || res.insights.length === 0) return null

  return (
    <Link
      href="/dashboard/admin/intelligence-mesh"
      className="block rounded-lg border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-white p-4 hover:bg-violet-50/40 transition"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-violet-600" />
          <p className="text-sm font-semibold">Brokerage Intelligence Mesh</p>
          <span className="text-[10px] uppercase font-medium text-violet-700 bg-violet-100 px-1.5 py-0.5 rounded-full">
            {res.insights.length} insight{res.insights.length === 1 ? "" : "s"}
          </span>
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Anonymized patterns mined from your own agents&apos; data. One click pushes the winning playbook to selected agents.
      </p>
      <ul className="space-y-2">
        {res.insights.map((i) => (
          <li key={i.id} className="rounded-md bg-white border border-violet-100 p-2.5 flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-snug">{i.headline}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {i.supportingAgentCount} agent{i.supportingAgentCount === 1 ? "" : "s"} · {i.sampleSize} observations
              </p>
            </div>
            <span className="text-[10px] uppercase font-medium px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 flex items-center gap-0.5 whitespace-nowrap">
              <Sparkles className="h-2.5 w-2.5" /> {Math.round(i.liftPct)}% lift
            </span>
          </li>
        ))}
      </ul>
    </Link>
  )
}
