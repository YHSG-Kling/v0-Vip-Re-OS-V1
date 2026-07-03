import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getReferralNetwork } from "@/app/actions/referrals/agent-referral-actions"
import { ReferralNetworkClient } from "./referral-network-client"

export const metadata = {
  title: "Referral Network",
  description: "Refer a client to an agent elsewhere in your brokerage and earn a referral fee when it closes.",
}

/**
 * /dashboard/agent/referral-network — the agent-to-agent CLIENT referral hub. See every agent in your
 * (multi-location / nationwide) brokerage grouped by location, refer a relocating client to the right
 * person, and track the referral + the fee you earn when their deal closes.
 */
export default async function ReferralNetworkPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const svc = createServiceClient()
  const { data: agent } = await svc.from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle()
  if (!agent?.brokerage_id) redirect("/dashboard/onboarding")

  const network = await getReferralNetwork()
  if (!network.ok) redirect("/dashboard/agent")

  // The agent's own contacts, for the "refer this client" picker.
  const { data: contacts } = await svc.from("contacts")
    .select("id, first_name, last_name").eq("brokerage_id", (agent as any).brokerage_id).eq("agent_id", (agent as any).id)
    .order("updated_at", { ascending: false }).limit(500)
  const contactOptions = ((contacts ?? []) as any[]).map((c) => ({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Unnamed contact" }))

  return (
    <ReferralNetworkClient
      agents={network.agents ?? []}
      outbound={network.outbound ?? []}
      earnedTotal={network.earnedTotal ?? 0}
      contacts={contactOptions}
    />
  )
}
