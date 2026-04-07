"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import {
  CheckCircle2,
  AlertTriangle,
  Shield,
  ArrowRight,
} from "lucide-react"
import Link from "next/link"

interface BrokerageComplianceOverviewProps {
  brokerageId?: string
  complianceRate?: number
}

export function BrokerageComplianceOverview({
  brokerageId,
  complianceRate = 0,
}: BrokerageComplianceOverviewProps) {
  const rate = Math.min(100, Math.max(0, complianceRate))

  const getStatusVariant = (): "default" | "secondary" | "destructive" => {
    if (rate >= 90) return "default"
    if (rate >= 70) return "secondary"
    return "destructive"
  }

  const getStatusLabel = () => {
    if (rate >= 90) return "Healthy"
    if (rate >= 70) return "Watch"
    return "At Risk"
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Compliance Overview
            </CardTitle>
            <CardDescription>Agent compliance status</CardDescription>
          </div>
          <Badge variant={getStatusVariant()}>
            {getStatusLabel()} · {rate.toFixed(0)}%
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Overall Compliance Rate</span>
            <span className="font-semibold">{rate.toFixed(1)}%</span>
          </div>
          <Progress value={rate} className="h-2" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex items-center gap-3 p-3 border rounded-lg">
            <div className="p-2 rounded-full bg-emerald-500/10">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{rate.toFixed(0)}%</p>
              <p className="text-xs text-muted-foreground">Compliant</p>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3 border rounded-lg">
            <div className="p-2 rounded-full bg-amber-500/10">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{(100 - rate).toFixed(0)}%</p>
              <p className="text-xs text-muted-foreground">Needs Review</p>
            </div>
          </div>
        </div>

        <div className="pt-2 border-t flex justify-end">
          <Link href={brokerageId ? `/compliance/dashboard` : `/compliance/dashboard`}>
            <Button variant="ghost" size="sm">
              View Details <ArrowRight className="w-3 h-3 ml-1" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
