"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CalendarDays, Megaphone, BarChart3, Sparkles } from "lucide-react"
import { MarketingTab } from "./tabs/marketing-tab"
import { EventDayTab } from "./tabs/event-day-tab"
import { AnalyticsTab } from "./tabs/analytics-tab"
import { IntelligenceTab } from "./tabs/intelligence-tab"

interface Props {
  listingId: string
  initialData: Awaited<ReturnType<typeof import("@/app/actions/seller-open-house").getOpenHouseDashboard>>
  agentId: string
  userId: string
}

export function OpenHouseClient({ listingId, initialData, agentId, userId }: Props) {
  const [data, setData] = useState(initialData!)
  const listing = data.listing!

  const fmt = (d: string | null) =>
    d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "TBD"

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Date context bar */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm">
          <span className="text-muted-foreground">MLS Live:</span>
          <span className="font-medium text-foreground">{fmt(listing.go_live_date)}</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm">
          <span className="text-muted-foreground">Open House Marketing:</span>
          <span className="font-medium text-foreground">{fmt(listing.open_house_marketing_date)}</span>
          <span className="text-xs text-muted-foreground">Friday before go-live</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm">
          <span className="text-muted-foreground">Open House Event:</span>
          <span className="font-medium text-foreground">{fmt(listing.open_house_event_date)}</span>
          <span className="text-xs text-muted-foreground">Saturday after go-live</span>
        </div>
      </div>

      <Tabs defaultValue="marketing" className="w-full">
        <div className="overflow-x-auto">
          <TabsList className="flex min-w-max sm:grid sm:w-full sm:max-w-xl sm:grid-cols-4">
            <TabsTrigger value="marketing" className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0 min-w-[110px] sm:min-w-0">
              <Megaphone className="h-3.5 w-3.5" />
              Marketing
            </TabsTrigger>
            <TabsTrigger value="event-day" className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0 min-w-[110px] sm:min-w-0">
              <CalendarDays className="h-3.5 w-3.5" />
              Event Day
            </TabsTrigger>
            <TabsTrigger value="intelligence" className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0 min-w-[110px] sm:min-w-0">
              <Sparkles className="h-3.5 w-3.5" />
              Intelligence
            </TabsTrigger>
            <TabsTrigger value="analytics" className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0 min-w-[110px] sm:min-w-0">
              <BarChart3 className="h-3.5 w-3.5" />
              Analytics
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="marketing" className="mt-6">
          <MarketingTab listingId={listingId} data={data} onRefresh={setData} />
        </TabsContent>

        <TabsContent value="event-day" className="mt-6">
          <EventDayTab listingId={listingId} data={data} onRefresh={setData} agentId={agentId} userId={userId} />
        </TabsContent>

        <TabsContent value="intelligence" className="mt-6">
          <IntelligenceTab listingId={listingId} data={data} />
        </TabsContent>

        <TabsContent value="analytics" className="mt-6">
          <AnalyticsTab listingId={listingId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
