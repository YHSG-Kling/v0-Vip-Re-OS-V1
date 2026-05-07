"use client"

import Link from "next/link"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Progress } from "@/app/components/ui/progress"
import { CheckCircle2, Circle, Clock, ArrowRight, Route } from "lucide-react"
import { cn } from "@/lib/utils"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface TransactionMilestone {
  id: string
  milestone_name: string
  milestone_type?: string | null
  target_date: string | null
  completed_at: string | null
  status: string
}

export interface MilestoneProgressBarProps {
  milestones: TransactionMilestone[]
  contactId: string
  labelMap?: Record<string, string>
  className?: string
}

// ─── DEFAULT LABEL MAP ────────────────────────────────────────────────────────

const DEFAULT_LABELS: Record<string, string> = {
  earnest_money_due: "Earnest Money",
  inspection_deadline: "Inspection",
  inspection_completed: "Inspection Done",
  appraisal_ordered: "Appraisal Ordered",
  appraisal_deadline: "Appraisal",
  appraisal_completed: "Appraisal Done",
  financing_deadline: "Financing",
  clear_to_close_received: "Clear to Close",
  final_walkthrough_scheduled: "Final Walkthrough",
  closing_date: "Closing Day",
}

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────

function getMilestoneLabel(name: string, labelMap?: Record<string, string>): string {
  if (labelMap?.[name]) return labelMap[name]
  if (DEFAULT_LABELS[name]) return DEFAULT_LABELS[name]
  // Convert snake_case to Title Case
  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "TBD"
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
}

function getMilestoneStatus(milestone: TransactionMilestone): "completed" | "current" | "upcoming" {
  if (milestone.status === "completed" || milestone.completed_at) {
    return "completed"
  }
  // Check if overdue
  if (milestone.target_date) {
    const dueDate = new Date(milestone.target_date)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (dueDate < today) {
      return "current" // Overdue = needs attention
    }
  }
  return "upcoming"
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export function MilestoneProgressBar({
  milestones,
  contactId,
  labelMap,
  className,
}: MilestoneProgressBarProps) {
  // Sort milestones by date
  const sortedMilestones = [...milestones].sort((a, b) => {
    if (!a.target_date) return 1
    if (!b.target_date) return -1
    return new Date(a.target_date).getTime() - new Date(b.target_date).getTime()
  })

  // Calculate progress
  const completedCount = sortedMilestones.filter(
    (m) => m.status === "completed" || m.completed_at
  ).length
  const totalCount = sortedMilestones.length
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  // Find current milestone (first non-completed)
  const currentIndex = sortedMilestones.findIndex(
    (m) => m.status !== "completed" && !m.completed_at
  )
  const currentMilestone = currentIndex >= 0 ? sortedMilestones[currentIndex] : null

  // Get next 3 milestones for display (including current)
  const displayMilestones = sortedMilestones.slice(
    Math.max(0, currentIndex),
    currentIndex + 3
  )

  // Empty state
  if (milestones.length === 0) {
    return (
      <Card className={className}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Route className="h-4 w-4" />
            Your Progress
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            Your transaction milestones will appear here once you are under contract
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Route className="h-4 w-4" />
            Your Progress
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/portal/${contactId}/journey`}>
              View All
              <ArrowRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {completedCount} of {totalCount} milestones completed
            </span>
            <span className="font-medium">{progressPercent}%</span>
          </div>
          <Progress value={progressPercent} className="h-2" />
        </div>

        {/* Current Stage Badge */}
        {currentMilestone && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Current:</span>
            <Badge variant="secondary" className="bg-blue-100 text-blue-800">
              {getMilestoneLabel(currentMilestone.milestone_name, labelMap)}
            </Badge>
          </div>
        )}

        {/* Next Milestones */}
        <div className="space-y-2">
          {displayMilestones.map((milestone, idx) => {
            const status = getMilestoneStatus(milestone)
            const isCurrent = idx === 0 && currentMilestone?.id === milestone.id

            return (
              <div
                key={milestone.id}
                className={cn(
                  "flex items-center gap-3 p-2 rounded-lg transition-colors",
                  isCurrent && "bg-blue-50 border border-blue-100"
                )}
              >
                {/* Status Icon */}
                {status === "completed" ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                ) : isCurrent ? (
                  <Clock className="h-5 w-5 text-blue-600 shrink-0" />
                ) : (
                  <Circle className="h-5 w-5 text-muted-foreground shrink-0" />
                )}

                {/* Label & Date */}
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      "text-sm truncate",
                      status === "completed" && "text-muted-foreground line-through",
                      isCurrent && "font-medium text-blue-800"
                    )}
                  >
                    {getMilestoneLabel(milestone.milestone_name, labelMap)}
                  </p>
                </div>

                {/* Date */}
                <span
                  className={cn(
                    "text-xs shrink-0",
                    status === "completed"
                      ? "text-green-600"
                      : isCurrent
                      ? "text-blue-600 font-medium"
                      : "text-muted-foreground"
                  )}
                >
                  {status === "completed" && milestone.completed_at
                    ? formatDate(milestone.completed_at)
                    : formatDate(milestone.target_date)}
                </span>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

export default MilestoneProgressBar
