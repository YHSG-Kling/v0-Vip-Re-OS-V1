"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import Link from "next/link"
import { 
  AlertTriangle, 
  ChevronRight,
  Clock,
  User,
  FileText,
  Settings,
  Zap
} from "lucide-react"

interface SetupBlocker {
  id: string
  agentId: string
  agentName: string
  blockerType: 'license' | 'tech_stack' | 'training' | 'brand' | 'compliance'
  description: string
  daysSinceStart: number
  completionPct: number
  currentStep: string
}

interface SetupBlockersPanelProps {
  blockers: SetupBlocker[]
  onNudge?: (agentId: string) => void
}

const blockerIcons = {
  license: FileText,
  tech_stack: Settings,
  training: Zap,
  brand: Zap,
  compliance: AlertTriangle,
}

const blockerColors = {
  license: "text-blue-500",
  tech_stack: "text-purple-500",
  training: "text-green-500",
  brand: "text-orange-500",
  compliance: "text-red-500",
}

export function SetupBlockersPanel({ blockers, onNudge }: SetupBlockersPanelProps) {
  if (blockers.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Setup Blockers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 text-muted-foreground">
            <p className="text-sm">No active blockers - all agents progressing well</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Setup Blockers
          <Badge variant="destructive" className="ml-auto">{blockers.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {blockers.slice(0, 5).map((blocker) => {
          const Icon = blockerIcons[blocker.blockerType] || AlertTriangle
          const color = blockerColors[blocker.blockerType] || "text-gray-500"
          
          return (
            <div 
              key={blocker.id} 
              className="flex items-center gap-3 p-2 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
            >
              <Icon className={`h-4 w-4 ${color} shrink-0`} />
              
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <User className="h-3 w-3 text-muted-foreground" />
                  <span className="text-sm font-medium truncate">{blocker.agentName}</span>
                </div>
                <p className="text-xs text-muted-foreground truncate">{blocker.description}</p>
                <div className="flex items-center gap-2 mt-1">
                  <Progress value={blocker.completionPct} className="h-1 flex-1" />
                  <span className="text-xs text-muted-foreground">{blocker.completionPct}%</span>
                </div>
              </div>
              
              <div className="flex items-center gap-2 shrink-0">
                <div className="text-right">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {blocker.daysSinceStart}d
                  </div>
                </div>
                
                <Link href={`/dashboard/onboarding/admin/agents/${blocker.agentId}`}>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </Link>
              </div>
            </div>
          )
        })}
        
        {blockers.length > 5 && (
          <Link href="/dashboard/onboarding/admin/agents">
            <Button variant="outline" size="sm" className="w-full">
              View All {blockers.length} Blockers
            </Button>
          </Link>
        )}
      </CardContent>
    </Card>
  )
}
