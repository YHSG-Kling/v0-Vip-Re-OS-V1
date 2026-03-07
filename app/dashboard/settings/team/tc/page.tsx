import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { TCSettingsClient } from "./tc-settings-client"

export const metadata = { title: "Transaction Coordinators | Team Settings" }

export default async function TCSettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  // Check user role
  const { data: userData } = await supabase.from("users").select("brokerage_id, role").eq("id", user.id).single()

  if (!userData?.brokerage_id) {
    return (
      <div className="p-6 text-red-600 text-sm">No brokerage found. Please contact your administrator.</div>
    )
  }

  // Only allow broker and admin roles
  if (!["broker", "admin", "superadmin"].includes(userData.role || "")) {
    return (
      <div className="p-6 text-red-600 text-sm">
        You do not have permission to access this page. Only brokers and admins can manage TC settings.
      </div>
    )
  }

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
