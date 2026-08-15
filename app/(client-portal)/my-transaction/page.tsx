import { redirect } from "next/navigation"
import { TransactionTimeline } from "@/components/client-portal/transaction-timeline"
import { ClientMilestones } from "@/components/client-portal/milestones"
import { PendingApprovals } from "@/components/client-portal/pending-approvals"
import { getAgentContext } from "@/lib/identity"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function ClientTransactionPage() {
  // ── Kernel OS: identity resolution ──────────────────────────────────────
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")

  const supabase = await createClient()

  // ── Look up contact by authenticated user email ──────────────────────────
  // getAgentContext gives us userId — look up email from users table
  const { data: userRow } = await supabase
    .from("users")
    .select("email")
    .eq("id", ctx.userId)
    .maybeSingle()

  if (!userRow?.email) {
    return <div className="p-6">Unable to resolve user record.</div>
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, brokerage_id")
    .eq("email", userRow.email)
    .maybeSingle()

  if (!contact) {
    return <div className="p-6">Contact record not found.</div>
  }

  // ── Active transaction — purchase_price is the correct column ────────────
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      stage,
      status,
      property_address,
      contract_date,
      purchase_price,
      agent_id
    `)
    .eq("contact_id", contact.id)
    .in("status", ["under_contract", "closing"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!transaction) {
    return (
      <div className="container mx-auto p-6">
        <h1 className="text-2xl font-bold">My Transaction</h1>
        <p className="text-muted-foreground mt-2">No active transaction found.</p>
      </div>
    )
  }

  // ── Resolve agent via agents → users join ────────────────────────────────
  let agentInfo: { name: string; phone: string | null; email: string | null } | null = null
  if (transaction.agent_id) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("users(first_name, last_name, email, phone_mobile)")
      .eq("id", transaction.agent_id)
      .maybeSingle()

    if (agentRow?.users) {
      const u = agentRow.users as {
        first_name?: string | null
        last_name?: string | null
        email?: string | null
        phone_mobile?: string | null
      }
      agentInfo = {
        name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Your Agent",
        phone: u.phone_mobile ?? null,
        email: u.email ?? null,
      }
    }
  }

  // ── Transparency updates → TransactionTimeline Milestone shape ───────────
  const { data: updatesRaw } = await supabase
    .from("transparency_updates")
    .select("id, title, message, update_type, created_at")
    .eq("transaction_id", transaction.id)
    .eq("is_visible_to_client", true)
    .order("created_at", { ascending: false })

  const timelineMilestones = (updatesRaw ?? []).map((u: any) => ({
    id: u.id,
    name: u.title ?? u.update_type ?? "Update",
    date: u.created_at ?? null,
    status: "completed",
    description: u.message ?? undefined,
  }))

  // ── Client-visible milestones ────────────────────────────────────────────
  const clientVisibleMilestones = [
    "earnest_money_due",
    "inspection_deadline",
    "inspection_completed",
    "financing_deadline",
    "clear_to_close_received",
    "final_walkthrough_scheduled",
    "closing_date",
  ]

  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, milestone_name, status, target_date, completed_at")
    .eq("transaction_id", transaction.id)
    .in("milestone_name", clientVisibleMilestones)
    .order("target_date", { ascending: true })

  // ── Pending approvals — activities table, columns that exist ─────────────
  const { data: pendingActivities } = await supabase
    .from("activities")
    .select("id, title, description, scheduled_at, notes")
    .eq("transaction_id", transaction.id)
    .eq("activity_type", "client.quote.approval_needed")
    .eq("status", "pending")

  const pendingApprovals = (pendingActivities ?? []).map((a: any) => ({
    id: a.id,
    title: a.title ?? "Approval Required",
    description: a.description ?? a.notes ?? "",
    dueDate: a.scheduled_at ?? undefined,
  }))

  return (
    <div className="container mx-auto p-6 max-w-4xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold">{transaction.property_address}</h1>
        {transaction.contract_date && (
          <p className="text-muted-foreground">
            Contract Date:{" "}
            {new Date(transaction.contract_date).toLocaleDateString()}
          </p>
        )}
      </div>

      {pendingApprovals.length > 0 && (
        <PendingApprovals approvals={pendingApprovals} />
      )}

      <ClientMilestones milestones={milestones ?? []} />

      <TransactionTimeline milestones={timelineMilestones} />

      <div className="rounded-lg border p-6 bg-muted/50">
        <h3 className="font-semibold mb-2">Your Agent</h3>
        {agentInfo ? (
          <>
            <p className="font-medium">{agentInfo.name}</p>
            {agentInfo.phone && (
              <p className="text-sm text-muted-foreground">{agentInfo.phone}</p>
            )}
            {agentInfo.email && (
              <p className="text-sm text-muted-foreground">{agentInfo.email}</p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Agent information not available.
          </p>
        )}
      </div>
    </div>
  )
}
