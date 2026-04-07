"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Building2, Users, ExternalLink, AlertCircle } from "lucide-react"

interface Brokerage {
  id: string
  name: string
  city: string | null
  state: string | null
  agent_count: number
  subscription_status: string | null
  has_billing_issue: boolean
}

interface BrokerageTenantPanelProps {
  brokerages: Brokerage[]
  totalCount: number
}

export function BrokerageTenantPanel({ brokerages, totalCount }: BrokerageTenantPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Brokerage Tenants
          </CardTitle>
          <Badge variant="secondary">{totalCount} total</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {brokerages.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No brokerages found</p>
          ) : (
            brokerages.map((brokerage) => (
              <div
                key={brokerage.id}
                className="flex items-center justify-between p-3 bg-muted/50 rounded-lg hover:bg-muted/70 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium">{brokerage.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {brokerage.city && brokerage.state
                        ? `${brokerage.city}, ${brokerage.state}`
                        : "Location not set"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="flex items-center gap-1 text-sm">
                      <Users className="h-3 w-3" />
                      <span>{brokerage.agent_count}</span>
                    </div>
                    {brokerage.has_billing_issue && (
                      <Badge variant="destructive" className="text-xs">
                        <AlertCircle className="h-3 w-3 mr-1" />
                        Billing
                      </Badge>
                    )}
                    {brokerage.subscription_status && !brokerage.has_billing_issue && (
                      <Badge
                        variant={brokerage.subscription_status === "active" ? "default" : "outline"}
                        className={`text-xs ${brokerage.subscription_status === "active" ? "bg-green-600" : ""}`}
                      >
                        {brokerage.subscription_status}
                      </Badge>
                    )}
                  </div>
                  <Link href={`/admin/brokerages/${brokerage.id}`}>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
        {totalCount > 5 && (
          <Link href="/admin/brokerages" className="block mt-4">
            <Button variant="outline" size="sm" className="w-full">
              View All Brokerages
            </Button>
          </Link>
        )}
      </CardContent>
    </Card>
  )
}
