import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { ContractReviewClient } from "./contract-review-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { TRANSACTION_STATUSES_TERMINAL } from "@/lib/transactions/transaction-status"

export const dynamic = "force-dynamic"

export default async function ContractReviewPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // maybeSingle(), not single(): single() THROWS when the users row is missing or
  // not-yet-provisioned, crashing the page ("Contract — page won't load"). The
  // brokerage_id guard below handles the null case by self-healing via /dashboard.
  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow?.brokerage_id) redirect("/dashboard")

  // Agent row (for agentId)
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, license_state")
    .eq("user_id", user.id)
    .maybeSingle()

  // Load open transactions so user can pick one.
  //
  // This excluded '("closed","cancelled")'. `cancelled` is not a value
  // transactions.status can hold — the live CHECK admits lead | qualifying |
  // active | under_contract | pending | clear_to_close | closed | funded | lost |
  // archived — so half the filter matched nothing, while the three states that
  // ARE terminal (funded, lost, archived) were never excluded. Dead and lost
  // deals were offered for contract review as though they were live.
  //
  // Excluding the canonical TERMINAL set keeps every non-terminal deal visible,
  // including lead/qualifying, so nothing an agent could pick before disappears.
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, transaction_type:deal_type, status, address:property_address, close_date, contact_id")
    .eq("brokerage_id", userRow.brokerage_id)
    .not("status", "in", `(${TRANSACTION_STATUSES_TERMINAL.join(",")})`)
    .order("created_at", { ascending: false })
    .limit(50)

  // agentId below is NOT `?? user.id` (m347) — an agents id, or nothing.
  // Substituting the auth user id produced a value whose class nothing
  // downstream could rely on; see lib/kernel/agent-identity.
  return (
    <ContractReviewClient
      agentId={agentRow?.id ?? ""}
      agentState={agentRow?.license_state ?? "CA"}
      transactions={transactions ?? []}
    />
  )
}
