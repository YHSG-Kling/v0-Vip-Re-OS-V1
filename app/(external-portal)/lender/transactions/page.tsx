import { redirect } from "next/navigation"
import { LenderTransactionList } from "@/components/external-portal/lender-transaction-list"
import { getAgentContext } from "@/lib/identity"
import { toCanonicalRole } from "@/lib/security"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function LenderTransactionsPage() {
  // ── Kernel OS: identity resolution ──────────────────────────────────────
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")

  // toCanonicalRole handles legacy "TC", "LENDER" etc.
  const userRole = toCanonicalRole(ctx.userType)
  if (userRole !== "lender") redirect("/")

  const supabase = await createClient()

  // ── lender_portal_users: user_id, transaction_id, brokerage_id ──────────
  const { data: lenderAssignments } = await supabase
    .from("lender_portal_users")
    .select("transaction_id")
    .eq("user_id", ctx.userId)

  if (!lenderAssignments || lenderAssignments.length === 0) {
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

  const transactionIds = lenderAssignments
    .map((a: any) => a.transaction_id)
    .filter(Boolean)

  const { data: transactionsData } = await supabase
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
        target_date,
        completed_at
      )
    `)
    .in("id", transactionIds)
    .in("status", ["under_contract", "closing"])

  // Map to LenderTransactionList shape — purchase_price → contract_price
  const transactions = (transactionsData ?? []).map((txn: any) => ({
    id: txn.id,
    property_address: txn.property_address ?? "",
    stage: txn.stage ?? "",
    status: txn.status ?? "",
    contract_price: txn.purchase_price ?? 0,
    contract_date: txn.contract_date ?? "",
    agent: null, // not exposed in lender view
    milestones: (txn.transaction_milestones ?? []).map((m: any) => ({
      id: m.id,
      milestone_name: m.milestone_name,
      status: m.status,
      target_date: m.target_date,
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
        lenderId={ctx.userId}
      />
    </div>
  )
}
