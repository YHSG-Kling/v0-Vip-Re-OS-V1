import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { SeedPageClient } from "./seed-page-client"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { RoleGateNotice } from "@/app/components/shared/role-gate-notice"

export const dynamic = "force-dynamic"

export default async function SeedPage() {
  const supabase = await createClient()
  const ctx = await getAgentContext()

  if (!ctx) {
    redirect("/login")
  }

  // Role gate: broker or admin only
  const { data: userData } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", ctx.userId)
    .single()

  if (!userData || !isAdminOrBroker({ user_type: userData.user_type })) {
    return <RoleGateNotice surface="The seed page" audience="your broker, brokerage admins, team leads and the compliance officer" />
  }

  return <SeedPageClient />
}
