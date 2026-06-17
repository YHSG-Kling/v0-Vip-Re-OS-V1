import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { loadCommandCenter } from "@/lib/kernel/command-center"
import { resolveEgressScope } from "@/lib/kernel/egress-scope"
import { computeManagerTrust } from "@/lib/kernel/outcome-learning"
import { CommandCenterClient } from "./command-center-client"
import { TrustMeter } from "./trust-meter"

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

  // Resolve the egress scope so the surface shows the right slice. superadmin =
  // platform-wide (no scope); everyone else is scoped through resolveEgressScope
  // (admin/broker → brokerage-wide today; ready for finer team/agent tiers).
  const scope = userType !== "superadmin" && brokerageId
    ? resolveEgressScope({ userType, userId: user.id, brokerageId })
    : undefined

  const data = await loadCommandCenter({
    brokerageId: userType === "superadmin" ? undefined : brokerageId,
    scope,
    limit:       100,
  })

  // THE TRUST METER — per-manager human-approval rates + the broker's own rejection
  // reasons (outcome learning made visible; brokerage scope only).
  const trust = brokerageId && userType !== "superadmin"
    ? await computeManagerTrust(brokerageId).catch(() => null)
    : null

  return (
    <>
      {trust && <TrustMeter outcomes={trust.outcomes} feedback={trust.feedback} />}
      <CommandCenterClient data={data} scope={userType === "superadmin" ? "platform" : "brokerage"} />
    </>
  )
}
