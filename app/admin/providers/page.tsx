import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ProvidersHealthClient } from "./providers-health-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Provider Health | Platform Admin",
  description: "Monitor live vs mock/degraded provider status across all integrations",
}

// Provider definitions with affected features when disconnected
const PROVIDER_DEFINITIONS = [
  {
    key: "ghl",
    name: "GoHighLevel (CRM)",
    category: "CRM",
    envKey: "GHL_API_KEY",
    settingsKey: "ghl_api_key",
    configPath: "/settings/integrations/ghl",
    affectedFeatures: ["Contact sync", "Lead distribution", "CRM push", "Automation triggers"],
  },
  {
    key: "calendar",
    name: "Google Calendar",
    category: "Calendar",
    envKey: "GOOGLE_CALENDAR_TOKEN",
    settingsKey: "google_calendar_token",
    configPath: "/settings/integrations/calendar",
    affectedFeatures: ["Showing scheduling", "Tour booking", "Availability sync"],
  },
  {
    key: "esign",
    name: "E-Sign Provider",
    category: "Transactions",
    envKey: null,
    settingsKey: "esign_api_key",
    configPath: "/settings/integrations/esign",
    affectedFeatures: ["Offer submission", "Listing agreements", "Contract signing"],
  },
  {
    key: "dotloop",
    name: "Dotloop",
    category: "Transactions",
    envKey: "DOTLOOP_API_KEY",
    settingsKey: "dotloop_access_token",
    configPath: "/settings/integrations/dotloop",
    affectedFeatures: ["Transaction forms", "E-sign in transactions", "Document management"],
  },
  {
    key: "heygen",
    name: "HeyGen (Video AI)",
    category: "AI",
    envKey: "HEYGEN_API_KEY",
    settingsKey: "heygen_api_key",
    configPath: "/settings/integrations/heygen",
    affectedFeatures: ["Video generation", "Personalized property videos", "AI presenter"],
  },
  {
    key: "idx",
    name: "IDX Broker (MLS)",
    category: "MLS",
    envKey: "IDXBROKER_API_KEY",
    settingsKey: "idx_api_key",
    configPath: "/settings/integrations/idx",
    affectedFeatures: ["Property search", "Buyer alerts", "Listing data"],
  },
  {
    key: "stripe",
    name: "Stripe",
    category: "Billing",
    envKey: "STRIPE_SECRET_KEY",
    settingsKey: null,
    configPath: "/admin/billing",
    affectedFeatures: ["Billing", "Subscription management", "Payment processing"],
  },
  {
    key: "twilio",
    name: "Twilio (SMS)",
    category: "Communications",
    envKey: "TWILIO_ACCOUNT_SID",
    settingsKey: null,
    configPath: "/settings/integrations/twilio",
    affectedFeatures: ["SMS messaging", "Voice calling", "Lead notifications"],
  },
  {
    key: "anthropic",
    name: "Anthropic (AI)",
    category: "AI",
    envKey: "ANTHROPIC_API_KEY",
    settingsKey: null,
    configPath: "/admin/integrations",
    affectedFeatures: ["Content generation", "Smart suggestions", "AI assistant"],
  },
  {
    key: "social",
    name: "Social Media",
    category: "Marketing",
    envKey: null,
    settingsKey: "social_accounts",
    configPath: "/settings/integrations/social",
    affectedFeatures: ["Social posting", "Campaign scheduling", "Content distribution"],
  },
]

export default async function ProviderHealthPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()

  // Role gate — platform admin only
  const { data: adminRole } = await service
    .from("user_role_assignments")
    .select("role")
    .eq("user_id", user.id)
    .single()

  if (adminRole?.role !== "platform_admin") redirect("/dashboard")

  // Fetch all brokerage settings to derive provider status across all tenants
  const { data: allSettings } = await service
    .from("brokerage_settings")
    .select("brokerage_id, ghl_api_key, google_calendar_token, esign_api_key, esign_provider, dotloop_access_token, heygen_api_key, idx_api_key, social_accounts")

  // Fetch brokerage_integrations for richer data
  const { data: integrations } = await service
    .from("brokerage_integrations")
    .select("brokerage_id, provider_type, provider_name, status, last_error, last_health_check_at")

  // Derive per-provider aggregate status across all tenants
  const providerStatuses = PROVIDER_DEFINITIONS.map((def) => {
    // Check env var availability for env-based providers
    const envAvailable = def.envKey ? !!process.env[def.envKey] : true

    // Count settings-based connections
    let liveCount = 0
    const totalBrokerages = allSettings?.length ?? 0

    if (def.settingsKey && allSettings) {
      allSettings.forEach((s: Record<string, unknown>) => {
        const val = s[def.settingsKey as string]
        if (def.settingsKey === "social_accounts") {
          if (Array.isArray(val) && val.length > 0) liveCount++
        } else if (val) {
          liveCount++
        }
      })
    }

    // Check integration records
    const providerIntegrations = integrations?.filter(
      (i) => i.provider_type === def.key || i.provider_name?.toLowerCase().includes(def.key)
    ) || []
    const integrationErrors = providerIntegrations.filter((i) => i.status === "error")

    // Determine status
    let status: "live" | "mock" | "disconnected" | "degraded"
    if (!envAvailable && !def.settingsKey) {
      status = "disconnected"
    } else if (def.settingsKey && totalBrokerages > 0 && liveCount === 0) {
      status = "disconnected"
    } else if (integrationErrors.length > 0) {
      status = "degraded"
    } else if (def.settingsKey && totalBrokerages > 0 && liveCount < totalBrokerages) {
      status = "mock" // partially connected = some brokerages in mock/fallback
    } else {
      status = envAvailable ? "live" : "disconnected"
    }

    return {
      ...def,
      status,
      liveCount: def.settingsKey ? liveCount : envAvailable ? totalBrokerages : 0,
      totalBrokerages,
      lastError: integrationErrors[0]?.last_error ?? null,
      lastCheckedAt: providerIntegrations[0]?.last_health_check_at ?? null,
    }
  })

  const liveCount = providerStatuses.filter((p) => p.status === "live").length
  const mockCount = providerStatuses.filter((p) => p.status === "mock").length
  const disconnectedCount = providerStatuses.filter((p) => p.status === "disconnected").length
  const degradedCount = providerStatuses.filter((p) => p.status === "degraded").length

  return (
    <ProvidersHealthClient
      providers={providerStatuses}
      summary={{ liveCount, mockCount, disconnectedCount, degradedCount }}
    />
  )
}
