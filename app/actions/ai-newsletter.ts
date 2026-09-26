"use server"

// TOMBSTONE: local escapeHtml merged onto lib/format/html.ts escapeHtmlFull — §1/§6 SAME
// BODY census round 3, 2026-09-09. Its only reader here (the newsletter writer) moved to
// lib/kernel/content-creators.ts authorNewsletterContent in wave 85F, which imports it.

import { createClient } from "@/lib/supabase/server"
import { LIFETIME_CUSTOMER_SEGMENT } from "@/lib/contact-types"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { revalidatePath } from "next/cache"
import { isValidUUID, isValidEmail } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import { canAccessFeature } from "@/lib/kernel/0.1-feature-access"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import type { NewsletterSectionInput } from "@/lib/kernel/content-creators"

// ============================================
// AI NEWSLETTER SYSTEM
// Complete email newsletter management with
// AI-powered content generation, A/B testing,
// and send time optimization
// ============================================

// The section shape the newsletter builder hands in. ONE definition (§6): the creator's,
// lib/kernel/content-creators.ts NewsletterSectionInput (section_type / target_personas /
// target_locations / order_index drive the Wave 20 decompose there).
type NewsletterSection = NewsletterSectionInput

// TOMBSTONE (wave 85F, §1.1/§6): NEWSLETTER_TEMPLATES (modern / luxury / minimal / insider)
// MOVED with its only reader, the writer, to lib/kernel/content-creators.ts
// NEWSLETTER_TEMPLATES. Its primaryColor / fontFamily fields had no reader anywhere (the
// list was module-private and the writer read only style + sections), so they did not move.

// ============================================
// 1. AI SUBJECT LINE GENERATOR
// ============================================
export async function aiGenerateSubjectLines(params: {
  agentId?: string // ignored — derived from session
  brokerageId?: string // ignored — derived from session
  newsletterTopic: string
  audience?: "all" | "buyers" | "sellers" | "investors" | typeof LIFETIME_CUSTOMER_SEGMENT
  tone?: "professional" | "friendly" | "urgent" | "curious"
  includeEmoji?: boolean
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const sessionBrokerageId = ctx.brokerageId
    const sessionUserId = ctx.userId
    const sessionAgentId = ctx.agentId

    // Kernel: Feature access check
    const access = await canAccessFeature(sessionUserId, "newsletter_engine")
    if (!access.allowed) {
      return { success: false, error: access.reason || "Feature not available" }
    }

    const supabase = await createClient()

    // Fetch brokerage and agent data for template variable substitution
    const [{ data: brokerageData }, { data: agentData }] = await Promise.all([
      supabase
        .from("brokerages")
        .select("city, state, name")
        .eq("id", sessionBrokerageId)
        .maybeSingle(),
      supabase
        .from("agents")
        .select("users(first_name, last_name)")
        .eq("user_id", sessionUserId)
        .maybeSingle(),
    ])

    const city = brokerageData?.city ?? brokerageData?.state ?? "your area"
    const brokerageName = brokerageData?.name ?? "our brokerage"
    const agentUser = (agentData?.users as any) ?? null
    const composedAgentName = [agentUser?.first_name, agentUser?.last_name].filter(Boolean).join(" ")
    const agentName = composedAgentName || "your agent"

    const { object: subjectLines } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        primary: z.object({
          subject: z.string(),
          preheader: z.string(),
          reasoning: z.string(),
        }),
        variants: z.array(
          z.object({
            subject: z.string(),
            preheader: z.string(),
            style: z.string(),
          })
        ),
        abTestRecommendation: z.object({
          variantA: z.string(),
          variantB: z.string(),
          hypothesis: z.string(),
        }),
      }),
      prompt: `Generate compelling email subject lines for a real estate newsletter.

Topic: ${params.newsletterTopic}
Audience: ${params.audience ?? "all"}
Tone: ${params.tone ?? "professional"}
Include Emoji: ${params.includeEmoji ?? false}
City / Market: ${city}
Agent Name: ${agentName}
Brokerage: ${brokerageName}

Create:
1. A primary subject line with preheader text
2. 4 alternative variants with different approaches
3. A/B test recommendation

Best practices:
- Keep under 50 characters
- Create urgency or curiosity
- Use the real city name (${city}) instead of placeholder tokens where appropriate
- Personalization token allowed for recipient first name: {{first_name}}
- Avoid spam trigger words`,
    })

    /** Substitute any remaining template variables with real values */
    function substituteVars(text: string): string {
      return text
        .replace(/\{\{city\}\}/gi, city)
        .replace(/\{\{agent_name\}\}/gi, agentName)
        .replace(/\{\{brokerage_name\}\}/gi, brokerageName)
    }

    const resolvedSubjectLines = {
      primary: {
        ...subjectLines.primary,
        subject: substituteVars(subjectLines.primary.subject),
        preheader: substituteVars(subjectLines.primary.preheader),
      },
      variants: subjectLines.variants.map((v) => ({
        ...v,
        subject: substituteVars(v.subject),
        preheader: substituteVars(v.preheader),
      })),
      abTestRecommendation: {
        ...subjectLines.abTestRecommendation,
        variantA: substituteVars(subjectLines.abTestRecommendation.variantA),
        variantB: substituteVars(subjectLines.abTestRecommendation.variantB),
      },
    }

    return { success: true, subjectLines: resolvedSubjectLines }
  } catch (error) {
    console.error("[AI Newsletter] Subject line error:", error)
    return handleError(error, "aiGenerateSubjectLines")
  }
}

// ============================================
// 2. AI NEWSLETTER CONTENT WRITER
// ============================================
export async function aiWriteNewsletterContent(params: {
  agentId?: string // ignored — derived from session
  brokerageId?: string // ignored — derived from session
  template?: string
  /** Flat alias for template — content-studio-client passes this */
  targetAudience?: string
  tone?: string
  topic: string
  featuredListings?: any[]
  marketStats?: any
  customSections?: string[]
  /** Wave 20.1 — content_topic_bank ids the approved plan names (cohesion with the video). */
  seedTopicIds?: string[]
}): Promise<{
  success: boolean
  error?: string
  content?: string
  sections?: NewsletterSection[]
  estimatedReadTime?: number | null
  wordCount?: number | null
  quality?: unknown
  contentId?: string | null
  seedTopicIds?: string[]
  complianceWarnings?: string[]
}> {
  // TOMBSTONE (wave 85F, §1.1). The writer's body (topic seeding, persona/location sections,
  // brand voice, the per-section compliance gate, the quality verdict and the
  // ai_generated_content artifact) MOVED to the one server-only writer,
  // lib/kernel/content-creators.ts authorNewsletterContent. The voice webhook has no cookie
  // session, so stage_newsletter_draft was refused "Unauthorized" here on every call. The
  // move also made the writer compliance-first (buildComplianceSystemBlocks in the system
  // prompt, postcheckScript on the issue) and ended the per-section `.catch(() => allowed)`
  // fail-open. This door keeps what only a "use server" door can do: verify the SESSION.
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const { authorNewsletterContent } = await import("@/lib/kernel/content-creators")
    return await authorNewsletterContent({
      ctx: { userId: ctx.userId, brokerageId: ctx.brokerageId, agentId: ctx.agentId ?? undefined },
      topic: params.topic,
      template: params.template,
      targetAudience: params.targetAudience,
      tone: params.tone,
      featuredListings: params.featuredListings,
      marketStats: params.marketStats,
      customSections: params.customSections,
      seedTopicIds: params.seedTopicIds,
    })
  } catch (error) {
    console.error("[AI Newsletter] Content error:", error)
    return handleError(error, "aiWriteNewsletterContent")
  }
}

// ============================================
// 3. AI SEND TIME OPTIMIZER
// ============================================
export async function aiOptimizeSendTime(params: {
  agentId?: string // ignored — derived from session
  audienceSegment: string
  historicalData?: any[]
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const sessionBrokerageId = ctx.brokerageId
    const sessionUserId = ctx.userId
    const sessionAgentId = ctx.agentId

    const supabase = await createClient()

    // Get historical email performance. newsletter_campaigns.agent_id is
    // agents-class; falling back to the session USERS id here matched nothing and
    // read as "no history" — so no agents row means no history, said honestly.
    let emailStats: Array<Record<string, unknown>> | null = null
    if (sessionAgentId) {
      const { data, error: statsErr } = await supabase
        .from("newsletter_scheduled_sends")
        .select("sent_at:sent_time, newsletter:newsletter_campaigns!inner(open_rate, click_rate, agent_id)")
        .eq("newsletter.agent_id", sessionAgentId)
        .order("sent_time", { ascending: false })
        .limit(50)
      if (statsErr) console.error("[ai-newsletter] send-time history read failed:", statsErr.message)
      emailStats = data as Array<Record<string, unknown>> | null
    }

    const { object: optimization } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        recommendedDay: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]),
        recommendedTime: z.string().describe("HH:MM format in recipient timezone"),
        confidence: z.number().min(0).max(100),
        reasoning: z.string(),
        alternativeTimes: z.array(
          z.object({
            day: z.string(),
            time: z.string(),
            expectedOpenRate: z.number(),
          })
        ),
        avoidTimes: z.array(z.string()),
      }),
      prompt: `Optimize email send time for real estate newsletter.

Audience: ${params.audienceSegment}
Historical Performance: ${emailStats?.length ? JSON.stringify(emailStats.slice(0, 10)) : "No data"}

Consider:
- Real estate audience behavior
- Time zone distribution
- Competition avoidance
- Industry benchmarks

Recommend optimal send time with reasoning.`,
    })

    return { success: true, optimization }
  } catch (error) {
    console.error("[AI Newsletter] Send time error:", error)
    return handleError(error, "aiOptimizeSendTime")
  }
}

// ============================================
// 4. AI PERSONALIZATION ENGINE
// ============================================
export async function aiPersonalizeNewsletter(params: {
  agentId?: string // ignored — derived from session
  newsletterId: string
  contactId: string
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const sessionBrokerageId = ctx.brokerageId
    const sessionUserId = ctx.userId
    const sessionAgentId = ctx.agentId

    if (!isValidUUID(params.contactId)) {
      return { success: false, error: "Invalid IDs" }
    }

    const supabase = await createClient()

    // Verify newsletter belongs to session brokerage
    const { data: ownershipRow } = await supabase
      .from("newsletter_campaigns")
      .select("brokerage_id")
      .eq("id", params.newsletterId)
      .maybeSingle()
    if (!ownershipRow || ownershipRow.brokerage_id !== sessionBrokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Get contact data.
    //
    // `interactions(*)` and `saved_searches(*)` embedded tables that DO NOT EXIST in the
    // live database (no public.interactions, no public.saved_searches, and neither name is
    // an FK column on contacts). PostgREST rejects the ENTIRE query when a select names an
    // unknown relation, so this read failed every time it ran; `error` was undestructured,
    // so the caller saw `contact: null` and bailed out with "Contact or newsletter not
    // found". Personalization has never actually personalized.
    //   interactions  → `activities`       (activities.contact_id → contacts.id)
    //   saved_searches → `property_alerts` (property_alerts.contact_id → contacts.id) —
    //                    this is the real saved-search table in this schema.
    // Columns are named explicitly; never `*` inside an embed (defect #214).
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select(`
        *,
        activities(notes, created_at),
        property_alerts(alert_name, cities, zip_codes, keywords, min_price, max_price, bedrooms_min, is_active)
      `)
      .eq("id", params.contactId)
      .eq("brokerage_id", sessionBrokerageId)
      .maybeSingle()

    if (contactError) {
      console.error("[aiPersonalizeNewsletter] contact read failed:", contactError.message)
      return { success: false, error: contactError.message }
    }

    // Get newsletter content. Name the columns the prompt below actually uses —
    // a refusal here arrives as a resolved promise, so the error is read.
    const { data: newsletter, error: newsletterError } = await supabase
      .from("newsletter_campaigns")
      .select("id, campaign_name, subject_line")
      .eq("id", params.newsletterId)
      .eq("brokerage_id", sessionBrokerageId)
      .maybeSingle()

    if (newsletterError) {
      console.error("[aiPersonalizeNewsletter] newsletter read failed:", newsletterError.message)
      return { success: false, error: newsletterError.message }
    }

    if (!contact || !newsletter) {
      return { success: false, error: "Contact or newsletter not found" }
    }

    // WHAT THE MODEL IS TOLD THE NEWSLETTER IS ABOUT.
    //
    // A campaign carries no free-standing "topic" — the subject line is the
    // stated subject, and the campaign name is the fallback the rest of this
    // file already treats as the human label. Neither is guaranteed to be set,
    // so the topic line is OMITTED from the prompt rather than emitted with an
    // empty or absent value: a topic line with nothing behind it is worse than
    // no topic line, because the model reads it as the actual subject and
    // steers the whole personalization toward that non-answer.
    const newsletterTopic =
      [newsletter.subject_line, newsletter.campaign_name]
        .find((v): v is string => typeof v === "string" && v.trim().length > 0)
        ?.trim() ?? null

    const topicLine = newsletterTopic ? `\nNewsletter Topic: ${newsletterTopic}\n` : ""

    // `property_alerts` has no single `criteria` blob (the old `saved_searches.criteria`
    // was never a real column) — the search is spread across typed columns, so summarize
    // the ones that exist. Embedded rows are unordered, so pick the newest activity here.
    const alertSummaries = ((contact.property_alerts ?? []) as Array<Record<string, any>>)
      .filter((s) => s.is_active !== false)
      .map((s) =>
        [
          s.alert_name,
          Array.isArray(s.cities) && s.cities.length ? s.cities.join("/") : null,
          Array.isArray(s.zip_codes) && s.zip_codes.length ? s.zip_codes.join("/") : null,
          s.min_price || s.max_price ? `$${s.min_price ?? 0}-${s.max_price ?? "any"}` : null,
          s.bedrooms_min ? `${s.bedrooms_min}+ bd` : null,
          Array.isArray(s.keywords) && s.keywords.length ? s.keywords.join("/") : null,
        ].filter(Boolean).join(" · "),
      )
      .filter((s) => s.length > 0)

    const lastActivity = ((contact.activities ?? []) as Array<{ notes: string | null; created_at: string | null }>)
      .filter((a) => a.created_at)
      .sort((a, b) => new Date(b.created_at!).getTime() - new Date(a.created_at!).getTime())[0] ?? null

    const { object: personalization } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        greeting: z.string(),
        customIntro: z.string(),
        recommendedListings: z.array(z.string()).describe("Listing IDs most relevant"),
        customCta: z.object({
          text: z.string(),
          url: z.string(),
        }),
        dynamicContent: z.record(z.string(), z.string()),
      }),
      prompt: `Personalize this newsletter for the contact.

Contact:
- Name: ${contact.first_name} ${contact.last_name}
- Persona: ${contact.contact_persona || "general"}
- Interests: ${alertSummaries.join(", ") || "Unknown"}
- Last Interaction: ${lastActivity?.notes || "None"}
${topicLine}
Create personalized elements that will resonate with this specific contact.`,
    })

    return { success: true, personalization }
  } catch (error) {
    console.error("[AI Newsletter] Personalization error:", error)
    return handleError(error, "aiPersonalizeNewsletter")
  }
}

// ============================================
// 5. CREATE NEWSLETTER CAMPAIGN
// ============================================
export async function createNewsletterCampaign(params: {
  agentId?: string // ignored — derived from session
  brokerageId?: string // ignored — derived from session
  title: string
  subjectLine: string
  preheaderText: string
  template: string
  content: NewsletterSection[]
  audienceSegment: string
  scheduledAt?: string
  /** Wave 20.1 — content_topic_bank ids that seeded the sections (performance loop). */
  seedTopicIds?: string[]
  /** UPSERT-BY-ID edit semantics (merged from the deleted insider-edit-save route); the id is
   *  verified to be the session brokerage's inside the creator. */
  campaignId?: string
  /** newsletter_campaigns.marketing_campaign_id — verified in-tenant inside the creator. */
  marketingCampaignId?: string
}): Promise<{ success: boolean; error?: string; newsletter?: Record<string, any>; audienceSize?: number }> {
  // TOMBSTONE (wave 85F, §1.1). The envelope insert/update, the Wave 20 section decompose, the
  // topic-use ledger, NEWSLETTER_SCHEDULED and the usage counter MOVED to the one creator,
  // lib/kernel/content-creators.ts createNewsletterCampaign, so the voice webhook (no cookie
  // session, refused "Unauthorized" here) files through the same chain. The unwired
  // lib/kernel/marketing.ts createNewsletterCampaign merged onto it too. This door keeps the
  // SESSION check and the page revalidation.
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const { createNewsletterCampaign: fileNewsletter } = await import("@/lib/kernel/content-creators")
    const result = await fileNewsletter({
      ctx: { userId: ctx.userId, brokerageId: ctx.brokerageId, agentId: ctx.agentId ?? undefined },
      title: params.title,
      subjectLine: params.subjectLine,
      preheaderText: params.preheaderText,
      template: params.template,
      content: params.content,
      audienceSegment: params.audienceSegment,
      scheduledAt: params.scheduledAt,
      seedTopicIds: params.seedTopicIds,
      campaignId: params.campaignId,
      marketingCampaignId: params.marketingCampaignId,
    })
    if (result.success) {
      revalidatePath("/content-studio")
      revalidatePath("/dashboard/marketing/studio")
    }
    return result
  } catch (error) {
    console.error("[AI Newsletter] Create campaign error:", error)
    return handleError(error, "createNewsletterCampaign")
  }
}

// ============================================
// 6. SEND NEWSLETTER
// ============================================
export async function sendNewsletter(params: { newsletterId: string; agentId?: string /* ignored — derived from session */; brokerageId?: string /* ignored — derived from session */ }) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const sessionBrokerageId = ctx.brokerageId
    const sessionUserId = ctx.userId
    const sessionAgentId = ctx.agentId

    if (!isValidUUID(params.newsletterId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // newsletter_subscribers.agent_id is agents-class. Substituting the session
    // USERS id matched no rows and surfaced as "No active subscribers for this
    // agent" — a missing agents profile reported as an empty audience.
    if (!sessionAgentId) {
      return { success: false, error: "No agent profile for this user in this brokerage — there is no subscriber list to send to." }
    }

    // Kernel: Feature access check
    const access = await canAccessFeature(sessionUserId, "newsletter_engine")
    if (!access.allowed) {
      return { success: false, error: access.reason || "Feature not available" }
    }

    const supabase = await createClient()

    // Verify newsletter belongs to session brokerage before mutating
    const { data: ownershipRow } = await supabase
      .from("newsletter_campaigns")
      .select("brokerage_id")
      .eq("id", params.newsletterId)
      .maybeSingle()
    if (!ownershipRow || ownershipRow.brokerage_id !== sessionBrokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Get newsletter and subscribers
    const { data: newsletter } = await supabase
      .from("newsletter_campaigns")
      .select("*")
      .eq("id", params.newsletterId)
      .eq("brokerage_id", sessionBrokerageId)
      .maybeSingle()

    if (!newsletter) {
      return { success: false, error: "Newsletter not found" }
    }

    // Kernel: Brand compliance check before send
    const compliance = await checkBrandCompliance({
      contentType: "newsletter",
      contentId: params.newsletterId,
      brokerageId: sessionBrokerageId,
    })
    if (!compliance.passed) {
      return { success: false, error: `Brand compliance failed: ${compliance.violations?.join(", ")}` }
    }

    // Manual-send path. The publish-newsletters cron is the canonical batch
    // sender; this action lets an authenticated agent fire one campaign
    // immediately. Both paths converge on the SAME dispatch + assembly
    // helpers so the De-Conflict + compliance + suppression gates fire once.
    const { data: subscribers } = await supabase
      .from("newsletter_subscribers")
      .select("id, contact_id, email, first_name, last_name, status, agent_id, contact:contacts(id, email, first_name, last_name, contact_persona, city, state, zip_code)")
      .eq("brokerage_id", sessionBrokerageId)
      .eq("agent_id", sessionAgentId)
      .eq("status", "subscribed")

    if (!subscribers || subscribers.length === 0) {
      return { success: false, error: "No active subscribers for this agent" }
    }

    // newsletter_sections.newsletter_id targets newsletter_campaigns.id, so the
    // section parent for this campaign IS the campaign itself.
    const newsletterId: string = params.newsletterId

    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const { resolveSectionsForRecipient, assembleNewsletterHtml } = await import("@/lib/kernel/newsletter/assemble")

    const fromAddress = `newsletter@${(process.env.NEWSLETTER_FROM_DOMAIN ?? "platform.com")}`
    let sent = 0, suppressed = 0, errors = 0

    for (const subscriber of subscribers) {
      const contactObj = (subscriber as { contact?: { email?: string | null; contact_persona?: string | null; city?: string | null; state?: string | null; zip_code?: string | null } }).contact
      const contactEmail = (contactObj?.email ?? subscriber.email) as string | null
      if (!contactEmail) continue
      const recipientLocation = contactObj ? { city: contactObj.city, state: contactObj.state, zip_code: contactObj.zip_code } : null
      const persona = (contactObj?.contact_persona as string | null) ?? null

      const sections = await resolveSectionsForRecipient({
        brokerageId: sessionBrokerageId,
        newsletterId,
        recipientPersona:  persona,
        recipientLocation: recipientLocation,
      })

      const assembled = assembleNewsletterHtml({
        context: {
          campaignId:       params.newsletterId,
          brokerageId:      sessionBrokerageId,
          newsletterId,
          campaignSubject:  (newsletter as { subject_line?: string | null }).subject_line ?? null,
          campaignBodyHtml: newsletter.content ?? null,
        },
        sections,
      })

      const result = await dispatchEmail({
        brokerageId:    sessionBrokerageId,
        userId:         sessionUserId,
        contactId:      subscriber.contact_id ?? undefined,
        systemSource:   "newsletter",
        channelPurpose: "campaign",
        from:           fromAddress,
        to:             contactEmail,
        subject:        assembled.subject,
        html:           assembled.html,
        text:           assembled.text,
        metadata:       {
          newsletter_campaign_id: params.newsletterId,
          newsletter_id:          newsletterId,
        },
      })

      const status =
        result.success                                ? "sent"
        : result.providerKey === "deconflict_gate"   ? "suppressed"
        : result.providerKey === "compliance_gate"   ? "suppressed"
                                                      : "failed"

      if (status === "sent")       sent++
      if (status === "suppressed") suppressed++
      if (status === "failed")     errors++

      try {
        // `subject` and `template_id` are NOT written on this row (wave 26, §1
        // duplicate). `assembled.subject` IS newsletter_campaigns.subject_line
        // (lib/kernel/newsletter/assemble.ts:162 copies context.campaignSubject,
        // which is the campaign row read at :1268 above and rendered at
        // app/newsletters/newsletters-client.tsx:1995) — the campaign is the
        // survivor and campaign_id is the join. The old `template_id: null` was
        // a literal null: nothing to merge. The one live template_id writer is
        // the workflow-OS path below (queueNewsletterForContact), where the row
        // has no campaign and the template is its only content source.
        await supabase.from("newsletter_sends").insert({
          brokerage_id:        sessionBrokerageId,
          campaign_id:         params.newsletterId,
          contact_id:          subscriber.contact_id ?? null,
          status,
          provider_message_id: result.messageId ?? null,
          sent_at:             status === "sent" ? new Date().toISOString() : null,
        })
      } catch { /* per-recipient log failure shouldn't block remaining recipients */ }
    }

    const sendRecord = { id: null as string | null }

    await supabase
      .from("newsletter_campaigns")
      .update({ status: "sent" })
      .eq("id", params.newsletterId)
      .eq("brokerage_id", sessionBrokerageId)

    // Kernel: Fire NEWSLETTER_SENT event
    processKernelEvent({
      event: KernelEvent.NEWSLETTER_SENT,
      brokerageId: sessionBrokerageId,
      entityType: "newsletter_campaign",
      entityId: params.newsletterId,
    }).catch((err) => console.error("[Kernel] NEWSLETTER_SENT error:", err))

    revalidatePath("/content-studio")
    revalidatePath("/dashboard/marketing/studio")

    return {
      success: true,
      sendId: sendRecord?.id,
      recipientCount: subscribers.length,
      sent,
      suppressed,
      errors,
    }
  } catch (error) {
    console.error("[AI Newsletter] Send error:", error)
    return handleError(error, "sendNewsletter")
  }
}

// ============================================
// 7. GET NEWSLETTER ANALYTICS
// ============================================
export async function getNewsletterAnalytics(params: { newsletterId: string; agentId?: string /* ignored — derived from session */; brokerageId?: string /* ignored — derived from session */ }) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const sessionBrokerageId = ctx.brokerageId
    const sessionUserId = ctx.userId
    const sessionAgentId = ctx.agentId

    if (!isValidUUID(params.newsletterId)) {
      return { success: false, error: "Invalid newsletter ID" }
    }

    const supabase = await createClient()

    // Verify newsletter belongs to session brokerage before reading analytics
    const { data: ownershipRow } = await supabase
      .from("newsletter_campaigns")
      .select("brokerage_id")
      .eq("id", params.newsletterId)
      .maybeSingle()
    if (!ownershipRow || ownershipRow.brokerage_id !== sessionBrokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // THE METRICS COME FROM THE DELIVERY LEDGER, NOT THE SCHEDULE.
    //
    // This used to read opened_count / delivered_count / clicked_count /
    // bounced_count / unsubscribed_count off newsletter_scheduled_sends — five
    // columns that DO NOT EXIST on that table (verified live). Because the read
    // was a select("*"), nothing refused: every metric came back undefined,
    // `|| 0`-ed into a zero, and this surface reported 0% opens on every
    // newsletter forever, invisibly.
    //
    // newsletter_scheduled_sends is the SCHEDULE — one row per scheduled issue,
    // carrying the audience estimate made at schedule time. The per-recipient
    // truth lives in `newsletter_sends` — one row per recipient, written by the
    // publish cron and stamped opened_at/clicked_at (+ status promotion) by the
    // SendGrid fan-out (lib/outcomes/provider-event-fanout.ts). Counted here
    // the same way the engagement rollup counts it
    // (lib/marketing/engagement-rollup.ts::newsletterSendRates); the five
    // columns are NOT added to the schedule table, which would duplicate the
    // ledger (§6).
    const sendsBase = () =>
      supabase
        .from("newsletter_sends")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", params.newsletterId)
        .eq("brokerage_id", sessionBrokerageId)

    // Every count is destructured and a refusal ABORTS — a refused read folded
    // into `?? 0` would render as "nobody opened it" (§3).
    const [total, delivered, opened, clicked, bounced] = await Promise.all([
      sendsBase(),
      sendsBase().not("sent_at", "is", null),
      sendsBase().not("opened_at", "is", null),
      sendsBase().not("clicked_at", "is", null),
      sendsBase().eq("status", "bounced"),
    ])
    for (const r of [total, delivered, opened, clicked, bounced]) {
      if (r.error) return { success: false, error: `Could not read the send ledger: ${r.error.message}` }
    }
    const totalSends = total.count ?? 0
    const deliveredCount = delivered.count ?? 0
    const openedCount = opened.count ?? 0
    const clickedCount = clicked.count ?? 0
    const bouncedCount = bounced.count ?? 0

    // The schedule row still contributes what only IT knows: the audience size
    // estimated when the issue was scheduled. A campaign sent straight from the
    // studio has no schedule row — that is not "not sent"; the ledger decides.
    const { data: schedule, error: scheduleError } = await supabase
      .from("newsletter_scheduled_sends")
      .select("recipient_count, sent_time")
      .eq("newsletter_id", params.newsletterId)
      .order("sent_time", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (scheduleError) {
      return { success: false, error: `Could not read the schedule: ${scheduleError.message}` }
    }

    if (totalSends === 0 && !schedule) {
      return { success: true, analytics: null, message: "Newsletter not yet sent" }
    }

    // Denominator: recipients the ledger actually processed, falling back to
    // the schedule-time estimate only when no per-recipient row exists yet.
    const recipientCount = totalSends > 0 ? totalSends : (schedule?.recipient_count ?? 0)

    const analytics = {
      recipientCount,
      delivered: deliveredCount,
      opened: openedCount,
      clicked: clickedCount,
      bounced: bouncedCount,
      // There is NO per-campaign unsubscribe ledger in this schema —
      // newsletter_subscribers.status flips to 'unsubscribed' globally, with no
      // record of which issue prompted it. null, not a fabricated 0: the UI
      // renders it as "—" rather than claiming nobody unsubscribed.
      unsubscribed: null as number | null,
      // Rates over DELIVERED sends, same denominator rule as the engagement
      // rollup — dividing opens by suppressed recipients flatters the campaign.
      openRate: deliveredCount > 0 ? (openedCount / deliveredCount) * 100 : 0,
      clickRate: openedCount > 0 ? (clickedCount / openedCount) * 100 : 0,
      bounceRate: recipientCount > 0 ? (bouncedCount / recipientCount) * 100 : 0,
    }

    return { success: true, analytics }
  } catch (error) {
    console.error("[AI Newsletter] Analytics error:", error)
    return handleError(error, "getNewsletterAnalytics")
  }
}

// ============================================
// 8. AI PERFORMANCE ANALYZER
// ============================================
export async function aiAnalyzeNewsletterPerformance(params: { agentId?: string /* ignored — derived from session */; brokerageId?: string /* ignored — derived from session */; newsletterId?: string }) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const sessionBrokerageId = ctx.brokerageId
    const sessionUserId = ctx.userId
    const sessionAgentId = ctx.agentId

    const supabase = await createClient()

    // If a specific newsletterId is provided, verify ownership before analyzing
    if (params.newsletterId) {
      if (!isValidUUID(params.newsletterId)) {
        return { success: false, error: "Invalid newsletter ID" }
      }
      const { data: ownershipRow } = await supabase
        .from("newsletter_campaigns")
        .select("brokerage_id")
        .eq("id", params.newsletterId)
        .maybeSingle()
      if (!ownershipRow || ownershipRow.brokerage_id !== sessionBrokerageId) {
        return { success: false, error: "Forbidden" }
      }
    }

    // Get historical performance. Same class rule as above — newsletter_campaigns
    // .agent_id is agents-class, and the session users id is not a substitute for
    // a missing agents row.
    let sends: Array<Record<string, unknown>> | null = null
    if (sessionAgentId) {
      // LITERAL columns, not "*" (both sides of the embed). The census cannot
      // see through a star, and this exact table is where the sibling defect
      // lived: getNewsletterAnalytics read five phantom columns
      // (opened_count/delivered_count/…) through a select("*") that refused
      // nothing — every metric came back undefined and rendered as 0% forever
      // (see the tombstone at the METRICS block above, ~:1209). Every column
      // named here exists live per scripts/schema-snapshot.ts
      // (newsletter_scheduled_sends :443, newsletter_campaigns :441).
      const { data, error: sendsErr } = await supabase
        .from("newsletter_scheduled_sends")
        .select(
          // unsubscribe_rate is DELIBERATELY absent from the embed: nothing
          // writes it — the engagement rollup stamps only open_rate/click_rate,
          // and this file's own getNewsletterAnalytics already returns
          // unsubscribed as an honest NULL because no per-campaign unsubscribe
          // fact exists in this schema (newsletter_subscribers.status flips
          // globally). Selecting a column no writer fills hands the model a
          // permanent zero dressed as a measurement (census 1b).
          "subject_line, preview_text, sent_time, scheduled_time, send_status, recipient_segment, recipient_count, ab_test_variant, newsletter:newsletter_campaigns!inner(campaign_name, subject_line, open_rate, click_rate, status, send_date)"
        )
        .eq("newsletter.agent_id", sessionAgentId)
        .eq("newsletter.brokerage_id", sessionBrokerageId)
        .order("sent_time", { ascending: false })
        .limit(20)
      if (sendsErr) console.error("[ai-newsletter] performance history read failed:", sendsErr.message)
      sends = data as Array<Record<string, unknown>> | null
    }

    const { object: analysis } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        overallPerformance: z.enum(["excellent", "good", "average", "needs_improvement"]),
        averageOpenRate: z.number(),
        averageClickRate: z.number(),
        trends: z.array(
          z.object({
            metric: z.string(),
            trend: z.enum(["improving", "stable", "declining"]),
            insight: z.string(),
          })
        ),
        topPerformingSubjects: z.array(z.string()),
        recommendations: z.array(
          z.object({
            area: z.string(),
            recommendation: z.string(),
            expectedImpact: z.string(),
          })
        ),
        nextActions: z.array(z.string()),
      }),
      prompt: `Analyze newsletter performance for this real estate agent.

Recent Sends: ${JSON.stringify(sends?.slice(0, 10) || [])}

Provide:
1. Overall performance assessment
2. Key trends
3. What's working well
4. Specific recommendations for improvement
5. Action items`,
    })

    return { success: true, analysis }
  } catch (error) {
    console.error("[AI Newsletter] Performance analysis error:", error)
    return handleError(error, "aiAnalyzeNewsletterPerformance")
  }
}

// ============================================
// 9. MANAGE SUBSCRIBERS
// ============================================
export async function manageSubscribers(params: {
  action: "add" | "remove" | "unsubscribe"
  email: string
  agentId?: string // ignored — derived from session
  brokerageId?: string // ignored — derived from session
  source?: string
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const sessionBrokerageId = ctx.brokerageId
    const sessionAgentId = ctx.agentId

    // newsletter_subscribers.agent_id is agents-class — a users id here is an FK
    // violation on insert and a no-match on update, both of which supabase-js
    // reports as an ordinary empty result.
    if (!sessionAgentId) {
      return { success: false, error: "No agent profile for this user in this brokerage — subscribers have no owner to file under." }
    }

    // The live UNIQUE is `newsletter_subscribers_brokerage_id_email_key
    // (brokerage_id, email)` — on the RAW email column. Without normalising,
    // "Bob@Example.com" and "bob@example.com" are two accepted rows for one
    // person, and that person then receives every newsletter twice. Normalise
    // before the constraint sees it.
    const email = String(params.email ?? "").trim().toLowerCase()
    if (!isValidEmail(email)) {
      return { success: false, error: "Enter a valid email address" }
    }

    const supabase = await createClient()

    if (params.action === "add") {
      // `source` has a live CHECK constraint; a value outside the vocabulary is
      // a 23514 the caller would see as an opaque database error.
      const ALLOWED_SOURCES = [
        "manual", "import", "form", "open_house", "qr_scan",
        "portal", "auto_lead_capture", "auto_contact", "auto_lifetime",
      ]
      const source = ALLOWED_SOURCES.includes(params.source ?? "") ? params.source! : "manual"

      const { data, error } = await supabase.from("newsletter_subscribers").insert({
        email,
        agent_id: sessionAgentId,
        brokerage_id: sessionBrokerageId,
        subscribed_at: new Date().toISOString(),
        source,
        status: "subscribed",
      })

      if (error) {
        // 23505 = the (brokerage_id, email) UNIQUE. That is the ordinary
        // "already on the list" case — including someone who UNSUBSCRIBED.
        // Re-subscribing an opt-out must be a deliberate act, so this reports
        // the state rather than flipping the row back to 'subscribed'.
        if ((error as { code?: string }).code === "23505") {
          return { success: false, error: "That email is already on this brokerage's list." }
        }
        throw error
      }
      revalidatePath("/content-studio")

      return { success: true, subscriber: data }
    }

    if (params.action === "unsubscribe" || params.action === "remove") {
      const { error } = await supabase
        .from("newsletter_subscribers")
        .update({ status: "unsubscribed", unsubscribed_at: new Date().toISOString() })
        .eq("email", email)
        .eq("agent_id", sessionAgentId)
        .eq("brokerage_id", sessionBrokerageId)

      if (error) throw error
      revalidatePath("/content-studio")

      return { success: true, message: "Subscriber removed" }
    }

    return { success: false, error: "Invalid action" }
  } catch (error) {
    return handleError(error, "manageSubscribers")
  }
}

export async function getNewsletters(_agentId?: string /* ignored — derived from session */) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const sessionBrokerageId = ctx.brokerageId

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("newsletter_campaigns")
      .select("*")
      .eq("brokerage_id", sessionBrokerageId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, newsletters: data || [] }
  } catch (error) {
    return handleError(error, "getNewsletters")
  }
}

/**
 * Delete a newsletter campaign.
 *
 * The newsletter list's Delete button called deleteEmailCampaign, which queries
 * `email_campaigns` by a `newsletter_campaigns` id — so it answered "Campaign
 * not found" every time and nothing on this screen could ever be deleted. That
 * is the third button on one screen pointed at the wrong table (Send and
 * Schedule were the other two): every action was written against the email
 * campaign lane while the list itself renders newsletter campaigns.
 *
 * Guards mirror deleteEmailCampaign — uuid, session brokerage ownership, and a
 * refusal on anything already sent — plus 'sending', because a campaign the
 * cron is mid-loop on must not have its row pulled out from under it.
 *
 * Hard delete is correct here: every child FK (newsletter_sections,
 * newsletter_scheduled_sends, newsletter_local_content, newsletter_video_renders)
 * is ON DELETE CASCADE, and the sent-campaign refusal means no delivery record
 * can be destroyed by it.
 */
export async function deleteNewsletterCampaign(newsletterId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const sessionBrokerageId = ctx.brokerageId

    if (!isValidUUID(newsletterId)) {
      return { success: false, error: "Invalid newsletter ID" }
    }

    const supabase = await createClient()

    const { data: existing, error: existingError } = await supabase
      .from("newsletter_campaigns")
      .select("id, status, brokerage_id")
      .eq("id", newsletterId)
      .maybeSingle()

    if (existingError) {
      return { success: false, error: `Could not read the newsletter: ${existingError.message}` }
    }
    if (!existing) return { success: false, error: "Newsletter not found" }
    if (existing.brokerage_id !== sessionBrokerageId) {
      return { success: false, error: "Forbidden" }
    }
    if (existing.status === "sent") {
      return { success: false, error: "Cannot delete a sent newsletter — its delivery record has to survive." }
    }
    if (existing.status === "sending") {
      return { success: false, error: "This newsletter is being sent right now — wait for it to finish." }
    }

    const { error } = await supabase
      .from("newsletter_campaigns")
      .delete()
      .eq("id", newsletterId)
      .eq("brokerage_id", sessionBrokerageId)

    if (error) {
      return { success: false, error: `Failed to delete the newsletter: ${error.message}` }
    }

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteNewsletterCampaign")
  }
}

// TOMBSTONE (§6 one-vocabulary, lane E2 2026-08-28) — the "backward
// compatibility" aliases `createNewsletter` and `generateNewsletterContent`
// were deleted. They were duplicate SPELLINGS of the canonical names in this
// file — SURVIVORS: `createNewsletterCampaign` (above) and
// `aiWriteNewsletterContent` (above). A stripped-source census found zero
// callers of either alias outside the the actions barrel (app/actions/index, deleted this wave) barrel, which
// itself has zero importers.

// ============================================
// WORKFLOW OS — queue newsletter for a single contact
// ============================================
/**
 * Queue a newsletter send to a specific contact.
 * Used by the workflow OS newsletter channel adapter.
 *
 * Creates a single-recipient newsletter_sends row so the send is tracked,
 * then dispatches via the platform email layer.
 */
export async function queueNewsletterForContact(params: {
  brokerageId: string
  contactId: string
  templateId?: string
  sectionIds?: string[]
  subject?: string
  customBody?: string
}): Promise<{ success: boolean; newsletterId?: string; error?: string }> {
  try {
    const supabase = await createClient()

    // Resolve contact's email + name
    const { data: contact, error: cErr } = await supabase
      .from("contacts")
      .select("id, email, first_name, last_name")
      .eq("id", params.contactId)
      .maybeSingle()

    if (cErr || !contact?.email) {
      return { success: false, error: "Contact not found or has no email" }
    }

    // Build or fetch newsletter content
    let html = params.customBody ?? ""
    let subject = params.subject ?? "Your Newsletter"

    if (!html && params.templateId) {
      const { data: tmpl } = await supabase
        .from("newsletter_templates")
        .select("content, subject_line")
        .eq("id", params.templateId)
        .maybeSingle()
      if (tmpl) {
        html = typeof tmpl.content === "string" ? tmpl.content : JSON.stringify(tmpl.content)
        subject = params.subject ?? (tmpl as any).subject_line ?? subject
      }
    }

    // IDEMPOTENCY ON (contact, template) — the reader for newsletter_sends.
    // template_id. A workflow step re-fired for the same contact (a retry, a
    // re-enrollment, two sequences sharing a template) used to mail the same
    // newsletter again; the column that could have told us was written here
    // and read nowhere. Same shape as the per-campaign check in
    // app/api/cron/publish-newsletters/route.ts:445, keyed on the template
    // because a workflow send has no campaign. Seven days: a template that
    // legitimately goes out weekly is not a duplicate the following week.
    if (params.templateId) {
      const dupSince = new Date(Date.now() - 7 * 86_400_000).toISOString()
      const { data: prior, error: priorErr } = await supabase
        .from("newsletter_sends")
        .select("id")
        .eq("brokerage_id", params.brokerageId)
        .eq("contact_id", params.contactId)
        .eq("template_id", params.templateId)
        .in("status", ["sent", "opened", "clicked"])
        .gte("sent_at", dupSince)
        .limit(1)
        .maybeSingle()
      if (priorErr) {
        // A refused check is not "no duplicate" — say so, but a read refusal
        // must not block a send the workflow owes the contact.
        console.error("[queueNewsletterForContact] duplicate check refused, sending anyway:", priorErr.message)
      } else if (prior?.id) {
        return { success: true, newsletterId: prior.id as string }
      }
    }

    // Record the send intent. `subject` is NOT written here (wave 26, §1
    // duplicate): it is newsletter_templates.subject_line, read at :1802 via
    // the template_id this row keeps, or the step's own override, which the
    // dispatch ledger records as vendor_usage_tracking.metadata.subject
    // (lib/providers/dispatch.ts:515).
    const { data: sendRow, error: insertErr } = await supabase
      .from("newsletter_sends")
      .insert({
        brokerage_id: params.brokerageId,
        contact_id: params.contactId,
        template_id: params.templateId ?? null,
        status: "queued",
        queued_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle()

    if (insertErr) {
      // §3: a refused insert used to be silent. The send still goes out, but
      // the ledger row that the queue-latency rollup and the duplicate check
      // above depend on does not exist, and that must be visible in the log.
      console.error("[queueNewsletterForContact] newsletter_sends insert refused, send untracked:", insertErr.message)
    }

    const newsletterId = sendRow?.id ?? `nws-${Date.now()}`

    // Dispatch via platform email
    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const result = await dispatchEmail({
      brokerageId: params.brokerageId,
      systemSource: "newsletter",
      contactId: params.contactId,
      from: "newsletter@platform.com",
      to: contact.email,
      subject,
      html: html || `<p>Hi ${contact.first_name ?? "there"},</p><p>Your newsletter is ready.</p>`,
    })

    // Update send status. sent_at ONLY on success: engagement-rollup counts the
    // delivered denominator as `sent_at IS NOT NULL` and the queue→send latency
    // as queued_at→sent_at, so stamping a failed send here inflated both.
    if (sendRow?.id) {
      void Promise.resolve(
        supabase
          .from("newsletter_sends")
          .update({
            status: result.success ? "sent" : "failed",
            ...(result.success && { sent_at: new Date().toISOString() }),
          })
          .eq("id", sendRow.id)
      ).catch(() => {})
    }

    return { success: result.success, newsletterId, error: result.error }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

export async function manageSubscriberBatch(params: {
  action: "add" | "remove" | "update_segment"
  contactIds: string[]
  agentId?: string // ignored — derived from session
  brokerageId?: string // ignored — derived from session
  segment?: string
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const sessionBrokerageId = ctx.brokerageId
    const sessionAgentId = ctx.agentId

    // Same class rule as manageSubscribers — newsletter_subscribers.agent_id is
    // agents-class, so a missing agents profile is a refusal, not a users id.
    if (!sessionAgentId) {
      return { success: false, error: "No agent profile for this user in this brokerage — subscribers have no owner to file under." }
    }

    // `contactIds` is a caller-supplied array driving one round trip per entry
    // (a scope read plus a write). Unbounded, this endpoint is an amplification
    // primitive: one request becomes arbitrarily many sequential queries. Cap
    // it and de-duplicate — the same id twice was two round trips for one row.
    const MAX_BATCH = 500
    const requestedIds = Array.isArray(params.contactIds) ? params.contactIds : []
    if (requestedIds.length > MAX_BATCH) {
      return {
        success: false,
        error: `Select ${MAX_BATCH} contacts or fewer per batch (received ${requestedIds.length}).`,
      }
    }
    const contactIds = Array.from(new Set(requestedIds))

    const supabase = await createClient()
    let affected = 0
    /** Contacts that were deliberately not subscribed, with the reason. */
    const skipped: Array<{ contactId: string; reason: string }> = []

    for (const contactId of contactIds) {
      if (!isValidUUID(contactId)) {
        skipped.push({ contactId, reason: "not a valid contact id" })
        continue
      }

      // Verify the contact belongs to the session brokerage before mutating
      // subscription — AND read the columns the write actually needs.
      //
      // THIS SELECT USED TO BE `brokerage_id` ALONE, and the "add" branch below
      // then upserted a row with NO `email`. `newsletter_subscribers.email` is
      // NOT NULL (verified live), so EVERY batch add was rejected by the
      // database — and the upsert's error was never destructured while
      // `affected++` ran unconditionally, so this action reported "47 contacts
      // added" over 47 rows that do not exist. The name and opt-out flag are
      // read for the same reason the auto-enrolment lane reads them
      // (lib/content/newsletter-enrollment.ts): a subscriber row with no name is
      // a worse row, and mailing an opted-out contact is a CAN-SPAM problem, not
      // a preference.
      const { data: contactRow, error: contactErr } = await supabase
        .from("contacts")
        .select("brokerage_id, email, email_opt_out, first_name, last_name")
        .eq("id", contactId)
        .maybeSingle()
      if (contactErr) {
        skipped.push({ contactId, reason: `could not be read: ${contactErr.message}` })
        continue
      }
      if (!contactRow || contactRow.brokerage_id !== sessionBrokerageId) {
        skipped.push({ contactId, reason: "not in your brokerage" })
        continue
      }

      const email = String(contactRow.email ?? "").trim().toLowerCase()

      if (params.action === "add") {
        if (!isValidEmail(email)) {
          skipped.push({ contactId, reason: "no usable email address on the contact" })
          continue
        }
        if (contactRow.email_opt_out === true) {
          skipped.push({ contactId, reason: "contact has opted out of email" })
          continue
        }

        // NEVER RE-SUBSCRIBE AN OPT-OUT. Same rule the automatic enrolment lane
        // enforces: an unsubscribe is a decision the person made, and an
        // upsert would silently flip it back to 'subscribed'.
        const { data: existing, error: existingErr } = await supabase
          .from("newsletter_subscribers")
          .select("id, status")
          .eq("brokerage_id", sessionBrokerageId)
          .eq("email", email)
          .maybeSingle()
        if (existingErr) {
          skipped.push({ contactId, reason: `subscription state unreadable: ${existingErr.message}` })
          continue
        }
        if (existing?.status === "unsubscribed") {
          skipped.push({ contactId, reason: "previously unsubscribed — re-subscribing must be deliberate" })
          continue
        }

        // onConflict names the REAL unique — newsletter_subscribers_brokerage_id_email_key
        // (brokerage_id, email). Without it the upsert conflicts on the primary
        // key only, which a new row never collides on, so a second run inserted
        // a duplicate instead of updating.
        const { error: upsertErr } = await supabase
          .from("newsletter_subscribers")
          .upsert(
            {
              agent_id: sessionAgentId,
              brokerage_id: sessionBrokerageId,
              contact_id: contactId,
              email,
              first_name: contactRow.first_name ?? null,
              last_name: contactRow.last_name ?? null,
              status: "subscribed",
              source: "manual",
              ...(existing ? {} : { subscribed_at: new Date().toISOString() }),
            },
            { onConflict: "brokerage_id,email" },
          )
        if (upsertErr) {
          skipped.push({ contactId, reason: upsertErr.message })
          continue
        }
        affected++
      } else if (params.action === "remove") {
        // Count what the database actually changed. A zero-row update is not a
        // removal, and `affected++` on an unchecked update was reporting one.
        const { data: removed, error: removeErr } = await supabase
          .from("newsletter_subscribers")
          .update({ status: "unsubscribed", unsubscribed_at: new Date().toISOString() })
          .eq("contact_id", contactId)
          .eq("agent_id", sessionAgentId)
          .eq("brokerage_id", sessionBrokerageId)
          .select("id")
        if (removeErr) {
          skipped.push({ contactId, reason: removeErr.message })
          continue
        }
        if (!removed || removed.length === 0) {
          skipped.push({ contactId, reason: "was not on your list" })
          continue
        }
        affected += removed.length
      } else if (params.action === "update_segment" && params.segment) {
        // Segments are not modeled on newsletter_subscribers (audience targeting lives at the
        // newsletter_sections level via target_personas/target_locations). No-op rather than write a
        // phantom column.
        skipped.push({ contactId, reason: "segments are not stored on subscribers" })
      }
    }

    revalidatePath("/content-studio")
    revalidatePath("/newsletters")

    return { success: true, affected, skipped }
  } catch (error) {
    console.error("[AI Newsletter] Subscriber management error:", error)
    return handleError(error, "manageSubscriberBatch")
  }
}
