"use client"

import { CheckCircle2, Circle, Clock } from "lucide-react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface Milestone {
  id: string
  name: string
  date: string | null
  status: string
  icon?: string
  description?: string
}

interface TimelineProps {
  milestones?: Milestone[]
  // Legacy props for backwards compatibility
  currentStage?: string
  completedStages?: string[]
  upcomingStages?: string[]
}

const STAGE_DISPLAY: Record<string, string> = {
  UNDER_CONTRACT: "Under Contract",
  INSPECTION: "Inspection Period",
  APPRAISAL: "Appraisal",
  FINANCING: "Financing",
  FINAL_WALKTHROUGH: "Final Walkthrough",
  CLOSING: "Closing",
  CLOSED: "Closed"
}

export function TransactionTimeline({ milestones, currentStage, completedStages = [], upcomingStages = [] }: TimelineProps) {
  // Use new milestones format if provided
  if (milestones && milestones.length > 0) {
    return (
      <Card className="p-4 sm:p-6">
        <h2 className="text-lg font-semibold mb-6">Your Transaction Progress</h2>
        <div className="space-y-1">
          {milestones.map((milestone, index) => {
            const isCompleted = milestone.status === "completed"
            const isCurrent = milestone.status === "in_progress" || milestone.status === "current"
            const isUpcoming = milestone.status === "pending" || milestone.status === "upcoming"
            const isLast = index === milestones.length - 1

            return (
              <div key={milestone.id} className="flex items-start gap-3 sm:gap-4">
                <div className="flex flex-col items-center">
                  <div className={cn(
                    "w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-colors",
                    isCompleted && "bg-green-100 dark:bg-green-950/30",
                    isCurrent && "bg-blue-100 dark:bg-blue-950/30 ring-2 ring-blue-500 ring-offset-2",
                    isUpcoming && "bg-muted"
                  )}>
                    {isCompleted && <CheckCircle2 className="h-4 w-4 sm:h-5 sm:w-5 text-green-600" />}
                    {isCurrent && <Clock className="h-4 w-4 sm:h-5 sm:w-5 text-blue-600 animate-pulse" />}
                    {isUpcoming && <Circle className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground" />}
                  </div>
                  {!isLast && (
                    <div className={cn(
                      "w-0.5 h-10 sm:h-12 transition-colors",
                      isCompleted ? "bg-green-500" : "bg-border"
                    )} />
                  )}
                </div>
                <div className="flex-1 pt-1 pb-2 min-w-0">
                  <p className={cn(
                    "font-medium text-sm sm:text-base",
                    isCurrent && "text-blue-600 dark:text-blue-400",
                    isCompleted && "text-green-600 dark:text-green-400",
                    isUpcoming && "text-muted-foreground"
                  )}>
                    {milestone.name}
                  </p>
                  {milestone.description && (
                    <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 line-clamp-2">
                      {milestone.description}
                    </p>
                  )}
                  {milestone.date && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {isCompleted ? "Completed" : "Target"}: {new Date(milestone.date).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Card>
    )
  }

  // Legacy support: use stage-based props
  const allStages = [...completedStages, currentStage || "", ...upcomingStages].filter(Boolean)

  return (
    <Card className="p-4 sm:p-6">
      <h2 className="text-lg font-semibold mb-6">Your Transaction Progress</h2>
      <div className="space-y-4">
        {allStages.map((stage, index) => {
          const isCompleted = completedStages.includes(stage)
          const isCurrent = stage === currentStage
          const isUpcoming = upcomingStages.includes(stage)

          return (
            <div key={stage} className="flex items-start gap-3 sm:gap-4">
              <div className="flex flex-col items-center">
                <div className={cn(
                  "w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center flex-shrink-0",
                  isCompleted && "bg-green-100 dark:bg-green-950/30",
                  isCurrent && "bg-blue-100 dark:bg-blue-950/30",
                  isUpcoming && "bg-muted"
                )}>
                  {isCompleted && <CheckCircle2 className="h-4 w-4 sm:h-5 sm:w-5 text-green-600" />}
                  {isCurrent && <Clock className="h-4 w-4 sm:h-5 sm:w-5 text-blue-600" />}
                  {isUpcoming && <Circle className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground" />}
                </div>
                {index < allStages.length - 1 && (
                  <div className={cn("w-0.5 h-12", isCompleted ? "bg-green-500" : "bg-border")} />
                )}
              </div>
              <div className="flex-1 pt-1">
                <p className={cn(
                  "font-medium text-sm sm:text-base",
                  isCurrent && "text-blue-600",
                  isCompleted && "text-green-600",
                  isUpcoming && "text-muted-foreground"
                )}>
                  {STAGE_DISPLAY[stage] || stage}
                </p>
                {isCurrent && (
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1">Currently in progress</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
