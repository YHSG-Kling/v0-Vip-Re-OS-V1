import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { HomeValueClient } from "./home-value-client"

export const dynamic = "force-dynamic"

interface AgentBrandData {
  agentId: string
  userId: string
  brokerageId: string
  agentName: string
  brokerageName: string | null
  brokeragePhone: string | null
  agentPhone: string | null
  agentEmail: string | null
  agentLicense: string | null
  licenseState: string | null
  photoUrl: string | null
  primaryColor: string | null
}

async function loadAgentBranding(slug: string): Promise<AgentBrandData | null> {
  const svc = createServiceClient()

  const { data: agent } = await svc
    .from("agents")
    .select(
      "id, user_id, brokerage_id, license_number, license_state, photo_url"
    )
    .eq("public_slug", slug)
    .maybeSingle()

  if (!agent) return null

  const { data: user } = await svc
    .from("users")
    .select("first_name, last_name, email, phone")
    .eq("id", agent.user_id)
    .maybeSingle()

  const { data: brokerage } = await svc
    .from("brokerages")
    .select("name, phone, primary_color")
    .eq("id", agent.brokerage_id)
    .maybeSingle()

  return {
    agentId: agent.id,
    userId: agent.user_id,
    brokerageId: agent.brokerage_id,
    agentName: [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "Your Agent",
    brokerageName: brokerage?.name ?? null,
    brokeragePhone: brokerage?.phone ?? null,
    agentPhone: user?.phone ?? null,
    agentEmail: user?.email ?? null,
    agentLicense: agent.license_number ?? null,
    licenseState: agent.license_state ?? null,
    photoUrl: agent.photo_url ?? null,
    primaryColor: brokerage?.primary_color ?? "#0f172a",
  }
}

export default async function HomeValuePage({
  params,
}: {
  params: Promise<{ agentSlug: string }>
}) {
  const { agentSlug } = await params
  const branding = await loadAgentBranding(agentSlug)
  if (!branding) notFound()

  return <HomeValueClient branding={branding} />
}
