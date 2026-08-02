import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  getScrapingMarkets,
  getScrapingKeywords,
  getScrapingJobs,
} from "@/app/actions/lead-scraping-config"
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

  // Markets carry their nested property/motivated params from getScrapingMarkets'
  // own select. Keywords and job history are the rest of the scrape config that
  // had no reader anywhere in the product before this page loaded them.
  const [{ markets }, { keywords }, { jobs }] = await Promise.all([
    getScrapingMarkets(),
    getScrapingKeywords(),
    getScrapingJobs(25),
  ])

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
        initialMarkets={(markets ?? []).map((m: any) => {
          const pp = Array.isArray(m.lead_scraping_property_params)
            ? m.lead_scraping_property_params[0]
            : m.lead_scraping_property_params
          const mp = Array.isArray(m.lead_scraping_motivated_params)
            ? m.lead_scraping_motivated_params[0]
            : m.lead_scraping_motivated_params
          return {
            id: m.id, name: m.name, city: m.city, state: m.state,
            zip_codes: Array.isArray(m.zip_codes) ? m.zip_codes : [],
            is_active: m.is_active !== false,
            propertyParams: pp
              ? {
                  id: pp.id,
                  min_price: pp.min_price ?? null, max_price: pp.max_price ?? null,
                  min_beds: pp.min_beds ?? null, max_beds: pp.max_beds ?? null,
                  is_active: pp.is_active !== false,
                }
              : null,
            motivatedParams: mp
              ? {
                  id: mp.id,
                  min_equity_percent: mp.min_equity_percent ?? null,
                  max_days_on_market: mp.max_days_on_market ?? null,
                  include_expired_listings: mp.include_expired_listings !== false,
                  include_fsbo: mp.include_fsbo !== false,
                  is_active: mp.is_active !== false,
                }
              : null,
          }
        })}
        initialKeywords={(keywords ?? []).map((k: any) => ({
          id: k.id, keyword: k.keyword,
          keyword_type: k.keyword_type ?? k.category ?? "custom",
          weight: k.weight ?? null,
          is_active: k.is_active !== false,
        }))}
        initialJobs={(jobs ?? []).map((j: any) => {
          const mkt = Array.isArray(j.lead_scraping_markets)
            ? j.lead_scraping_markets[0]
            : j.lead_scraping_markets
          return {
            id: j.id, job_type: j.job_type, source: j.source, status: j.status ?? "pending",
            leads_found: j.leads_found ?? null, leads_created: j.leads_created ?? null,
            error_message: j.error_message ?? null,
            created_at: j.created_at ?? null, completed_at: j.completed_at ?? null,
            market_label: mkt ? `${mkt.name} — ${mkt.city}, ${mkt.state}` : null,
          }
        })}
        suggestedZip={suggestedZip}
      />
    </div>
  )
}
