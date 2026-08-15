import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { ContractReviewClient } from "./contract-review-client"

export const dynamic = "force-dynamic"

export default async function ContractReviewPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .single()
  if (!userRow?.brokerage_id) redirect("/dashboard")

  // Agent row (for agentId)
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, license_state")
    .eq("user_id", user.id)
    .maybeSingle()

  // Load open transactions so user can pick one
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, transaction_type, status, address, close_date, contact_id")
    .eq("brokerage_id", userRow.brokerage_id)
    .not("status", "in", '("closed","cancelled")')
    .order("created_at", { ascending: false })
    .limit(50)

  return (
    <ContractReviewClient
      agentId={agentRow?.id ?? user.id}
      agentState={agentRow?.license_state ?? "CA"}
      transactions={transactions ?? []}
    />
  )
}
