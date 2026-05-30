'use server'

import { createClient } from '@/lib/supabase/server'

export interface ScheduleNewsletterInput {
  templateId: string
  subjectLine: string
  previewText?: string
  scheduledSendTime: Date
  recipientSegment: {
    role?: string
    ZIP?: string
    specialization?: string
  }
  sectionsIncluded: string[]
  personalizationVariables?: Record<string, string>
  abTestVariant?: string
}

export async function scheduleNewsletter(input: ScheduleNewsletterInput) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Verify template is approved
  const { data: template } = await supabase
    .from('newsletter_brokers_templates')
    .select('id, approval_status')
    .eq('id', input.templateId)
    .eq('brokerage_id', userData.brokerage_id)
    .single()

  if (!template) throw new Error('Template not found')
  if (template.approval_status !== 'approved') {
    throw new Error('Only approved templates can be scheduled')
  }

  // Validate send time is in future
  if (new Date(input.scheduledSendTime) <= new Date()) {
    throw new Error('Send time must be in the future')
  }

  // Count contacts matching the recipient segment filters
  let countQuery = supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", userData.brokerage_id)

  if (input.recipientSegment.ZIP) {
    countQuery = countQuery.eq("zip", input.recipientSegment.ZIP)
  }
  if (input.recipientSegment.role) {
    countQuery = countQuery.eq("contact_type", input.recipientSegment.role)
  }

  const { count } = await countQuery
  const recipientCount = count ?? 0

  // Create scheduled send record
  const { data: scheduled, error } = await supabase
    .from('newsletter_scheduled_sends')
    .insert({
      brokerage_id: userData.brokerage_id,
      template_id: input.templateId,
      agent_id: user.id,
      subject_line: input.subjectLine,
      preview_text: input.previewText,
      scheduled_send_time: input.scheduledSendTime.toISOString(),
      send_status: 'scheduled',
      recipient_segment: input.recipientSegment,
      recipient_count: recipientCount,
      sections_included: input.sectionsIncluded,
      personalization_variables: input.personalizationVariables,
      ab_test_variant: input.abTestVariant,
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to schedule newsletter: ${error.message}`)

  return {
    success: true,
    scheduledSendId: scheduled.id,
    message: 'Newsletter scheduled successfully',
  }
}
