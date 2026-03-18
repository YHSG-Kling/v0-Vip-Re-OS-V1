"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { 
  Radio, 
  Zap, 
  Users, 
  CheckCircle2, 
  Clock, 
  XCircle, 
  RefreshCw 
} from "lucide-react"

interface QualificationRadarProps {
  newLeadsUnderAI: number
  activelyNurturing: number
  positiveResponders: number
  qualifiedHandoffReady: number
  stalled: number
  blockedByHardStop: number
  waitingRetry: number
}

export function QualificationRadar({
  newLeadsUnderAI,
  activelyNurturing,
  positiveResponders,
  qualifiedHandoffReady,
  stalled,
  blockedByHardStop,
  waitingRetry,
}: QualificationRadarProps) {
  const radarItems = [
    {
      label: "New Leads Under AI",
      value: newLeadsUnderAI,
      icon: Radio,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
      description: "Raw leads in AI qualification pipeline",
    },
    {
      label: "Actively Nurturing",
      value: activelyNurturing,
      icon: Zap,
      color: "text-purple-600",
      bgColor: "bg-purple-50",
      description: "AI engaged in active conversations",
    },
    {
      label: "Positive Responders",
      value: positiveResponders,
      icon: Users,
      color: "text-green-600",
      bgColor: "bg-green-50",
      description: "Meaningful engagement detected",
    },
    {
      label: "Qualified + Handoff Ready",
      value: qualifiedHandoffReady,
      icon: CheckCircle2,
      color: "text-emerald-600",
      bgColor: "bg-emerald-50",
      description: "Ready for agent handoff",
    },
    {
      label: "Stalled",
      value: stalled,
      icon: Clock,
      color: "text-amber-600",
      bgColor: "bg-amber-50",
      description: "No progress in 48+ hours",
    },
    {
      label: "Blocked by Hard Stop",
      value: blockedByHardStop,
      icon: XCircle,
      color: "text-red-600",
      bgColor: "bg-red-50",
      description: "Compliance or data issue",
    },
    {
      label: "Waiting Retry",
      value: waitingRetry,
      icon: RefreshCw,
      color: "text-slate-600",
      bgColor: "bg-slate-50",
      description: "Scheduled for re-engagement",
    },
  ]

  const totalLeads = newLeadsUnderAI + activelyNurturing + positiveResponders + qualifiedHandoffReady + stalled + blockedByHardStop + waitingRetry

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="h-4 w-4 text-indigo-600" />
            Qualification Radar
          </CardTitle>
          <Badge variant="outline" className="text-xs">
            {totalLeads} total leads
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {radarItems.map((item) => (
            <div
              key={item.label}
              className={`${item.bgColor} rounded-lg p-3 flex flex-col items-center text-center`}
            >
              <item.icon className={`h-5 w-5 ${item.color} mb-1`} />
              <p className={`text-2xl font-bold ${item.color}`}>{item.value}</p>
              <p className="text-xs font-medium text-foreground mt-0.5">{item.label}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
