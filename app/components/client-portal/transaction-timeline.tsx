"use client"

import { CheckCircle2, Circle, Clock } from "lucide-react"
import { Card } from "@/components/ui/card"

interface TimelineProps {
  currentStage: string
  completedStages: string[]
  upcomingStages: string[]
}

const STAGE_DISPLAY = {
  UNDER_CONTRACT: "Under Contract",
  INSPECTION: "Inspection Period",
  APPRAISAL: "Appraisal",
  FINANCING: "Financing",
  FINAL_WALKTHROUGH: "Final Walkthrough",
  CLOSING: "Closing",
  CLOSED: "Closed"
}

export function TransactionTimeline({ currentStage, completedStages, upcomingStages }: TimelineProps) {
  const allStages = [...completedStages, currentStage, ...upcomingStages]

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-6">Your Transaction Progress</h2>
      <div className="space-y-4">
        {allStages.map((stage, index) => {
          const isCompleted = completedStages.includes(stage)
          const isCurrent = stage === currentStage
          const isUpcoming = upcomingStages.includes(stage)

          return (
            <div key={stage} className="flex items-start gap-4">
              <div className="flex flex-col items-center">
                {isCompleted && <CheckCircle2 className="h-6 w-6 text-green-600" />}
                {isCurrent && <Clock className="h-6 w-6 text-blue-600" />}
                {isUpcoming && <Circle className="h-6 w-6 text-gray-300" />}
                {index < allStages.length - 1 && (
                  <div className={`w-0.5 h-12 ${isCompleted ? 'bg-green-600' : 'bg-gray-300'}`} />
                )}
              </div>
              <div className="flex-1 pt-0.5">
                <p className={`font-medium ${isCurrent ? 'text-blue-600' : isCompleted ? 'text-green-600' : 'text-gray-400'}`}>
                  {STAGE_DISPLAY[stage as keyof typeof STAGE_DISPLAY] || stage}
                </p>
                {isCurrent && (
                  <p className="text-sm text-muted-foreground mt-1">Currently in progress</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
