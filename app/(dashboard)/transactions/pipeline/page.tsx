import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { TransactionPipelineView } from "@/components/transactions/pipeline-view"

export const dynamic = 'force-dynamic'

export default async function TransactionPipelinePage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) {
    return <div>Brokerage not found</div>
  }

  // Fetch all transactions in pipeline stages with agent details
  const { data: transactionData } = await supabase
    .from("transactions")
    .select(`
      id,
      stage,
      status,
      property_address,
      contract_price,
      contract_date,
      created_at,
      agent_id,
      milestones:transaction_milestones(
        id,
        milestone_name,
        status,
        milestone_date,
        completed_at
      )
    `)
    .eq("brokerage_id", profile.brokerage_id)
    .in("status", ["under_contract", "closing"])
    .order("created_at", { ascending: false })

  // Map transaction data to include agent details from joined agent lookup
  let transactions: any[] = []
  if (transactionData && transactionData.length > 0) {
    // Get unique agent IDs
    const agentIds = [...new Set(transactionData.map((t: any) => t.agent_id).filter(Boolean))]
    
    // Fetch agent details for all agents
    const { data: agents } = agentIds.length > 0
      ? await supabase
          .from("agents")
          .select("id, name")
          .in("id", agentIds)
      : { data: [] }

    const agentMap = agents?.reduce((acc: any, agent: any) => {
      acc[agent.id] = agent
      return acc
    }, {}) || {}

    // Map transactions with agent details
    transactions = transactionData.map((t: any) => ({
      ...t,
      agent: t.agent_id && agentMap[t.agent_id]
        ? { id: agentMap[t.agent_id].id, name: agentMap[t.agent_id].name }
        : null,
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
        transactions={transactions || []}
        userRole={profile.role}
      />
    </div>
  )
}
