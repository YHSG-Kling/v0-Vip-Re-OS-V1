"use client"

import { Heart, Star, Users, DollarSign, TrendingUp, PlusCircle, Trophy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"

interface ReferralCommandStripProps {
  agentId: string
  referralCount: number
  pendingReferrals: number
  roiSummary?: {
    totalReferrals: number
    converted: number
    conversionRate: number
    totalValue: number
  } | null
  onCreateReferral: () => void
}

export function ReferralCommandStrip({
  agentId,
  referralCount,
  pendingReferrals,
  roiSummary,
  onCreateReferral,
}: ReferralCommandStripProps) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-rose-100">
            <Heart className="h-5 w-5 text-rose-600" />
          </div>
          <div className="flex items-center gap-2">
            <Star className="h-5 w-5 text-amber-500" />
            <h2 className="text-lg font-semibold">Referral & Advocacy Engine</h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onCreateReferral} className="gap-2">
            <PlusCircle className="h-4 w-4" />
            Create Referral
          </Button>
          <Link href="/dashboard/agent/referrals">
            <Button variant="outline" className="gap-2">
              <Trophy className="h-4 w-4" />
              Open Leaderboard
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
          <Users className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">Total Referrals</p>
            <p className="text-xl font-bold">{referralCount}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
          <Badge variant="outline" className="h-8 w-8 rounded-full flex items-center justify-center border-amber-500 text-amber-700">
            P
          </Badge>
          <div>
            <p className="text-xs text-muted-foreground">Pending</p>
            <p className="text-xl font-bold">{pendingReferrals}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
          <TrendingUp className="h-5 w-5 text-emerald-600" />
          <div>
            <p className="text-xs text-muted-foreground">Conversion Rate</p>
            <p className="text-xl font-bold">{roiSummary?.conversionRate?.toFixed(1) || 0}%</p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
          <DollarSign className="h-5 w-5 text-emerald-600" />
          <div>
            <p className="text-xs text-muted-foreground">Total Value</p>
            <p className="text-xl font-bold">
              ${((roiSummary?.totalValue || 0) / 1000).toFixed(0)}K
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
