"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { 
  CheckCircle2, 
  Circle,
  ArrowRight,
  Settings 
} from "lucide-react"

interface SetupItem {
  key: string
  label: string
  completed: boolean
  href: string
  priority: "high" | "medium" | "low"
}

interface SetupCompletenessPanelProps {
  items: SetupItem[]
  completionPct: number
}

export function SetupCompletenessPanel({ items, completionPct }: SetupCompletenessPanelProps) {
  const incompleteItems = items.filter((item) => !item.completed)
  const highPriority = incompleteItems.filter((item) => item.priority === "high")
  
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Settings className="h-4 w-4" />
          Setup Completeness
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Configuration Progress</span>
            <span className="font-medium">{completionPct}%</span>
          </div>
          <Progress value={completionPct} className="h-2" />
        </div>

        {/* High Priority Items */}
        {highPriority.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-amber-600">Needs Attention</p>
            {highPriority.slice(0, 3).map((item) => (
              <div
                key={item.key}
                className="flex items-center justify-between py-1"
              >
                <div className="flex items-center gap-2">
                  <Circle className="h-3 w-3 text-amber-500" />
                  <span className="text-sm">{item.label}</span>
                </div>
                <Link href={item.href}>
                  <Button variant="ghost" size="sm" className="h-6 px-2">
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
            ))}
          </div>
        )}

        {/* Completed Items Summary */}
        <div className="flex items-center justify-between pt-2 border-t">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <span>{items.filter((i) => i.completed).length} of {items.length} complete</span>
          </div>
          {incompleteItems.length > 0 && (
            <Badge variant="outline" className="text-xs">
              {incompleteItems.length} remaining
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
