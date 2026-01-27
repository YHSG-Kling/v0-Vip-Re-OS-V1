"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateEmail } from "./ai-content-generation"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"

// ============================================
// CAMPAIGN MANAGEMENT
// ============================================

export async function createEmailCampaign(params: {
  agentId: string
  campaignName: string
  campaignType: "one_time" | "drip" | "behavioral"
  targetSegment?: string
  scheduledSendTime?: string
  templateId?: string
  listSegmentId?: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: campaign, error } = await supabase
      .from("email_campaigns")
      .insert({
        agent_id: params.agentId,
        campaign_name: params.campaignName,
        campaign_type: params.campaignType,
        target_segment: params.targetSegment,
        scheduled_send_time: params.scheduledSendTime,
        template_id: params.templateId,
        list_segment_id: params.listSegmentId,
        status: params.scheduledSendTime ? "scheduled" : "draft",
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard/marketing/email")
    return { success: true, data: campaign }
  } catch (error) {
    console.error("Create campaign error:", error)
    return { success: false, error: "Failed to create campaign" }
  }
}

export async function sendCampaign(campaignId: string) {
  if (!isValidUUID(campaignId)) {
    return { success: false, error: "Invalid campaign ID" }
  }

  const supabase = await createClient()

  try {
    const { data: campaign } = await supabase.from("email_campaigns").select("*").eq("id", campaignId).single()

    if (!campaign) {
      return { success: false, error: "Campaign not found" }
    }

    // Get recipient list
    const recipients = await getSegmentContacts(campaign.agent_id, campaign.list_segment_id)

    if (recipients.length === 0) {
      return { success: false, error: "No recipients in segment" }
    }

    // Queue emails for sending
    const sends = await Promise.all(
      recipients.map((contact) =>
        supabase
          .from("email_sends")
          .insert({
            campaign_id: campaignId,
            contact_id: contact.id,
            email_address: contact.email,
            scheduled_send_time: campaign.scheduled_send_time || new Date().toISOString(),
            status: "queued",
          })
          .select()
          .single()
      )
    )

    // Update campaign status
    await supabase
      .from("email_campaigns")
      .update({
        status: "sending",
        sent_at: new Date().toISOString(),
        total_recipients: recipients.length,
      })
      .eq("id", campaignId)

    revalidatePath("/dashboard/marketing/email")
    return { success: true, data: { queued: sends.length } }
  } catch (error) {
    console.error("Send campaign error:", error)
    return { success: false, error: "Failed to send campaign" }
  }
}

// ============================================
// DRIP SEQUENCE AUTOMATION
// ============================================

export async function createDripSequence(params: {
  agentId: string
  sequenceName: string
  triggerEvent: string
  targetPersona?: string
  emails: Array<{
    subject: string
    delayDays: number
    delayHours: number
    templateId?: string
  }>
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Create sequence
    const { data: sequence, error: seqError } = await supabase
      .from("email_drip_sequences")
      .insert({
        agent_id: params.agentId,
        sequence_name: params.sequenceName,
        trigger_event: params.triggerEvent,
        target_persona: params.targetPersona,
        is_active: true,
      })
      .select()
      .single()

    if (seqError) throw seqError

    // Create sequence emails
    const emailsToInsert = params.emails.map((email, index) => ({
      sequence_id: sequence.id,
      step_number: index + 1,
      email_subject: email.subject,
      delay_days: email.delayDays,
      delay_hours: email.delayHours,
      template_id: email.templateId,
    }))

    const { error: emailsError } = await supabase.from("drip_sequence_emails").insert(emailsToInsert)

    if (emailsError) throw emailsError

    revalidatePath("/dashboard/marketing/drip-sequences")
    return { success: true, data: sequence }
  } catch (error) {
    console.error("Create drip sequence error:", error)
    return { success: false, error: "Failed to create drip sequence" }
  }
}

export async function enrollContactInDrip(contactId: string, sequenceId: string) {
  if (!isValidUUID(contactId) || !isValidUUID(sequenceId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Get sequence emails
    const { data: emails } = await supabase
      .from("drip_sequence_emails")
      .select("*")
      .eq("sequence_id", sequenceId)
      .order("step_number")

    if (!emails || emails.length === 0) {
      return { success: false, error: "No emails in sequence" }
    }

    // Get contact
    const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).single()

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    const enrollmentTime = new Date()

    // Schedule all emails in sequence
    for (const email of emails) {
      const sendTime = new Date(enrollmentTime)
      sendTime.setDate(sendTime.getDate() + email.delay_days)
      sendTime.setHours(sendTime.getHours() + email.delay_hours)

      await supabase.from("email_sends").insert({
        drip_sequence_id: sequenceId,
        drip_email_id: email.id,
        contact_id: contactId,
        email_address: contact.email,
        scheduled_send_time: sendTime.toISOString(),
        status: "queued",
      })
    }

    return { success: true, data: { scheduled: emails.length } }
  } catch (error) {
    console.error("Enroll in drip error:", error)
    return { success: false, error: "Failed to enroll contact" }
  }
}

// ============================================
// BEHAVIORAL TRIGGERS
// ============================================

export async function triggerBehavioralEmail(params: {
  contactId: string
  triggerEvent: "listing_view" | "property_search" | "open_house_rsvp" | "offer_submitted" | "abandoned_cart"
  metadata?: any
}) {
  if (!isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const supabase = await createClient()

  try {
    // Find matching drip sequences for this trigger
    const { data: sequences } = await supabase
      .from("email_drip_sequences")
      .select("*")
      .eq("trigger_event", params.triggerEvent)
      .eq("is_active", true)

    if (!sequences || sequences.length === 0) {
      return { success: false, error: "No active sequences for this trigger" }
    }

    // Enroll in first matching sequence
    const result = await enrollContactInDrip(params.contactId, sequences[0].id)

    return result
  } catch (error) {
    console.error("Trigger behavioral email error:", error)
    return { success: false, error: "Failed to trigger email" }
  }
}

// ============================================
// SEND TIME OPTIMIZATION
// ============================================

export async function optimizeSendTime(params: { contactId: string; agentId: string }) {
  if (!isValidUUID(params.contactId)) {
    return { recommendedTime: "09:00", recommendedDay: "Tuesday" }
  }

  const supabase = await createClient()

  try {
    // Get historical engagement data for this contact
    const { data: engagement } = await supabase
      .from("email_engagement")
      .select("sent_at, opened_at")
      .eq("contact_id", params.contactId)
      .not("opened_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(20)

    if (!engagement || engagement.length === 0) {
      // No history - use agent-level optimization
      const { data: agentOptimization } = await supabase
        .from("send_time_optimization")
        .select("*")
        .eq("agent_id", params.agentId)
        .order("avg_open_rate", { ascending: false })
        .limit(1)
        .maybeSingle()

      return {
        recommendedTime: agentOptimization?.best_hour_of_day || "09:00",
        recommendedDay: agentOptimization?.best_day_of_week || "Tuesday",
        confidence: "low",
      }
    }

    // Analyze contact's engagement patterns
    const dayOpenCounts: Record<string, number> = {}
    const hourOpenCounts: Record<number, number> = {}

    for (const record of engagement) {
      const openedDate = new Date(record.opened_at)
      const day = openedDate.toLocaleDateString("en-US", { weekday: "long" })
      const hour = openedDate.getHours()

      dayOpenCounts[day] = (dayOpenCounts[day] || 0) + 1
      hourOpenCounts[hour] = (hourOpenCounts[hour] || 0) + 1
    }

    const bestDay = Object.entries(dayOpenCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "Tuesday"
    const bestHour = Object.entries(hourOpenCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 9

    return {
      recommendedTime: `${String(bestHour).padStart(2, "0")}:00`,
      recommendedDay: bestDay,
      confidence: engagement.length >= 10 ? "high" : "medium",
    }
  } catch (error) {
    console.error("Optimize send time error:", error)
    return { recommendedTime: "09:00", recommendedDay: "Tuesday" }
  }
}

// ============================================
// EMAIL ENGAGEMENT TRACKING
// ============================================

export async function trackEmailOpen(sendId: string) {
  if (!isValidUUID(sendId)) {
    return { success: false }
  }

  const supabase = await createClient()

  try {
    const { data: send } = await supabase.from("email_sends").select("*").eq("id", sendId).single()

    if (!send) return { success: false }

    // Record engagement
    await supabase.from("email_engagement").insert({
      send_id: sendId,
      contact_id: send.contact_id,
      campaign_id: send.campaign_id,
      sent_at: send.sent_at,
      opened_at: new Date().toISOString(),
      open_count: 1,
    })

    // Update send record
    await supabase
      .from("email_sends")
      .update({
        opened_at: new Date().toISOString(),
      })
      .eq("id", sendId)

    return { success: true }
  } catch (error) {
    console.error("Track email open error:", error)
    return { success: false }
  }
}

export async function trackEmailClick(sendId: string, linkUrl: string) {
  if (!isValidUUID(sendId)) {
    return { success: false }
  }

  const supabase = await createClient()

  try {
    const { data: engagement } = await supabase
      .from("email_engagement")
      .select("*")
      .eq("send_id", sendId)
      .maybeSingle()

    if (engagement) {
      // Update existing engagement
      await supabase
        .from("email_engagement")
        .update({
          clicked_at: new Date().toISOString(),
          click_count: (engagement.click_count || 0) + 1,
          clicked_links: [...(engagement.clicked_links || []), linkUrl],
        })
        .eq("id", engagement.id)
    }

    return { success: true }
  } catch (error) {
    console.error("Track email click error:", error)
    return { success: false }
  }
}

// ============================================
// A/B TESTING
// ============================================

export async function createEmailABTest(params: {
  agentId: string
  testName: string
  variantASubject: string
  variantBSubject: string
  variantAContent: string
  variantBContent: string
  testVariable: "subject_line" | "content" | "send_time" | "from_name"
  sampleSize: number
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: test, error } = await supabase
      .from("ab_test_campaigns")
      .insert({
        test_name: params.testName,
        test_variable: params.testVariable,
        variant_a_subject: params.variantASubject,
        variant_b_subject: params.variantBSubject,
        variant_a_content: params.variantAContent,
        variant_b_content: params.variantBContent,
        sample_size: params.sampleSize,
        status: "running",
      })
      .select()
      .single()

    if (error) throw error

    return { success: true, data: test }
  } catch (error) {
    console.error("Create A/B test error:", error)
    return { success: false, error: "Failed to create A/B test" }
  }
}

// ============================================
// LIST SEGMENTATION
// ============================================

export async function createSegment(params: {
  agentId: string
  segmentName: string
  criteria: {
    persona?: string[]
    priceRange?: { min: number; max: number }
    location?: string[]
    leadScore?: { min: number; max: number }
    lastEngagement?: string
  }
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: segment, error } = await supabase
      .from("email_list_segments")
      .insert({
        agent_id: params.agentId,
        segment_name: params.segmentName,
        filter_criteria: params.criteria,
        is_dynamic: true,
      })
      .select()
      .single()

    if (error) throw error

    // Calculate segment size
    const contacts = await getSegmentContacts(params.agentId, segment.id)

    await supabase
      .from("email_list_segments")
      .update({
        contact_count: contacts.length,
      })
      .eq("id", segment.id)

    return { success: true, data: segment, contactCount: contacts.length }
  } catch (error) {
    console.error("Create segment error:", error)
    return { success: false, error: "Failed to create segment" }
  }
}

async function getSegmentContacts(agentId: string, segmentId?: string) {
  const supabase = await createClient()

  if (!segmentId) {
    // Return all contacts for agent
    const { data } = await supabase.from("contacts").select("*").eq("agent_id", agentId)
    return data || []
  }

  // Get segment criteria
  const { data: segment } = await supabase.from("email_list_segments").select("*").eq("id", segmentId).single()

  if (!segment) return []

  let query = supabase.from("contacts").select("*").eq("agent_id", agentId)

  const criteria = segment.filter_criteria as any

  // Apply filters
  if (criteria.persona && criteria.persona.length > 0) {
    query = query.in("buyer_persona", criteria.persona)
  }

  if (criteria.priceRange) {
    query = query.gte("budget_min", criteria.priceRange.min).lte("budget_max", criteria.priceRange.max)
  }

  if (criteria.leadScore) {
    query = query.gte("lead_score", criteria.leadScore.min).lte("lead_score", criteria.leadScore.max)
  }

  const { data } = await query
  return data || []
}

// ============================================
// CAMPAIGN ANALYTICS
// ============================================

export async function getCampaignAnalytics(campaignId: string) {
  if (!isValidUUID(campaignId)) {
    return {
      total_sent: 0,
      open_rate: 0,
      click_rate: 0,
      unsubscribe_rate: 0,
    }
  }

  const supabase = await createClient()

  try {
    const { data: sends } = await supabase.from("email_sends").select("*").eq("campaign_id", campaignId)

    const { data: engagement } = await supabase.from("email_engagement").select("*").eq("campaign_id", campaignId)

    // Track unsubscribes from this campaign
    const { data: unsubscribes } = await supabase
      .from("email_unsubscribes")
      .select("*")
      .eq("campaign_id", campaignId)

    const totalSent = sends?.length || 0
    const totalOpened = engagement?.filter((e) => e.opened_at).length || 0
    const totalClicked = engagement?.filter((e) => e.clicked_at).length || 0
    const totalUnsubscribed = unsubscribes?.length || 0

    return {
      total_sent: totalSent,
      total_delivered: sends?.filter((s) => s.status === "delivered").length || 0,
      total_opened: totalOpened,
      total_clicked: totalClicked,
      total_unsubscribed: totalUnsubscribed,
      open_rate: totalSent > 0 ? (totalOpened / totalSent) * 100 : 0,
      click_rate: totalSent > 0 ? (totalClicked / totalSent) * 100 : 0,
      click_to_open_rate: totalOpened > 0 ? (totalClicked / totalOpened) * 100 : 0,
      unsubscribe_rate: totalSent > 0 ? (totalUnsubscribed / totalSent) * 100 : 0,
    }
  } catch (error) {
    console.error("Get campaign analytics error:", error)
    return {
      total_sent: 0,
      open_rate: 0,
      click_rate: 0,
    }
  }
}

// ============================================
// LISTING-SPECIFIC EMAIL CAMPAIGNS
// ============================================

export async function prepareListingEmailCampaign(params: {
  transactionId: string
  campaignType: "coming_soon" | "launch" | "open_house" | "price_drop" | "sold"
}) {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const supabase = await createClient()

  try {
    // Get transaction and listing details
    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, listings(*), listing_photos(*)")
      .eq("id", params.transactionId)
      .single()

    if (!transaction || !transaction.listings) {
      return { success: false, error: "Transaction not found" }
    }

    const listing = transaction.listings

    // Generate subject line and body using AI
    const emailContent = await generateEmail({
      agentId: transaction.agent_id,
      emailType: params.campaignType as any,
      propertyId: listing.id,
    })

    if (!emailContent.success) {
      return { success: false, error: "Failed to generate email content" }
    }

    // Determine recipients based on campaign type
    const recipients = await getTargetRecipients(params.transactionId, params.campaignType, listing)

    // Create campaign
    const { data: campaign, error } = await supabase
      .from("email_campaigns")
      .insert({
        agent_id: transaction.agent_id,
        campaign_name: `${params.campaignType} - ${listing.address}`,
        campaign_type: "one_time",
        target_segment: determineSegment(params.campaignType),
        status: "draft",
      })
      .select()
      .single()

    if (error) throw error

    // Create email template from generated content
    const { data: template } = await supabase
      .from("email_templates")
      .insert({
        agent_id: transaction.agent_id,
        template_name: `${params.campaignType} - ${listing.address}`,
        template_type: params.campaignType,
        subject_line: emailContent.data?.subject || `New Listing: ${listing.address}`,
        email_body: emailContent.data?.body || emailContent.data?.generated_content || "",
        variables: {
          property_address: listing.address,
          property_city: listing.city,
          property_price: listing.price,
          property_bedrooms: listing.bedrooms,
          property_bathrooms: listing.bathrooms,
        },
      })
      .select()
      .single()

    if (template) {
      await supabase.from("email_campaigns").update({ template_id: template.id }).eq("id", campaign.id)
    }

    // Link recipients
    for (const contactId of recipients) {
      await supabase.from("email_sends").insert({
        campaign_id: campaign.id,
        contact_id: contactId,
        status: "queued",
      })
    }

    revalidatePath("/dashboard/listings")
    return {
      success: true,
      campaign_id: campaign.id,
      recipients: recipients.length,
      subject: emailContent.data?.subject,
    }
  } catch (error) {
    console.error("Prepare listing email campaign error:", error)
    return { success: false, error: "Failed to prepare campaign" }
  }
}

async function getTargetRecipients(transactionId: string, campaignType: string, listing: any): Promise<string[]> {
  const supabase = await createClient()

  if (campaignType === "coming_soon" || campaignType === "launch") {
    // Send to matching buyers based on price and location
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id")
      .eq("status", "active")
      .gte("budget_max", (listing.price || 0) * 0.9)
      .lte("budget_min", (listing.price || 0) * 1.1)

    return contacts?.map((c) => c.id) || []
  }

  if (campaignType === "open_house") {
    // Send to those who viewed or saved this listing
    const { data: interested } = await supabase
      .from("property_interactions")
      .select("contact_id")
      .eq("listing_id", listing.id)
      .in("interaction_type", ["view", "save"])

    return interested?.map((i) => i.contact_id).filter((id) => id) || []
  }

  if (campaignType === "price_drop") {
    // Send to previous viewers
    const { data: viewers } = await supabase
      .from("property_interactions")
      .select("contact_id")
      .eq("listing_id", listing.id)
      .eq("interaction_type", "view")

    return viewers?.map((v) => v.contact_id).filter((id) => id) || []
  }

  // Default: all active contacts
  const { data: allContacts } = await supabase.from("contacts").select("id").eq("status", "active").limit(100)

  return allContacts?.map((c) => c.id) || []
}

function determineSegment(campaignType: string): string {
  const segments: Record<string, string> = {
    coming_soon: "matching_buyers",
    launch: "all_database",
    open_house: "interested_buyers",
    price_drop: "previous_viewers",
    sold: "sphere",
  }
  return segments[campaignType] || "all_database"
}

export async function sendListingCampaign(campaignId: string) {
  return await sendCampaign(campaignId)
}

export async function trackListingEmailEngagement(sendId: string, eventType: "open" | "click" | "reply") {
  if (eventType === "open") {
    return await trackEmailOpen(sendId)
  }
  if (eventType === "click") {
    return await trackEmailClick(sendId, "listing_link")
  }

  // For replies, just track engagement
  return await trackEmailOpen(sendId)
}
