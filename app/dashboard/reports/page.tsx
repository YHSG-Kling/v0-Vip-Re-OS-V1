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

  // Prefetch all four report types in parallel — gives client zero loading flash
  const [campaignResult, financialResult, reputationResult, sourceResult] =
    await Promise.all([
      generateCampaignROIReport({ ctx }),
      generateFinancialSummaryReport({ ctx, dateFrom: ytdStart }),
      generateReputationReport({ ctx }),
      generateSourcePerformanceReport({ ctx, dateFrom: ytdStart }),
    ])

  return (
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
  )
}
