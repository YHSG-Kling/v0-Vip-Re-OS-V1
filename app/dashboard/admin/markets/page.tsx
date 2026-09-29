import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  getScrapingMarkets,
  getScrapingKeywords,
  getScrapingJobs,
  getBatchDataFeedStatus,
} from "@/app/actions/lead-scraping-config"
import { MarketsSetupClient } from "./markets-client"
import { BATCHDATA_MOTIVATION_TYPES, quickListCatalogueForTrigger } from "@/lib/external/batchdata-client"
import { ALL_RECORD_TYPES } from "@/lib/osint-client"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { RoleGateNotice } from "@/app/components/shared/role-gate-notice"

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
  if (!user) redirect("/login")

  const { data: userData } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  const userType = userData?.user_type ?? "agent"
  const brokerageId = userData?.brokerage_id ?? null
  if (!isAdminOrBroker({ user_type: userType })) return <RoleGateNotice surface="Markets" audience="your broker, brokerage admins, team leads and the compliance officer" />

  // Markets carry their nested property/motivated params from getScrapingMarkets'
  // own select. Keywords and job history are the rest of the scrape config that
  // had no reader anywhere in the product before this page loaded them.
  // Wave 66: the BatchData feed status (active-listing feed, incremental-search
  // cursor state, Property-Monitoring subscription ledger) is the READER half
  // of m635/m636 — written by the lead-scraping cron, shown nowhere before.
  const [{ markets }, { keywords }, { jobs }, feed] = await Promise.all([
    getScrapingMarkets(),
    getScrapingKeywords(),
    getScrapingJobs(25),
    getBatchDataFeedStatus(),
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
            // Lane 72C — the toggle surface wave 71 flagged. NULL reads as the cron's own
            // fallback (["batchdata_motivated"], app/api/cron/lead-scraping/route.ts:231/1031),
            // never as "everything on" or "everything off" — the panel shows that fallback
            // explicitly rather than guessing.
            enabled_sources: Array.isArray(m.enabled_sources) ? m.enabled_sources : null,
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
                  // Lane 88G — the real columns (signal_types, is_active); the four fields read here
                  // before were never columns of lead_scraping_motivated_params.
                  signal_types: Array.isArray(mp.signal_types) ? mp.signal_types : [],
                  is_active: mp.is_active !== false,
                  facebook_group_urls: Array.isArray(mp.facebook_group_urls) ? mp.facebook_group_urls : [],
                  reddit_subreddits: Array.isArray(mp.reddit_subreddits) ? mp.reddit_subreddits : [],
                  lookback_days: typeof mp.lookback_days === "number" ? mp.lookback_days : null,
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
        initialFeed={{
          listings: feed.listings,
          searchState: feed.searchState,
          subscriptions: feed.subscriptions,
          activeListingSources: feed.activeListingSources,
          error: feed.success ? null : (feed.error ?? "feed status unavailable"),
        }}
        signalTypeOptions={MOTIVATED_SIGNAL_OPTIONS}
      />
    </div>
  )
}

/**
 * Lane 88G — the "Motivated signals" picker's options, DERIVED from the two vocabularies the cron
 * reads (never a hand list, CLAUDE.md §6): BatchData's pullable triggers (BATCHDATA_MOTIVATION_TYPES
 * minus 'expired', which is its own Data-sources toggle) and the OSINT court record types
 * (ALL_RECORD_TYPES). Built server-side so the client bundle never imports either provider client.
 */
const MOTIVATED_SIGNAL_OPTIONS: Array<{ value: string; source: "batchdata" | "court"; caption: string | null; quickList: string | null; defaultOn: boolean }> = [
  // Lane 90B — each BatchData option carries the catalogue's JUDGEMENT (why the quickList is pulled
  // this way, which published list it is, whether an unconfigured market already runs it) from
  // quickListCatalogueForTrigger — lane 89B named it "the admin picker's caption source" and no
  // picker read it (orphan census, category A). The operator switching a trigger on now sees why.
  ...BATCHDATA_MOTIVATION_TYPES.filter((t) => t !== "expired").map((value) => {
    const entry = quickListCatalogueForTrigger(value)
    return { value, source: "batchdata" as const, caption: entry?.why ?? null, quickList: entry?.quickList ?? null, defaultOn: entry?.defaultOn === true }
  }),
  ...(ALL_RECORD_TYPES as readonly string[])
    .filter((t) => !(BATCHDATA_MOTIVATION_TYPES as readonly string[]).includes(t))
    .map((value) => ({ value, source: "court" as const, caption: null, quickList: null, defaultOn: false })),
]
