import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { TransactionTimeline } from "@/components/client-portal/transaction-timeline"
import { ClientMilestones } from "@/components/client-portal/milestones"
import { PendingApprovals } from "@/components/client-portal/pending-approvals"

export const dynamic = 'force-dynamic'

export default async function ClientTransactionPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Get client's contact record
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, brokerage_id")
    .eq("email", user.email)
    .single()

  if (!contact) {
    return <div className="p-6">Contact record not found</div>
  }

  // Get active transaction for this client
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      stage,
      status,
      property_address,
      contract_date,
      contract_price,
      agent:agents(name, phone, email)
    `)
    .eq("contact_id", contact.id)
    .in("status", ["under_contract", "closing"])
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  if (!transaction) {
    return (
      <div className="container mx-auto p-6">
        <h1 className="text-2xl font-bold">My Transaction</h1>
        <p className="text-muted-foreground mt-2">No active transaction found</p>
      </div>
    )
  }

  // Get client-safe transparency updates
  const { data: updates } = await supabase
    .from("transparency_updates")
    .select("*")
    .eq("transaction_id", transaction.id)
    .order("created_at", { ascending: false })

  // Get client-visible milestones only
  const clientVisibleMilestones = [
    'earnest_money_due',
    'inspection_deadline',
    'inspection_completed',
    'financing_deadline',
    'clear_to_close_received',
    'final_walkthrough_scheduled',
    'closing_date'
  ]

  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("*")
    .eq("transaction_id", transaction.id)
    .in("milestone_name", clientVisibleMilestones)
    .order("milestone_date", { ascending: true })

  // Get pending quote approvals
  const { data: pendingApprovals } = await supabase
    .from("activities")
    .select(`
      id,
      title,
      description,
      metadata,
      due_date,
      document:client_documents(id, file_name, file_url)
    `)
    .eq("transaction_id", transaction.id)
    .eq("activity_type", "client.quote.approval_needed")
    .eq("status", "pending")

  return (
    <div className="container mx-auto p-6 max-w-4xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold">{transaction.property_address}</h1>
        <p className="text-muted-foreground">
          Contract Date: {new Date(transaction.contract_date).toLocaleDateString()}
        </p>
      </div>

      {pendingApprovals && pendingApprovals.length > 0 && (
        <PendingApprovals 
          approvals={pendingApprovals}
        />
      )}

      <ClientMilestones milestones={milestones || []} />

      <TransactionTimeline milestones={updates || []} />

      <div className="rounded-lg border p-6 bg-muted/50">
        <h3 className="font-semibold mb-2">Your Agent</h3>
        <p className="font-medium">{transaction.agent?.name}</p>
        <p className="text-sm text-muted-foreground">{transaction.agent?.phone}</p>
        <p className="text-sm text-muted-foreground">{transaction.agent?.email}</p>
      </div>
    </div>
  )
}
