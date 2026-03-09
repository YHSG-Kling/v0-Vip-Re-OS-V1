'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Loader2, Lock, Award, Download, RefreshCw, ChevronRight, CheckCircle2, Circle, AlertCircle, Sparkles } from 'lucide-react'
import {
  getAgentProgress,
  checkCertEligibility,
  claimCertification,
  generatePerformanceReport,
  dismissCelebration,
  retakeCourse,
} from '@/app/actions/onboarding/progress'
import confetti from 'canvas-confetti'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CategoryProgress {
  category: string
  completed: number
  total: number
  percentage: number
  steps: Array<{
    id: string
    name: string
    completed: boolean
    completedAt?: string
  }>
}

interface CourseProgress {
  id: string
  courseName: string
  category: string
  status: 'not_started' | 'in_progress' | 'passed' | 'failed'
  score: number | null
  completedAt?: string
  isRequired: boolean
  passingScore: number
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

interface ProgressData {
  overallPercentage: number
  completedRequired: number
  totalRequired: number
  categories: CategoryProgress[]
  courses: CourseProgress[]
  certifications: CertificationCard[]
  onboardingStatus: string
  startDate?: string
  certificationAchieved: boolean
  celebrationDismissed: boolean
}

// ─── Progress Ring Component ─────────────────────────────────────────────────

function ProgressRing({
  percentage,
  size = 120,
  strokeWidth = 8,
  color = 'stroke-primary',
  label,
  onClick,
  animated = false,
}: {
  percentage: number
  size?: number
  strokeWidth?: number
  color?: string
  label?: string
  onClick?: () => void
  animated?: boolean
}) {
  const [displayPercent, setDisplayPercent] = useState(animated ? 0 : percentage)
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const offset = circumference - (displayPercent / 100) * circumference

  useEffect(() => {
    if (animated) {
      const timer = setTimeout(() => {
        const interval = setInterval(() => {
          setDisplayPercent(prev => {
            if (prev >= percentage) {
              clearInterval(interval)
              return percentage
            }
            return Math.min(prev + 1, percentage)
          })
        }, 15)
        return () => clearInterval(interval)
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [animated, percentage])

  const ringColor = percentage === 100
    ? 'stroke-emerald-500'
    : percentage > 0
    ? 'stroke-blue-500'
    : 'stroke-muted'

  return (
    <div
      className={`flex flex-col items-center gap-2 ${onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
      onClick={onClick}
    >
      <div className="relative">
        <svg width={size} height={size} className="-rotate-90">
          <circle
            className="stroke-muted"
            strokeWidth={strokeWidth}
            fill="transparent"
            r={radius}
            cx={size / 2}
            cy={size / 2}
          />
          <circle
            className={`${color || ringColor} transition-all duration-1000 ease-out`}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            fill="transparent"
            r={radius}
            cx={size / 2}
            cy={size / 2}
            style={{
              strokeDasharray: circumference,
              strokeDashoffset: offset,
            }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold">{Math.round(displayPercent)}%</span>
        </div>
      </div>
      {label && <span className="text-sm text-muted-foreground capitalize">{label}</span>}
    </div>
  )
}

// ─── Celebration Modal ───────────────────────────────────────────────────────

function CelebrationModal({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    // Fire confetti
    const duration = 3000
    const end = Date.now() + duration

    const frame = () => {
      confetti({
        particleCount: 3,
        angle: 60,
        spread: 55,
        origin: { x: 0 },
        colors: ['#10b981', '#3b82f6', '#8b5cf6'],
      })
      confetti({
        particleCount: 3,
        angle: 120,
        spread: 55,
        origin: { x: 1 },
        colors: ['#10b981', '#3b82f6', '#8b5cf6'],
      })

      if (Date.now() < end) {
        requestAnimationFrame(frame)
      }
    }

    frame()
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-md mx-4 text-center">
        <CardHeader>
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
            <Award className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
          </div>
          <CardTitle className="text-2xl">Onboarding Complete!</CardTitle>
          <CardDescription className="text-lg">
            You are ready to start closing deals.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onDismiss} className="w-full" size="lg">
            Go to Dashboard
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ProgressDashboardClient({
  initialData,
  agentName,
}: {
  initialData: ProgressData | null
  agentName: string
}) {
  const router = useRouter()
  const [data, setData] = useState<ProgressData | null>(initialData)
  const [loading, setLoading] = useState(false)
  const [claimingCert, setClaimingCert] = useState<string | null>(null)
  const [checkingEligibility, setCheckingEligibility] = useState<string | null>(null)
  const [generatingReport, setGeneratingReport] = useState(false)
  const [report, setReport] = useState<{ summary: string; recommendations: string[] } | null>(null)
  const [showCelebration, setShowCelebration] = useState(false)
  const [retakingCourse, setRetakingCourse] = useState<string | null>(null)

  const categorySectionRef = useRef<HTMLDivElement>(null)

  // Check for celebration
  useEffect(() => {
    if (data?.onboardingStatus === 'completed' && data?.certificationAchieved && !data?.celebrationDismissed) {
      setShowCelebration(true)
    }
  }, [data])

  const refreshData = useCallback(async () => {
    setLoading(true)
    const result = await getAgentProgress()
    if (result.success && result.data) {
      setData(result.data)
    }
    setLoading(false)
  }, [])

  const handleCategoryClick = (category: string) => {
    // Scroll to the category section
    const element = document.getElementById(`category-${category}`)
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleCheckEligibility = async (certName: string) => {
    setCheckingEligibility(certName)
    await checkCertEligibility(certName)
    await refreshData()
    setCheckingEligibility(null)
  }

  const handleClaimCert = async (certName: string) => {
    setClaimingCert(certName)
    const result = await claimCertification(certName)
    if (result.success) {
      await refreshData()
    }
    setClaimingCert(null)
  }

  const handleGenerateReport = async () => {
    setGeneratingReport(true)
    const result = await generatePerformanceReport()
    if (result.success) {
      setReport({
        summary: result.summary || '',
        recommendations: result.recommendations || [],
      })
    }
    setGeneratingReport(false)
  }

  const handleDismissCelebration = async () => {
    await dismissCelebration()
    setShowCelebration(false)
    router.push('/dashboard')
  }

  const handleRetakeCourse = async (courseId: string) => {
    setRetakingCourse(courseId)
    const result = await retakeCourse(courseId)
    if (result.success) {
      await refreshData()
    }
    setRetakingCourse(null)
  }

  const getCategoryLabel = (cat: string) => {
    const labels: Record<string, string> = {
      license: 'License',
      brand: 'Brand',
      tech_stack: 'Tech Stack',
      training: 'Training',
      certification: 'Certification',
    }
    return labels[cat] || cat
  }

  const getStatusIcon = (completed: boolean, inProgress?: boolean) => {
    if (completed) return <CheckCircle2 className="h-5 w-5 text-emerald-500" />
    if (inProgress) return <Circle className="h-5 w-5 text-blue-500 fill-blue-500/20" />
    return <Circle className="h-5 w-5 text-muted-foreground" />
  }

  const getCourseStatusBadge = (status: string) => {
    switch (status) {
      case 'passed':
        return <Badge variant="default" className="bg-emerald-500">Passed</Badge>
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>
      case 'in_progress':
        return <Badge variant="secondary">In Progress</Badge>
      default:
        return <Badge variant="outline">Not Started</Badge>
    }
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="container max-w-5xl py-8 space-y-8">
      {showCelebration && <CelebrationModal onDismiss={handleDismissCelebration} />}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Training Progress</h1>
          <p className="text-muted-foreground">Welcome back, {agentName}</p>
        </div>
        <Button variant="outline" size="sm" onClick={refreshData} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="ml-2 hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {/* Section 1: Overall Completion Ring */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-4">
            <ProgressRing
              percentage={data.overallPercentage}
              size={180}
              strokeWidth={12}
              animated
            />
            <div className="text-center">
              <p className="text-lg font-medium">Onboarding Complete</p>
              <p className="text-sm text-muted-foreground">
                {data.completedRequired} of {data.totalRequired} required steps complete
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: Category Progress Rings */}
      <Card>
        <CardHeader>
          <CardTitle>Progress by Category</CardTitle>
          <CardDescription>Click a ring to jump to that section</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap justify-center gap-6 sm:gap-8">
            {data.categories.map((cat) => (
              <ProgressRing
                key={cat.category}
                percentage={cat.percentage}
                size={80}
                strokeWidth={6}
                label={getCategoryLabel(cat.category)}
                onClick={() => handleCategoryClick(cat.category)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Section 3: Required Steps Checklist */}
      <Card ref={categorySectionRef}>
        <CardHeader>
          <CardTitle>Required Steps</CardTitle>
          <CardDescription>Complete all required steps to earn your certifications</CardDescription>
        </CardHeader>
        <CardContent>
          <Accordion type="multiple" className="w-full">
            {data.categories.map((cat) => (
              <AccordionItem key={cat.category} value={cat.category} id={`category-${cat.category}`}>
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{getCategoryLabel(cat.category)}</span>
                    <Badge variant={cat.percentage === 100 ? 'default' : 'secondary'}>
                      {cat.completed}/{cat.total}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-2 pt-2">
                    {cat.steps.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No steps in this category</p>
                    ) : (
                      cat.steps.map((step) => (
                        <div
                          key={step.id}
                          className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50"
                        >
                          <div className="flex items-center gap-3">
                            {getStatusIcon(step.completed)}
                            <span className={step.completed ? 'text-muted-foreground' : ''}>
                              {step.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {step.completedAt && (
                              <span className="text-xs text-muted-foreground">
                                {new Date(step.completedAt).toLocaleDateString()}
                              </span>
                            )}
                            {!step.completed && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => router.push(`/dashboard/onboarding/${cat.category}`)}
                              >
                                Resume <ChevronRight className="h-4 w-4 ml-1" />
                              </Button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>

      {/* Section 4: Course Progress */}
      <Card>
        <CardHeader>
          <CardTitle>Course Progress</CardTitle>
          <CardDescription>Complete required courses to qualify for certifications</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Course Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.courses.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No courses available
                  </TableCell>
                </TableRow>
              ) : (
                data.courses
                  .sort((a, b) => (a.isRequired === b.isRequired ? 0 : a.isRequired ? -1 : 1))
                  .map((course) => (
                    <TableRow key={course.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {course.courseName}
                          {course.isRequired && (
                            <Badge variant="outline" className="text-xs">Required</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="capitalize">{course.category.replace('_', ' ')}</TableCell>
                      <TableCell>{getCourseStatusBadge(course.status)}</TableCell>
                      <TableCell>
                        {course.score !== null ? `${course.score}%` : '-'}
                      </TableCell>
                      <TableCell>
                        {course.completedAt
                          ? new Date(course.completedAt).toLocaleDateString()
                          : '-'}
                      </TableCell>
                      <TableCell>
                        {course.status === 'failed' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRetakeCourse(course.id)}
                            disabled={retakingCourse === course.id}
                          >
                            {retakingCourse === course.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              'Retake'
                            )}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Section 5: Certifications */}
      <Card>
        <CardHeader>
          <CardTitle>Certifications</CardTitle>
          <CardDescription>Earn all required certifications to complete onboarding</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.certifications.map((cert) => (
              <Card
                key={cert.name}
                className={`relative overflow-hidden ${
                  cert.awarded
                    ? 'border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20'
                    : ''
                }`}
              >
                <CardContent className="pt-6">
                  <div className="flex flex-col items-center text-center gap-3">
                    <div
                      className={`flex h-12 w-12 items-center justify-center rounded-full ${
                        cert.awarded
                          ? 'bg-amber-100 dark:bg-amber-900'
                          : 'bg-muted'
                      }`}
                    >
                      {cert.awarded ? (
                        <Award className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                      ) : (
                        <Lock className="h-6 w-6 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <h4 className="font-semibold">{cert.name}</h4>
                      {cert.awarded && cert.issuedAt && (
                        <p className="text-xs text-muted-foreground">
                          Issued {new Date(cert.issuedAt).toLocaleDateString()}
                        </p>
                      )}
                    </div>

                    {cert.awarded ? (
                      <Button variant="outline" size="sm" asChild>
                        <a href={cert.certificateUrl} target="_blank" rel="noopener noreferrer">
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </a>
                      </Button>
                    ) : cert.eligible ? (
                      <Button
                        size="sm"
                        onClick={() => handleClaimCert(cert.name)}
                        disabled={claimingCert === cert.name}
                      >
                        {claimingCert === cert.name ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                          <Award className="h-4 w-4 mr-2" />
                        )}
                        Claim Certificate
                      </Button>
                    ) : (
                      <div className="space-y-2 w-full">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => handleCheckEligibility(cert.name)}
                          disabled={checkingEligibility === cert.name}
                        >
                          {checkingEligibility === cert.name ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            'Check Eligibility'
                          )}
                        </Button>
                        {cert.missingRequirements && cert.missingRequirements.length > 0 && (
                          <div className="text-xs text-muted-foreground text-left">
                            <p className="font-medium flex items-center gap-1">
                              <AlertCircle className="h-3 w-3" />
                              Missing:
                            </p>
                            <ul className="list-disc list-inside ml-1">
                              {cert.missingRequirements.slice(0, 3).map((req, i) => (
                                <li key={i} className="truncate">{req}</li>
                              ))}
                              {cert.missingRequirements.length > 3 && (
                                <li>...and {cert.missingRequirements.length - 3} more</li>
                              )}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Section 6: AI Coaching Report */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            AI Coaching Report
          </CardTitle>
          <CardDescription>
            Get personalized recommendations based on your progress
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            onClick={handleGenerateReport}
            disabled={generatingReport}
          >
            {generatingReport ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-2" />
                Generate My Performance Report
              </>
            )}
          </Button>

          {report && (
            <Card className="bg-muted/50">
              <CardContent className="pt-6 space-y-4">
                <div>
                  <h4 className="font-semibold mb-2">Performance Summary</h4>
                  <p className="text-sm text-muted-foreground whitespace-pre-line">
                    {report.summary}
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold mb-2">Recommendations</h4>
                  <ul className="space-y-2">
                    {report.recommendations.map((rec, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
                          {i + 1}
                        </span>
                        {rec}
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="text-xs text-muted-foreground italic">
                  This report is a draft and has not been shared with your brokerage.
                </p>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
