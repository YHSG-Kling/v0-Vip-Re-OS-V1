"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckSquare, Play, CheckCircle2, Clock, ArrowRight } from "lucide-react"
import Link from "next/link"

interface TrainingProgressPanelProps {
  completedContent: any[]
  inProgressContent: any[]
  totalAvailable: number
}

export function TrainingProgressPanel({
  completedContent,
  inProgressContent,
  totalAvailable,
}: TrainingProgressPanelProps) {
  const available = totalAvailable - completedContent.length - inProgressContent.length

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckSquare className="h-5 w-5 text-blue-600" />
          My Progress
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="p-3 bg-green-50 rounded-lg">
            <div className="text-2xl font-bold text-green-700">{completedContent.length}</div>
            <div className="text-xs text-green-600">Completed</div>
          </div>
          <div className="p-3 bg-amber-50 rounded-lg">
            <div className="text-2xl font-bold text-amber-700">{inProgressContent.length}</div>
            <div className="text-xs text-amber-600">In Progress</div>
          </div>
          <div className="p-3 bg-blue-50 rounded-lg">
            <div className="text-2xl font-bold text-blue-700">{available}</div>
            <div className="text-xs text-blue-600">Available</div>
          </div>
        </div>

        {/* In Progress List */}
        {inProgressContent.length > 0 && (
          <div>
            <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-600" />
              Continue Learning
            </h4>
            <div className="space-y-2">
              {inProgressContent.slice(0, 3).map((content: any) => (
                <div key={content.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3 min-w-0">
                    <Play className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{content.title}</p>
                      <p className="text-xs text-muted-foreground">{content.category || content.type}</p>
                    </div>
                  </div>
                  <Button size="sm" variant="outline">
                    Resume
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Completed List */}
        {completedContent.length > 0 && (
          <div>
            <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Recently Completed
            </h4>
            <div className="space-y-1">
              {completedContent.slice(0, 5).map((content: any) => (
                <div key={content.id} className="flex items-center justify-between py-2 px-3 bg-muted/50 rounded">
                  <div className="flex items-center gap-2 min-w-0">
                    <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                    <span className="text-sm truncate">{content.title}</span>
                  </div>
                  {content.completed_at && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {new Date(content.completed_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* View All Link */}
        <Link href="/academy?tab=learning" className="flex items-center justify-center gap-1 text-sm text-primary hover:underline">
          View All Resources
          <ArrowRight className="h-3 w-3" />
        </Link>
      </CardContent>
    </Card>
  )
}
