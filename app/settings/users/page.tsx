import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { UsersManagementClient } from "./users-management-client"
import { SsoConnectionCard } from "./sso-connection-card"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
// Read on the SERVER so the ~1600-line generated vocabulary cache stays out of
// the client bundle; only the ~15 admissible user_type strings cross.
import { CHECK_VOCABULARIES } from "@/scripts/check-vocabularies"

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
  if (!isAdminOrBroker({ user_type: userType })) {
    redirect("/dashboard")
  }

  const brokerageId = profile?.brokerage_id

  // Tenant tier — drives the tier-aware role menu + invite dialog (same matrix
  // the canonical /dashboard/admin/users surface uses; no drift).
  const { data: tenant } = brokerageId
    ? await supabase.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
    : { data: null }
  const planTier = (tenant as { plan_tier?: string | null } | null)?.plan_tier ?? null

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
        callerRole={userType}
        tier={planTier}
        storableUserTypes={CHECK_VOCABULARIES.users?.user_type}
      />
      {/* SSO / SAML — team access policy lives with team management. */}
      <SsoConnectionCard />
    </div>
  )
}
