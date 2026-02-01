"use client"
import { DollarSign, TrendingUp, Users, Home, AlertTriangle, Target } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

interface KPICardsProps {
  data: {
    title: string
    value: string | number
    trend?: string
    icon: "dollar" | "trending" | "users" | "home" | "alert" | "target"
    trendUp?: boolean
  }[]
}

export function KPICards({ data }: KPICardsProps) {
  const iconMap = {
    dollar: DollarSign,
    trending: TrendingUp,
    users: Users,
    home: Home,
    alert: AlertTriangle,
    target: Target,
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {data.map((kpi, idx) => {
        const Icon = iconMap[kpi.icon]
        return (
          <Card key={idx} className="p-6 hover:shadow-lg transition-shadow">
            <div className="flex items-start justify-between mb-3">
              <div className="p-2 bg-indigo-100 rounded-lg">
                <Icon className="w-5 h-5 text-indigo-600" />
              </div>
              {kpi.trend && (
                <Badge variant={kpi.trendUp ? "default" : "destructive"} className="text-xs">
                  {kpi.trend}
                </Badge>
              )}
            </div>
            <p className="text-sm font-medium text-slate-500 mb-1">{kpi.title}</p>
            <p className="text-2xl font-bold text-slate-900">{kpi.value}</p>
          </Card>
        )
      })}
    </div>
  )
}
