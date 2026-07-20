import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getScrapingMarkets } from "@/app/actions/lead-scraping-config"
import { MarketsSetupClient } from "./markets-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title:       "Lead Markets | Kernel OS Admin",
  description: "Define the territories the canonical scrape pipeline works — the pipeline no-ops without an active market.",
}

/**
 * MARKETS SETUP (round 42 gap-wire) — the missing settings surface for
 * lead_scraping_markets. The create/update actions existed
 * (app/actions/lead-scraping-config.ts) but NO page called them: territories
 * were only VIEWED in scrape-diagnostics, so the entire scrape pipeline
 * no-oped for every self-serve tenant. This page is the honest fill: list +
 * create + activate/deactivate, prefilled with the zip the prospect searched
 * on /pricing (billing_metadata.signup_intent — a SUGGESTION, never
 * auto-created; lib/platform/territory-marketplace.ts contract).
 */
export default async function MarketsSetupPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")

  const { data: userData } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  const userType = userData?.user_type ?? "agent"
  const brokerageId = userData?.brokerage_id ?? null
  if (!["admin", "broker", "broker_admin", "superadmin"].includes(userType)) redirect("/dashboard")

  const { markets } = await getScrapingMarkets()

  // The territory-marketplace carry: the zip searched on /pricing, stored at
  // signup as a suggestion. Prefill only — the admin still creates the market.
  let suggestedZip: string | null = null
  if (brokerageId) {
    try {
      const { loadCarriedTerritoryZip } = await import("@/lib/platform/territory-marketplace")
      suggestedZip = await loadCarriedTerritoryZip(createServiceClient(), brokerageId)
    } catch { /* prefill is additive */ }
  }

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Lead markets</h1>
        <p className="text-sm text-muted-foreground">
          The territories your AI lead engine works. The scrape pipeline only runs inside active markets —
          with none defined it no-ops and you get zero platform-sourced leads. A market&apos;s zips also become
          your claimed service areas for lead distribution.
        </p>
      </div>
      <MarketsSetupClient
        initialMarkets={(markets ?? []).map((m: any) => ({
          id: m.id, name: m.name, city: m.city, state: m.state,
          zip_codes: Array.isArray(m.zip_codes) ? m.zip_codes : [],
          is_active: m.is_active !== false,
        }))}
        suggestedZip={suggestedZip}
      />
    </div>
  )
}
