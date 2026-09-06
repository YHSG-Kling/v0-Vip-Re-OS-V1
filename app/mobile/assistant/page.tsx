import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { redirect } from "next/navigation"
import { DailyBriefingCard } from "@/app/components/mobile/DailyBriefingCard"
import { QuickActionGrid } from "@/app/components/mobile/QuickActionGrid"
import { MobileActivityFeed } from "@/app/components/mobile/MobileActivityFeed"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Home, Search } from "lucide-react"
import Link from "next/link"
import {
  MobileCommandStrip,
  FieldQuickActions,
  ShowingDayPanel,
  OpenHousePanel,
  TourDayPanel,
  MobileFollowupPanel,
} from "../components/os"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Mobile Assistant | VIP-OS",
  description: "Your mobile real estate assistant",
}

export default async function MobileAssistantPage() {
  const supabase = await createClient()
  
  let agentContext
  try {
    agentContext = await getAgentContext()
  } catch {
    redirect("/login")
  }
  
  const { agentId, brokerageId } = agentContext
  const today = new Date().toISOString().split("T")[0]

  // Fetch agent name
  const { data: agent } = await supabase
    .from("agents")
    .select("id, user_id")
    .eq("id", agentId)
    .single()

  const { data: user } = await supabase
    .from("users")
    .select("first_name, last_name")
    .eq("id", agent?.user_id)
    .single()

  const agentFirstName = user?.first_name || "Agent"

  // THE BRIEFING IS KEYED ON users.id, NOT agents.id — the same defect fixed at
  // app/actions/briefing-actions.ts:41. The only writer of a briefing row
  // (lib/intelligence/daily-briefing-generator.ts:806) stores `user_id` and has
  // never written `agent_id`, and the two spaces are DISJOINT (§3), so this
  // mobile card asked under a key nothing writes and always showed the "no
  // briefing yet" state. `agent.user_id` is already loaded above for the name.
  const briefingUserId = agent?.user_id ?? null

  // Fetch today's briefing
  const { data: briefing } = briefingUserId
    ? await supabase
        .from("ai_daily_briefings")
        .select("*")
        .eq("user_id", briefingUserId)
        .eq("briefing_date", today)
        .maybeSingle()
    : { data: null }

  // Fetch last briefing date if no briefing today
  let lastBriefingDate: string | undefined
  if (!briefing && briefingUserId) {
    const { data: lastBriefing } = await supabase
      .from("ai_daily_briefings")
      .select("briefing_date")
      .eq("user_id", briefingUserId)
      .order("briefing_date", { ascending: false })
      .limit(1)
      .maybeSingle()
    lastBriefingDate = lastBriefing?.briefing_date
  }

  // Fetch upcoming calendar events (next 3)
  const { data: calendarEvents } = await supabase
    .from("calendar_events")
    .select("id, event_type, start_at, end_at, metadata")
    .eq("brokerage_id", brokerageId)
    .gte("start_at", new Date().toISOString())
    .order("start_at", { ascending: true })
    .limit(3)

  // Fetch recent activity (lifecycle_events)
  const { data: lifecycleEvents } = await supabase
    .from("lifecycle_events")
    .select("id, entity_type, entity_id, event_type, metadata, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(10)

  // Fetch active listings
  const { data: activeListings } = await supabase
    .from("listings")
    .select("id, address, city, state, list_price, status, created_at")
    .eq("agent_id", agentId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(10)

  // ─── THE FIELD PANELS ──────────────────────────────────────────────────────
  // These four panels were mounted with hardcoded []. Every one of them
  // rendered its empty state forever while the rows sat in the database — the
  // agent standing in the field saw "nothing today" no matter what their day
  // actually held. All of these agent_id columns FK agents(id), and
  // getAgentContext() returns the agents id, so agentId is the right filter.
  const [
    { data: todaysShowings },
    { data: todaysOpenHouses },
    { data: followupTasks },
    { data: recentContacts },
    { data: todaysTours },
  ] = await Promise.all([
    supabase
      .from("showings")
      .select(`id, listing_id, contact_id, scheduled_at, scheduled_date, scheduled_time, status,
               buyer_agent_name, buyer_agent_phone, notes, external_address,
               contacts(first_name, last_name, phone),
               listings(address, city, state, list_price)`)
      .eq("agent_id", agentId)
      .eq("scheduled_date", today)
      .neq("status", "cancelled")
      .order("scheduled_time", { ascending: true }),
    supabase
      .from("open_house_events")
      .select(`id, listing_id, event_date, start_time, end_time, status, description, qr_code_id,
               listings(address, city, state, list_price)`)
      .eq("agent_id", agentId)
      .eq("event_date", today)
      .neq("status", "cancelled")
      .order("start_time", { ascending: true }),
    supabase
      .from("activities")
      .select(`id, contact_id, title, description, scheduled_at, priority, status,
               contact:contacts(first_name, last_name, phone, email)`)
      .eq("agent_id", agentId)
      .eq("status", "pending")
      .order("scheduled_at", { ascending: true })
      .limit(20),
    supabase
      .from("contacts")
      .select("id, first_name, last_name, phone, email, contact_type, status, last_contacted_at")
      .eq("agent_id", agentId)
      .order("last_contacted_at", { ascending: false, nullsFirst: false })
      .limit(20),
    supabase
      .from("tours")
      .select(`id, contact_id, tour_date, status, notes,
               contacts(first_name, last_name, phone),
               tour_stops(id, tour_id, listing_id, property_address, city, state, list_price,
                          order_index, suggested_time, confirmed_time, is_confirmed,
                          buyer_interest_level, access_method, access_code, access_instructions,
                          listing_agent_name, listing_agent_phone, drive_time_from_prev_minutes)`)
      .eq("agent_id", agentId)
      .eq("tour_date", today)
      .neq("status", "cancelled")
      .order("start_time", { ascending: true }),
  ])

  // The panel reads `property_address`; showings carry either a listing join or
  // an external address for a non-MLS property, so flatten to one field here
  // rather than teaching the panel about both shapes.
  const showingsForPanel = (todaysShowings ?? []).map((sh: any) => ({
    ...sh,
    property_address:
      sh.listings?.address ?? sh.external_address ?? undefined,
  }))

  // Calculate days on market for listings
  const listingsWithDOM = (activeListings || []).map((listing) => {
    const dom = Math.floor(
      (Date.now() - new Date(listing.created_at).getTime()) / (1000 * 60 * 60 * 24)
    )
    return { ...listing, dom }
  })

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">{agentFirstName}</h1>
            <p className="text-xs text-muted-foreground">Mobile Assistant</p>
          </div>
          <Link href="/notifications" className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center">
            <Badge variant="destructive" className="h-6 w-6 rounded-full p-0 flex items-center justify-center text-xs">
              3
            </Badge>
          </Link>
        </div>
      </header>

      <main className="px-4 py-4 space-y-6">
        {/* Mobile OS Command Strip */}
        <MobileCommandStrip agentId={agentId ?? ""} />

        {/* Section 1: Daily Briefing */}
        <section>
          <DailyBriefingCard
            agentFirstName={agentFirstName}
            briefing={briefing}
            lastBriefingDate={lastBriefingDate}
          />
        </section>

        {/* Mobile OS Field Quick Actions — the Quick Note box lives here; the
            command strip's "Quick Note" tile targets this id. */}
        <div id="quick-note">
          <FieldQuickActions agentId={agentId ?? ""} />
        </div>

        {/* Section 2: Quick Actions Grid */}
        <section>
          <h2 className="text-sm font-medium mb-3">Quick Actions</h2>
          <QuickActionGrid />
        </section>

        {/* Section 3: Today's Schedule — every stop below carries its own
            "Directions" button; the command strip's Directions tile targets this id. */}
        <section id="todays-schedule">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium">Today&apos;s Schedule</h2>
            <Link href="/dashboard/calendar" className="text-xs text-primary min-h-[44px] flex items-center">
              View All
            </Link>
          </div>

          {/* Mobile OS Showing & Open House Panels */}
          <ShowingDayPanel showings={showingsForPanel} />
          <div className="mt-4">
            <OpenHousePanel events={(todaysOpenHouses ?? []) as any} />
          </div>
        </section>

        {/* Section 4: Recent Activity Feed */}
        <section>
          <h2 className="text-sm font-medium mb-3">Recent Activity</h2>
          <MobileActivityFeed events={lifecycleEvents || []} />
        </section>

        {/* Mobile OS Follow-up Panel */}
        <TourDayPanel tours={(todaysTours ?? []) as any} />

        <MobileFollowupPanel tasks={(followupTasks ?? []) as any} />

        {/* Section 5: Active Listings Strip */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium">Active Listings</h2>
            <Link href="/dashboard/listings" className="text-xs text-primary min-h-[44px] flex items-center">
              View All
            </Link>
          </div>
          {listingsWithDOM.length > 0 ? (
            <ScrollArea className="w-full whitespace-nowrap">
              <div className="flex gap-3 pb-2">
                {listingsWithDOM.map((listing) => (
                  <Link
                    key={listing.id}
                    href={`/dashboard/listings/${listing.id}`}
                    className="inline-block min-w-[200px] max-w-[200px]"
                  >
                    <Card className="p-3 h-full active:opacity-70">
                      <div className="flex items-start gap-2">
                        <div className="h-8 w-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
                          <Home className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{listing.address}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {listing.city}, {listing.state}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-2 pt-2 border-t">
                        <Badge variant="secondary" className="text-xs">
                          {listing.dom} DOM
                        </Badge>
                        <span className="text-xs font-medium">
                          ${(listing.list_price / 1000).toFixed(0)}K
                        </span>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          ) : (
            <Card className="p-4 text-center text-muted-foreground text-sm">
              No active listings
            </Card>
          )}
        </section>

        {/* Section 6: Quick CMA Lookup */}
        <section>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Quick CMA Lookup</CardTitle>
            </CardHeader>
            <CardContent>
              <form action="/dashboard/cma/quick" method="GET" className="flex gap-2">
                <Input
                  name="address"
                  placeholder="Enter property address..."
                  className="flex-1 min-h-[44px]"
                />
                <Button type="submit" size="icon" className="min-h-[44px] min-w-[44px]">
                  <Search className="h-4 w-4" />
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  )
}
