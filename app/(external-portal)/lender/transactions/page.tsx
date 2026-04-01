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
  agent: { name: string; email: string; phone: string }[] | null
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

  // Get transactions where this user is assigned as lender
  const { data: assignments } = await supabase
    .from("deal_team_members")
    .select(`
      transaction_id,
      transaction:transactions(
        id,
        property_address,
        stage,
        status,
        contract_price,
        contract_date,
        agent:agents(name, email, phone),
        milestones:transaction_milestones(
          id,
          milestone_name,
          status,
          milestone_date,
          completed_at
        )
      )
    `)
    .eq("user_id", user.id)
    .eq("member_type", "lender")
    .in("transaction.status", ["under_contract", "closing"])

  // Map assignments to transactions and flatten to 1D array per Kernel OS contract
  // Each lender can only access transactions they're assigned to via deal_team_members
  const transactions: Transaction[] = (assignments || [])
    .map(a => a.transaction)
    .filter((t): t is Transaction => Boolean(t))

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
