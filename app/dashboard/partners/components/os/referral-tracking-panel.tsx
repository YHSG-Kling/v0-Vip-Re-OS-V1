"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Users, ArrowRight, TrendingUp } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"

interface ReferralTrackingPanelProps {
  brokerageId: string
}

interface ReferralStats {
  totalReferrals: number
  pendingReferrals: number
  convertedReferrals: number
  conversionRate: number
  topReferrers: { vendorId: string; vendorName: string; count: number }[]
}

export function ReferralTrackingPanel({ brokerageId }: ReferralTrackingPanelProps) {
  const [stats, setStats] = useState<ReferralStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadStats() {
      const supabase = createClient()

      // Get referrals from vendor_referrals table
      const { data: referrals } = await supabase
        .from("vendor_referrals")
        .select("id, vendor_id, status, vendors(name)")
        .eq("brokerage_id", brokerageId)

      if (!referrals || referrals.length === 0) {
        setStats({
          totalReferrals: 0,
          pendingReferrals: 0,
          convertedReferrals: 0,
          conversionRate: 0,
          topReferrers: [],
        })
        setLoading(false)
        return
      }

      const totalReferrals = referrals.length
      const pendingReferrals = referrals.filter(r => r.status === "pending").length
      const convertedReferrals = referrals.filter(r => r.status === "converted").length
      const conversionRate = totalReferrals > 0 ? (convertedReferrals / totalReferrals) * 100 : 0

      // Calculate top referrers
      const referrerMap = new Map<string, { name: string; count: number }>()
      referrals.forEach(r => {
        if (!r.vendor_id) return
        const existing = referrerMap.get(r.vendor_id) || { 
          name: (r.vendors as any)?.name || "Unknown", 
          count: 0 
        }
        referrerMap.set(r.vendor_id, { 
          name: existing.name, 
          count: existing.count + 1 
        })
      })

      const topReferrers = Array.from(referrerMap.entries())
        .map(([vendorId, data]) => ({
          vendorId,
          vendorName: data.name,
          count: data.count,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)

      setStats({
        totalReferrals,
        pendingReferrals,
        convertedReferrals,
        conversionRate,
        topReferrers,
      })
      setLoading(false)
    }

    loadStats()
  }, [brokerageId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Referral Tracking</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!stats) {
    return null
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Referral Tracking</CardTitle>
            <CardDescription>Partner referral performance</CardDescription>
          </div>
          <Link href="/referrals">
            <Button variant="ghost" size="sm">
              View All
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <p className="text-2xl font-bold">{stats.totalReferrals}</p>
            <p className="text-xs text-muted-foreground">Total</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-yellow-600">{stats.pendingReferrals}</p>
            <p className="text-xs text-muted-foreground">Pending</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-green-600">{stats.convertedReferrals}</p>
            <p className="text-xs text-muted-foreground">Converted</p>
          </div>
        </div>

        {/* Conversion Rate */}
        <div className="rounded-lg bg-muted/50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Conversion Rate</span>
            <div className="flex items-center gap-1">
              <TrendingUp className="h-4 w-4 text-green-500" />
              <span className="font-bold">{stats.conversionRate.toFixed(1)}%</span>
            </div>
          </div>
        </div>

        {/* Top Referrers */}
        {stats.topReferrers.length > 0 && (
          <div className="space-y-2">
            <span className="text-sm font-medium">Top Referrers</span>
            {stats.topReferrers.slice(0, 3).map((referrer, idx) => (
              <div key={referrer.vendorId} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="h-5 w-5 justify-center p-0 text-xs">
                    {idx + 1}
                  </Badge>
                  <span className="truncate">{referrer.vendorName}</span>
                </div>
                <Badge variant="secondary">{referrer.count} referrals</Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
