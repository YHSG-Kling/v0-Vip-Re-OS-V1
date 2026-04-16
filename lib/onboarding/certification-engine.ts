// lib/onboarding/certification-engine.ts
// VIP Real Estate AI OS — Layer 11
// Certification Engine for Training Progress Tracker
//
// This module handles certification eligibility checks, awarding certifications,
// and completing onboarding when all required certifications are earned.

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import type { EntityType } from "@/lib/kernel/types"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CertificationEligibilityResult {
  eligible: boolean
  missingRequirements: string[]
}

export interface AwardCertificationResult {
  success: boolean
  certId?: string
  error?: string
}

// ─── Required Onboarding Certifications ──────────────────────────────────────

const REQUIRED_ONBOARDING_CERTS = [
  'Platform Fundamentals',
  'Compliance Basics',
  'Lead Management Essentials',
]

// ─── Certification Eligibility Checks ────────────────────────────────────────

export async function checkCertificationEligibility(
  certName: string,
  agentId: string,
  brokerageId: string
): Promise<CertificationEligibilityResult> {
  const supabase = createServiceClient()
  const missingRequirements: string[] = []

  // Check if already awarded
  const { data: existingCert } = await supabase
    .from('agent_certifications')
    .select('id')
    .eq('agent_id', agentId)
    .eq('certification_name', certName)
    .maybeSingle()

  if (existingCert) {
    return { eligible: false, missingRequirements: ['Certification already awarded'] }
  }

  switch (certName) {
    case 'Platform Fundamentals':
      return checkPlatformFundamentalsEligibility(agentId, brokerageId, supabase, missingRequirements)

    case 'Compliance Basics':
      return checkComplianceBasicsEligibility(agentId, brokerageId, supabase, missingRequirements)

    case 'Lead Management Essentials':
      return checkLeadManagementEligibility(agentId, brokerageId, supabase, missingRequirements)

    default:
      return { eligible: false, missingRequirements: [`Unknown certification: ${certName}`] }
  }
}

async function checkPlatformFundamentalsEligibility(
  agentId: string,
  brokerageId: string,
  supabase: ReturnType<typeof createServiceClient>,
  missingRequirements: string[]
): Promise<CertificationEligibilityResult> {
  // Requirement 1: All onboarding steps in 'platform_tour' category completed
  const { data: platformTourSteps } = await supabase
    .from('onboarding_steps')
    .select('id, step_key, step_name')
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .eq('category', 'platform_tour')
    .eq('required', true)

  if (platformTourSteps && platformTourSteps.length > 0) {
    const { data: completedSteps } = await supabase
      .from('agent_step_completions')
      .select('step_id')
      .eq('agent_id', agentId)
      .eq('completed', true)

    const completedIds = new Set((completedSteps || []).map(s => s.step_id))
    
    for (const step of platformTourSteps) {
      if (!completedIds.has(step.id)) {
        missingRequirements.push(`Complete step: ${step.step_name || step.step_key}`)
      }
    }
  }

  // Requirement 2: All required platform_tour training videos watched >= 90%
  const { data: platformVideos } = await supabase
    .from('training_videos')
    .select('id, title')
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .eq('category', 'platform_tour')
    .eq('is_required', true)

  if (platformVideos && platformVideos.length > 0) {
    const { data: videoProgress } = await supabase
      .from('video_completion_tracking')
      .select('training_video_id, percent_watched')
      .eq('agent_id', agentId)
      .in('training_video_id', platformVideos.map(v => v.id))

    const progressMap = new Map((videoProgress || []).map(v => [v.training_video_id, v.percent_watched]))

    for (const video of platformVideos) {
      const progress = progressMap.get(video.id) || 0
      if (progress < 90) {
        missingRequirements.push(`Watch video: ${video.title} (${Math.round(progress)}% complete, 90% required)`)
      }
    }
  }

  return {
    eligible: missingRequirements.length === 0,
    missingRequirements,
  }
}

async function checkComplianceBasicsEligibility(
  agentId: string,
  brokerageId: string,
  supabase: ReturnType<typeof createServiceClient>,
  missingRequirements: string[]
): Promise<CertificationEligibilityResult> {
  // Requirement 1: fair_housing_ack and tcpa_ack steps completed
  const requiredComplianceSteps = ['fair_housing_ack', 'tcpa_ack']
  
  const { data: complianceSteps } = await supabase
    .from('onboarding_steps')
    .select('id, step_key, step_name')
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .in('step_key', requiredComplianceSteps)

  if (complianceSteps && complianceSteps.length > 0) {
    const { data: completedSteps } = await supabase
      .from('agent_step_completions')
      .select('step_id')
      .eq('agent_id', agentId)
      .eq('completed', true)
      .in('step_id', complianceSteps.map(s => s.id))

    const completedIds = new Set((completedSteps || []).map(s => s.step_id))

    for (const step of complianceSteps) {
      if (!completedIds.has(step.id)) {
        missingRequirements.push(`Complete acknowledgment: ${step.step_name || step.step_key}`)
      }
    }
  } else {
    // If steps don't exist, still mark as requirements
    missingRequirements.push('Complete Fair Housing acknowledgment')
    missingRequirements.push('Complete TCPA acknowledgment')
  }

  // Requirement 2: All required compliance training videos complete
  const { data: complianceVideos } = await supabase
    .from('training_videos')
    .select('id, title')
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .eq('category', 'compliance')
    .eq('is_required', true)

  if (complianceVideos && complianceVideos.length > 0) {
    const { data: videoProgress } = await supabase
      .from('video_completion_tracking')
      .select('training_video_id, percent_watched')
      .eq('agent_id', agentId)
      .in('training_video_id', complianceVideos.map(v => v.id))

    const progressMap = new Map((videoProgress || []).map(v => [v.training_video_id, v.percent_watched]))

    for (const video of complianceVideos) {
      const progress = progressMap.get(video.id) || 0
      if (progress < 90) {
        missingRequirements.push(`Watch video: ${video.title} (${Math.round(progress)}% complete)`)
      }
    }
  }

  return {
    eligible: missingRequirements.length === 0,
    missingRequirements,
  }
}

async function checkLeadManagementEligibility(
  agentId: string,
  brokerageId: string,
  supabase: ReturnType<typeof createServiceClient>,
  missingRequirements: string[]
): Promise<CertificationEligibilityResult> {
  // Requirement 1: All required lead_management training videos complete
  const { data: leadVideos } = await supabase
    .from('training_videos')
    .select('id, title')
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .eq('category', 'lead_management')
    .eq('is_required', true)

  if (leadVideos && leadVideos.length > 0) {
    const { data: videoProgress } = await supabase
      .from('video_completion_tracking')
      .select('training_video_id, percent_watched')
      .eq('agent_id', agentId)
      .in('training_video_id', leadVideos.map(v => v.id))

    const progressMap = new Map((videoProgress || []).map(v => [v.training_video_id, v.percent_watched]))

    for (const video of leadVideos) {
      const progress = progressMap.get(video.id) || 0
      if (progress < 90) {
        missingRequirements.push(`Watch video: ${video.title} (${Math.round(progress)}% complete)`)
      }
    }
  }

  // Requirement 2: Lead Management Essentials course passed
  const { data: leadCourse } = await supabase
    .from('training_courses')
    .select('id')
    .eq('course_name', 'Lead Management Essentials')
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .maybeSingle()

  if (leadCourse) {
    const { data: courseProgress } = await supabase
      .from('agent_courses')
      .select('status, score')
      .eq('agent_id', agentId)
      .eq('training_course_id', leadCourse.id)
      .maybeSingle()

    if (!courseProgress || courseProgress.status !== 'passed') {
      missingRequirements.push('Pass the Lead Management Essentials course')
    }
  }

  return {
    eligible: missingRequirements.length === 0,
    missingRequirements,
  }
}

// ─── Award Certification ─────────────────────────────────────────────────────

export async function awardCertification(
  certName: string,
  agentId: string,
  brokerageId: string,
  issuedBy?: string
): Promise<AwardCertificationResult> {
  const supabase = createServiceClient()

  // 1. Verify eligibility (re-check server-side, never trust client)
  const eligibility = await checkCertificationEligibility(certName, agentId, brokerageId)
  
  if (!eligibility.eligible) {
    return {
      success: false,
      error: `Not eligible for certification. Missing: ${eligibility.missingRequirements.join(', ')}`,
    }
  }

  // 2. Insert certification record
  const { data: cert, error: insertError } = await supabase
    .from('agent_certifications')
    .insert({
      agent_id: agentId,
      brokerage_id: brokerageId,
      certification_name: certName,
      cert_type: 'onboarding',
      issued_at: new Date().toISOString(),
      issued_by: issuedBy || null,
      certificate_url: `/api/certificates/${agentId}/${encodeURIComponent(certName)}`, // Placeholder path for L12
    })
    .select('id')
    .single()

  if (insertError) {
    console.error('[CertificationEngine] Error inserting certification:', insertError)
    return { success: false, error: insertError.message }
  }

  // 3. Fire kernel event
  await processKernelEvent({
    event: KernelEvent.CERTIFICATION_AWARDED,
    brokerageId,
    entityType: 'agent_certification',
    entityId: cert.id,
  }).catch(err => {
    console.error('[CertificationEngine] Notification processing failed (non-blocking):', err)
  })

  // 4. Check if all required onboarding certs are now awarded
  const { data: allCerts } = await supabase
    .from('agent_certifications')
    .select('certification_name')
    .eq('agent_id', agentId)
    .eq('cert_type', 'onboarding')

  const awardedCertNames = new Set((allCerts || []).map(c => c.certification_name))
  const allRequiredAwarded = REQUIRED_ONBOARDING_CERTS.every(name => awardedCertNames.has(name))

  // 5. If all required certs earned, complete onboarding
  if (allRequiredAwarded) {
    await completeOnboarding(agentId, brokerageId)
  }

  return { success: true, certId: cert.id }
}

// ─── Complete Onboarding ─────────────────────────────────────────────────────

export async function completeOnboarding(
  agentId: string,
  brokerageId: string
): Promise<void> {
  const supabase = createServiceClient()

  // 1. Get the agent_onboarding record
  const { data: onboarding } = await supabase
    .from('agent_onboarding')
    .select('id, status')
    .eq('agent_id', agentId)
    .eq('brokerage_id', brokerageId)
    .maybeSingle()

  if (!onboarding) {
    console.error('[CertificationEngine] No agent_onboarding record found')
    return
  }

  // Guard: Don't complete if already completed
  if (onboarding.status === 'completed') {
    console.log('[CertificationEngine] Onboarding already completed, skipping')
    return
  }

  const previousState = onboarding.status || 'in_progress'

  // 2. Update agent_onboarding
  await supabase
    .from('agent_onboarding')
    .update({
      certification_achieved: true,
      certified_at: new Date().toISOString(),
      status: 'completed',
      completion_percentage: 100,
      updated_at: new Date().toISOString(),
    })
    .eq('id', onboarding.id)

  // 3. Update agents.onboarding_status
  await supabase
    .from('agents')
    .update({
      onboarding_status: 'completed',
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', agentId)

  // 4. Transition lifecycle (only once, check prevents duplicate)
  await transitionLifecycle({
    brokerageId,
    entityType: 'agent_onboarding_machine' as EntityType,
    entityId: onboarding.id,
    fromState: previousState,
    toState: 'completed',
    actorUserId: agentId,
    eventType: 'onboarding_completed',
    metadata: {
      certification_achieved: true,
      completed_at: new Date().toISOString(),
    },
  }).catch(err => {
    console.error('[CertificationEngine] Lifecycle transition failed:', err)
  })

  // 5. Fire kernel event
  await processKernelEvent({
    event: KernelEvent.ONBOARDING_COMPLETED,
    brokerageId,
    entityType: 'agent_onboarding',
    entityId: onboarding.id,
  }).catch(err => {
    console.error('[CertificationEngine] Onboarding completed notification failed:', err)
  })

  // 6. Get agent details for admin notification
  const { data: agent } = await supabase
    .from('users')
    .select('first_name, last_name')
    .eq('id', agentId)
    .single()

  const agentName = agent ? `${agent.first_name} ${agent.last_name}`.trim() : 'Agent'

  // 7. Create notification for brokerage admins
  const { data: admins } = await supabase
    .from('users')
    .select('id')
    .eq('brokerage_id', brokerageId)
    .in('user_type', ['admin', 'broker'])

  for (const admin of admins || []) {
    await supabase.from('notifications').insert({
      user_id: admin.id,
      brokerage_id: brokerageId,
      type: 'onboarding_completed',
      entity_type: 'agent_onboarding',
      entity_id: onboarding.id,
      title: 'Agent Onboarding Complete',
      body: `${agentName} has completed onboarding and is ready to start.`,
      is_read: false,
    })
  }

  console.log(`[CertificationEngine] Onboarding completed for agent ${agentId}`)
}

// ─── Get Certification Status ────────────────────────────────────────────────

export async function getCertificationStatus(
  agentId: string,
  brokerageId: string
): Promise<{
  certifications: Array<{
    name: string
    awarded: boolean
    issuedAt?: string
    certId?: string
    certificateUrl?: string
  }>
  allRequiredAwarded: boolean
}> {
  const supabase = createServiceClient()

  const { data: certs } = await supabase
    .from('agent_certifications')
    .select('id, certification_name, issued_at, certificate_url')
    .eq('agent_id', agentId)
    .eq('cert_type', 'onboarding')

  const awardedMap = new Map((certs || []).map(c => [c.certification_name, c]))

  const certifications = REQUIRED_ONBOARDING_CERTS.map(name => {
    const cert = awardedMap.get(name)
    return {
      name,
      awarded: !!cert,
      issuedAt: cert?.issued_at,
      certId: cert?.id,
      certificateUrl: cert?.certificate_url,
    }
  })

  const allRequiredAwarded = certifications.every(c => c.awarded)

  return { certifications, allRequiredAwarded }
}
