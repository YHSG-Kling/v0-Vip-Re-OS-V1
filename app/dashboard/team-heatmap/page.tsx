export const dynamic = "force-dynamic"

import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveMapProvider, bookMapLoadSpend } from "@/lib/property/street-view"
import { loadProviderHealth } from "@/lib/agentic-os/connector-gateway"
import { createClient } from "@/lib/supabase/server"
import {
  getHeatmapSnapshots,
  getTopZipCodes,
  getOpportunityZones,
  getTerritoryGaps,
  getAgentActivitySummary,
  getAgentsForFilter,
  getTeamsForFilter,
  type HeatmapFilters,
} from "@/app/actions/team-heatmap"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  MapPin,
  TrendingUp,
  TrendingDown,
  Users,
  AlertTriangle,
  Target,
} from "lucide-react"

// Import client components
import { HeatmapFilterBar } from "./heatmap-filter-bar"
import { HeatmapMap } from "./heatmap-map"
import { HeatmapLegend } from "./heatmap-legend"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const metadata = {
  title: "Team Heatmap | VIP-OS",
  description: "Team territory activity heatmap and opportunity analysis",
}

interface PageProps {
  searchParams: Promise<{
    agent?: string
    team?: string
    activity?: string
    range?: string
    startDate?: string
    endDate?: string
    weighted?: string
  }>
}

export default async function TeamHeatmapPage({ searchParams }: PageProps) {
  const params = await searchParams
  
  // Auth check
  let context
  try {
    context = await getAgentContext()
  } catch {
    redirect("/login")
  }

  const supabase = await createClient()
  const { data: user } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", (await supabase.auth.getUser()).data.user?.id)
    .single()

  const userRole = user?.user_type || "agent"
  const isPrivileged = isAdminOrBroker({ user_type: userRole })

  // Parse filters from URL
  const filters: HeatmapFilters = {
    agentId: params.agent || undefined,
    teamId: params.team || undefined,
    activityTypes: params.activity
      ? (params.activity.split(",") as any[])
      : ["all"],
    dateRange: (params.range as any) || "30d",
    startDate: params.startDate,
    endDate: params.endDate,
    revenueWeighted: params.weighted === "true",
  }

  // Fetch all data in parallel
  const [
    { snapshots },
    { zipCodes: topZips },
    { zones: opportunityZones },
    { gaps: territoryGaps },
    { agents: agentSummary },
    { agents: agentOptions },
    { teams: teamOptions },
  ] = await Promise.all([
    getHeatmapSnapshots(filters),
    getTopZipCodes(filters, 5),
    getOpportunityZones(),
    getTerritoryGaps(),
    getAgentActivitySummary(filters),
    getAgentsForFilter(),
    getTeamsForFilter(),
  ])

  // THE MAP PROVIDER (wave 140, lane 140I; owner: "team heatmap chooses a VALID configured provider,
  // never Google Maps with an empty key"). Before this the page tested `Google key OR MAPBOX_TOKEN` and
  // the client then loaded Google Maps JS regardless — with MAPBOX_TOKEN alone the script tag rendered
  // `key=` empty. Now the ONE map_render route is walked server-side (Mapbox first, Google Maps the
  // fallback, health-aware, unconfigured providers skipped) and the client receives only the chosen
  // provider + its PUBLIC credential. One map load is booked per render, with the route as evidence.
  const mapHealth = await Promise.all((["mapbox", "google_maps"] as const).map(async (p) => [p, await loadProviderHealth(p)] as const))
  const mapChoice = resolveMapProvider("browser_tiles", { health: Object.fromEntries(mapHealth) })
  if (mapChoice) await bookMapLoadSpend({ brokerageId: context.brokerageId ?? null, choice: mapChoice, systemSource: "team_heatmap" })
  const hasMapKey = mapChoice !== null

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team Heatmap</h1>
          <p className="text-sm text-muted-foreground">
            Territory activity analysis and opportunity identification
          </p>
        </div>
      </div>

      {/* Section 1: Filter Bar */}
      <Suspense fallback={<Skeleton className="h-14 w-full" />}>
        <HeatmapFilterBar
          filters={filters}
          agentOptions={agentOptions}
          teamOptions={teamOptions}
          isPrivileged={isPrivileged}
          userRole={userRole}
        />
      </Suspense>

      {/* Section 2: Map + Section 5: Legend */}
      <div className="relative">
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="h-[60vh] min-h-[400px] relative">
              {hasMapKey && mapChoice ? (
                <Suspense fallback={<MapPlaceholder />}>
                  <HeatmapMap
                    snapshots={snapshots}
                    revenueWeighted={filters.revenueWeighted}
                    opportunityZones={opportunityZones}
                    showGaps={false}
                    map={{ provider: mapChoice.provider, key: mapChoice.key, browser: mapChoice.browser }}
                  />
                </Suspense>
              ) : (
                <MapPlaceholder showConfigMessage />
              )}
            </div>
          </CardContent>
        </Card>

        {/* Legend overlay */}
        <div className="absolute bottom-4 left-4 z-10">
          <HeatmapLegend revenueWeighted={filters.revenueWeighted} />
        </div>
      </div>

      {/* Section 3: Territory Analysis Panel */}
      <div className="grid gap-6 md:grid-cols-3">
        {/* Top 5 Active Zip Codes */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <MapPin className="h-4 w-4 text-primary" />
              Top Active Zip Codes
            </CardTitle>
            <CardDescription>Highest activity concentration</CardDescription>
          </CardHeader>
          <CardContent>
            {topZips.length > 0 ? (
              <div className="space-y-3">
                {topZips.map((zip, i) => (
                  <div
                    key={zip.zip_code}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                        {i + 1}
                      </span>
                      <div>
                        <p className="text-sm font-medium">{zip.zip_code}</p>
                        {zip.city && (
                          <p className="text-xs text-muted-foreground">
                            {zip.city}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium">
                        {zip.total_activity} activities
                      </p>
                      {zip.total_revenue > 0 && (
                        <p className="text-xs text-muted-foreground">
                          ${(zip.total_revenue / 1000).toFixed(0)}K
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No activity data for selected filters
              </p>
            )}
          </CardContent>
        </Card>

        {/* Opportunity Zones */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Target className="h-4 w-4 text-amber-600" />
              Opportunity Zones
            </CardTitle>
            <CardDescription>High demand, low inventory</CardDescription>
          </CardHeader>
          <CardContent>
            {opportunityZones.length > 0 ? (
              <div className="space-y-3">
                {opportunityZones.slice(0, 5).map((zone) => (
                  <div
                    key={zone.zip_code}
                    className="flex items-center justify-between"
                  >
                    <div>
                      <p className="text-sm font-medium">{zone.zip_code}</p>
                      <p className="text-xs text-muted-foreground">
                        {zone.buyer_count} buyers, {zone.listing_count} listings
                      </p>
                    </div>
                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                      Score: {zone.opportunity_score.toFixed(1)}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No opportunity zones identified
              </p>
            )}
          </CardContent>
        </Card>

        {/* Territory Gaps */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Territory Gaps
            </CardTitle>
            <CardDescription>No recent activity (90+ days)</CardDescription>
          </CardHeader>
          <CardContent>
            {territoryGaps.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {territoryGaps.map((zip) => (
                  <Badge
                    key={zip}
                    variant="outline"
                    className="bg-red-50 text-red-700 border-red-200"
                  >
                    {zip}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                All market areas have recent activity
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Section 4: Agent Activity Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Agent Activity Summary
          </CardTitle>
          <CardDescription>
            Performance by agent for the selected period
          </CardDescription>
        </CardHeader>
        <CardContent>
          {agentSummary.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-center">Active Zips</TableHead>
                  <TableHead className="text-center">Listings</TableHead>
                  <TableHead className="text-center">Buyers</TableHead>
                  <TableHead className="text-center">Closed</TableHead>
                  <TableHead className="text-right">Total Revenue</TableHead>
                  <TableHead className="text-right">Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agentSummary.map((agent) => (
                  <TableRow
                    key={agent.agent_id}
                    className="cursor-pointer hover:bg-muted/50"
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                          {agent.agent_name
                            .split(" ")
                            .map((n) => n[0])
                            .join("")}
                        </div>
                        <span className="font-medium">{agent.agent_name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      {agent.active_zips}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary" className="bg-blue-100 text-blue-700">
                        {agent.listings}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary" className="bg-green-100 text-green-700">
                        {agent.buyers}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary" className="bg-amber-100 text-amber-700">
                        {agent.closed}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      ${agent.total_revenue.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {agent.change_pct !== 0 && (
                        <div
                          className={`flex items-center justify-end gap-1 ${
                            agent.change_pct > 0
                              ? "text-green-700"
                              : "text-red-600"
                          }`}
                        >
                          {agent.change_pct > 0 ? (
                            <TrendingUp className="h-4 w-4" />
                          ) : (
                            <TrendingDown className="h-4 w-4" />
                          )}
                          <span className="text-sm font-medium">
                            {Math.abs(agent.change_pct).toFixed(1)}%
                          </span>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No agent activity data for selected filters
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function MapPlaceholder({ showConfigMessage = false }: { showConfigMessage?: boolean }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-muted/20">
      <div className="text-center">
        <MapPin className="mx-auto h-12 w-12 text-muted-foreground/50" />
        <p className="mt-2 text-sm text-muted-foreground">
          {/* Sanitized capability status (owner, wave 141): the map provider is platform-managed, so a
              tenant reads WHAT is unavailable, never which platform env var to set — that instruction
              lives on the superadmin providers console. */}
          {showConfigMessage
            ? "Maps aren't available yet — the platform's map provider isn't configured. Your team's activity is still listed below."
            : "Loading map..."}
        </p>
      </div>
    </div>
  )
}
