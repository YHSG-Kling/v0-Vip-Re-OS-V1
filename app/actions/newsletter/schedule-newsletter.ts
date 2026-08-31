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
  /** Optional umbrella marketing_campaigns id, from the wizard's Step 1 picker —
   *  this action creates the newsletter_campaigns row the cron drains, so it is
   *  a creation door for the umbrella link too. Verified below to belong to the
   *  caller's brokerage before it is written (§4). */
  marketingCampaignId?: string
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
  // agent_id on BOTH newsletter_campaigns and the newsletter_scheduled_sends
  // ledger below is agents-class; created_by FKs users(id). Passing the users id
  // to both would have thrown a foreign-key violation on every schedule — the
  // exact identity-class defect this sweep exists to remove. Resolve, never
  // substitute — and scoped, since the brokerage is already established above.
  const { resolveAgentIdInBrokerage } = await import('@/lib/kernel/agent-identity')
  const agentRecordId = await resolveAgentIdInBrokerage(supabase, user.id, userData.brokerage_id)
  if (!agentRecordId) {
    throw new Error('Your account has no agent profile yet, so the newsletter cannot be attributed to a sender. Finish agent setup first.')
  }

  // THE UMBRELLA MUST BE ONE OF OURS — the id is body data even on a session
  // client, and an unverified id would file this issue under another tenant's
  // ROI rollup. Same gate as createNewsletterCampaign / createEmailCampaign.
  let marketingCampaignId: string | null = null
  if (input.marketingCampaignId) {
    // Named `umbrellaCampaign`, not `umbrella`: error-message-honesty matches
    // the tested identifier's noun against the message's noun, and the message
    // rightly says "campaign" — the binding should say what the message says.
    const { data: umbrellaCampaign, error: umbrellaError } = await supabase
      .from('marketing_campaigns')
      .select('id')
      .eq('id', input.marketingCampaignId)
      .eq('brokerage_id', userData.brokerage_id)
      .maybeSingle()
    if (umbrellaError) throw new Error(`Could not verify that campaign: ${umbrellaError.message}`)
    if (!umbrellaCampaign) throw new Error('That campaign is not on your brokerage.')
    marketingCampaignId = umbrellaCampaign.id as string
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
      marketing_campaign_id: marketingCampaignId, // verified above, never the raw body id
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
      agent_id: agentRecordId,
      subject_line: input.subjectLine,
      preview_text: input.previewText,
      // `scheduled_time` — NOT scheduled_send_time. The table carried both
      // spellings with one writer each (§6 split): this action wrote
      // scheduled_send_time, the kernel sibling wrote scheduled_time, and every
      // READER — the ROI calculator's window filter
      // (lib/campaigns/roi-calculator.ts:365) and the studio's send list
      // (marketing-studio-client.tsx:2525) — reads scheduled_time. So rows
      // scheduled HERE were invisible to the channel-ROI window forever.
      // Converged onto the read column; scheduled_send_time is now a
      // writer-less orphan for the integrator to drop.
      scheduled_time: scheduleTime.iso!,
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

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE A NEWSLETTER THAT ALREADY EXISTS
//
// scheduleNewsletter above CREATES a campaign from wizard input. The newsletter
// LIST has its own Schedule button, and it was calling scheduleEmailCampaign —
// which queries `email_campaigns` by a `newsletter_campaigns` id, so it returned
// "Campaign not found" every time. That is the same wrong-table defect the Send
// button carried; this is its other half.
//
// There is no drop-in: scheduleNewsletter takes wizard-shaped input and inserts
// a new row, which is not what "schedule the campaign I am looking at" means.
// So this is the missing sibling — same terminal ledger, same governance, keyed
// by an existing campaign id.
//
// WHAT MAKES A SEND ACTUALLY HAPPEN (verified against the cron, not assumed):
// app/api/cron/publish-newsletters queries
//   newsletter_campaigns
//     .eq("approval_status","approved").in("status",["scheduled"])
//     .lte("send_date", now)
// so all three must be true. newsletter_scheduled_sends is the LEDGER the
// analytics reads join on — not the queue. Both sides are written here for the
// same reason scheduleNewsletter writes both.
//
// APPROVAL IS NOT GRANTED HERE. An unapproved campaign is refused with the
// reason, never auto-approved — scheduling is not an approval authority, and
// silently flipping approval_status would turn this button into a bypass of the
// review gate.
// ─────────────────────────────────────────────────────────────────────────────

export async function scheduleExistingNewsletter(input: {
  newsletterId: string
  scheduledSendTime: Date | string
}): Promise<{ success: boolean; error?: string; scheduledFor?: string; ledgerWarning?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { isValidUUID } = await import('@/lib/validations')
  if (!isValidUUID(input.newsletterId)) {
    return { success: false, error: 'Invalid newsletter id' }
  }

  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle()
  if (userError) return { success: false, error: `Could not read your account: ${userError.message}` }
  if (!userData?.brokerage_id) return { success: false, error: 'User has no brokerage assigned' }
  const brokerageId: string = userData.brokerage_id

  // Same pure validator the wizard runs client-side, re-run server-side as the
  // authority — a client can post any time it likes.
  const scheduleTime = validateScheduleTime(input.scheduledSendTime)
  if (!scheduleTime.valid || !scheduleTime.iso) {
    return { success: false, error: scheduleTime.reason }
  }

  const { data: campaign, error: campaignReadError } = await supabase
    .from('newsletter_campaigns')
    .select('id, brokerage_id, agent_id, status, approval_status, campaign_name, subject_line')
    .eq('id', input.newsletterId)
    .eq('brokerage_id', brokerageId)
    .maybeSingle()
  if (campaignReadError) {
    return { success: false, error: `Could not read the newsletter: ${campaignReadError.message}` }
  }
  if (!campaign) {
    return { success: false, error: 'Newsletter not found in your brokerage' }
  }

  // Do not re-schedule something already in flight or delivered — rewinding
  // status would hand it back to the cron and send it twice.
  if (campaign.status === 'sending') {
    return { success: false, error: 'This newsletter is being sent right now — it cannot be rescheduled.' }
  }
  if (campaign.status === 'sent') {
    return { success: false, error: 'This newsletter has already been sent. Duplicate it to send again.' }
  }

  if (campaign.approval_status !== 'approved') {
    return {
      success: false,
      error:
        `This newsletter is "${campaign.approval_status ?? 'draft'}" and the send cron only picks up approved campaigns. ` +
        `Get it approved first — scheduling does not approve it.`,
    }
  }

  const { error: updateError } = await supabase
    .from('newsletter_campaigns')
    .update({ status: 'scheduled', send_date: scheduleTime.iso })
    .eq('id', campaign.id)
    .eq('brokerage_id', brokerageId)
  if (updateError) {
    return { success: false, error: `Failed to schedule the newsletter: ${updateError.message}` }
  }

  // Ledger row so the analytics joins (ai-newsletter.ts uses !inner on
  // newsletter_id) can see this send. agent_id here is agents-class: prefer the
  // campaign's own, and resolve — never substitute the users id, which would be
  // a foreign-key violation on a different id space.
  let agentRecordId: string | null = campaign.agent_id ?? null
  if (!agentRecordId) {
    const { resolveAgentIdInBrokerage } = await import('@/lib/kernel/agent-identity')
    agentRecordId = await resolveAgentIdInBrokerage(supabase, user.id, brokerageId)
  }

  const subjectLine = campaign.subject_line ?? campaign.campaign_name ?? 'Newsletter'
  const { error: ledgerError } = await supabase
    .from('newsletter_scheduled_sends')
    .insert({
      brokerage_id: brokerageId,
      newsletter_id: campaign.id,
      agent_id: agentRecordId,
      subject_line: subjectLine,
      // Same §6 convergence as scheduleNewsletter above — scheduled_time is the
      // column the readers use; scheduled_send_time is the retired spelling.
      scheduled_time: scheduleTime.iso,
      send_status: 'scheduled',
    })

  // The campaign row is what the cron drains, so the send IS scheduled even if
  // the ledger write failed. Say so rather than reporting a clean success or a
  // false failure.
  if (ledgerError) {
    console.error('[scheduleExistingNewsletter] ledger row failed:', ledgerError.message)
    return {
      success: true,
      scheduledFor: scheduleTime.iso,
      ledgerWarning: 'Scheduled, but it will not appear in newsletter analytics until the send record is repaired.',
    }
  }

  return { success: true, scheduledFor: scheduleTime.iso }
}
