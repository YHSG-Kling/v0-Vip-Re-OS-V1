import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"
import { ProvidersHealthClient } from "./providers-health-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Provider Health | Admin",
  description: "Live status of all external integrations and providers",
}

export default async function ProvidersPage() {
  const context = await getAgentContext()

  if (!context?.brokerageId) redirect("/login")
  if (context.role !== "admin" && context.role !== "broker") redirect("/dashboard")

  const supabase = createClient()

  // Load brokerage settings — GHL, IDX, calendar, e-sign keys live here
  const [settingsResult, integrationsResult, socialResult] = await Promise.all([
    supabase
      .from("global_settings")
      .select("ghl_api_key, zapier_api_key, smtp_host")
      .eq("brokerage_id", context.brokerageId)
      .maybeSingle(),
    supabase
      .from("brokerage_integrations")
      .select("provider_name, provider_type, status, last_health_check_at, last_error, metadata")
      .eq("brokerage_id", context.brokerageId),
    supabase
      .from("social_media_accounts")
      .select("platform, is_active")
      .eq("brokerage_id", context.brokerageId),
  ])

  const settings = settingsResult.data
  const integrations = integrationsResult.data ?? []
  const socialAccounts = socialResult.data ?? []

  // Helper: find a brokerage_integration by provider name
  const findIntegration = (name: string) =>
    integrations.find((i) => i.provider_name?.toLowerCase().includes(name.toLowerCase()))

  // Derive per-provider status from real data
  const ghlIntegration = findIntegration("ghl") ?? findIntegration("go_high_level")
  const calendarIntegration = findIntegration("google_calendar") ?? findIntegration("calendar")
  const esignIntegration = findIntegration("docusign") ?? findIntegration("hellosign") ?? findIntegration("esign")
  const heygenIntegration = findIntegration("heygen")
  const dotloopIntegration = findIntegration("dotloop")
  const idxIntegration = findIntegration("idx") ?? findIntegration("mls")

  const hasStripe = !!process.env.STRIPE_SECRET_KEY
  const hasGhl = !!(settings?.ghl_api_key || ghlIntegration?.status === "active")
  const hasCalendar = !!(calendarIntegration?.status === "active")
  const hasEsign = !!(esignIntegration?.status === "active")
  const hasSocial = socialAccounts.some((a) => a.is_active)
  const hasHeygen = !!(heygenIntegration?.status === "active")
  const hasIdx = !!(idxIntegration?.status === "active")
  const hasDotloop = !!(dotloopIntegration?.status === "active")

  const providers = [
    {
      key: "ghl",
      name: "GoHighLevel / CRM",
      icon: "briefcase",
      isLive: hasGhl,
      integration: ghlIntegration,
      affectedFeatures: ["Contact sync", "Lead distribution", "CRM push"],
      configPath: "/dashboard/settings/integrations",
    },
    {
      key: "calendar",
      name: "Calendar",
      icon: "calendar",
      isLive: hasCalendar,
      integration: calendarIntegration,
      affectedFeatures: ["Scheduling", "Showing confirmation", "Tour booking"],
      configPath: "/dashboard/settings/integrations",
    },
    {
      key: "esign",
      name: "E-Sign",
      icon: "pen-line",
      isLive: hasEsign,
      integration: esignIntegration,
      affectedFeatures: ["Offer submission", "Listing agreement"],
      configPath: "/dashboard/settings/integrations",
    },
    {
      key: "social",
      name: "Social Media",
      icon: "share-2",
      isLive: hasSocial,
      integration: null,
      affectedFeatures: ["Post scheduling", "Brand campaigns", "Listing promotion"],
      configPath: "/dashboard/settings/integrations",
    },
    {
      key: "heygen",
      name: "HeyGen Video",
      icon: "video",
      isLive: hasHeygen,
      integration: heygenIntegration,
      affectedFeatures: ["Video generation", "AI avatar content"],
      configPath: "/dashboard/settings/integrations",
    },
    {
      key: "dotloop",
      name: "Dotloop",
      icon: "file-signature",
      isLive: hasDotloop,
      integration: dotloopIntegration,
      affectedFeatures: ["Transaction forms", "E-sign in transactions"],
      configPath: "/dashboard/settings/integrations",
    },
    {
      key: "idx",
      name: "IDX / MLS",
      icon: "home",
      isLive: hasIdx,
      integration: idxIntegration,
      affectedFeatures: ["Property search", "Buyer alerts", "Listing syndication"],
      configPath: "/dashboard/settings/integrations",
    },
    {
      key: "stripe",
      name: "Stripe",
      icon: "credit-card",
      isLive: hasStripe,
      integration: null,
      affectedFeatures: ["Billing", "Subscription management"],
      configPath: "/dashboard/settings/integrations",
    },
  ]

  const liveCount = providers.filter((p) => p.isLive).length
  const disconnectedCount = providers.filter((p) => !p.isLive).length
  // Mock mode = not live but integration record exists (fallback is running)
  const mockCount = providers.filter(
    (p) => !p.isLive && p.integration !== null
  ).length

  return (
    <ProvidersHealthClient
      brokerageId={context.brokerageId}
      providers={providers}
      summary={{ liveCount, disconnectedCount, mockCount }}
    />
  )
}
