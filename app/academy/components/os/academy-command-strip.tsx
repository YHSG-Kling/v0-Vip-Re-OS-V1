"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { GraduationCap, Sparkles, Loader2, Trophy } from "lucide-react"

interface AcademyCommandStripProps {
  agentName: string
  completedCount: number
  totalContent: number
  currentPoints?: number
  currentTier?: string
  onGenerateLearningPath: () => void
  generating: boolean
}

export function AcademyCommandStrip({
  agentName,
  completedCount,
  totalContent,
  currentPoints,
  currentTier,
  onGenerateLearningPath,
  generating,
}: AcademyCommandStripProps) {
  const progressPercent = totalContent > 0 ? Math.round((completedCount / totalContent) * 100) : 0

  return (
    <div className="rounded-lg bg-gradient-to-r from-emerald-700 to-teal-800 text-white p-6 mb-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/20">
            <GraduationCap className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Academy & Training Center</h1>
            <p className="text-emerald-100 text-sm">
              Welcome back, {agentName}. {completedCount}/{totalContent} resources completed.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {currentPoints !== undefined && (
            <div className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-amber-300" />
              <span className="font-semibold">{currentPoints.toLocaleString()} pts</span>
              {currentTier && (
                <Badge variant="secondary" className="bg-white/20 text-white border-0">
                  {currentTier}
                </Badge>
              )}
            </div>
          )}

          <Button
            onClick={onGenerateLearningPath}
            disabled={generating}
            className="bg-white text-emerald-800 hover:bg-emerald-50"
          >
            {generating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-2" />
                Generate My Learning Path
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="text-emerald-100">Learning Progress</span>
          <span className="font-medium">{progressPercent}%</span>
        </div>
        <div className="h-2 bg-white/20 rounded-full overflow-hidden">
          <div
            className="h-full bg-white rounded-full transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
    </div>
  )
}
