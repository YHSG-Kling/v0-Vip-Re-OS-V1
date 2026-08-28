// app/dashboard/onboarding/admin/agents/[agentId]/page.tsx
// VIP Real Estate AI OS — Layer 11
// Admin view of a specific agent's onboarding progress
// Access: admin, broker, superadmin only

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getAgentOnboardingDashboard } from '@/lib/kernel/agent-onboarding'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { resolveUserIdForAgentRecord } from "@/lib/kernel/agent-identity"
import { 
  ArrowLeft,
  Check,
  Lock,
  Clock,
  Award,
  Mail,
  Calendar,
  AlertTriangle,
} from 'lucide-react'
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { WelcomeMessageCard } from "./welcome-message-card"

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function AdminAgentDetailPage({ params }: PageProps) {
  const { id: agentId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Get user details and verify admin access
  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect('/dashboard')
  }

  if (!isAdminOrBroker({ user_type: userData.user_type || '' })) {
    redirect('/dashboard/onboarding')
  }

  // IDENTITY CLASS. The roster links here with agent_onboarding.agent_id
  // (see lib/onboarding/onboarding-roster.ts), which FKs agents(id). Both
  // lookups below read the `users` table, so they matched nothing and the
  // `notFound()` beneath them fired for EVERY agent — this page was
  // unreachable from the only place that links to it. The agents-class
  // queries further down (agent_step_completions) were always correct, so the
  // id itself is right; only these two reads need resolving.
  const agentUserId = await resolveUserIdForAgentRecord(supabase, agentId)
  if (!agentUserId) {
    notFound()
  }

  // Get agent details
  const { data: agentUser } = await supabase
    .from('users')
    .select('id, first_name, last_name, email, created_at')
    .eq('id', agentUserId)
    .single()

  if (!agentUser) {
    notFound()
  }

  // Verify agent belongs to same brokerage
  const { data: agentUserBrokerage } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', agentUserId)
    .eq('brokerage_id', userData.brokerage_id)
    .single()

  if (!agentUserBrokerage) {
    notFound()
  }

  // Get onboarding dashboard data
  let dashboard
  try {
    dashboard = await getAgentOnboardingDashboard({
      userId: user.id, // Admin user ID for access check
      agentId,
    })
  } catch (error) {
    console.error('[AdminAgentDetail] Failed to load dashboard:', error)
    return (
      <div className="p-6">
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
          <p className="text-destructive">Failed to load onboarding data for this agent.</p>
        </div>
      </div>
    )
  }

  // Get certifications
  const { data: certifications } = await supabase
    .from('agent_certifications')
    .select('id, certification_name, issued_at')
    .eq('agent_id', agentId)
    .eq('cert_type', 'onboarding')

  // Get latest activity
  const { data: latestCompletion } = await supabase
    .from('agent_step_completions')
    .select('completed_at')
    .eq('agent_id', agentId)
    .eq('completed', true)
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const lastActivity = latestCompletion?.completed_at
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const isStalled = dashboard.onboarding.status === 'in_progress' && (
    !lastActivity || new Date(lastActivity) < sevenDaysAgo
  )

  // Group steps by day
  const stepsByDay = new Map<number, typeof dashboard.steps>()
  dashboard.steps.forEach(step => {
    if (!stepsByDay.has(step.day_number)) {
      stepsByDay.set(step.day_number, [])
    }
    stepsByDay.get(step.day_number)!.push(step)
  })

  const completionMap = new Map(
    dashboard.completions.map(c => [c.step_id, c])
  )

  const agentName = `${agentUser.first_name || ''} ${agentUser.last_name || ''}`.trim() || 'Unknown Agent'

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'N/A'
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="container mx-auto p-6">
        {/* Header */}
        <div className="mb-6">
          <Link href="/dashboard/onboarding/admin/agents">
            <Button variant="ghost" className="mb-4">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to All Agents
            </Button>
          </Link>

          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-bold">{agentName}</h1>
                {isStalled && (
                  <Badge variant="destructive" className="flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Stalled
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-4 mt-2 text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Mail className="h-4 w-4" />
                  {agentUser.email}
                </span>
                <span className="flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  Joined {formatDate(agentUser.created_at)}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Progress Overview */}
          <Card>
            <CardHeader>
              <CardTitle>Progress Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col items-center">
                <div className="relative h-32 w-32 mb-4">
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
                      strokeDasharray={`${dashboard.onboarding.completion_percentage * 2.83} 283`}
                      className="text-primary"
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-3xl font-bold">
                      {dashboard.onboarding.completion_percentage}%
                    </span>
                  </div>
                </div>
                <Badge 
                  variant={dashboard.onboarding.status === 'completed' ? 'default' : 'secondary'}
                  className="mb-2"
                >
                  {dashboard.onboarding.status === 'completed' ? 'Completed' : 
                   dashboard.onboarding.status === 'paused' ? 'Paused' : 'In Progress'}
                </Badge>
                <p className="text-sm text-muted-foreground">
                  Day {dashboard.onboarding.current_day} of 7
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  Started {formatDate(dashboard.onboarding.start_date)}
                </p>
                {lastActivity && (
                  <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Last active {formatDate(lastActivity)}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Certifications */}
          <Card>
            <CardHeader>
              <CardTitle>Certifications</CardTitle>
              <CardDescription>{certifications?.length || 0} of 3 earned</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {['Platform Fundamentals', 'Compliance Basics', 'Lead Management Essentials'].map(certName => {
                  const cert = certifications?.find(c => c.certification_name === certName)
                  return (
                    <div key={certName} className="flex items-center gap-3">
                      <div className={`h-10 w-10 rounded-full flex items-center justify-center ${
                        cert ? 'bg-amber-100' : 'bg-muted'
                      }`}>
                        {cert ? (
                          <Award className="h-5 w-5 text-amber-600" />
                        ) : (
                          <Lock className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium">{certName}</p>
                        {cert ? (
                          <p className="text-xs text-muted-foreground">
                            Awarded {formatDate(cert.issued_at)}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">Not earned</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Quick Stats */}
          <Card>
            <CardHeader>
              <CardTitle>Quick Stats</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Steps Completed</span>
                  <span className="font-medium">
                    {dashboard.completions.filter(c => c.completed).length} / {dashboard.steps.length}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Required Completed</span>
                  <span className="font-medium">
                    {dashboard.completions.filter(c => {
                      const step = dashboard.steps.find(s => s.id === c.step_id)
                      return c.completed && step?.required
                    }).length} / {dashboard.steps.filter(s => s.required).length}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Quizzes Taken</span>
                  <span className="font-medium">
                    {dashboard.completions.filter(c => c.quiz_score !== null).length}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Avg Quiz Score</span>
                  <span className="font-medium">
                    {(() => {
                      const scores = dashboard.completions
                        .filter(c => c.quiz_score !== null)
                        .map(c => c.quiz_score!)
                      return scores.length > 0
                        ? `${Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}%`
                        : 'N/A'
                    })()}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* AI welcome message — generate-and-review, never auto-sent. The door
            for app/actions/ai-agent-onboarding.ts:generateWelcomeMessage. */}
        <div className="mt-6">
          <WelcomeMessageCard agentId={agentId} agentName={agentName} />
        </div>

        {/* Steps by Day */}
        <div className="mt-6 space-y-4">
          <h2 className="text-xl font-semibold">Detailed Progress</h2>
          
          {Array.from(stepsByDay.entries())
            .sort(([a], [b]) => a - b)
            .map(([day, steps]) => {
              const dayCompleted = steps.every(s => completionMap.get(s.id)?.completed)

              return (
                <Card key={day}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg flex items-center gap-2">
                        Day {day}
                        {dayCompleted && (
                          <Badge className="bg-green-100 text-green-700">
                            <Check className="h-3 w-3 mr-1" />
                            Complete
                          </Badge>
                        )}
                      </CardTitle>
                      <span className="text-sm text-muted-foreground">
                        {steps.filter(s => completionMap.get(s.id)?.completed).length} / {steps.length} steps
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {steps.sort((a, b) => a.step_order - b.step_order).map(step => {
                        const completion = completionMap.get(step.id)
                        const isCompleted = completion?.completed ?? false

                        return (
                          <div 
                            key={step.id} 
                            className={`flex items-center justify-between p-3 rounded-lg ${
                              isCompleted ? 'bg-green-50' : 'bg-muted/50'
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              {isCompleted ? (
                                <div className="h-6 w-6 rounded-full bg-green-100 flex items-center justify-center">
                                  <Check className="h-4 w-4 text-green-600" />
                                </div>
                              ) : (
                                <div className="h-6 w-6 rounded-full border-2 border-muted-foreground/30" />
                              )}
                              <div>
                                <p className={`text-sm font-medium ${isCompleted ? 'text-muted-foreground' : ''}`}>
                                  {step.step_name}
                                </p>
                                <div className="flex items-center gap-2">
                                  {step.required && (
                                    <Badge variant="outline" className="text-xs">Required</Badge>
                                  )}
                                  {step.estimated_minutes && (
                                    <span className="text-xs text-muted-foreground">
                                      {step.estimated_minutes} min
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                            {isCompleted && completion?.completed_at && (
                              <span className="text-xs text-muted-foreground">
                                {formatDate(completion.completed_at)}
                              </span>
                            )}
                            {isCompleted && completion?.quiz_score != null && (
                              <Badge variant="outline">
                                Quiz: {completion?.quiz_score}%
                              </Badge>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
        </div>
      </div>
    </div>
  )
}
