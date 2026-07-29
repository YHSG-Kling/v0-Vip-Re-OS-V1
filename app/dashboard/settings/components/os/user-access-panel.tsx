"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
  Users,
  UserPlus,
  Shield,
  ExternalLink 
} from "lucide-react"

interface UserStats {
  totalUsers: number
  /** Users consuming a plan SEAT — partners (vendor, lender) and the `system`
   *  AI-ISA actor never do, and suspended users do not either. */
  seatCount: number
  /** The plan's seat allowance; null = unlimited (Brokerage / Multi-Location). */
  seatLimit: number | null
  /** A staff-set per-tenant override is in force. */
  seatOverridden: boolean
  planTier: string | null
  activeUsers: number
  adminCount: number
  brokerCount: number
  agentCount: number
  coordinatorCount: number
}

interface UserAccessPanelProps {
  stats: UserStats
}

const TIER_NAMES: Record<string, string> = {
  solo_agent: "Solo", team: "Team", brokerage: "Brokerage", multi_location: "Multi-Location",
}

export function UserAccessPanel({ stats }: UserAccessPanelProps) {
  const overSeats = stats.seatLimit !== null && stats.seatCount > stats.seatLimit
  const tierName = TIER_NAMES[stats.planTier ?? ""] ?? "your"
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4" />
            User Access
          </CardTitle>
          <Link href="/settings/users">
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
              Manage <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* SEATS — the same number the user-management page shows, from the same
            source. This tile used to read `users.length` twice ("Total Users" and
            "Active"), which counted partners, the system actor and suspended
            users as if they held seats, and never showed the plan's limit. */}
        <div className="grid grid-cols-2 gap-3">
          <div className="text-center p-2 bg-muted/50 rounded-md">
            <p className={`text-2xl font-bold ${overSeats ? "text-red-600" : ""}`}>
              {stats.seatLimit === null
                ? stats.seatCount
                : `${stats.seatCount}/${stats.seatLimit}`}
            </p>
            <p className="text-xs text-muted-foreground">
              Seats used{stats.seatOverridden ? " (custom)" : ""}
            </p>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded-md">
            <p className="text-2xl font-bold">{stats.totalUsers}</p>
            <p className="text-xs text-muted-foreground">People in workspace</p>
          </div>
        </div>

        {/* Say what the plan allows, and say it plainly when it is exceeded —
            an admin could not previously tell either from this panel. */}
        <p className={`text-xs ${overSeats ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
          {stats.seatLimit === null
            ? `Unlimited seats on ${tierName}. Vendors, lenders and portal contacts never use one.`
            : overSeats
              ? `Over your ${tierName} plan's ${stats.seatLimit} seats — remove or suspend a user, or upgrade.`
              : `${stats.seatLimit - stats.seatCount} of ${stats.seatLimit} seats left on ${tierName}. Vendors and lenders never use one.`}
        </p>

        {/* Role Breakdown */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">By Role</p>
          <div className="flex flex-wrap gap-2">
            {stats.adminCount > 0 && (
              <Badge variant="outline" className="text-xs">
                <Shield className="h-3 w-3 mr-1" />
                {stats.adminCount} Admin
              </Badge>
            )}
            {stats.brokerCount > 0 && (
              <Badge variant="outline" className="text-xs">
                {stats.brokerCount} Broker
              </Badge>
            )}
            {stats.agentCount > 0 && (
              <Badge variant="outline" className="text-xs">
                {stats.agentCount} Agent
              </Badge>
            )}
            {stats.coordinatorCount > 0 && (
              <Badge variant="outline" className="text-xs">
                {stats.coordinatorCount} TC
              </Badge>
            )}
          </div>
        </div>

        {/* Actions */}
        <Link href="/settings/users?action=invite">
          <Button variant="outline" size="sm" className="w-full gap-2">
            <UserPlus className="h-4 w-4" />
            Invite User
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
