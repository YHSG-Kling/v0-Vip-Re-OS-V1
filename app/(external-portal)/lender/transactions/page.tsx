import { redirect } from "next/navigation"
import { LenderTransactionList } from "@/components/external-portal/lender-transaction-list"
import { getAgentContext } from "@/lib/identity"
import { toCanonicalRole } from "@/lib/security"
import { createClient } from "@/lib/supabase/server"
import { TRANSACTION_STATUSES_IN_ESCROW } from "@/lib/transactions/transaction-status"

export const dynamic = "force-dynamic"

export default async function LenderTransactionsPage() {
  // ── Kernel OS: identity resolution ──────────────────────────────────────
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")

  // toCanonicalRole handles legacy "TC", "LENDER" etc.
  const userRole = toCanonicalRole(ctx.userType)
  if (userRole !== "lender") redirect("/")

  const supabase = await createClient()

  // Lenders are vendors — the deals are the lender vendor's assignments.
  const { lenderVendorForUser, lenderVendorTransactionIds } = await import("@/lib/kernel/lender-linkage")
  const lenderVendor = await lenderVendorForUser(supabase, ctx.userId)
  const lenderAssignments = lenderVendor
    ? (await lenderVendorTransactionIds(supabase, lenderVendor.vendorId)).map((id) => ({ transaction_id: id }))
    : []

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
    .in("status", [...TRANSACTION_STATUSES_IN_ESCROW])

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
