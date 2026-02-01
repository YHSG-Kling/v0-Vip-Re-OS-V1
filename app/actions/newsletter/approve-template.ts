'use server'

import { createClient } from '@/lib/supabase/server'

export async function submitTemplateForApproval(templateId: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, role')
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

  // Verify approver is broker admin
  const { data: approverData } = await supabase
    .from('users')
    .select('role, brokerage_id')
    .eq('id', user.id)
    .single()

  if (!approverData || !['broker_admin', 'admin'].includes(approverData.role)) {
    throw new Error('Only broker admins can approve templates')
  }

  const { error } = await supabase
    .from('newsletter_brokers_templates')
    .update({
      approval_status: 'approved',
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId)

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

  // Verify rejector is broker admin
  const { data: rejectorData } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!rejectorData || !['broker_admin', 'admin'].includes(rejectorData.role)) {
    throw new Error('Only broker admins can reject templates')
  }

  const { error } = await supabase
    .from('newsletter_brokers_templates')
    .update({
      approval_status: 'rejected',
      rejected_reason: rejectionReason,
      rejected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId)

  if (error) throw new Error(`Failed to reject template: ${error.message}`)

  return {
    success: true,
    message: 'Template rejected',
  }
}
