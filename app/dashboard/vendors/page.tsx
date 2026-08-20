import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import Link from "next/link"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { VendorDirectoryClient } from "./vendor-directory-client"
import {
  PremiumPlacementPanel,
  type PlacementInvoice,
} from "./premium-placement-panel"
import {
  VendorChargesPanel,
  type VendorChargeInvoice,
} from "./vendor-charges-panel"
import {
  VendorBillsPanel,
  type VendorBillInvoice,
} from "./vendor-bills-panel"
import { createServiceClient } from "@/lib/supabase/service"
import { canInviteVendors, findChargeAttribution, resolveVendorActorScope } from "@/lib/vendors/vendor-scope"
import { readW9StatusMap, type W9Status } from "@/lib/vendors/w9"
import {
  searchVendors,
  getAllVendorBookings,
  getCompletedBookingsForRating,
  getVendorCostComparison,
  getAgentAssignedVendors,
  getVendorReviews,
} from "@/app/actions/vendor-marketplace"
import { Store, FileText, Star, CheckCircle2, KeyRound, Layers } from "lucide-react"
import { VendorAccessPanel } from "./vendor-access-panel"
import { VendorPortalInvitePanel } from "./vendor-portal-invite-panel"
import { VendorPlanCataloguePanel } from "./vendor-plan-catalogue-panel"
import { listVendorAssignmentsForBrokerageAction } from "@/app/actions/vendor-contact-access"
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
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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
    placementInvoices,
    listings,
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
    // ONE VENDOR SYSTEM (m355): the placement flags are columns on the vendor
    // row, so the Preferred tab reads them here instead of joining a second
    // table. display_priority leads the sort — that is what a brokerage's
    // vendor actually paid for, and ordering by rating alone meant a paid
    // placement changed nothing about where the vendor appeared.
    supabase
      .from("vendors")
      // compliance_credentials carries the certificate of insurance (m376). The
      // directory reads it so the bench itself distinguishes insured / expiring
      // / lapsed / never-checked — before an agent refers the vendor to a client,
      // not the morning after the nightly sweep suspends them.
      .select("id, name, phone, email, website, category, notes, rating, brokerage_id, preferred, display_priority, visible_in_portal, compliance_credentials")
      .eq("brokerage_id", profile.brokerage_id)
      .order("display_priority", { ascending: false })
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
    // Premium placement charges live in the vendor_invoices ledger; the paid
    // flags themselves are on the vendor row read above.
    // See lib/vendors/premium-placement.ts.
    supabase
      .from("vendor_invoices")
      .select("id, invoice_number, status, total_amount, due_date, paid_at, line_items")
      .eq("brokerage_id", profile.brokerage_id)
      .contains("line_items", JSON.stringify([{ type: "premium_placement" }]))
      .order("created_at", { ascending: false })
      .limit(100)
      .then(r => (r.data || []) as PlacementInvoice[]),
    // LISTING-level vendor work. vendor_bookings.listing_id has always existed
    // and the kernel has always been able to write it, but every booking surface
    // on the platform only ever offered a TRANSACTION — so pre-contract work on a
    // listing (staging, photography, pre-list inspection, cleaning) had nowhere
    // to be booked against the property it was for.
    supabase
      .from("listings")
      .select("id, address, status")
      .eq("brokerage_id", profile.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(50)
      .then(r => r.data || []),
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

  // VENDOR BILLS — the BROKERAGE→VENDOR payable lane (billed_to='brokerage'):
  // invoices vendors submitted for booked work, which the brokerage owes. Produced
  // by app/actions/multi-persona.ts:submitVendorInvoice from the vendor-bookings
  // panel. Marking one paid (vendor-payments.ts:markInvoicePaid) is the only thing
  // that mints the vendor_earnings row the payout lane draws on, so without this
  // list the loop had no consumer. `error` is read deliberately — supabase-js
  // resolves a refused query, and rendering "no bills awaiting payment" over a
  // denied read would hide real payables.
  const { data: vendorBillRows, error: vendorBillsErr } = await supabase
    .from("vendor_invoices")
    .select("id, vendor_id, invoice_number, status, total_amount, due_date, paid_at, notes")
    .eq("brokerage_id", profile.brokerage_id)
    .eq("billed_to", "brokerage")
    .order("created_at", { ascending: false })
    .limit(100)
  const vendorBills: VendorBillInvoice[] = vendorBillsErr ? [] : ((vendorBillRows ?? []) as VendorBillInvoice[])

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

  // CLIENT ACCESS GRANTS (vendor_contact_assignments). The read gate
  // lib/vendor/assignment-access.ts has always enforced these rows; until now
  // nothing on the platform could create one, so every vendor was locked out by
  // an empty table rather than by a decision. The list action is brokerage-scoped
  // server-side; the contact picker below is scoped again here.
  const accessRes = await listVendorAssignmentsForBrokerageAction()
  const accessAssignments = accessRes.ok ? accessRes.rows : []
  const accessLoadError = accessRes.ok ? null : accessRes.error
  const { data: grantableContacts } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email")
    .eq("brokerage_id", profile.brokerage_id)
    .order("last_name", { ascending: true })
    .limit(500)
  const contactOptions = (grantableContacts ?? []).map((c: any) => ({
    id: c.id as string,
    name: [c.first_name, c.last_name].filter(Boolean).join(" ") || (c.email as string) || "Unnamed contact",
  }))
  const vendorOptions = (preferredVendors ?? []).map((v: any) => ({
    id: v.id as string,
    name: (v.name as string) ?? "Unnamed vendor",
  }))
  const canRevokeAccess = isAdminOrBroker({ user_type: profile.user_type ?? "" })

  // PLATFORM INVITATIONS — the front door for the vendor portal. vendor_invitations
  // has had a writer (app/actions/vendor-invite.ts) and an acceptance page
  // (/vendor-invite/[token]) since round 15, but NO surface ever called the
  // writer: the invite could only be created by hand, so the vendor portal was
  // reachable in principle and unreachable in practice. This reads the state the
  // panel below acts on. `error` is read deliberately — an RLS refusal must not
  // render as "nobody has been invited".
  const { data: inviteRows, error: inviteErr } = await supabase
    .from("vendor_invitations")
    .select("id, vendor_id, status, email, expires_at, created_at")
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(500)
  // Which vendors already hold a portal login. vendors has NO user_id column —
  // the user_role_assignments row IS the link (see the superadmin vendor board).
  const svcForLinks = createServiceClient()
  const { data: vendorLinkRows } = await svcForLinks
    .from("user_role_assignments")
    .select("user_id, vendor_id")
    .eq("brokerage_id", profile.brokerage_id)
    .not("vendor_id", "is", null)
  const linkedUserIds = [...new Set((vendorLinkRows ?? []).map((r: any) => r.user_id as string))]
  const { data: linkedUsers } = linkedUserIds.length
    ? await svcForLinks.from("users").select("id, email").in("id", linkedUserIds)
    : { data: [] as any[] }
  const emailByUserId = new Map<string, string>(
    (linkedUsers ?? []).map((u: any) => [u.id as string, (u.email as string) ?? "linked account"])
  )
  const linkedEmailByVendor = new Map<string, string>()
  for (const l of (vendorLinkRows ?? []) as any[]) {
    if (l.vendor_id && !linkedEmailByVendor.has(l.vendor_id)) {
      linkedEmailByVendor.set(l.vendor_id, emailByUserId.get(l.user_id) ?? "linked account")
    }
  }
  const invitableVendors = (preferredVendors ?? []).map((v: any) => ({
    id:          v.id as string,
    name:        (v.name as string) ?? "Unnamed vendor",
    email:       (v.email as string | null) ?? null,
    linkedEmail: linkedEmailByVendor.get(v.id as string) ?? null,
  }))
  const canInviteVendorsHere = canInviteVendors(profile.user_type)

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
        <TabsList className="grid w-full grid-cols-6">
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
          <TabsTrigger value="client-access" className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            <span className="hidden sm:inline">Client access</span>
            {accessAssignments.filter(a => a.status === "active").length > 0 && (
              <span className="ml-1 inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                {accessAssignments.filter(a => a.status === "active").length}
              </span>
            )}
          </TabsTrigger>
          {/* VENDOR PACKAGES — what this brokerage CHARGES its vendors, monthly.
              This tab shipped as the opposite (the brokerage subscribing to a vendor's
              plan and paying it monthly). Owner ruling: "vendor packages are for
              brokerages to charge the vendor on a subscription to the platform.
              vendors do bill the brokerages for jobs but not a monthly subscription."
              m497 repointed the schema; the authoring surface lives here because the
              SELLER authors the price sheet. What the brokerage PAYS a vendor is per
              job and appears on the Bills tab, never here. */}
          <TabsTrigger value="plans" className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            <span className="hidden sm:inline">Packages</span>
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
              listings={listings}
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
          {/* Every vendor on the brokerage's bench is sellable — placement is a
              flag on the row, so there is no second list to be curated into. */}
          <PremiumPlacementPanel
            vendors={(preferredVendors ?? []).map((v: any) => ({
              vendorId: v.id as string,
              name: v.name ?? null,
              category: v.category ?? null,
              preferred: v.preferred ?? false,
              display_priority: v.display_priority ?? 0,
            }))}
            placementInvoices={placementInvoices}
            userRole={profile.user_type ?? "agent"}
          />

          {/* General tenant→vendor charges (beyond placement). Premium placement
              above stays brokerage-level (brokerage-wide vendor placement flags); agents
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

          {/* The opposite direction: what the brokerage OWES its vendors for booked
              work (billed_to='brokerage'). Marking one paid credits the vendor's
              available balance, which is what the vendor payout lane draws on. */}
          <VendorBillsPanel
            bills={vendorBills}
            vendorNames={Object.fromEntries(
              (preferredVendors ?? []).map((v: any) => [v.id as string, (v.name as string | null) ?? "Vendor"])
            )}
            userRole={profile.user_type ?? "agent"}
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

        {/* Tab 5: Client access grants — the write half of the vendor access model */}
        <TabsContent value="client-access" className="space-y-4">
          {/* Platform access: can this vendor sign in at all. Distinct from the
              per-client grants below, which decide what a signed-in vendor sees. */}
          <VendorPortalInvitePanel
            vendors={invitableVendors}
            invitations={(inviteRows ?? []) as any}
            loadError={inviteErr?.message ?? null}
            canInvite={canInviteVendorsHere}
            canRevoke={canRevokeAccess}
          />
          <VendorAccessPanel
            assignments={accessAssignments}
            vendors={vendorOptions}
            contacts={contactOptions}
            loadError={accessLoadError}
            canRevoke={canRevokeAccess}
          />
        </TabsContent>

        {/* Tab 6: Vendor packages — the brokerage's own catalogue (money vendor → brokerage) */}
        <TabsContent value="plans" className="space-y-4">
          <VendorPlanCataloguePanel />
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
