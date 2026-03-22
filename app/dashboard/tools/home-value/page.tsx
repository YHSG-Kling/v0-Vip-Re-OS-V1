import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
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

  if (!agentRow?.id) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground text-sm">
          No agent record found for your account. Contact your broker to get set up.
        </p>
      </div>
    )
  }

  // Resolve agent slug from valuation_requests or contacts — used for the embed URL.
  // We store the slug in ref_agent_slug on valuation_requests. The canonical
  // slug is the agent's user id (always available) so we use that as the fallback.
  const agentSlug = agentRow.user_id

  // Load existing config
  const existingConfig = await getPageConfig(agentRow.id)

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""

  return (
    <HomeValuePageBuilderClient
      agentId={agentRow.id}
      brokerageId={agentRow.brokerage_id}
      agentSlug={agentSlug}
      baseUrl={baseUrl}
      initialConfig={existingConfig}
    />
  )
}
