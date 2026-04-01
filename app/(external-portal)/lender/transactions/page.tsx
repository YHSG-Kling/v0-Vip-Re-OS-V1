import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { LenderTransactionList } from "@/components/external-portal/lender-transaction-list"

export const dynamic = 'force-dynamic'

// Type matching LenderTransactionList Transaction interface
interface Transaction {
  id: string
  property_address: string
  stage: string
  status: string
  contract_price: number
  contract_date: string
  agent: { name: string; email: string; phone: string } | null
  milestones: Array<{
    id: string
    milestone_name: string
    status: string
    milestone_date: string | null
    completed_at: string | null
  }>
}

export default async function LenderTransactionsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Get lender's profile
  const { data: profile } = await supabase
    .from("users")
    .select("id, role")
    .eq("id", user.id)
    .single()

  if (profile?.role !== 'lender') {
    redirect("/")
  }

  // Step 1: Get transaction IDs where this lender is assigned
  const { data: teamAssignments, error: assignmentError } = await supabase
    .from("deal_team_members")
    .select("transaction_id")
    .eq("user_id", user.id)
    .eq("member_type", "lender")

  if (assignmentError) {
    console.error("[v0] Error fetching lender assignments:", assignmentError)
    redirect("/")
  }

  // Step 2: If no assignments, show empty state
  if (!teamAssignments || teamAssignments.length === 0) {
    return (
      <div className="container mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">My Assigned Transactions</h1>
          <p className="text-muted-foreground">
            Update financing milestones and upload documents
          </p>
        </div>

        <div className="text-center py-12">
          <p className="text-muted-foreground">No transactions assigned yet.</p>
        </div>
      </div>
    )
  }

  // Step 3: Get the actual transaction data for assigned transaction IDs
  const transactionIds = teamAssignments.map((a: any) => a.transaction_id)
  const { data: transactionsData, error: txnError } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      stage,
      status,
      purchase_price,
      contract_date,
      close_date,
      transaction_milestones(
        id,
        milestone_name,
        status,
        milestone_date,
        completed_at
      )
    `)
    .in("id", transactionIds)
    .in("status", ["under_contract", "closing"])

  if (txnError) {
    console.error("[v0] Error fetching transactions:", txnError)
    return (
      <div className="container mx-auto p-6">
        <p className="text-red-500">Error loading transactions. Please try again.</p>
      </div>
    )
  }

  // Step 4: Map transactions to proper type - handle nested transaction_milestones
  const transactions: Transaction[] = (transactionsData || []).map((txn: any) => ({
    id: txn.id,
    property_address: txn.property_address,
    stage: txn.stage,
    status: txn.status,
    contract_price: txn.purchase_price || 0,
    contract_date: txn.contract_date,
    agent: null, // No agent data for lender view
    milestones: (txn.transaction_milestones || []).map((m: any) => ({
      id: m.id,
      milestone_name: m.milestone_name,
      status: m.status,
      milestone_date: m.milestone_date,
      completed_at: m.completed_at,
    })),
  }))

  return (
    <div className="container mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">My Assigned Transactions</h1>
        <p className="text-muted-foreground">
          Update financing milestones and upload documents
        </p>
      </div>

      <LenderTransactionList 
        transactions={transactions}
        lenderId={user.id}
      />
    </div>
  )
}
