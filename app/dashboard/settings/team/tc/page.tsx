import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { TCSettingsClient } from "./tc-settings-client"

export const metadata = { title: "Transaction Coordinators | Team Settings" }

export default async function TCSettingsPage() {
  // Kernel OS: getAgentContext — canonical identity resolution
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect("/login")

  if (!ctx.brokerageId) return (
    <div className="p-6 text-red-600 text-sm">No brokerage found. Please contact your administrator.</div>
  )
  // TRUE ADMIN GATE (operational: team/TC settings) — repointed to the ONE
  // tenant roster (it accepts every legacy input spelling the canonicalizer
  // does). 'superadmin' was dead: 0 live rows store that users.user_type.
  if (!isAdminOrBroker({ user_type: ctx.userType })) return (
    <div className="p-6 text-red-600 text-sm">
      You do not have permission to access this page. Only brokers and admins can manage TC settings.
    </div>
  )

  const supabase = await createClient()
  // alias for downstream usage
  const userData = { brokerage_id: ctx.brokerageId }

  // Fetch all transaction coordinators for this brokerage
  const { data: coordinators } = await supabase
    .from("transaction_coordinators")
    .select("*")
    .eq("brokerage_id", userData.brokerage_id)
    .order("display_name")

  // Fetch users who could be TCs (for the dropdown)
  const { data: users } = await supabase
    .from("users")
    .select("id, first_name, last_name, email, role")
    .eq("brokerage_id", userData.brokerage_id)
    .order("first_name")

  // Fetch all transactions for assignment
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, property_address, status, stage, close_date, agent_id")
    .eq("brokerage_id", userData.brokerage_id)
    .not("status", "in", "(closed,cancelled)")
    .order("close_date")

  // Fetch all current assignments
  const { data: assignments } = await supabase
    .from("transaction_assignments")
    .select("id, transaction_id, coordinator_id, is_primary, assigned_at")
    .eq("brokerage_id", userData.brokerage_id)

  return (
    <TCSettingsClient
      coordinators={coordinators || []}
      users={users || []}
      transactions={transactions || []}
      assignments={assignments || []}
      brokerageId={userData.brokerage_id}
    />
  )
}
