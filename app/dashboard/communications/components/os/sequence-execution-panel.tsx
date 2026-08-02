"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { 
  Users, 
  Play, 
  Pause, 
  CheckCircle, 
  Clock, 
  Mail,
  MessageSquare,
  SkipForward,
  AlertTriangle
} from "lucide-react"

interface SequenceEnrollment {
  id: string
  contactName: string
  contactId: string
  sequenceName: string
  sequenceId: string
  currentStep: number
  totalSteps: number
  status: "active" | "paused" | "completed" | "failed"
  nextStepAt?: string
  nextStepChannel?: "email" | "sms"
}

interface SequenceExecutionPanelProps {
  enrollments: SequenceEnrollment[]
  onPause: (enrollmentId: string) => Promise<void>
  onResume: (enrollmentId: string) => Promise<void>
  onSkipStep: (enrollmentId: string) => Promise<void>
  onRemove: (enrollmentId: string) => Promise<void>
  onViewSequence: (sequenceId: string) => void
}

export function SequenceExecutionPanel({
  enrollments,
  onPause,
  onResume,
  onSkipStep,
  onRemove,
  onViewSequence,
}: SequenceExecutionPanelProps) {
  const activeEnrollments = enrollments.filter(e => e.status === "active")
  const pausedEnrollments = enrollments.filter(e => e.status === "paused")

  const formatNextStep = (dateStr?: string) => {
    if (!dateStr) return "N/A"
    const date = new Date(dateStr)
    const now = new Date()
    const diffHours = Math.round((date.getTime() - now.getTime()) / (1000 * 60 * 60))
    
    if (diffHours < 0) return "Overdue"
    if (diffHours < 1) return "< 1 hour"
    if (diffHours < 24) return `${diffHours}h`
    return `${Math.round(diffHours / 24)}d`
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Sequence Execution
            </CardTitle>
            <CardDescription>Active automated outreach sequences</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="default">{activeEnrollments.length} active</Badge>
            {pausedEnrollments.length > 0 && (
              <Badge variant="secondary">{pausedEnrollments.length} paused</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[350px]">
          <div className="space-y-3">
            {enrollments.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No active sequence enrollments.</p>
                {/* Had no handler: the one control on the empty state, and the
                    only way out of it, went nowhere. The sequences list lives at
                    /dashboard/campaigns/sequences. */}
                <Button variant="link" size="sm" className="mt-2" asChild>
                  <Link href="/dashboard/campaigns/sequences">Browse Sequences</Link>
                </Button>
              </div>
            ) : (
              enrollments.map((enrollment) => (
                <div
                  key={enrollment.id}
                  className={`p-3 rounded-lg border ${
                    enrollment.status === "paused" ? "bg-muted/50 border-muted" :
                    enrollment.status === "failed" ? "bg-destructive/5 border-destructive" :
                    "bg-muted/30"
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="font-medium">{enrollment.contactName}</div>
                      <div className="text-sm text-muted-foreground">
                        {enrollment.sequenceName}
                      </div>
                    </div>
                    <Badge 
                      variant={
                        enrollment.status === "active" ? "default" :
                        enrollment.status === "paused" ? "secondary" :
                        enrollment.status === "completed" ? "outline" :
                        "destructive"
                      }
                    >
                      {enrollment.status}
                    </Badge>
                  </div>

                  {/* Progress */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                      <span>Step {enrollment.currentStep} of {enrollment.totalSteps}</span>
                      <span>{Math.round((enrollment.currentStep / enrollment.totalSteps) * 100)}%</span>
                    </div>
                    <Progress 
                      value={(enrollment.currentStep / enrollment.totalSteps) * 100} 
                      className="h-1.5"
                    />
                  </div>

                  {/* Next Step Info */}
                  {enrollment.status === "active" && enrollment.nextStepAt && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
                      <Clock className="h-3 w-3" />
                      Next: {enrollment.nextStepChannel === "email" ? (
                        <Mail className="h-3 w-3" />
                      ) : (
                        <MessageSquare className="h-3 w-3" />
                      )}
                      in {formatNextStep(enrollment.nextStepAt)}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2">
                    {enrollment.status === "active" ? (
                      <>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => onPause(enrollment.id)}
                          className="flex-1"
                        >
                          <Pause className="h-3 w-3 mr-1" />
                          Pause
                        </Button>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => onSkipStep(enrollment.id)}
                        >
                          <SkipForward className="h-3 w-3" />
                        </Button>
                      </>
                    ) : enrollment.status === "paused" ? (
                      <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={() => onResume(enrollment.id)}
                        className="flex-1"
                      >
                        <Play className="h-3 w-3 mr-1" />
                        Resume
                      </Button>
                    ) : null}
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => onViewSequence(enrollment.sequenceId)}
                    >
                      View
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
