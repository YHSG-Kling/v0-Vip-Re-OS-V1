import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import Link from "next/link"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { VendorDirectoryClient } from "./vendor-directory-client"
import {
  PremiumPlacementPanel,
  type DirectoryEntry,
  type PlacementInvoice,
} from "./premium-placement-panel"
import {
  VendorChargesPanel,
  type VendorChargeInvoice,
} from "./vendor-charges-panel"
import { createServiceClient } from "@/lib/supabase/service"
import { findChargeAttribution, resolveVendorActorScope } from "@/lib/vendors/vendor-scope"
import { readW9StatusMap, type W9Status } from "@/lib/vendors/w9"
import {
  searchVendors,
  getAllVendorBookings,
  getCompletedBookingsForRating,
  getVendorCostComparison,
  getAgentAssignedVendors,
  getVendorReviews,
} from "@/app/actions/vendor-marketplace"
import { Store, FileText, Star, CheckCircle2 } from "lucide-react"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"
import {
  PartnerCommandStrip,
  VendorPerformanceRadar,
  ReferralTrackingPanel,
  LenderStatusPanel,
  TitlePipelinePanel,
  VendorSlaPanel,
  AiVendorInsightsPanel,
} from "@/app/dashboard/partners/components/os"

export const dynamic = "force-dynamic"

export default async function VendorsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // Fetch parallel data for all tabs
  const [
    vendors,
    recentBookings,
    pendingRatings,
    transactions,
    assignedVendors,
    preferredVendors,
    deliverables,
    directoryEntries,
    placementInvoices,
  ] = await Promise.all([
    searchVendors({ limit: 100 }),
    getAllVendorBookings(20),
    getCompletedBookingsForRating(),
    supabase
      .from("transactions")
      .select("id, property_address, stage")
      .eq("brokerage_id", profile.brokerage_id)
      .in("status", [...TRANSACTION_STATUSES_OPEN])
      .order("created_at", { ascending: false })
      .limit(50)
      .then(r => r.data || []),
    getAgentAssignedVendors(50),
    // vendors replaced vendor_directory — vendor_directory was a writer-less legacy twin (burn-down round 4 repoint)
    supabase
      .from("vendors")
      .select("id, name, phone, email, website, category, notes, rating, brokerage_id")
      .eq("brokerage_id", profile.brokerage_id)
      .order("rating", { ascending: false, nullsFirst: false })
      .then(r => r.data || []),
    // Vendor deliverables — client_documents with doc_type = 'vendor_deliverable'
    supabase
      .from("client_documents")
      .select("id, doc_name:document_name, file_url:document_url, notes, created_at, metadata")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("document_type", "vendor_deliverable")
      .order("created_at", { ascending: false })
      .limit(100)
      .then(r => r.data || []),
    // Premium placement (monetization): curated vendor_directory rows carry the
    // paid placement flags {preferred, display_priority}; the vendor_invoices
    // ledger holds the placement charges. See lib/vendors/premium-placement.ts.
    supabase
      .from("vendor_directory")
      .select("id, vendor_id, name, category, preferred, display_priority")
      .eq("brokerage_id", profile.brokerage_id)
      .order("display_priority", { ascending: false })
      .order("name", { ascending: true })
      .limit(100)
      .then(r => (r.data || []) as Array<{
        id: string
        vendor_id: string | null
        name: string | null
        category: string | null
        preferred: boolean | null
        display_priority: number | null
      }>),
    supabase
      .from("vendor_invoices")
      .select("id, invoice_number, status, total_amount, due_date, paid_at, line_items")
      .eq("brokerage_id", profile.brokerage_id)
      .contains("line_items", JSON.stringify([{ type: "premium_placement" }]))
      .order("created_at", { ascending: false })
      .limit(100)
      .then(r => (r.data || []) as PlacementInvoice[]),
  ])

  // General tenant→vendor charges (billed_to='vendor' — migration 1104). Safe
  // pre-migration: the filter simply matches no rows. The query stays
  // BROKERAGE-WIDE with no scope fork — brokerage admins see agent/team-raised
  // charges in the same list; per-scope attribution is read off the
  // charge_attribution line item (round 37) for display + agent filtering.
  const vendorCharges = await supabase
    .from("vendor_invoices")
    .select("id, vendor_id, invoice_number, status, total_amount, due_date, paid_at, notes, line_items")
    .eq("brokerage_id", profile.brokerage_id)
    .eq("billed_to", "vendor")
    .order("created_at", { ascending: false })
    .limit(100)
    .then(r =>
      (r.data || []).map((row: any) => {
        const attribution = findChargeAttribution(row.line_items)
        const { line_items: _li, ...rest } = row
        return {
          ...rest,
          attributed_user_id: attribution?.user_id ?? null,
          attributed_scope: attribution?.scope ?? null,
        } as VendorChargeInvoice
      })
    )

  // Round 37 — agents charge THEIR vendors: resolve the viewer's team scope and
  // (for agents) which vendors are attributed to them (migration 1106 columns —
  // pre-migration the select fails soft to an empty list, an honest "none yet").
  let chargeableVendorIds: string[] | null = null // null = unrestricted (leadership)
  if (profile.user_type === "agent") {
    chargeableVendorIds = []
    try {
      const svc = createServiceClient()
      const scope = await resolveVendorActorScope(svc, {
        userId: profile.id,
        userType: profile.user_type,
        brokerageId: profile.brokerage_id,
      })
      const { data: attributed } = await svc
        .from("vendors")
        .select("id, invited_by_user_id, invited_by_team_id")
        .eq("brokerage_id", profile.brokerage_id)
        .or(
          scope.teamId
            ? `invited_by_user_id.eq.${profile.id},invited_by_team_id.eq.${scope.teamId}`
            : `invited_by_user_id.eq.${profile.id}`
        )
      chargeableVendorIds = (attributed ?? []).map((v: any) => v.id as string)
    } catch { /* pre-migration 1106 — no attributed vendors yet */ }
  }

  // W-9 posture per vendor (owner round 43) — powers the on_file/missing badge
  // so the brokerage can see who to chase for 1099 reporting. Fail-soft
  // pre-migration m275: an empty map renders every vendor as 'missing' — the
  // honest default (no W-9 has ever been captured).
  const w9StatusMap: Map<string, W9Status> = await readW9StatusMap(
    createServiceClient(), profile.brokerage_id
  ).catch(() => new Map<string, W9Status>())

  const serviceTypes = [...new Set(vendors.map(v => v.category).filter(Boolean))]
  const assignedCount = assignedVendors?.length || 0
  const pendingRatingsCount = pendingRatings?.length || 0

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Vendor Management</h1>
        <p className="text-muted-foreground mt-1">
          Browse vendors, manage assignments, and track service bookings
        </p>
      </div>

      {/* OS Command Strip */}
      <PartnerCommandStrip brokerageId={profile.brokerage_id} />

      {/* OS Intelligence Panels - First Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <VendorPerformanceRadar brokerageId={profile.brokerage_id} />
        <VendorSlaPanel brokerageId={profile.brokerage_id} />
        <AiVendorInsightsPanel brokerageId={profile.brokerage_id} />
      </div>

      {/* OS Intelligence Panels - Second Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <LenderStatusPanel brokerageId={profile.brokerage_id} />
        <TitlePipelinePanel brokerageId={profile.brokerage_id} />
        <ReferralTrackingPanel brokerageId={profile.brokerage_id} />
      </div>

      <Tabs defaultValue="marketplace" className="space-y-6">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="marketplace" className="flex items-center gap-2">
            <Store className="h-4 w-4" />
            <span className="hidden sm:inline">Marketplace</span>
          </TabsTrigger>
          <TabsTrigger value="assigned" className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            <span className="hidden sm:inline">Assigned</span>
            {assignedCount > 0 && (
              <span className="ml-1 inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                {assignedCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="preferred" className="flex items-center gap-2">
            <Star className="h-4 w-4" />
            <span className="hidden sm:inline">Preferred</span>
          </TabsTrigger>
          <TabsTrigger value="reviews" className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            <span className="hidden sm:inline">Reviews</span>
            {pendingRatingsCount > 0 && (
              <span className="ml-1 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                {pendingRatingsCount}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Marketplace */}
        <TabsContent value="marketplace" className="space-y-4">
          <Suspense fallback={<div className="animate-pulse">Loading vendor directory...</div>}>
            <VendorDirectoryClient
              initialVendors={vendors}
              recentBookings={recentBookings}
              pendingRatings={pendingRatings}
              transactions={transactions}
              serviceTypes={serviceTypes}
              brokerageId={profile.brokerage_id}
              userRole={profile.user_type ?? "agent"}
              deliverables={deliverables}
            />
          </Suspense>
        </TabsContent>

        {/* Tab 2: Assigned Vendors */}
        <TabsContent value="assigned" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>My Assigned Vendors</CardTitle>
              <CardDescription>
                Vendors assigned to your active transactions
              </CardDescription>
            </CardHeader>
            <CardContent>
              {assignedVendors && assignedVendors.length > 0 ? (
                <div className="space-y-4">
                  {assignedVendors.map((assignment: any) => (
                    <div
                      key={assignment.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium">
                            {assignment.vendors?.name || "Unknown Vendor"}
                          </p>
                          <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                            {assignment.assignment_type}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {assignment.transactions?.property_address || "Transaction"}
                        </p>
                        {assignment.scheduled_date && (
                          <p className="text-xs text-muted-foreground">
                            Scheduled: {new Date(assignment.scheduled_date).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-medium ${
                            assignment.status === "completed"
                              ? "bg-green-100 text-green-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {assignment.status}
                        </span>
                        <Link
                          href={`/dashboard/transactions/${assignment.transaction_id}`}
                          className="text-blue-600 hover:underline text-sm"
                        >
                          View
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No vendors assigned yet</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Preferred Vendors (Brokerage Curated) */}
        <TabsContent value="preferred" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Preferred Vendors</CardTitle>
              <CardDescription>
                Your brokerage's curated vendor list
              </CardDescription>
            </CardHeader>
            <CardContent>
              {preferredVendors && preferredVendors.length > 0 ? (
                <div className="space-y-3">
                  {preferredVendors.map((v: any) => (
                    <div
                      key={v.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{v.name || "Vendor"}</p>
                          {/* W-9 badge (round 43) — soft visibility, never a block */}
                          <W9Badge status={w9StatusMap.get(v.id) ?? "missing"} />
                        </div>
                        <p className="text-sm text-muted-foreground">{v.category}</p>
                        <div className="flex gap-4 text-sm">
                          {v.phone && (
                            <a href={`tel:${v.phone}`} className="text-blue-600 hover:underline">
                              {v.phone}
                            </a>
                          )}
                          {v.website && (
                            <a
                              href={v.website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              Website
                            </a>
                          )}
                        </div>
                      </div>
                      {v.rating && (
                        <div className="flex items-center gap-1">
                          <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                          <span className="font-medium">{Number(v.rating).toFixed(1)}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No preferred vendors set up yet</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Premium placement — subscribers charge vendors to be featured here */}
          {/*
            EVERY BENCH VENDOR IS SELLABLE, curated or not. This used to be fed
            vendor_directory rows only — and nothing in the repo ever inserted
            one (live count: 0 in every tenancy), so the list was always empty,
            the panel's own `length === 0` early-return fired, and the premium
            placement surface never rendered at all. The curation row is created
            on the first sale; until then a vendor simply has no directory id.
          */}
          <PremiumPlacementPanel
            directoryEntries={(preferredVendors ?? []).map((v: any) => {
              const curated = directoryEntries.find((d) => d.vendor_id === v.id)
              return {
                id: curated?.id ?? null,
                vendorId: v.id as string,
                name: curated?.name ?? v.name ?? null,
                category: curated?.category ?? v.category ?? null,
                preferred: curated?.preferred ?? false,
                display_priority: curated?.display_priority ?? 0,
              }
            })}
            placementInvoices={placementInvoices}
            userRole={profile.user_type ?? "agent"}
          />

          {/* General tenant→vendor charges (beyond placement). Premium placement
              above stays brokerage-level (brokerage-wide directory flags); agents
              and team leads monetize THEIR vendors through this lane instead. */}
          <VendorChargesPanel
            vendors={(preferredVendors ?? []).map((v: any) => ({
              id: v.id,
              name: v.name ?? null,
              category: v.category ?? null,
            }))}
            charges={vendorCharges}
            userRole={profile.user_type ?? "agent"}
            viewerUserId={profile.id}
            chargeableVendorIds={chargeableVendorIds}
          />
        </TabsContent>

        {/* Tab 4: Reviews */}
        <TabsContent value="reviews" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Vendor Reviews</CardTitle>
              <CardDescription>
                Rate your vendor experiences and view pending reviews
              </CardDescription>
            </CardHeader>
            <CardContent>
              {pendingRatings && pendingRatings.length > 0 ? (
                <div className="space-y-3">
                  {pendingRatings.map((booking: any) => (
                    <div
                      key={booking.id}
                      className="p-4 border rounded-lg"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{booking.vendors?.name || "Vendor"}</p>
                          <p className="text-sm text-muted-foreground">
                            {booking.transactions?.property_address}
                          </p>
                          <p className="text-sm text-muted-foreground mt-1">
                            Service: {booking.service_type}
                          </p>
                        </div>
                        <Link
                          href={`/dashboard/vendors?review=${booking.id}`}
                          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
                        >
                          Write Review
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No pending reviews</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** W-9 posture badge (round 43): on_file green / missing amber / expired red. */
function W9Badge({ status }: { status: W9Status }) {
  const meta =
    status === "on_file"
      ? { label: "W-9 on file", cls: "bg-green-100 text-green-800" }
      : status === "expired"
        ? { label: "W-9 needs update", cls: "bg-red-100 text-red-800" }
        : { label: "W-9 missing", cls: "bg-amber-100 text-amber-800" }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.cls}`}>
      {meta.label}
    </span>
  )
}
