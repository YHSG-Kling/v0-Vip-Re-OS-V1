"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { TrendingUp, TrendingDown, Minus } from "lucide-react"

interface Agent {
  id: string
  name: string
  email: string
  avatar_url?: string
  status: string
  deals_ytd: number
  volume_ytd: number
  trend: "up" | "down" | "stable"
}

interface BrokerageAgentListProps {
  agents?: Agent[]
}

export function BrokerageAgentList({ agents = [] }: BrokerageAgentListProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  }

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2)
  }

  const getTrendIcon = (trend: string) => {
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
          <CardTitle>Agent Roster</CardTitle>
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
        <CardTitle>Agent Roster</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Avatar>
                  <AvatarImage src={agent.avatar_url} />
                  <AvatarFallback>{getInitials(agent.name)}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">{agent.name}</p>
                  <p className="text-sm text-muted-foreground">{agent.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="font-semibold">{agent.deals_ytd} deals</p>
                  <p className="text-sm text-muted-foreground">
                    {formatCurrency(agent.volume_ytd)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {getTrendIcon(agent.trend)}
                  <Badge
                    variant={agent.status === "active" ? "default" : "secondary"}
                  >
                    {agent.status}
                  </Badge>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
