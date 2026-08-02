'use server'

import { createClient } from '@/lib/supabase/server'
import { getSEOScore } from '@/app/actions/newsletter/get-seo-score'
import { validateScheduleTime } from '@/lib/newsletter/schedule-time'

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
  /** Optional assembled HTML body — when present, an SEO score is computed and
   *  persisted (newsletter_seo_scores) against the new scheduled send. */
  htmlContent?: string
  /** Primary keyword to score keyword density against (defaults to subject). */
  primaryKeyword?: string
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

  // Validate + normalize send time (pure lib/newsletter/schedule-time.ts —
  // same check the wizard runs client-side before the round-trip).
  const scheduleTime = validateScheduleTime(input.scheduledSendTime)
  if (!scheduleTime.valid) {
    throw new Error(scheduleTime.reason)
  }

  // Count contacts matching the recipient segment filters
  let countQuery = supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", userData.brokerage_id)

  if (input.recipientSegment.ZIP) {
    countQuery = countQuery.eq("zip_code", input.recipientSegment.ZIP)
  }
  if (input.recipientSegment.role) {
    countQuery = countQuery.eq("contact_type", input.recipientSegment.role)
  }

  const { count } = await countQuery
  const recipientCount = count ?? 0

  // THE SEND MUST EXIST WHERE THE CRON LOOKS FOR IT.
  //
  // This action used to write ONLY newsletter_scheduled_sends, and the UI told
  // the user "the governed cron will deliver it". No cron reads that table.
  // The real drain is app/api/cron/publish-newsletters, whose query is:
  //
  //   .from("newsletter_campaigns")
  //     .eq("approval_status", "approved")
  //     .in("status", ["scheduled"])
  //     .lte("send_date", now)
  //
  // newsletter_scheduled_sends is the LEDGER, not the queue — the working
  // sibling (lib/kernel/marketing.ts scheduleNewsletterSend) writes both sides
  // and that is exactly why its sends go out. So create the campaign row the
  // cron drains, then point the ledger row at it.
  //
  // approval_status "approved" is justified, not assumed: this action already
  // refuses above unless the TEMPLATE is approved.
  // newsletter_campaigns.agent_id FKs agents(id); created_by FKs users(id).
  // Passing the users id to both would have thrown a foreign-key violation on
  // every schedule — the exact identity-class defect this sweep exists to
  // remove, and I nearly shipped it. Resolve, never substitute.
  const { resolveAgentId } = await import('@/lib/kernel/agent-identity')
  const agentRecordId = await resolveAgentId(supabase, user.id)
  if (!agentRecordId) {
    throw new Error('Your account has no agent profile yet, so the newsletter cannot be attributed to a sender. Finish agent setup first.')
  }

  const { data: campaign, error: campaignError } = await supabase
    .from('newsletter_campaigns')
    .insert({
      brokerage_id: userData.brokerage_id,
      agent_id: agentRecordId,
      created_by: user.id,
      campaign_name: input.subjectLine,
      subject_line: input.subjectLine,
      content: input.htmlContent ?? null,
      approval_status: 'approved',
      status: 'scheduled',
      send_date: scheduleTime.iso!,
    })
    .select('id')
    .single()

  if (campaignError || !campaign) {
    throw new Error(`Failed to queue the newsletter for sending: ${campaignError?.message ?? 'no row returned'}`)
  }

  // Create scheduled send record
  const { data: scheduled, error } = await supabase
    .from('newsletter_scheduled_sends')
    .insert({
      brokerage_id: userData.brokerage_id,
      // The analytics reads (ai-newsletter.ts) join newsletter_campaigns on
      // newsletter_id with !inner — without this the ledger row was invisible
      // to them too, not just to delivery.
      newsletter_id: campaign.id,
      template_id: input.templateId,
      agent_id: user.id,
      subject_line: input.subjectLine,
      preview_text: input.previewText,
      scheduled_send_time: scheduleTime.iso!,
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

  // Score + persist SEO for the new scheduled send when a body was supplied.
  // newsletter_seo_scores rows are keyed by this scheduledSendId.
  let seoScore: Awaited<ReturnType<typeof getSEOScore>> | null = null
  if (input.htmlContent) {
    seoScore = await getSEOScore({
      scheduledSendId: scheduled.id,
      subjectLine: input.subjectLine,
      previewText: input.previewText ?? '',
      htmlContent: input.htmlContent,
      primaryKeyword: input.primaryKeyword || input.subjectLine,
    })
  }

  return {
    success: true,
    scheduledSendId: scheduled.id,
    seoScore,
    message: 'Newsletter scheduled successfully',
  }
}
