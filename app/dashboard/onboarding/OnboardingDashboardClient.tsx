'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import confetti from 'canvas-confetti'
import { 
  Check, 
  Lock, 
  Play, 
  FileText, 
  Award, 
  Clock, 
  ChevronDown, 
  ChevronUp,
  Loader2,
  AlertCircle,
  Trophy,
  Star,
  TrendingUp,
  Users,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { OnboardingQuizClient } from './OnboardingQuizClient'
import { 
  getAgentProgress, 
  claimCertification, 
  dismissCelebration,
  getAdminOnboardingOverview,
} from '@/app/actions/onboarding/progress'
import { completeMyOnboardingStep } from '@/app/actions/onboarding/agent-onboarding-actions'
import type { OnboardingStepRow } from '@/lib/kernel'

interface OnboardingDashboardClientProps {
  initialData: {
    onboarding: {
      id: string
      status: string
      completion_percentage: number
      current_day: number
      certification_achieved: boolean
      certified_at: string | null
    }
    steps: OnboardingStepRow[]
    completions: Array<{
      step_id: string
      completed: boolean
      completed_at: string | null
      quiz_score: number | null
    }>
  }
  userType: string
  brokerageId: string
}

interface PerformanceReport {
  id: string
  overallScore: number
  aiNarrative: string
  strengths: string[]
  improvementAreas: string[]
  recommendedActions: string[]
  createdAt: string
}

interface CertificationCard {
  name: string
  awarded: boolean
  issuedAt?: string
  certId?: string
  certificateUrl?: string
  eligible?: boolean
  missingRequirements?: string[]
}

export function OnboardingDashboardClient({ 
  initialData, 
  userType,
  brokerageId,
}: OnboardingDashboardClientProps) {
  const router = useRouter()
  const [expandedDays, setExpandedDays] = useState<number[]>([initialData.onboarding.current_day])
  const [showCelebration, setShowCelebration] = useState(false)
  const [claimingCert, setClaimingCert] = useState<string | null>(null)
  const [generatingReport, setGeneratingReport] = useState(false)
  const [performanceReport, setPerformanceReport] = useState<PerformanceReport | null>(null)

  // Fetch progress data with SWR
  const { data: progressData, mutate: mutateProgress } = useSWR(
    'agent-progress',
    async () => {
      const result = await getAgentProgress()
      return result.success ? result.data : null
    },
    { refreshInterval: 30000 }
  )

  // Fetch performance report
  const { data: reportData } = useSWR(
    'performance-report',
    async () => {
      const res = await fetch('/api/onboarding/performance-report')
      const data = await res.json()
      return data.hasReport ? data.report : null
    }
  )

  useEffect(() => {
    if (reportData) {
      setPerformanceReport(reportData)
    }
  }, [reportData])

  // Check for celebration on completion
  useEffect(() => {
    if (
      progressData?.certificationAchieved && 
      !progressData?.celebrationDismissed &&
      progressData?.certifications?.every(c => c.awarded)
    ) {
      setShowCelebration(true)
      // Fire confetti
      const duration = 3000
      const end = Date.now() + duration
      const colors = ['#0EA5E9', '#10B981', '#8B5CF6', '#F59E0B']
      
      const frame = () => {
        confetti({
          particleCount: 4,
          angle: 60,
          spread: 55,
          origin: { x: 0 },
          colors,
        })
        confetti({
          particleCount: 4,
          angle: 120,
          spread: 55,
          origin: { x: 1 },
          colors,
        })
        if (Date.now() < end) {
          requestAnimationFrame(frame)
        }
      }
      frame()
    }
  }, [progressData])

  const handleDismissCelebration = async () => {
    setShowCelebration(false)
    await dismissCelebration()
    mutateProgress()
  }

  const handleClaimCert = async (certName: string) => {
    setClaimingCert(certName)
    const result = await claimCertification(certName)
    setClaimingCert(null)
    if (result.success) {
      mutateProgress()
    }
  }

  const handleGenerateReport = async () => {
    setGeneratingReport(true)
    try {
      const res = await fetch('/api/onboarding/performance-report', { method: 'POST' })
      const reader = res.body?.getReader()
      if (!reader) return

      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
      }

      // Refetch report after generation
      const reportRes = await fetch('/api/onboarding/performance-report')
      const data = await reportRes.json()
      if (data.hasReport) {
        setPerformanceReport(data.report)
      }
    } finally {
      setGeneratingReport(false)
    }
  }

  const toggleDay = (day: number) => {
    setExpandedDays(prev => 
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    )
  }

  // Group steps by day
  const stepsByDay = new Map<number, OnboardingStepRow[]>()
  initialData.steps.forEach(step => {
    if (!stepsByDay.has(step.day_number)) {
      stepsByDay.set(step.day_number, [])
    }
    stepsByDay.get(step.day_number)!.push(step)
  })

  const completionMap = new Map(
    initialData.completions.map(c => [c.step_id, c])
  )

  const certifications = progressData?.certifications || []
  const isAdmin = ['admin', 'broker', 'superadmin'].includes(userType)

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Celebration Modal */}
      <Dialog open={showCelebration} onOpenChange={setShowCelebration}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-2xl">
              <Trophy className="h-8 w-8 text-amber-500" />
              Congratulations!
            </DialogTitle>
            <DialogDescription className="text-base">
              You have successfully completed your onboarding and earned all required certifications. 
              You are now fully certified to start your real estate career with us!
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center py-4">
            <div className="grid grid-cols-3 gap-4">
              {certifications.filter(c => c.awarded).map(cert => (
                <div key={cert.name} className="flex flex-col items-center">
                  <div className="h-16 w-16 rounded-full bg-amber-100 flex items-center justify-center">
                    <Award className="h-8 w-8 text-amber-600" />
                  </div>
                  <span className="text-xs text-center mt-2 font-medium">{cert.name}</span>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleDismissCelebration} className="w-full">
              Continue to Dashboard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="container mx-auto p-6">
        <h1 className="text-3xl font-bold mb-6">Agent Onboarding</h1>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* LEFT COLUMN - Progress Sidebar */}
          <div className="lg:col-span-1 space-y-4">
            {/* Progress Dial */}
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-col items-center">
                  <div className="relative h-32 w-32">
                    <svg className="h-32 w-32 -rotate-90" viewBox="0 0 100 100">
                      <circle
                        cx="50"
                        cy="50"
                        r="45"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="8"
                        className="text-muted"
                      />
                      <circle
                        cx="50"
                        cy="50"
                        r="45"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="8"
                        strokeLinecap="round"
                        strokeDasharray={`${(progressData?.overallPercentage || initialData.onboarding.completion_percentage) * 2.83} 283`}
                        className="text-primary transition-all duration-500"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-3xl font-bold">
                        {progressData?.overallPercentage || initialData.onboarding.completion_percentage}%
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mt-2">
                    Day {initialData.onboarding.current_day} of 7
                  </p>
                  <Badge 
                    variant={initialData.onboarding.status === 'completed' ? 'default' : 'secondary'}
                    className="mt-2"
                  >
                    {initialData.onboarding.status === 'completed' ? 'Completed' : 
                     initialData.onboarding.status === 'paused' ? 'Paused' : 'In Progress'}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {/* Day-by-Day Steps */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Your Journey</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {Array.from(stepsByDay.entries())
                  .sort(([a], [b]) => a - b)
                  .map(([day, steps]) => {
                    const dayCompleted = steps.every(s => completionMap.get(s.id)?.completed)
                    const isCurrentDay = day === initialData.onboarding.current_day
                    const isLocked = day > initialData.onboarding.current_day

                    return (
                      <Collapsible 
                        key={day} 
                        open={expandedDays.includes(day)}
                        onOpenChange={() => toggleDay(day)}
                      >
                        <CollapsibleTrigger className="flex items-center justify-between w-full p-2 rounded-lg hover:bg-muted transition-colors">
                          <div className="flex items-center gap-2">
                            {dayCompleted ? (
                              <div className="h-6 w-6 rounded-full bg-green-100 flex items-center justify-center">
                                <Check className="h-4 w-4 text-green-600" />
                              </div>
                            ) : isLocked ? (
                              <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center">
                                <Lock className="h-3 w-3 text-muted-foreground" />
                              </div>
                            ) : (
                              <div className={`h-6 w-6 rounded-full flex items-center justify-center ${isCurrentDay ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                                <span className="text-xs font-medium">{day}</span>
                              </div>
                            )}
                            <span className={`text-sm ${isCurrentDay ? 'font-semibold' : ''}`}>
                              Day {day}
                            </span>
                          </div>
                          {expandedDays.includes(day) ? (
                            <ChevronUp className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )}
                        </CollapsibleTrigger>
                        <CollapsibleContent className="pl-8 space-y-1">
                          {steps.map(step => {
                            const completion = completionMap.get(step.id)
                            return (
                              <div key={step.id} className="flex items-center gap-2 py-1 text-sm">
                                {completion?.completed ? (
                                  <Check className="h-3 w-3 text-green-600" />
                                ) : isLocked ? (
                                  <Lock className="h-3 w-3 text-muted-foreground" />
                                ) : (
                                  <div className="h-3 w-3 rounded-full border border-muted-foreground" />
                                )}
                                <span className={completion?.completed ? 'text-muted-foreground line-through' : ''}>
                                  {step.step_name}
                                </span>
                              </div>
                            )
                          })}
                        </CollapsibleContent>
                      </Collapsible>
                    )
                  })}
              </CardContent>
            </Card>

            {/* Certification Status */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Certifications</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {certifications.map(cert => (
                  <div key={cert.name} className="flex items-center gap-3">
                    <div className={`h-10 w-10 rounded-full flex items-center justify-center ${
                      cert.awarded ? 'bg-amber-100' : cert.eligible ? 'bg-green-100' : 'bg-muted'
                    }`}>
                      {cert.awarded ? (
                        <Award className="h-5 w-5 text-amber-600" />
                      ) : cert.eligible ? (
                        <Star className="h-5 w-5 text-green-600" />
                      ) : (
                        <Lock className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{cert.name}</p>
                      {cert.awarded ? (
                        <p className="text-xs text-muted-foreground">Awarded</p>
                      ) : cert.eligible ? (
                        <Button 
                          size="sm" 
                          variant="outline" 
                          className="h-6 text-xs mt-1"
                          onClick={() => handleClaimCert(cert.name)}
                          disabled={claimingCert === cert.name}
                        >
                          {claimingCert === cert.name ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : 'Claim'}
                        </Button>
                      ) : (
                        <p className="text-xs text-muted-foreground">Locked</p>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          {/* CENTER COLUMN - Active Work Area */}
          <div className="lg:col-span-2 space-y-6">
            {/* Current Day Steps */}
            <Card>
              <CardHeader>
                <CardTitle>Day {initialData.onboarding.current_day} Tasks</CardTitle>
                <CardDescription>Complete these tasks to progress</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {(stepsByDay.get(initialData.onboarding.current_day) || [])
                  .sort((a, b) => a.step_order - b.step_order)
                  .map(step => {
                    const completion = completionMap.get(step.id)
                    const isCompleted = completion?.completed ?? false
                    const hasQuiz = typeof step.success_criteria?.quiz_key === 'string'

                    return (
                      <div
                        key={step.id}
                        className={`border rounded-lg p-4 ${isCompleted ? 'bg-muted/50 border-muted' : 'border-border'}`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className={`font-medium ${isCompleted ? 'text-muted-foreground' : ''}`}>
                                {step.step_name}
                              </h3>
                              {step.required && (
                                <Badge variant="destructive" className="text-xs">Required</Badge>
                              )}
                              {isCompleted && (
                                <Badge variant="secondary" className="text-xs bg-green-100 text-green-700">
                                  <Check className="h-3 w-3 mr-1" />Complete
                                </Badge>
                              )}
                              {hasQuiz && !isCompleted && (
                                <Badge variant="secondary" className="text-xs bg-purple-100 text-purple-700">
                                  Quiz
                                </Badge>
                              )}
                            </div>
                            {step.instructions && (
                              <p className="text-sm text-muted-foreground mt-1">{step.instructions}</p>
                            )}
                            {step.estimated_minutes && (
                              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                                <Clock className="h-3 w-3" /> {step.estimated_minutes} min
                              </p>
                            )}
                          </div>
                        </div>

                        {step.video_url && !isCompleted && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-3"
                            onClick={() => router.push(`/dashboard/onboarding/training/${step.id}`)}
                          >
                            <Play className="h-4 w-4 mr-2" />
                            Watch Video
                          </Button>
                        )}

                        {!isCompleted && hasQuiz && (
                          <OnboardingQuizClient
                            stepId={step.id}
                            onPassAndComplete={async () => {
                              await completeMyOnboardingStep(step.id)
                              mutateProgress()
                              router.refresh()
                            }}
                          />
                        )}

                        {!isCompleted && !hasQuiz && !step.video_url && (
                          <form
                            action={async () => {
                              await completeMyOnboardingStep(step.id)
                              mutateProgress()
                              router.refresh()
                            }}
                            className="mt-3"
                          >
                            <Button type="submit" size="sm">
                              <Check className="h-4 w-4 mr-2" />
                              Mark Complete
                            </Button>
                          </form>
                        )}
                      </div>
                    )
                  })}
              </CardContent>
            </Card>

            {/* Performance Report */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" />
                  Performance Report
                </CardTitle>
                <CardDescription>AI-generated insights on your progress</CardDescription>
              </CardHeader>
              <CardContent>
                {performanceReport ? (
                  <div className="space-y-4">
                    {/* Overall Score */}
                    <div className="flex items-center gap-4">
                      <div className="relative h-20 w-20">
                        <svg className="h-20 w-20 -rotate-90" viewBox="0 0 100 100">
                          <circle
                            cx="50"
                            cy="50"
                            r="40"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="8"
                            className="text-muted"
                          />
                          <circle
                            cx="50"
                            cy="50"
                            r="40"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="8"
                            strokeLinecap="round"
                            strokeDasharray={`${performanceReport.overallScore * 2.51} 251`}
                            className="text-primary"
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-xl font-bold">{performanceReport.overallScore}</span>
                        </div>
                      </div>
                      <div className="flex-1">
                        <p className="text-sm">{performanceReport.aiNarrative}</p>
                      </div>
                    </div>

                    {/* Strengths & Improvement Areas */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <h4 className="text-sm font-medium text-green-700 mb-2">Strengths</h4>
                        <ul className="space-y-1">
                          {performanceReport.strengths.map((s, i) => (
                            <li key={i} className="text-sm flex items-center gap-2">
                              <div className="h-1.5 w-1.5 rounded-full bg-green-500" />
                              {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h4 className="text-sm font-medium text-amber-700 mb-2">Areas to Improve</h4>
                        <ul className="space-y-1">
                          {performanceReport.improvementAreas.map((a, i) => (
                            <li key={i} className="text-sm flex items-center gap-2">
                              <div className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                              {a}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    {/* Top Recommendation */}
                    {performanceReport.recommendedActions[0] && (
                      <div className="bg-primary/10 rounded-lg p-4">
                        <h4 className="text-sm font-medium mb-1">Top Recommended Action</h4>
                        <p className="text-sm">{performanceReport.recommendedActions[0]}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <TrendingUp className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground mb-4">
                      Generate an AI-powered analysis of your onboarding progress
                    </p>
                    <Button onClick={handleGenerateReport} disabled={generatingReport}>
                      {generatingReport ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        'Generate My Performance Report'
                      )}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* RIGHT COLUMN - Achievements & Admin */}
          <div className="lg:col-span-1 space-y-4">
            {/* Earned Certifications */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Achievements</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-2">
                  {certifications.map(cert => (
                    <div 
                      key={cert.name}
                      className="flex flex-col items-center p-2"
                      title={cert.name}
                    >
                      <div className={`h-12 w-12 rounded-full flex items-center justify-center ${
                        cert.awarded ? 'bg-amber-100 ring-2 ring-amber-400' : 'bg-muted'
                      }`}>
                        <Award className={`h-6 w-6 ${cert.awarded ? 'text-amber-600' : 'text-muted-foreground'}`} />
                      </div>
                      <span className="text-xs text-center mt-1 line-clamp-2">
                        {cert.name.split(' ').slice(0, 2).join(' ')}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Practice Scores (placeholder for future) */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Quiz Scores</CardTitle>
              </CardHeader>
              <CardContent>
                {initialData.completions
                  .filter(c => c.quiz_score !== null)
                  .slice(0, 5)
                  .map((c, i) => {
                    const step = initialData.steps.find(s => s.id === c.step_id)
                    return (
                      <div key={i} className="flex items-center justify-between py-2 border-b last:border-0">
                        <span className="text-sm truncate flex-1">{step?.step_name || 'Quiz'}</span>
                        <Badge variant={c.quiz_score! >= 80 ? 'default' : 'secondary'}>
                          {c.quiz_score}%
                        </Badge>
                      </div>
                    )
                  })}
                {initialData.completions.filter(c => c.quiz_score !== null).length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No quiz scores yet
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Mentorship */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Mentorship
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Get paired with an experienced agent for guidance during your first 90 days.
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => router.push('/dashboard/onboarding/mentorship')}
                >
                  Find My Mentor
                </Button>
              </CardContent>
            </Card>

            {/* Admin Quick Stats */}
            {isAdmin && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Admin Overview
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => router.push('/dashboard/onboarding/admin/agents')}
                  >
                    View All Agents
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
