import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { loadCommandCenter } from "@/lib/kernel/command-center"
import { CommandCenterClient } from "./command-center-client"

export const metadata = {
  title:       "Agent Command Center | Kernel OS Admin",
  description: "Live managed-agent sessions + the agent-action approval queue across the multi-manager runtime.",
}

/**
 * Agent Command Center — the operator surface over the multi-manager runtime.
 * Auth-gated (admin/broker/superadmin); superadmin sees platform-wide, others
 * are scoped to their brokerage. All data via loadCommandCenter() — no mock data.
 */
export default async function CommandCenterPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")

  const { data: userData } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const userType    = userData?.user_type ?? "agent"
  const brokerageId = userData?.brokerage_id ?? undefined
  if (!["admin", "broker", "superadmin"].includes(userType)) redirect("/dashboard")

  const data = await loadCommandCenter({
    brokerageId: userType === "superadmin" ? undefined : brokerageId,
    limit:       100,
  })

  return <CommandCenterClient data={data} scope={userType === "superadmin" ? "platform" : "brokerage"} />
}
