import { redirect } from "next/navigation"
import { TransactionPipelineView } from "@/components/transactions/pipeline-view"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { toCanonicalRoleOrDefault } from "@/lib/security"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function TransactionPipelinePage() {
  // ── Kernel OS: identity resolution via canonical helper ──────────────────
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")

  // toCanonicalRoleOrDefault normalises legacy DB values (TC → tc, etc.)
  const userRole = toCanonicalRoleOrDefault(ctx.userType, "agent")

  const supabase = await createClient()

  // ── Fetch pipeline transactions ──────────────────────────────────────────
  const { data: transactionData } = await supabase
    .from("transactions")
    .select(`
      id,
      stage,
      status,
      property_address,
      purchase_price,
      contract_date,
      created_at,
      agent_id,
      milestones:transaction_milestones(
        id,
        milestone_name,
        status,
        target_date,
        completed_at
      )
    `)
    .eq("brokerage_id", ctx.brokerageId)
    .in("status", ["under_contract", "closing"])
    .order("created_at", { ascending: false })

  // ── Resolve agent display names via agents → users join ──────────────────
  let transactions: any[] = []
  if (transactionData && transactionData.length > 0) {
    const agentIds = [
      ...new Set(
        transactionData.map((t: any) => t.agent_id).filter(Boolean)
      ),
    ]

    const { data: agentRows } =
      agentIds.length > 0
        ? await supabase
            .from("agents")
            .select("id, users(first_name, last_name)")
            .in("id", agentIds)
        : { data: [] }

    const agentMap = (agentRows ?? []).reduce((acc: any, a: any) => {
      const u = a.users as {
        first_name?: string | null
        last_name?: string | null
      } | null
      acc[a.id] = {
        id: a.id,
        name: u
          ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim()
          : "Unknown Agent",
      }
      return acc
    }, {})

    transactions = transactionData.map((t: any) => ({
      ...t,
      // Rename purchase_price → contract_price for the view component
      contract_price: t.purchase_price ?? 0,
      agent:
        t.agent_id && agentMap[t.agent_id] ? agentMap[t.agent_id] : null,
    }))
  }

  return (
    <div className="container mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Transaction Pipeline</h1>
        <p className="text-muted-foreground">
          Monitor all active transactions by stage
        </p>
      </div>

      <TransactionPipelineView
        transactions={transactions}
        userRole={userRole}
      />
    </div>
  )
}
