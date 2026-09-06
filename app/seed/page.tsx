import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { SeedPageClient } from "./seed-page-client"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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
    redirect("/dashboard")
  }

  return <SeedPageClient />
}
