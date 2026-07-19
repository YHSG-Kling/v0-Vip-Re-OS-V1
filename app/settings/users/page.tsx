import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { UsersManagementClient } from "./users-management-client"
import { SsoConnectionCard } from "./sso-connection-card"

export const dynamic = "force-dynamic"

export default async function SettingsUsersPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const userType = profile?.user_type ?? "agent"

  // Only admin/broker/superadmin can manage users
  if (!["admin", "broker", "superadmin", "broker_admin"].includes(userType)) {
    redirect("/dashboard")
  }

  const brokerageId = profile?.brokerage_id

  // Fetch all users in the brokerage
  const { data: users } = brokerageId
    ? await supabase
        .from("users")
        .select("id, email, first_name, last_name, user_type, created_at, brokerage_id")
        .eq("brokerage_id", brokerageId)
        .order("created_at", { ascending: false })
    : await supabase
        .from("users")
        .select("id, email, first_name, last_name, user_type, created_at, brokerage_id")
        .order("created_at", { ascending: false })

  return (
    <div className="space-y-6">
      <UsersManagementClient
        users={users ?? []}
        currentUserId={user.id}
        brokerageId={brokerageId}
      />
      {/* SSO / SAML — team access policy lives with team management. */}
      <SsoConnectionCard />
    </div>
  )
}
