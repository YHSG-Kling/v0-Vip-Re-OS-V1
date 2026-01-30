"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Users, TrendingUp, Target } from "lucide-react"

interface Agent {
  id: string
  name: string
  email: string
  active_listings: number
  closed_transactions: number
  revenue: number
}

export function BrokerageAgentList() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadAgents()
  }, [])

  const loadAgents = async () => {
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("agents")
        .select("*")
        .eq("status", "active")

      if (error) throw error
      
      setAgents(data || [])
    } catch (error) {
      console.error("Error loading agents:", error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="text-center py-8">Loading agents...</div>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="w-5 h-5" />
          Active Agents
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {agents.length === 0 ? (
            <p className="text-muted-foreground">No active agents</p>
          ) : (
            agents.map((agent) => (
              <div key={agent.id} className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <h4 className="font-semibold">{agent.name}</h4>
                  <p className="text-sm text-muted-foreground">{agent.email}</p>
                </div>
                <div className="flex gap-4 text-sm">
                  <div className="text-center">
                    <p className="text-muted-foreground">Listings</p>
                    <p className="font-semibold">{agent.active_listings}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-muted-foreground">Closed</p>
                    <p className="font-semibold">{agent.closed_transactions}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-muted-foreground">Revenue</p>
                    <p className="font-semibold">${(agent.revenue / 1000).toFixed(1)}K</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
