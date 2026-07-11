import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { ReportsClient } from "./reports-client"
import {
  generateCampaignROIReport,
  generateFinancialSummaryReport,
  generateReputationReport,
  generateSourcePerformanceReport,
} from "@/lib/kernel/reporting"
import {
  generateAutonomyImpactReport,
  generateCoachingSignalsReport,
  composeKpiNarrative,
} from "@/lib/kernel/reporting-autonomy"

export const dynamic = "force-dynamic"

export default async function ReportsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const agentCtx = await getAgentContext()
  if (!agentCtx.isAuthenticated) redirect("/login")

  const today      = new Date()
  const ytdStart   = `${today.getFullYear()}-01-01`
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split("T")[0]

  // Ensure agentId is resolved — fallback to agents table lookup
  let resolvedAgentId = agentCtx.agentId ?? ""
  if (!resolvedAgentId) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle()
    resolvedAgentId = agentRow?.id ?? user.id
  }

  const ctx = {
    userId:      user.id,
    agentId:     resolvedAgentId,
    brokerageId: agentCtx.brokerageId ?? "",
    userType:    agentCtx.role ?? "agent",
  }

  // Prefetch all report types in parallel — gives client zero loading flash
  const [campaignResult, financialResult, reputationResult, sourceResult, autonomyResult, coachingResult] =
    await Promise.all([
      generateCampaignROIReport({ ctx }),
      generateFinancialSummaryReport({ ctx, dateFrom: ytdStart }),
      generateReputationReport({ ctx }),
      generateSourcePerformanceReport({ ctx, dateFrom: ytdStart }),
      generateAutonomyImpactReport({ ctx }),
      generateCoachingSignalsReport({ ctx }),
    ])

  const autonomy = autonomyResult.success ? autonomyResult.data ?? null : null
  const coaching = coachingResult.success ? coachingResult.data ?? null : null
  const narrative = autonomy && coaching ? composeKpiNarrative(autonomy, coaching) : []

  return (
    <div>
      {/* THE AUTONOMY REPORT — what the OS did, measured (tier-scoped: a
          broker sees the brokerage, a team lead their team, an agent their
          own work). Every number traces to ledger rows; the narrative is
          what the tenant's assistant presents. */}
      {autonomy && coaching && (
        <section className="mx-auto max-w-6xl px-6 pt-6">
          <div className="rounded-xl border bg-card p-6">
            <h2 className="text-lg font-semibold">Your AI team, measured</h2>
            <p className="text-xs text-muted-foreground mt-0.5 capitalize">{autonomy.tier} view · last 30 days · every number traces to a ledger row</p>
            <div className="mt-4 grid gap-4 grid-cols-2 md:grid-cols-4 lg:grid-cols-8 text-center">
              <div><div className="text-2xl font-bold">{autonomy.assets.videosProduced + autonomy.assets.rendersProduced}</div><div className="text-xs text-muted-foreground">videos &amp; renders</div></div>
              <div><div className="text-2xl font-bold">{autonomy.assets.documentsProduced}</div><div className="text-xs text-muted-foreground">documents</div></div>
              <div><div className="text-2xl font-bold">{autonomy.assets.socialPostsPublished}</div><div className="text-xs text-muted-foreground">posts published</div></div>
              <div><div className="text-2xl font-bold">{autonomy.aiLane.draftsWritten}</div><div className="text-xs text-muted-foreground">drafts written{autonomy.aiLane.draftAdoptionRate != null ? ` · ${Math.round(autonomy.aiLane.draftAdoptionRate * 100)}% sent` : ""}</div></div>
              <div><div className="text-2xl font-bold">{autonomy.provenance.learnedShare != null ? `${Math.round(autonomy.provenance.learnedShare * 100)}%` : "—"}</div><div className="text-xs text-muted-foreground">decisions on your own evidence</div></div>
              <div><div className="text-2xl font-bold">${autonomy.attribution.creditDollars.toLocaleString("en-US")}</div><div className="text-xs text-muted-foreground">attributed credit · {autonomy.attribution.creditedTransactions} deals</div></div>
              <div><div className="text-2xl font-bold">{coaching.medianFirstResponseMinutes != null ? `${coaching.medianFirstResponseMinutes}m` : "—"}</div><div className="text-xs text-muted-foreground">median first response{coaching.followUpGaps ? ` · ${coaching.followUpGaps} follow-up gaps` : ""}</div></div>
              <div><div className="text-2xl font-bold">{autonomy.docKernel.deadlinesFromDocuments}</div><div className="text-xs text-muted-foreground">deadlines from paperwork{autonomy.docKernel.conflictsCaught ? ` · ${autonomy.docKernel.conflictsCaught} conflicts caught` : ""}</div></div>
            </div>
            {narrative.length > 0 && (
              <ul className="mt-5 space-y-1.5 text-sm border-t pt-4">
                {narrative.map((line, i) => (
                  <li key={i} className="text-muted-foreground">· {line}</li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      <ReportsClient
      agentId={resolvedAgentId}
      brokerageId={agentCtx.brokerageId ?? ""}
      role={agentCtx.role || "agent"}
      userId={user.id}
      monthStart={monthStart}
      initialCampaignData={campaignResult.data ?? null}
      initialFinancialData={financialResult.data ?? null}
      initialReputationData={reputationResult.data ?? null}
      initialSourceData={sourceResult.data ?? null}
    />
    </div>
  )
}
