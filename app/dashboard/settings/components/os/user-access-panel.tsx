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
  activeUsers: number
  adminCount: number
  brokerCount: number
  agentCount: number
  coordinatorCount: number
}

interface UserAccessPanelProps {
  stats: UserStats
}

export function UserAccessPanel({ stats }: UserAccessPanelProps) {
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
        {/* User Counts */}
        <div className="grid grid-cols-2 gap-3">
          <div className="text-center p-2 bg-muted/50 rounded-md">
            <p className="text-2xl font-bold">{stats.totalUsers}</p>
            <p className="text-xs text-muted-foreground">Total Users</p>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded-md">
            <p className="text-2xl font-bold">{stats.activeUsers}</p>
            <p className="text-xs text-muted-foreground">Active</p>
          </div>
        </div>

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
