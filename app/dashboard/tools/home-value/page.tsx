import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getPageConfig } from "@/app/actions/home-value"
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

  // Resolve agent record
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, brokerage_id, user_id")
    .eq("user_id", user.id)
    .maybeSingle()

  // A signed-in user with no agent record is an incomplete/brokerage-less account —
  // NOT a dead end, and "contact your broker" is wrong for a solo agent (their own
  // broker). Send them to /dashboard, which self-heals the agent record and re-routes.
  if (!agentRow?.id) {
    redirect("/dashboard")
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
