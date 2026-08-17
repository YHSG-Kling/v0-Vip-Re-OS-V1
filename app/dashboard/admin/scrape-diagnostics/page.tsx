import { loadScrapingDiagnostics } from "@/lib/kernel/scraping"
import { createClient } from "@/lib/supabase/server"
import { ScrapeDiagnosticsClient } from "./scrape-diagnostics-client"
import { TenantCoverageCard } from "./tenant-coverage-card"
import { loadTenantCoverage, type TenantCoverage } from "@/lib/analytics/territory-coverage"
import { loadTerritoryRoi, type TerritoryRoiReport } from "@/lib/analytics/territory-roi"
import { redirect } from "next/navigation"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const metadata = {
  title:       "Scrape Diagnostics | Kernel OS Admin",
  description: "Source health, raw queue, enrichment status, dedup decisions, gating status, failed batch retry, source lineage, cron run history",
}

/**
 * Admin Scrape Diagnostics Page — Kernel OS
 *
 * Data loading is fully delegated to loadScrapingDiagnostics() in lib/kernel/scraping.ts.
 * That command returns all 9 required visibility dimensions as a normalized contract:
 *   1. Source health (executions per source, status)
 *   2. Raw queue (funnel by source + status)
 *   3. Enrichment status (queued_for_enrichment + enriching rows)
 *   4. Dedup decisions (lead_deduplication_log)
 *   5. Gating status (territory_mismatch, insufficient_identity rows)
 *   6. Failed source batch visibility (failed scraper_executions)
 *   7. Cron run history (cron_execution_logs)
 *   8. Source lineage and attribution (markets + funnel by source)
 *   9. Territory budgets (lead_scraping_markets)
 *
 * Zero direct DB queries in this file. Zero mock data.
 */
export default async function ScrapeDiagnosticsPage() {
  // Auth guard — only admin/broker/superadmin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")

  const { data: userData } = await supabase
    .from("users")
    .select("user_type, platform_role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const userType    = userData?.user_type ?? "agent"
  const brokerageId = userData?.brokerage_id ?? undefined
  // Platform scope from BOTH identity columns. `userType === "superadmin"` is
  // FALSE for the platform's only superadmin (user_type='admin',
  // platform_role='superadmin'), so this page always ran the brokerage-scoped
  // branch: the owner saw one tenant's scrape runs behind a header reading
  // "Production", and the tenant-coverage card (a card explicitly not meant for
  // them) rendered instead. Same shape as public.is_platform_admin() in RLS —
  // see app/actions/vendor-budget.ts:136-147.
  const isSuperadmin = userType === "superadmin" || userData?.platform_role === "superadmin"

  if (!isAdminOrBroker({ user_type: userType })) {
    redirect("/dashboard")
  }

  // Delegate all data loading to the kernel command
  const diagnostics = await loadScrapingDiagnostics({
    brokerageId: isSuperadmin ? undefined : brokerageId,
    limit:       100,
  })

  // Per-actor Apify health written by /api/cron/actor-health (platform-owned;
  // RLS limits reads to platform admins — non-platform callers just see an empty list)
  const { data: actorHealth } = await supabase
    .from("scraper_actor_health")
    .select("id, task, actor_id, alive, last_checked, last_error")
    .order("task", { ascending: true })
    .order("actor_id", { ascending: true })

  // "YOUR COVERAGE" (round 39) — the tenant territory-coverage card + their own
  // scrape-ROI funnel, mounted on this brokerage lead-scraping surface. Service
  // reads behind the admin/broker gate above (the same pattern as
  // loadScrapingDiagnostics on this page — subscriber_service_areas is
  // RLS-locked to the platform): the card renders ONLY this tenant's claims,
  // markets and funnel plus AGGREGATE per-zip counts for expansion hints —
  // never another tenant's identity. Superadmins (no single brokerage) skip the
  // tenant card — their board lives on /dashboard/superadmin/platform.
  let tenantCoverage: TenantCoverage | null = null
  let tenantCoverageError: string | null = null
  let tenantRoi: TerritoryRoiReport | null = null
  let tenantRoiError: string | null = null
  if (!isSuperadmin && brokerageId) {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const [cov, roi] = await Promise.all([
      loadTenantCoverage(svc, brokerageId),
      loadTerritoryRoi(svc, { brokerageId }),
    ])
    tenantCoverage = cov.coverage
    tenantCoverageError = cov.error
    tenantRoi = roi.report
    tenantRoiError = roi.error
  }

  return (
    <>
      <ScrapeDiagnosticsClient
        data={diagnostics}
        actorHealth={actorHealth ?? []}
        isSuperadmin={isSuperadmin}
        currentUserId={user.id}
      />
      {!isSuperadmin && brokerageId && (
        <TenantCoverageCard
          coverage={tenantCoverage}
          coverageError={tenantCoverageError}
          roi={tenantRoi}
          roiError={tenantRoiError}
        />
      )}
    </>
  )
}
