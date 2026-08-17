'use server'

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/**
 * Can this user approve/reject newsletter templates?
 * Broker-side roles always can. TIER PARITY (owner rule, same allowance round
 * 32 gave bulk campaigns): a solo-tier subscriber IS their own broker — their
 * one working seat often carries user_type 'agent'/'solo_agent', which locked
 * them out of approving their OWN templates, and scheduleNewsletter refuses
 * unapproved templates → solo principals could never send a templated
 * newsletter end-to-end.
 */
async function canApproveTemplates(
  userType: string | null,
  role: string | null,
  brokerageId: string,
): Promise<boolean> {
  if (isAdminOrBroker({ user_type: userType ?? role ?? '' })) return true
  const svc = createServiceClient()
  const { data: b } = await svc
    .from('brokerages').select('plan_tier').eq('id', brokerageId).maybeSingle()
  return (b as { plan_tier?: string } | null)?.plan_tier === 'solo_agent'
}

export async function submitTemplateForApproval(templateId: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type, role')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Update status to pending_review
  const { error } = await supabase
    .from('newsletter_brokers_templates')
    .update({
      approval_status: 'pending_review',
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId)
    .eq('brokerage_id', userData.brokerage_id)

  if (error) throw new Error(`Failed to submit for approval: ${error.message}`)

  return {
    success: true,
    message: 'Template submitted for broker approval',
  }
}

export async function approveTemplate(templateId: string, approvingUserId: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Verify approver is broker-side (or the solo-tier principal)
  const { data: approverData } = await supabase
    .from('users')
    .select('user_type, role, brokerage_id')
    .eq('id', user.id)
    .single()

  if (!approverData?.brokerage_id) throw new Error('User has no brokerage assigned')
  const allowed = await canApproveTemplates(
    approverData.user_type ?? null, approverData.role ?? null, approverData.brokerage_id,
  )
  if (!allowed) throw new Error('Only broker admins can approve templates')

  const { error } = await supabase
    .from('newsletter_brokers_templates')
    .update({
      approval_status: 'approved',
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId)
    .eq('brokerage_id', approverData.brokerage_id) // tenant-scoped write

  if (error) throw new Error(`Failed to approve template: ${error.message}`)

  return {
    success: true,
    message: 'Template approved',
  }
}

export async function rejectTemplate(templateId: string, rejectionReason: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Verify rejector is broker-side (or the solo-tier principal)
  const { data: rejectorData } = await supabase
    .from('users')
    .select('user_type, role, brokerage_id')
    .eq('id', user.id)
    .single()

  if (!rejectorData?.brokerage_id) throw new Error('User has no brokerage assigned')
  const allowed = await canApproveTemplates(
    rejectorData.user_type ?? null, rejectorData.role ?? null, rejectorData.brokerage_id,
  )
  if (!allowed) throw new Error('Only broker admins can reject templates')

  const { error } = await supabase
    .from('newsletter_brokers_templates')
    .update({
      approval_status: 'rejected',
      rejected_reason: rejectionReason,
      rejected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId)
    .eq('brokerage_id', rejectorData.brokerage_id) // tenant-scoped write

  if (error) throw new Error(`Failed to reject template: ${error.message}`)

  return {
    success: true,
    message: 'Template rejected',
  }
}
