import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { LenderTransactionList } from "@/components/external-portal/lender-transaction-list"

export default async function LenderTransactionsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Get lender's profile
  const { data: profile } = await supabase
    .from("profiles")
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

  const transactions = assignments?.map(a => a.transaction).filter(Boolean) || []

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
