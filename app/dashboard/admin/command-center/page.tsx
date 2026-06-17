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

  // Resolve the egress scope so the surface shows the right slice. superadmin = platform-wide (no
  // scope). For everyone else, resolve their office (agents.location_id) + team so a multi-location
  // admin is scoped to their location while broker/broker_admin see all locations.
  let locationId: string | null = null
  let teamId: string | null = null
  if (userType !== "superadmin" && brokerageId) {
    const { data: agentRow } = await supabase
      .from("agents").select("location_id, team_id").eq("user_id", user.id).eq("brokerage_id", brokerageId).maybeSingle()
    locationId = (agentRow as any)?.location_id ?? null
    teamId = (agentRow as any)?.team_id ?? null
  }
  const scope = userType !== "superadmin" && brokerageId
    ? resolveEgressScope({ userType, userId: user.id, brokerageId, locationId, teamId })
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
