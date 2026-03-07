import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { TransactionPipelineView } from "@/components/transactions/pipeline-view"

export const dynamic = 'force-dynamic'

export default async function TransactionPipelinePage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("profiles")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) {
    return <div>Brokerage not found</div>
  }

  // Fetch all transactions in pipeline stages
  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      id,
      stage,
      status,
      property_address,
      contract_price,
      contract_date,
      created_at,
      agent:agents(id, name),
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
