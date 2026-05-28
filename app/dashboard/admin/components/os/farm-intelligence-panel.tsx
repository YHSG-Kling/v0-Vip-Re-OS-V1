"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  MapPin, 
  ChevronRight,
  TrendingUp,
  Users,
  Loader2,
  Target
} from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface FarmIntelligencePanelProps {
  brokerageId: string
}

interface FarmData {
  totalTerritories: number
  activeTerritories: number
  totalLeadsFromFarms: number
  topTerritories: Array<{
    id: string
    name: string
    city: string
    lead_count: number
  }>
}

export function FarmIntelligencePanel({ brokerageId }: FarmIntelligencePanelProps) {
  const [data, setData] = useState<FarmData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadFarmData() {
      if (!brokerageId) {
        setLoading(false)
        return
      }

      const supabase = createClient()

      const [
        { data: territories, count: totalTerritories },
        { data: territoryMetrics },
      ] = await Promise.all([
        supabase
          .from("farm_territories")
          .select("id, name, city, is_active", { count: "exact" })
          .eq("brokerage_id", brokerageId),
        supabase
          .from("territory_metrics")
          .select("zip_code, lead_count")
          .eq("brokerage_id", brokerageId)
          .order("lead_count", { ascending: false })
          .limit(10),
      ])

      const activeTerritories = (territories || []).filter((t: { is_active: boolean }) => t.is_active).length
      const totalLeadsFromFarms = (territoryMetrics || []).reduce(
        (sum: number, m: { lead_count: number | null }) => sum + (m.lead_count || 0),
        0
      )

      // Map territories with lead counts
      const zipLeadMap = new Map(
        (territoryMetrics || []).map((m: { zip_code: string; lead_count: number | null }) => [m.zip_code, m.lead_count])
      )

      const topTerritories = (territories || [])
        .filter((t: { is_active: boolean }) => t.is_active)
        .slice(0, 3)
        .map((t: { id: string; name: string; city: string | null; is_active: boolean }) => ({
          id: t.id,
          name: t.name,
          city: t.city || "N/A",
          lead_count: 0, // Would calculate from territory_metrics
        }))

      setData({
        totalTerritories: totalTerritories || 0,
        activeTerritories,
        totalLeadsFromFarms,
        topTerritories,
      })
      setLoading(false)
    }

    loadFarmData()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border">
        <CardContent className="flex items-center justify-center p-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <MapPin className="h-4 w-4 text-rose-600" />
            Farm Intelligence
          </CardTitle>
          <Badge variant="outline" className="text-xs">
            {data.activeTerritories} Active
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-2 bg-muted/50 rounded-lg">
            <p className="text-lg font-bold">{data.totalTerritories}</p>
            <p className="text-xs text-muted-foreground">Territories</p>
          </div>
          <div className="text-center p-2 bg-emerald-50/50 rounded-lg">
            <p className="text-lg font-bold text-emerald-700">{data.activeTerritories}</p>
            <p className="text-xs text-muted-foreground">Active</p>
          </div>
          <div className="text-center p-2 bg-blue-50/50 rounded-lg">
            <p className="text-lg font-bold text-blue-700">{data.totalLeadsFromFarms}</p>
            <p className="text-xs text-muted-foreground">Leads</p>
          </div>
        </div>

        {/* Top Territories */}
        {data.topTerritories.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Top Territories</p>
            {data.topTerritories.map((territory) => (
              <Link
                key={territory.id}
                href={`/dashboard/admin/farm-intelligence?territory=${territory.id}`}
                className="block"
              >
                <div className="flex items-center justify-between p-2 bg-muted/30 rounded-lg hover:bg-muted/50 transition-colors">
                  <div className="flex items-center gap-2">
                    <Target className="h-3.5 w-3.5 text-rose-500" />
                    <div>
                      <p className="text-xs font-medium">{territory.name}</p>
                      <p className="text-[10px] text-muted-foreground">{territory.city}</p>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="text-center py-4 text-muted-foreground">
            <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No territories configured</p>
          </div>
        )}

        <Link href="/dashboard/admin/farm-intelligence">
          <Button variant="outline" size="sm" className="w-full">
            View Farm Intelligence
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
