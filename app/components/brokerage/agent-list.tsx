"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { TrendingUp, TrendingDown, Minus, Users, ExternalLink } from "lucide-react"
import Link from "next/link"

interface Agent {
  id: string
  name?: string
  first_name?: string
  last_name?: string
  email: string
  avatar_url?: string
  status?: string
  user_type?: string
  deals_ytd?: number
  volume_ytd?: number
  trend?: "up" | "down" | "stable"
  active_listings?: number
  closed_transactions?: number
  revenue?: number
}

interface BrokerageAgentListProps {
  agents?: Agent[]
  brokerageId?: string
}

export function BrokerageAgentList({ agents = [], brokerageId: _brokerageId }: BrokerageAgentListProps) {
  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)

  const getDisplayName = (agent: Agent) => {
    if (agent.name) return agent.name
    const full = `${agent.first_name ?? ""} ${agent.last_name ?? ""}`.trim()
    return full || agent.email.split("@")[0]
  }

  const getInitials = (name: string) =>
    name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2)

  const getTrendIcon = (trend?: string) => {
    switch (trend) {
      case "up":
        return <TrendingUp className="w-4 h-4 text-emerald-500" />
      case "down":
        return <TrendingDown className="w-4 h-4 text-red-500" />
      default:
        return <Minus className="w-4 h-4 text-muted-foreground" />
    }
  }

  if (agents.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            Agent Roster
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-center text-muted-foreground py-8">
            No agents found in your brokerage
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            Agent Roster
            <Badge variant="secondary">{agents.length}</Badge>
          </CardTitle>
          <Link href="/settings/users">
            <Button variant="ghost" size="sm">
              Manage <ExternalLink className="w-3 h-3 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {agents.map((agent) => {
            const name = getDisplayName(agent)
            const deals = agent.deals_ytd ?? agent.closed_transactions ?? 0
            const volume = agent.volume_ytd ?? agent.revenue ?? 0
            return (
              <div
                key={agent.id}
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar className="h-9 w-9 shrink-0">
                    <AvatarImage src={agent.avatar_url} />
                    <AvatarFallback>{getInitials(name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="font-medium truncate">{name}</p>
                    <p className="text-sm text-muted-foreground truncate">{agent.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <div className="text-right hidden sm:block">
                    <p className="font-semibold text-sm">{deals} deals</p>
                    <p className="text-xs text-muted-foreground">{formatCurrency(volume)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {getTrendIcon(agent.trend)}
                    <Badge
                      variant={
                        agent.status === "active" || agent.status === "approved"
                          ? "default"
                          : "secondary"
                      }
                    >
                      {agent.status ?? "active"}
                    </Badge>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
