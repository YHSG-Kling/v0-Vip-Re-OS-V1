import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  getProviderConnectionStatus,
  getSyncHistory,
  getSyncErrors,
  getTaxCategories,
} from "@/app/actions/accounting-sync"
import { LinkIcon, RefreshCw, AlertCircle, CheckCircle2, Clock, Settings2 } from "lucide-react"
import { ACCOUNTING_OFFERINGS, QUICKBOOKS_OAUTH_START } from "@/lib/connections/accounting-scopes"
import { readScopedZoom } from "@/lib/connections/zoom"
import { createServiceClient } from "@/lib/supabase/service"
import { defaultQbReconciliationPeriod, loadBrokerageQbReconciliation } from "@/lib/finance/qb-reconciliation"
import { ProviderConnectionCard } from "./provider-connection-card"
import { QbReconciliationCard } from "./qb-reconciliation-card"
import { SyncControlsCard } from "./sync-controls-card"
import { SyncHistoryTable } from "./sync-history-table"
import { ErrorLogTable } from "./error-log-table"
import { TaxCategoryManager } from "./tax-category-manager"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

export default async function AccountingSettingsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Get user profile and verify role
  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // Role gate: broker + admin only
  if (!["broker", "admin"].includes(profile.user_type ?? "")) {
    redirect("/dashboard")
  }

  // Fetch data in parallel
  const [
    providerStatus,
    syncHistoryResult,
    syncErrorsResult,
    taxCategories,
  ] = await Promise.all([
    getProviderConnectionStatus(profile.brokerage_id),
    getSyncHistory({ brokerageId: profile.brokerage_id, limit: 20 }),
    getSyncErrors({ brokerageId: profile.brokerage_id, limit: 50 }),
    getTaxCategories(profile.brokerage_id),
  ])

  const pendingErrorCount = syncErrorsResult.errors.length
  const hasActiveProvider = providerStatus.quickbooks.connected || providerStatus.xero.connected

  // QuickBooks reconciliation (round 37) — read-side: OS ledgers vs the
  // OS-recorded export log for the trailing window. Best-effort: a failed
  // read renders nothing rather than a broken card.
  const reconciliation = await loadBrokerageQbReconciliation(createServiceClient(), {
    brokerageId: profile.brokerage_id,
    ...defaultQbReconciliationPeriod(),
  }).catch(() => null)

  // BROKERAGE MEETINGS (round 39) — the brokerage's own Zoom (scope-aware, exact
  // owner match). Zoom appointments booked by brokerage members host here when
  // no more-specific (agent/team) Zoom is connected.
  const brokerageZoom = await readScopedZoom(createServiceClient(), "brokerage", profile.brokerage_id).catch(() => null)

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Accounting Sync</h1>
        <p className="text-muted-foreground mt-1">
          Connect QuickBooks or Xero and sync commissions and expenses
        </p>
      </div>

      <Tabs defaultValue="connections" className="space-y-6">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="connections" className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Connections</span>
          </TabsTrigger>
          <TabsTrigger value="history" className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            <span className="hidden sm:inline">History</span>
          </TabsTrigger>
          <TabsTrigger value="errors" className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span className="hidden sm:inline">Errors</span>
            {pendingErrorCount > 0 && (
              <Badge variant="destructive" className="ml-1">
                {pendingErrorCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="mapping" className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            <span className="hidden sm:inline">Tax Mapping</span>
          </TabsTrigger>
        </TabsList>

        {/* Section 1 & 2: Provider Connections + Sync Controls */}
        <TabsContent value="connections" className="space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <Suspense fallback={<div className="animate-pulse h-48 bg-muted rounded-lg" />}>
              <ProviderConnectionCard
                provider="quickbooks"
                scope="brokerage"
                status="connectable"
                connected={providerStatus.quickbooks.connected}
                companyName={providerStatus.quickbooks.companyName}
                lastSyncedAt={providerStatus.quickbooks.lastSyncedAt}
                connectPath={QUICKBOOKS_OAUTH_START}
                note="Connect the brokerage's QuickBooks company to sync commissions and expenses."
                brokerageId={profile.brokerage_id}
              />
            </Suspense>
            <Suspense fallback={<div className="animate-pulse h-48 bg-muted rounded-lg" />}>
              <ProviderConnectionCard
                provider="xero"
                scope="brokerage"
                status="connectable"
                connected={providerStatus.xero.connected}
                companyName={providerStatus.xero.companyName}
                lastSyncedAt={providerStatus.xero.lastSyncedAt}
                connectPath="/api/integrations/oauth/xero"
                note="Connect the brokerage's Xero organisation to sync commissions and expenses."
                brokerageId={profile.brokerage_id}
              />
            </Suspense>
            <Suspense fallback={<div className="animate-pulse h-48 bg-muted rounded-lg" />}>
              <ProviderConnectionCard
                provider="stripe"
                scope="brokerage"
                status={ACCOUNTING_OFFERINGS.brokerage.stripe.status}
                connected={false}
                connectPath={ACCOUNTING_OFFERINGS.brokerage.stripe.connectPath}
                note={ACCOUNTING_OFFERINGS.brokerage.stripe.verdict}
                brokerageId={profile.brokerage_id}
              />
            </Suspense>
            {/* MEETINGS (round 39) — the brokerage's Zoom, same card idiom. Provider-gated:
                missing ZOOM_CLIENT_ID/SECRET renders the honest gap, never a dead button. */}
            {brokerageZoom && (
              <Suspense fallback={<div className="animate-pulse h-48 bg-muted rounded-lg" />}>
                <ProviderConnectionCard
                  provider="zoom"
                  scope="brokerage"
                  status={brokerageZoom.offering.status}
                  connected={brokerageZoom.connected}
                  companyName={brokerageZoom.accountEmail}
                  connectPath={brokerageZoom.offering.connectPath}
                  note={brokerageZoom.offering.verdict}
                  canConnect={brokerageZoom.providerGap === null}
                  connectDisabledReason={brokerageZoom.providerGap}
                  brokerageId={profile.brokerage_id}
                />
              </Suspense>
            )}
          </div>

          {hasActiveProvider && (
            <SyncControlsCard brokerageId={profile.brokerage_id} />
          )}

          {!hasActiveProvider && (
            <Card>
              <CardContent className="p-8 text-center">
                <LinkIcon className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-muted-foreground">
                  Connect QuickBooks or Xero to start syncing your financial data
                </p>
              </CardContent>
            </Card>
          )}

          {/* QuickBooks reconciliation (round 37) — OS ledgers vs OS-recorded
              exports; the card itself states it is not a live QuickBooks pull. */}
          {reconciliation && <QbReconciliationCard recon={reconciliation} />}
        </TabsContent>

        {/* Section 3: Sync History */}
        <TabsContent value="history" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Sync History</CardTitle>
              <CardDescription>
                View past sync operations and their results
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SyncHistoryTable
                logs={syncHistoryResult.logs}
                brokerageId={profile.brokerage_id}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Section 4: Error Log */}
        <TabsContent value="errors" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Sync Errors</CardTitle>
              <CardDescription>
                Review and retry failed sync operations
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ErrorLogTable
                errors={syncErrorsResult.errors}
                brokerageId={profile.brokerage_id}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Section 5: Tax Category Mapping */}
        <TabsContent value="mapping" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Tax Category Mapping</CardTitle>
              <CardDescription>
                Map your categories to QuickBooks/Xero tax codes and accounts
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TaxCategoryManager
                categories={taxCategories}
                brokerageId={profile.brokerage_id}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
