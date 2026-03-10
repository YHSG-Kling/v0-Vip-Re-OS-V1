import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { determinePortalView } from "@/lib/kernel/portal"
import { CLIENT_VISIBLE_MILESTONES } from "@/lib/transactions/transaction-stages"
import { BUYER_MILESTONE_LABELS } from "@/lib/portal/resolve-education-context"
import { DealTeamCard } from "@/app/components/portal/DealTeamCard"
import { OfferStatusCard } from "@/app/components/portal/OfferStatusCard"
import { MilestoneProgressBar } from "@/app/components/portal/MilestoneProgressBar"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar"
import {
  Home,
  Search,
  Calendar,
  FileText,
  MessageSquare,
  Eye,
  BookOpen,
  Briefcase,
  ArrowRight,
  Building,
  Bell,
  MapPin,
} from "lucide-react"
import SellerHome from "./seller-home"

export default async function PortalHomePage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Determine portal view from kernel
  const portalView = await determinePortalView(supabase, contactId)

  // Render seller home if seller view
  if (portalView === "seller") {
    return <SellerHome contactId={contactId} />
  }

  // Lifetime view redirects to lifetime dashboard (future)
  if (portalView === "lifetime") {
    // For now, show buyer view as fallback
    // TODO: Create lifetime dashboard
  }

  // Fetch contact basic info
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, name, contact_type, buyer_stage, agent_id")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Get active transaction for this buyer
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, property_address, status, close_date, under_contract_date, list_price, purchase_price")
    .or(`buyer_contact_id.eq.${contactId}`)
    .not("status", "in", "(cancelled)")
    .order("created_at", { ascending: false })
    .limit(1)

  const activeTransaction = transactions?.[0] ?? null

  // Parallel data fetches
  const [
    milestonesResult,
    dealTeamResult,
    agentResult,
    offersResult,
    showingsResult,
    preferencesResult,
    alertsResult,
    savedPropertiesResult,
    messagesResult,
    educationResult,
    vendorAssignmentsResult,
  ] = await Promise.all([
    // Milestones from transaction
    activeTransaction
      ? supabase
          .from("transaction_milestones")
          .select("id, milestone_name, milestone_type, milestone_date, completed_date, status")
          .eq("transaction_id", activeTransaction.id)
          .order("milestone_date", { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [] }),
    // Deal team members
    activeTransaction
      ? supabase
          .from("deal_team_members")
          .select("id, member_type, agent_id, external_name, external_company, external_phone, external_email, scheduled_date, agent:agents(id, first_name, last_name, phone, email, profile_photo_url)")
          .eq("transaction_id", activeTransaction.id)
      : Promise.resolve({ data: [] }),
    // Primary agent
    contact.agent_id
      ? supabase
          .from("agents")
          .select("id, first_name, last_name, phone, email, profile_photo_url")
          .eq("id", contact.agent_id)
          .single()
      : Promise.resolve({ data: null }),
    // Offers
    supabase
      .from("offers")
      .select("id, listing_id, transaction_id, offer_amount, status, created_at, listing:listings(address, property_address)")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(10),
    // Showings
    supabase
      .from("showings")
      .select("id, listing_id, showing_date, status, listing:listings(address, property_address)")
      .eq("contact_id", contactId)
      .order("showing_date", { ascending: true })
      .limit(5),
    // Property preferences
    supabase
      .from("property_preferences")
      .select("id, min_price, max_price, min_beds, min_baths, zip_codes")
      .eq("contact_id", contactId)
      .maybeSingle(),
    // Property alerts
    supabase
      .from("property_alerts")
      .select("id, alert_name, is_active")
      .eq("contact_id", contactId)
      .eq("is_active", true),
    // Saved properties
    supabase
      .from("property_interests")
      .select("id, listing_id, interest_level, saved_at, listing:listings(id, address, property_address, list_price, bedrooms, bathrooms, primary_photo_url)")
      .eq("contact_id", contactId)
      .in("interest_level", ["saved", "favorited"])
      .order("saved_at", { ascending: false })
      .limit(4),
    // Messages
    supabase
      .from("client_portal_messages")
      .select("id, body, direction, read_at, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(3),
    // Education - unread lessons
    supabase
      .from("educational_moments")
      .select("id, lesson_key, read_at")
      .eq("contact_id", contactId)
      .is("read_at", null)
      .limit(1),
    // Vendor assignments
    activeTransaction
      ? supabase
          .from("vendor_assignments")
          .select("id, vendor_id, assignment_type, status, scheduled_date, vendor:vendors(id, business_name, vendor_type)")
          .eq("transaction_id", activeTransaction.id)
          .limit(3)
      : Promise.resolve({ data: [] }),
  ])

  // Filter milestones to client-visible only
  const milestones = (milestonesResult.data ?? []).filter((m: any) =>
    CLIENT_VISIBLE_MILESTONES.includes(m.milestone_name as any)
  )

  const dealTeamMembers = dealTeamResult.data ?? []
  const primaryAgent = agentResult.data
  const offers = offersResult.data ?? []
  const showings = showingsResult.data ?? []
  const preferences = preferencesResult.data
  const alerts = alertsResult.data ?? []
  const savedProperties = savedPropertiesResult.data ?? []
  const messages = messagesResult.data ?? []
  const unreadEducation = educationResult.data?.[0]
  const vendorAssignments = vendorAssignmentsResult.data ?? []

  // Computed values
  const contactName = contact.first_name || contact.name || "there"
  const unreadMessageCount = messages.filter((m: any) => m.direction === "outbound" && !m.read_at).length
  const upcomingShowings = showings.filter((s: any) => new Date(s.showing_date) >= new Date())

  // Calculate days under contract if applicable
  let daysUnderContract: number | null = null
  if (activeTransaction?.under_contract_date) {
    const contractDate = new Date(activeTransaction.under_contract_date)
    const today = new Date()
    daysUnderContract = Math.floor((today.getTime() - contractDate.getTime()) / (1000 * 60 * 60 * 24))
  }

  return (
    <div className="space-y-6">
      {/* 1. ACTIVE TRANSACTION BANNER or START SEARCH CTA */}
      {activeTransaction ? (
        <Card className="bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200">
          <CardContent className="py-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Home className="h-5 w-5 text-blue-600" />
                  <h2 className="font-semibold text-lg">
                    {activeTransaction.property_address || "Your Home Purchase"}
                  </h2>
                  <Badge className="bg-blue-100 text-blue-800">{activeTransaction.status}</Badge>
                </div>
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  {activeTransaction.close_date && (
                    <span>
                      Closing: {new Date(activeTransaction.close_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </span>
                  )}
                  {daysUnderContract !== null && daysUnderContract >= 0 && (
                    <span>{daysUnderContract} days under contract</span>
                  )}
                </div>
              </div>
              <Button asChild>
                <Link href={`/portal/${contactId}/journey`}>
                  View Journey
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-200">
          <CardContent className="py-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <h2 className="font-semibold text-lg text-emerald-900">
                  Welcome, {contactName}!
                </h2>
                <p className="text-sm text-emerald-700">
                  Start your home search and we will guide you every step of the way.
                </p>
              </div>
              <Button className="bg-emerald-600 hover:bg-emerald-700" asChild>
                <Link href={`/portal/${contactId}/search`}>
                  <Search className="h-4 w-4 mr-2" />
                  Start Your Search
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 2. MILESTONE PROGRESS BAR */}
      {activeTransaction && milestones.length > 0 && (
        <MilestoneProgressBar
          milestones={milestones}
          contactId={contactId}
          labelMap={BUYER_MILESTONE_LABELS}
        />
      )}

      {/* Main Content Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* 3. DEAL TEAM CARD */}
        <div className="md:col-span-2 lg:col-span-2">
          <DealTeamCard
            primaryAgent={primaryAgent}
            teamMembers={dealTeamMembers as any}
            variant="compact"
          />
        </div>

        {/* 4. OFFER STATUS CARD */}
        <OfferStatusCard offers={offers as any} contactId={contactId} />

        {/* 5. UPCOMING SHOWINGS */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Upcoming Showings
              </CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/portal/${contactId}/showings`}>
                  View All
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {upcomingShowings.length === 0 ? (
              <div className="text-center py-4 space-y-3">
                <p className="text-sm text-muted-foreground">No upcoming showings scheduled</p>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/portal/${contactId}/showings`}>
                    <Calendar className="h-4 w-4 mr-2" />
                    Schedule Showing
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {upcomingShowings.slice(0, 2).map((showing: any) => (
                  <div key={showing.id} className="flex items-center justify-between p-3 rounded-lg border">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {showing.listing?.address || showing.listing?.property_address || "Property"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(showing.showing_date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                      </p>
                    </div>
                    <Badge variant="secondary">{showing.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 6. SMART SEARCH ENTRY */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Search className="h-4 w-4" />
              Smart Search
            </CardTitle>
          </CardHeader>
          <CardContent>
            {preferences ? (
              <div className="space-y-3">
                <div className="text-sm space-y-1">
                  {preferences.min_beds && (
                    <p className="text-muted-foreground">
                      {preferences.min_beds}+ beds, {preferences.min_baths || 1}+ baths
                    </p>
                  )}
                  {(preferences.min_price || preferences.max_price) && (
                    <p className="text-muted-foreground">
                      ${preferences.min_price?.toLocaleString() || "0"} - ${preferences.max_price?.toLocaleString() || "Any"}
                    </p>
                  )}
                </div>
                {alerts.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Bell className="h-4 w-4 text-amber-600" />
                    <span className="text-sm">{alerts.length} active alert{alerts.length !== 1 ? "s" : ""}</span>
                  </div>
                )}
                <Button className="w-full" variant="outline" asChild>
                  <Link href={`/portal/${contactId}/search`}>
                    <Search className="h-4 w-4 mr-2" />
                    View Search
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="text-center py-4 space-y-3">
                <p className="text-sm text-muted-foreground">Set up your home search criteria</p>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/portal/${contactId}/search`}>Get Started</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 7. SAVED PROPERTIES */}
        <Card className="md:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Building className="h-4 w-4" />
                Saved Properties
              </CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/portal/${contactId}/properties`}>
                  View All
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {savedProperties.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                Properties you save will appear here
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {savedProperties.map((prop: any) => (
                  <Link
                    key={prop.id}
                    href={`/portal/${contactId}/properties/${prop.listing_id}`}
                    className="group rounded-lg border overflow-hidden hover:border-primary transition-colors"
                  >
                    <div className="aspect-video bg-muted relative">
                      {prop.listing?.primary_photo_url ? (
                        <img
                          src={prop.listing.primary_photo_url}
                          alt={prop.listing?.address || "Property"}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Home className="h-8 w-8 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="p-2">
                      <p className="font-medium text-sm truncate group-hover:text-primary">
                        {prop.listing?.address || prop.listing?.property_address || "Property"}
                      </p>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>${prop.listing?.list_price?.toLocaleString() || "N/A"}</span>
                        <span>{prop.listing?.bedrooms || 0}bd / {prop.listing?.bathrooms || 0}ba</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 8. MESSAGES PREVIEW */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Messages
                {unreadMessageCount > 0 && (
                  <Badge variant="destructive" className="ml-1">{unreadMessageCount}</Badge>
                )}
              </CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/portal/${contactId}/messages`}>
                  View All
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {messages.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No messages yet
              </p>
            ) : (
              <div className="space-y-2">
                {messages.slice(0, 2).map((msg: any) => (
                  <div key={msg.id} className="p-2 rounded-lg bg-muted/50">
                    <p className="text-sm line-clamp-2">
                      {msg.body?.substring(0, 80)}{msg.body?.length > 80 ? "..." : ""}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(msg.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 9. EDUCATION SPOTLIGHT */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              Learn
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-center py-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                {unreadEducation
                  ? "You have unread lessons to help you on your journey"
                  : "Educational resources to guide your home buying journey"}
              </p>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/portal/${contactId}/learn`}>
                  <BookOpen className="h-4 w-4 mr-2" />
                  View Lessons
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 10. VENDORS PREVIEW */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Briefcase className="h-4 w-4" />
                Vendors
              </CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/portal/${contactId}/vendors`}>
                  View All
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {vendorAssignments.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                Your vendor team will appear here
              </p>
            ) : (
              <div className="space-y-2">
                {vendorAssignments.map((va: any) => (
                  <div key={va.id} className="flex items-center justify-between p-2 rounded-lg border">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{va.vendor?.business_name || "Vendor"}</p>
                      <p className="text-xs text-muted-foreground">{va.vendor?.vendor_type || va.assignment_type}</p>
                    </div>
                    <Badge variant="secondary">{va.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 11. QUICK ACTIONS ROW */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap gap-3 justify-center">
            <Button variant="outline" asChild>
              <Link href={`/portal/${contactId}/showings`}>
                <Eye className="h-4 w-4 mr-2" />
                Schedule Showing
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/portal/${contactId}/messages`}>
                <MessageSquare className="h-4 w-4 mr-2" />
                Message Agent
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/portal/${contactId}/offers`}>
                <FileText className="h-4 w-4 mr-2" />
                View Offers
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/portal/${contactId}/documents`}>
                <FileText className="h-4 w-4 mr-2" />
                View Documents
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
