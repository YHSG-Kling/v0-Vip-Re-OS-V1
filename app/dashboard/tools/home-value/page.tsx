import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getPageConfig } from "@/app/actions/home-value"
import { ensureAgentBrokerage } from "@/app/actions/onboarding/ensure-agent-brokerage"
import { HomeValuePageBuilderClient } from "./HomeValuePageBuilderClient"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Home Value Page Builder",
  description: "Customize and publish your home value landing page.",
}

export default async function HomeValuePageBuilderPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Heal an incomplete account IN PLACE before resolving the agent record — don't
  // bounce the user off the Home Value builder they're working on.
  await ensureAgentBrokerage()

  // Resolve agent record
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, brokerage_id, user_id")
    .eq("user_id", user.id)
    .maybeSingle()

  // Heal genuinely couldn't complete (pending invite / non-agent) — honest in-place
  // notice instead of a dead end or a bounce.
  if (!agentRow?.id) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Finishing your account setup — refresh in a moment to build your home-value page.
      </div>
    )
  }

  const agentSlug = agentRow.user_id
  const service = createServiceClient()

  // Load config + requests in parallel
  const [existingConfig, requestsResult] = await Promise.all([
    getPageConfig(agentRow.id),
    service
      .from("valuation_requests")
      .select(
        `id, property_address, bedrooms, bathrooms, square_feet, condition,
         qualification_data, utm_source, submitted_at, contact_id,
         cma_sent, appointment_scheduled,
         contacts(first_name, last_name, email)`
      )
      .eq("brokerage_id", agentRow.brokerage_id)
      .order("submitted_at", { ascending: false })
      .limit(30),
  ])

  const allRequests = (requestsResult.data ?? []) as any[]
  const newRequests = allRequests.filter((r) => !r.contact_id)
  const convertedRequests = allRequests.filter((r) => r.contact_id)

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""

  return (
    <HomeValuePageBuilderClient
      agentId={agentRow.id}
      userId={user.id}
      brokerageId={agentRow.brokerage_id}
      agentSlug={agentSlug}
      baseUrl={baseUrl}
      initialConfig={existingConfig}
      newRequests={newRequests}
      convertedRequests={convertedRequests}
    />
  )
}
