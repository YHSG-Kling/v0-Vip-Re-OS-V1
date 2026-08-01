'use server'

// app/actions/onboarding/progress.ts
// VIP Real Estate AI OS — Layer 11
// Server actions for Training Progress Tracker + Certification Engine

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { resolveAgentRecordToUserId } from "@/lib/kernel/agent-identity-resolver"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import {
  checkCertificationEligibility as checkCertEligibilityEngine,
  awardCertification as awardCertEngine,
  getCertificationStatus,
} from "@/lib/onboarding/certification-engine"

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
  steps?: Array<{
    id: string
    title: string
    type: string
    isRequired: boolean
  }>
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

interface AgentProgressData {
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

// ─── Get Agent Progress ──────────────────────────────────────────────────────

export async function getAgentProgress(
  agentId?: string,
  _brokerageId?: string  // ignored — derived from session user's brokerage
): Promise<{ success: boolean; data?: AgentProgressData; error?: string }> {
  const supabase = await createClient()

  // Require auth — caller-supplied brokerageId previously let any
  // signed-in user view any agent's onboarding progress + completion.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }
  const { data: callerProfile } = await supabase
    .from('users').select('brokerage_id, user_type').eq('id', user.id).maybeSingle()
  if (!callerProfile?.brokerage_id) return { success: false, error: 'No brokerage found' }

  const isAdmin = ['admin','broker','broker_owner','superadmin','super_admin']
    .includes(callerProfile.user_type ?? '')

  // Resolve target agent: default to self. If caller specifies someone
  // else, must be admin AND in same brokerage.
  // IDENTITY CLASS (m342). The two branches used to produce DIFFERENT classes
  // into the same variable: the self path resolves an AGENTS id, while the admin
  // path validated the caller-supplied id against `users` and kept it as a USERS
  // id. Everything downstream (agent_onboarding, agent_step_completions,
  // video_completion_tracking, agent_performance_reports) is agents-class, so
  // the ADMIN path silently returned an empty progress report — a broker looking
  // at one of their agents saw "nothing completed" rather than an error.
  // Both branches now end on an agents id.
  let targetAgentId = agentId
  if (!targetAgentId) {
    targetAgentId = await resolveAgentId(supabase, user.id) ?? undefined
  } else if (targetAgentId !== user.id) {
    if (!isAdmin) return { success: false, error: 'Forbidden' }
    const { data: tgt } = await supabase
      .from('users').select('brokerage_id').eq('id', targetAgentId).maybeSingle()
    if (!tgt || tgt.brokerage_id !== callerProfile.brokerage_id) {
      return { success: false, error: 'Forbidden' }
    }
    targetAgentId = await resolveAgentId(supabase, targetAgentId) ?? undefined
    if (!targetAgentId) return { success: false, error: 'That user has no agent profile yet' }
  } else {
    // Caller passed their OWN users id explicitly — same resolution as the
    // default path, not a third behaviour.
    targetAgentId = await resolveAgentId(supabase, user.id) ?? undefined
  }

  if (!targetAgentId) return { success: false, error: 'Agent profile not found' }

  const targetBrokerageId = callerProfile.brokerage_id

  // Get agent_onboarding record
  const { data: onboarding } = await supabase
    .from('agent_onboarding')
    .select('id, status, start_date, completion_percentage, certification_achieved, additional_data')
    .eq('agent_id', targetAgentId)
    .eq('brokerage_id', targetBrokerageId)
    .maybeSingle()

  // Get all required onboarding steps
  const { data: allSteps } = await supabase
    .from('onboarding_steps')
    .select('id, step_key, step_name, category, required')
    .or(`brokerage_id.is.null,brokerage_id.eq.${targetBrokerageId}`)
    .eq('required', true)
    .order('day_number', { ascending: true })
    .order('step_order', { ascending: true })

  // Get completed steps
  const { data: completedSteps } = await supabase
    .from('agent_step_completions')
    .select('step_id, completed_at, completed')
    .eq('agent_id', targetAgentId)
    .eq('completed', true)

  const completedMap = new Map((completedSteps || []).map(s => [s.step_id, s.completed_at]))

  // Group steps by category
  const categoryMap = new Map<string, CategoryProgress>()
  const categories = ['license', 'brand', 'tech_stack', 'training', 'certification']
  
  for (const cat of categories) {
    categoryMap.set(cat, {
      category: cat,
      completed: 0,
      total: 0,
      percentage: 0,
      steps: [],
    })
  }

  for (const step of allSteps || []) {
    const cat = step.category || 'general'
    if (!categoryMap.has(cat)) {
      categoryMap.set(cat, { category: cat, completed: 0, total: 0, percentage: 0, steps: [] })
    }
    const catData = categoryMap.get(cat)!
    catData.total++
    const isComplete = completedMap.has(step.id)
    if (isComplete) catData.completed++
    catData.steps.push({
      id: step.id,
      name: step.step_name || step.step_key,
      completed: isComplete,
      completedAt: completedMap.get(step.id),
    })
  }

  // Calculate category percentages
  for (const [, catData] of categoryMap) {
    catData.percentage = catData.total > 0 ? Math.round((catData.completed / catData.total) * 100) : 0
  }

  // Get training videos completion for training category
  const { data: requiredVideos } = await supabase
    .from('training_videos')
    .select('id, title')
    .or(`brokerage_id.is.null,brokerage_id.eq.${targetBrokerageId}`)
    .eq('is_required', true)

  if (requiredVideos && requiredVideos.length > 0) {
    const { data: videoProgress } = await supabase
      .from('video_completion_tracking')
      .select('training_video_id, completed')
      .eq('agent_id', targetAgentId)
      .in('training_video_id', requiredVideos.map(v => v.id))

    const videoCompletedSet = new Set(
      (videoProgress || []).filter(v => v.completed).map(v => v.training_video_id)
    )

    const trainingCat = categoryMap.get('training')!
    trainingCat.total += requiredVideos.length
    trainingCat.completed += videoCompletedSet.size
    trainingCat.percentage = trainingCat.total > 0 
      ? Math.round((trainingCat.completed / trainingCat.total) * 100) 
      : 0
  }

  // Courses = the agent's Academy coursework on the CANONICAL rail (learning_modules +
  // learning_assignments). The legacy training_courses/agent_courses spine had no
  // course-taking runtime (agent_courses was never written), so it always rendered the
  // same three seed courses as permanently "not started" — a duplicate of the
  // certifications list. This shows the agent's REAL assigned + completed modules.
  // learning_assignments.agent_user_id is a users.id. targetAgentId is now ALWAYS
  // an agents.id — m342 made both branches above agree, where they previously
  // produced different classes and this line compensated for the difference.
  // Compensating for an invariant that no longer holds would have been a fresh
  // bug, so this resolves the one class into the other explicitly.
  const targetUserId = (!agentId || agentId === user.id)
    ? user.id
    : (await resolveAgentRecordToUserId(targetAgentId)) ?? user.id
  const { data: courseAssignments } = await supabase
    .from('learning_assignments')
    .select('module_id, status, quiz_score, completed_at, learning_modules!inner(title, stage_tags, required, audience_roles)')
    .eq('agent_user_id', targetUserId)
    .not('module_id', 'is', null)

  const mapCourseStatus = (s: string | null): CourseProgress['status'] =>
    s === 'completed' ? 'passed' : s === 'in_progress' ? 'in_progress' : 'not_started'

  const courseProgress: CourseProgress[] = ((courseAssignments || []) as any[])
    // Agent-facing coursework only — never a customer-audience module.
    .filter(a => {
      const m = Array.isArray(a.learning_modules) ? a.learning_modules[0] : a.learning_modules
      const roles = m?.audience_roles ?? []
      return roles.length === 0 || !roles.includes('customer')
    })
    .map(a => {
      const m = Array.isArray(a.learning_modules) ? a.learning_modules[0] : a.learning_modules
      return {
        id: a.module_id as string,
        courseName: (m?.title as string) ?? 'Course',
        category: (m?.stage_tags?.[0] as string) ?? 'academy',
        status: mapCourseStatus(a.status),
        score: a.quiz_score ?? null,
        completedAt: a.completed_at ?? undefined,
        isRequired: (m?.required as boolean) ?? false,
        passingScore: 80,
      }
    })

  // Update certification category based on earned certs
  const certStatus = await getCertificationStatus(targetAgentId, targetBrokerageId)
  const certCat = categoryMap.get('certification')!
  certCat.total = certStatus.certifications.length
  certCat.completed = certStatus.certifications.filter(c => c.awarded).length
  certCat.percentage = certCat.total > 0 
    ? Math.round((certCat.completed / certCat.total) * 100) 
    : 0

  // Build certification cards with eligibility check
  const certCards: CertificationCard[] = []
  for (const cert of certStatus.certifications) {
    if (cert.awarded) {
      certCards.push({
        name: cert.name,
        awarded: true,
        issuedAt: cert.issuedAt,
        certId: cert.certId,
        certificateUrl: cert.certificateUrl,
      })
    } else {
      const eligibility = await checkCertEligibilityEngine(cert.name, targetAgentId, targetBrokerageId)
      certCards.push({
        name: cert.name,
        awarded: false,
        eligible: eligibility.eligible,
        missingRequirements: eligibility.missingRequirements,
      })
    }
  }

  // Calculate overall percentage (required steps only)
  const totalRequired = Array.from(categoryMap.values()).reduce((sum, cat) => sum + cat.total, 0)
  const completedRequired = Array.from(categoryMap.values()).reduce((sum, cat) => sum + cat.completed, 0)
  const overallPercentage = totalRequired > 0 ? Math.round((completedRequired / totalRequired) * 100) : 0

  // Check if celebration was dismissed
  const celebrationDismissed = (onboarding?.additional_data as any)?.celebration_dismissed === true

  return {
    success: true,
    data: {
      overallPercentage,
      completedRequired,
      totalRequired,
      categories: Array.from(categoryMap.values()).filter(c => categories.includes(c.category)),
      courses: courseProgress,
      certifications: certCards,
      onboardingStatus: onboarding?.status || 'not_started',
      startDate: onboarding?.start_date,
      certificationAchieved: onboarding?.certification_achieved || false,
      celebrationDismissed,
    },
  }
}

// ─── Check Certification Eligibility ─────────────────────────────────────────

export async function checkCertEligibility(
  certName: string,
  agentId?: string,
  brokerageId?: string
): Promise<{ success: boolean; eligible?: boolean; missing?: string[]; error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user && !agentId) {
    return { success: false, error: 'Not authenticated' }
  }

  const targetAgentId = agentId || (user ? await resolveAgentId(supabase, user.id) : null)
  if (!targetAgentId) {
    return { success: false, error: 'Agent profile not found' }
  }

  // IDENTITY CLASS (m342). targetAgentId is an AGENTS id (resolveAgentId returns
  // the agents PK), so reading `users` by it never matched and targetBrokerageId
  // fell back to whatever the caller supplied — or to undefined, which failed the
  // action. agents carries brokerage_id directly; no second class needed.
  const { data: userData } = await supabase
    .from('agents')
    .select('brokerage_id')
    .eq('id', targetAgentId)
    .maybeSingle()

  const targetBrokerageId = brokerageId || userData?.brokerage_id
  if (!targetBrokerageId) {
    return { success: false, error: 'No brokerage found' }
  }

  const result = await checkCertEligibilityEngine(certName, targetAgentId, targetBrokerageId)

  return {
    success: true,
    eligible: result.eligible,
    missing: result.missingRequirements,
  }
}

// ─── Claim Certification ─────────────────────────────────────────────────────

export async function claimCertification(
  certName: string,
  agentId?: string,
  brokerageId?: string
): Promise<{ success: boolean; certId?: string; error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user && !agentId) {
    return { success: false, error: 'Not authenticated' }
  }

  const targetAgentId = agentId || (user ? await resolveAgentId(supabase, user.id) : null)
  if (!targetAgentId) {
    return { success: false, error: 'Agent profile not found' }
  }

  // IDENTITY CLASS (m342). targetAgentId is an AGENTS id (resolveAgentId returns
  // the agents PK), so reading `users` by it never matched and targetBrokerageId
  // fell back to whatever the caller supplied — or to undefined, which failed the
  // action. agents carries brokerage_id directly; no second class needed.
  const { data: userData } = await supabase
    .from('agents')
    .select('brokerage_id')
    .eq('id', targetAgentId)
    .maybeSingle()

  const targetBrokerageId = brokerageId || userData?.brokerage_id
  if (!targetBrokerageId) {
    return { success: false, error: 'No brokerage found' }
  }

  const result = await awardCertEngine(certName, targetAgentId, targetBrokerageId, user?.id)

  return result
}

// ─── Generate Performance Report ─────────────────────────────────────────────

export async function generatePerformanceReport(
  agentId?: string,
  brokerageId?: string
): Promise<{
  success: boolean
  reportId?: string
  summary?: string
  recommendations?: string[]
  error?: string
}> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user && !agentId) {
    return { success: false, error: 'Not authenticated' }
  }

  const targetAgentId = agentId || (user ? await resolveAgentId(supabase, user.id) : null)
  if (!targetAgentId) {
    return { success: false, error: 'Agent profile not found' }
  }

  // IDENTITY CLASS (m342). targetAgentId is an AGENTS id (resolveAgentId returns
  // the agents PK), so reading `users` by it never matched and targetBrokerageId
  // fell back to whatever the caller supplied — or to undefined, which failed the
  // action. agents carries brokerage_id directly; no second class needed.
  const { data: userData } = await supabase
    .from('agents')
    .select('brokerage_id')
    .eq('id', targetAgentId)
    .maybeSingle()

  const targetBrokerageId = brokerageId || userData?.brokerage_id
  if (!targetBrokerageId) {
    return { success: false, error: 'No brokerage found' }
  }

  // Gather metrics
  const progressResult = await getAgentProgress(targetAgentId, targetBrokerageId)
  if (!progressResult.success || !progressResult.data) {
    return { success: false, error: 'Failed to gather progress data' }
  }

  const { data: onboarding } = await supabase
    .from('agent_onboarding')
    .select('start_date')
    .eq('agent_id', targetAgentId)
    .maybeSingle()

  const { data: videoProgress } = await supabase
    .from('video_completion_tracking')
    .select('training_video_id, percent_watched, completed')
    .eq('agent_id', targetAgentId)

  const avgVideoCompletion = videoProgress && videoProgress.length > 0
    ? Math.round(videoProgress.reduce((sum, v) => sum + (v.percent_watched || 0), 0) / videoProgress.length)
    : 0

  const { data: quizAttempts } = await supabase
    .from('agent_quiz_attempts')
    .select('score, passed')
    .eq('agent_id', targetAgentId)

  const avgQuizScore = quizAttempts && quizAttempts.length > 0
    ? Math.round(quizAttempts.reduce((sum, q) => sum + (q.score || 0), 0) / quizAttempts.length)
    : null

  // Calculate days in onboarding
  const daysInOnboarding = onboarding?.start_date
    ? Math.ceil((Date.now() - new Date(onboarding.start_date).getTime()) / (1000 * 60 * 60 * 24))
    : 0

  const metrics = {
    overallCompletion: progressResult.data.overallPercentage,
    completedSteps: progressResult.data.completedRequired,
    totalSteps: progressResult.data.totalRequired,
    daysInOnboarding,
    avgVideoCompletion,
    avgQuizScore,
    certificationsEarned: progressResult.data.certifications.filter(c => c.awarded).length,
    totalCertifications: progressResult.data.certifications.length,
    categories: progressResult.data.categories.map(c => ({
      name: c.category,
      percentage: c.percentage,
    })),
  }

  // Get brand voice for the brokerage
  const { data: brandVoice } = await supabase
    .from('brand_voice_profile')
    .select('tone, formality_level, key_brand_messages')
    .eq('brokerage_id', targetBrokerageId)
    .is('agent_id', null)
    .is('team_id', null)
    .maybeSingle()

  const toneGuidance = brandVoice?.tone 
    ? `Use a ${brandVoice.tone} tone.` 
    : 'Use a professional and encouraging tone.'

  // Generate AI coaching report
  const { text } = await generateText({
    model: 'anthropic/claude-opus-4',
    system: `You are a real estate brokerage training coach. ${toneGuidance} Be concise and actionable.`,
    prompt: `Based on this new agent's onboarding metrics: ${JSON.stringify(metrics, null, 2)}

Generate a coaching report with exactly these sections:
1. A 3-sentence performance summary
2. Top 3 specific recommendations for improvement
3. A predicted time to first transaction based on their completion pace (e.g., "2-3 weeks if current pace continues")

Format as JSON with keys: summary (string), recommendations (array of 3 strings), predictedTimeToTransaction (string).`,
  })

  let parsed: { summary: string; recommendations: string[]; predictedTimeToTransaction: string }
  try {
    // Extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { 
      summary: text, 
      recommendations: ['Continue your current progress'], 
      predictedTimeToTransaction: 'Unable to predict' 
    }
  } catch {
    parsed = { 
      summary: text.slice(0, 500), 
      recommendations: ['Continue your current progress', 'Complete remaining training videos', 'Focus on certification requirements'], 
      predictedTimeToTransaction: 'Based on current pace, expect 2-4 weeks' 
    }
  }

  const fullSummary = `${parsed.summary}\n\nPredicted time to first transaction: ${parsed.predictedTimeToTransaction}`

  // Save report to database
  const serviceClient = createServiceClient()
  const { data: report, error: insertError } = await serviceClient
    .from('agent_performance_reports')
    .insert({
      agent_id: targetAgentId,
      brokerage_id: targetBrokerageId,
      report_type: 'onboarding_coaching',
      period_start: onboarding?.start_date || new Date().toISOString(),
      period_end: new Date().toISOString(),
      metrics,
      ai_summary: fullSummary,
      recommendations: parsed.recommendations,
    })
    .select('id')
    .single()

  if (insertError) {
    console.error('[Progress] Error saving report:', insertError)
    return { success: false, error: 'Failed to save report' }
  }

  return {
    success: true,
    reportId: report.id,
    summary: fullSummary,
    recommendations: parsed.recommendations,
  }
}

// ─── Dismiss Celebration ─────────────────────────────────────────────────────

export async function dismissCelebration(): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: 'Not authenticated' }
  }

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) {
    return { success: false, error: 'No brokerage found' }
  }

  const agentId = await resolveAgentId(supabase, user.id)
  const { error } = await supabase
    .from('agent_onboarding')
    .update({
      additional_data: { celebration_dismissed: true },
      updated_at: new Date().toISOString(),
    })
    .eq('agent_id', agentId)
    .eq('brokerage_id', userData.brokerage_id)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── Retake Course ───────────────────────────────────────────────────────────

export async function retakeCourse(
  courseId: string  // a learning_modules.id on the canonical rail
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: 'Not authenticated' }
  }

  // Reset the agent's completion on the canonical rail so the module can be
  // retaken — RESET the learning_assignments row back to 'open', don't DELETE it.
  // Deleting made the course vanish from the progress dashboard entirely instead
  // of showing as retakeable; the dashboard reads the row's status, so the row
  // must survive. Clear the completion fields (completed_at, quiz_score, viewed_at,
  // dismissed_at). Scoped to the caller's own user id — an agent can only reset
  // their own coursework.
  const { error } = await supabase
    .from('learning_assignments')
    .update({
      status: 'open',
      completed_at: null,
      quiz_score: null,
      viewed_at: null,
      dismissed_at: null,
    })
    .eq('agent_user_id', user.id)
    .eq('module_id', courseId)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── Admin: Get Onboarding Overview ──────────────────────────────────────────

interface AgentOnboardingStatus {
  agentId: string
  agentName: string
  email: string
  status: string
  percentComplete: number
  daysSinceStart: number
  certsEarned: number
  lastActivityAt?: string
  isStalled: boolean
}

export async function getAdminOnboardingOverview(
  _brokerageId?: string  // ignored — always scoped to session brokerage (superadmin can use the superadmin/ APIs to cross-tenant)
): Promise<{
  success: boolean
  data?: {
    agents: AgentOnboardingStatus[]
    completedThisMonth: number
    stalledCount: number
    avgDaysToComplete: number
  }
  error?: string
}> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: 'Not authenticated' }
  }

  // Get user's brokerage and role
  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) {
    return { success: false, error: 'No brokerage found' }
  }

  if (!['admin', 'broker', 'broker_owner', 'superadmin', 'super_admin'].includes(userData.user_type || '')) {
    return { success: false, error: 'Unauthorized' }
  }

  // Always use session brokerage. Caller-supplied brokerageId previously
  // let admins from brokerage A query brokerage B's onboarding data.
  const targetBrokerageId = userData.brokerage_id

  // Get all agent onboarding records
  const { data: onboardings } = await supabase
    .from('agent_onboarding')
    .select(`
      id,
      agent_id,
      status,
      completion_percentage,
      start_date,
      certified_at,
      updated_at
    `)
    .eq('brokerage_id', targetBrokerageId)

  if (!onboardings || onboardings.length === 0) {
    return {
      success: true,
      data: {
        agents: [],
        completedThisMonth: 0,
        stalledCount: 0,
        avgDaysToComplete: 0,
      },
    }
  }

  // Get agent details
  const agentIds = onboardings.map(o => o.agent_id)
  const { data: agents } = await supabase
    .from('users')
    .select('id, first_name, last_name, email')
    .in('id', agentIds)

  const agentMap = new Map((agents || []).map(a => [a.id, a]))

  // Get certification counts
  const { data: certs } = await supabase
    .from('agent_certifications')
    .select('agent_id')
    .in('agent_id', agentIds)
    .eq('cert_type', 'onboarding')

  const certCounts = new Map<string, number>()
  for (const cert of certs || []) {
    certCounts.set(cert.agent_id, (certCounts.get(cert.agent_id) || 0) + 1)
  }

  // Build agent status list
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const agentStatuses: AgentOnboardingStatus[] = onboardings.map(o => {
    const agent = agentMap.get(o.agent_id)
    const daysSinceStart = o.start_date
      ? Math.ceil((now.getTime() - new Date(o.start_date).getTime()) / (1000 * 60 * 60 * 24))
      : 0

    const lastActivity = o.updated_at ? new Date(o.updated_at) : null
    const isStalled = o.status !== 'completed' && lastActivity && lastActivity < sevenDaysAgo

    return {
      agentId: o.agent_id,
      agentName: agent ? `${agent.first_name || ''} ${agent.last_name || ''}`.trim() || 'Unknown' : 'Unknown',
      email: agent?.email || '',
      status: o.status || 'not_started',
      percentComplete: o.completion_percentage || 0,
      daysSinceStart,
      certsEarned: certCounts.get(o.agent_id) || 0,
      lastActivityAt: o.updated_at,
      isStalled: !!isStalled,
    }
  })

  // Calculate stats
  const completedThisMonth = onboardings.filter(
    o => o.status === 'completed' && o.certified_at && new Date(o.certified_at) >= thisMonthStart
  ).length

  const stalledCount = agentStatuses.filter(a => a.isStalled).length

  const completedOnboardings = onboardings.filter(o => o.status === 'completed' && o.start_date && o.certified_at)
  const avgDaysToComplete = completedOnboardings.length > 0
    ? Math.round(
        completedOnboardings.reduce((sum, o) => {
          const days = Math.ceil(
            (new Date(o.certified_at!).getTime() - new Date(o.start_date!).getTime()) / (1000 * 60 * 60 * 24)
          )
          return sum + days
        }, 0) / completedOnboardings.length
      )
    : 0

  return {
    success: true,
    data: {
      agents: agentStatuses,
      completedThisMonth,
      stalledCount,
      avgDaysToComplete,
    },
  }
}

// ─── Admin: Send Reminder ────────────────────────────────────────────────────

export async function sendOnboardingReminder(
  agentId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: 'Not authenticated' }
  }

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .single()

  if (!['admin', 'broker', 'broker_owner', 'superadmin', 'super_admin'].includes(userData?.user_type || '')) {
    return { success: false, error: 'Unauthorized' }
  }

  // Verify the agent is in the caller's brokerage — previously any
  // admin could send "reminder" notifications to any user across tenants.
  const { data: targetUser } = await supabase
    .from('users').select('brokerage_id').eq('id', agentId).maybeSingle()
  if (!targetUser || targetUser.brokerage_id !== userData!.brokerage_id) {
    return { success: false, error: 'Forbidden: agent not in your brokerage' }
  }

  // Create notification for the agent
  const { error } = await supabase.from('notifications').insert({
    user_id: agentId,
    brokerage_id: userData!.brokerage_id,
    type: 'onboarding_reminder',
    entity_type: 'agent_onboarding',
    entity_id: agentId,
    title: 'Onboarding Reminder',
    body: 'Your brokerage admin has sent you a reminder to complete your onboarding. Please continue your training to get certified.',
    is_read: false,
  })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}
