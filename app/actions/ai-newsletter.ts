"use server"

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// ============================================
// AI NEWSLETTER SYSTEM
// Complete email newsletter management with
// AI-powered content generation, A/B testing,
// and send time optimization
// ============================================

interface NewsletterSection {
  type: "hero" | "featured_listings" | "market_update" | "tips" | "testimonial" | "cta" | "custom"
  title: string
  content: string
  imageUrl?: string
  listings?: any[]
  ctaText?: string
  ctaUrl?: string
}

interface NewsletterTemplate {
  id: string
  name: string
  style: "modern" | "classic" | "minimal" | "luxury"
  sections: string[]
  primaryColor: string
  fontFamily: string
}

const NEWSLETTER_TEMPLATES: NewsletterTemplate[] = [
  {
    id: "modern",
    name: "Modern Real Estate",
    style: "modern",
    sections: ["hero", "featured_listings", "market_update", "tips", "cta"],
    primaryColor: "#2563eb",
    fontFamily: "Inter, sans-serif",
  },
  {
    id: "luxury",
    name: "Luxury Collection",
    style: "luxury",
    sections: ["hero", "featured_listings", "testimonial", "cta"],
    primaryColor: "#1e3a5f",
    fontFamily: "Playfair Display, serif",
  },
  {
    id: "minimal",
    name: "Clean & Simple",
    style: "minimal",
    sections: ["hero", "market_update", "tips", "cta"],
    primaryColor: "#374151",
    fontFamily: "system-ui, sans-serif",
  },
]

// ============================================
// 1. AI SUBJECT LINE GENERATOR
// ============================================
export async function aiGenerateSubjectLines(params: {
  agentId?: string // ignored — derived from session
  brokerageId?: string // ignored — derived from session
  newsletterTopic: string
  audience?: "all" | "buyers" | "sellers" | "investors" | "lifetime_customers"
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
        .select("first_name, last_name, full_name")
        .eq("user_id", sessionUserId)
        .maybeSingle(),
    ])

    const city = brokerageData?.city ?? brokerageData?.state ?? "your area"
    const brokerageName = brokerageData?.name ?? "our brokerage"
    const agentName =
      agentData?.full_name ??
      (agentData?.first_name
        ? `${agentData.first_name} ${agentData.last_name ?? ""}`.trim()
        : "your agent")

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

    // Get agent's brand voice
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", sessionAgentId ?? sessionUserId)
      .maybeSingle()

    const template = NEWSLETTER_TEMPLATES.find((t) => t.id === (params.template ?? "modern")) || NEWSLETTER_TEMPLATES[0]

    const { object: content } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        sections: z.array(
          z.object({
            type: z.string(),
            title: z.string(),
            content: z.string(),
            ctaText: z.string().optional(),
            ctaUrl: z.string().optional(),
          })
        ),
        estimatedReadTime: z.number(),
        wordCount: z.number(),
      }),
      prompt: `Write newsletter content for a real estate agent.

Template Style: ${template.style}
Topic: ${params.topic}
Sections needed: ${template.sections.join(", ")}
${brandVoice ? `Brand Voice: ${brandVoice.tone}, ${brandVoice.style}` : ""}

${params.featuredListings?.length ? `Featured Listings: ${JSON.stringify(params.featuredListings)}` : ""}
${params.marketStats ? `Market Stats: ${JSON.stringify(params.marketStats)}` : ""}

Write engaging content for each section. Keep paragraphs short and scannable.
Include clear CTAs where appropriate.`,
    })

    // Apply brand voice to generated content
    const brandedSections = await Promise.all(
      content.sections.map(async (section: any) => {
        const branded = await applyBrandVoice({
          brokerageId: sessionBrokerageId,
          actorUserId: sessionAgentId ?? sessionUserId,
          actorRole: "agent",
          journeyType: "seller",
          persona: "seller",
          messageType: "email",
          content: section.content,
        })
        return { ...section, content: branded.content || section.content }
      })
    )

    // Run compliance check on all content
    for (const section of brandedSections) {
      const compliance = await evaluateOutbound({
        actorContext: { userId: sessionAgentId ?? sessionUserId, role: "agent", brokerageId: sessionBrokerageId },
        journeyType: "buyer",
        persona: "first_time",
        messageType: "email",
        content: section.content,
        contact: {
          id: "broadcast",
          first_name: "Subscriber",
          last_name: "Audience",
          contact_type: "buyer",
          tcpa_consent: true,
          isa_reengage_allowed: false,
          dnc_status: false,
        },
      }).catch(() => ({ allowed: true, violations: [] as string[] }))
      if (!compliance.allowed) {
        return { success: false, error: `Compliance violation in ${section.type}: ${compliance.violations.join(", ")}` }
      }
    }

    await incrementFeatureUsage(sessionAgentId ?? sessionUserId, "newsletter_engine")

    // Build a flat HTML string from sections for display with dangerouslySetInnerHTML
    const flatContent = brandedSections
      .map(
        (s: any) =>
          `<section style="margin-bottom:1.5rem">` +
          `<h2 style="font-size:1.1rem;font-weight:600;margin-bottom:0.5rem">${escapeHtml(s.title)}</h2>` +
          `<div style="line-height:1.6"><p>${escapeHtml(s.content).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p></div>` +
          (s.ctaText
            ? `<p style="margin-top:0.75rem"><strong>${escapeHtml(s.ctaText)}</strong></p>`
            : "") +
          `</section>`
      )
      .join('<hr style="margin:1.5rem 0;border-color:#e5e7eb">')

    return {
      success: true,
      /** Flat markdown string — used by content-studio-client for display/editing */
      content: flatContent,
      /** Structured sections — used by newsletter campaign builder */
      sections: brandedSections,
      estimatedReadTime: (content as any).estimatedReadTime ?? null,
      wordCount: (content as any).wordCount ?? null,
    }
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

    // Get historical email performance
    const { data: emailStats } = await supabase
      .from("newsletter_scheduled_sends")
      .select("sent_at, open_rate, click_rate")
      .eq("agent_id", sessionAgentId ?? sessionUserId)
      .order("sent_at", { ascending: false })
      .limit(50)

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

    // Get contact data
    const { data: contact } = await supabase
      .from("contacts")
      .select("*, interactions(*), saved_searches(*)")
      .eq("id", params.contactId)
      .eq("brokerage_id", sessionBrokerageId)
      .maybeSingle()

    // Get newsletter content
    const { data: newsletter } = await supabase
      .from("newsletter_campaigns")
      .select("*")
      .eq("id", params.newsletterId)
      .eq("brokerage_id", sessionBrokerageId)
      .maybeSingle()

    if (!contact || !newsletter) {
      return { success: false, error: "Contact or newsletter not found" }
    }

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
- Persona: ${contact.persona || "general"}
- Interests: ${contact.saved_searches?.map((s: any) => s.criteria).join(", ") || "Unknown"}
- Last Interaction: ${contact.interactions?.[0]?.notes || "None"}

Newsletter Topic: ${newsletter.topic}

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

    // STEP 1: Resolve agents.id from users.id (required for agent_id FK)
    let agentsTableId: string | null = sessionAgentId
    if (!agentsTableId) {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", sessionUserId)
        .maybeSingle()
      agentsTableId = agentRow?.id ?? null
    }

    // STEP 2: Fix the insert payload with correct field names and values
    const { data: newsletter, error } = await supabase
      .from("newsletter_campaigns")
      .insert({
        campaign_name: params.title, // campaign_name NOT title
        subject_line: params.subjectLine,
        preheader_text: params.preheaderText,
        template_id: params.template,
        content: params.content,
        audience_segment: params.audienceSegment,
        status: params.scheduledAt ? "scheduled" : "draft",
        send_date: params.scheduledAt ?? null, // send_date NOT scheduled_at
        brokerage_id: sessionBrokerageId, // session-derived
        agent_id: agentsTableId, // agents.id NOT users.id
        created_by: sessionUserId, // users.id
      })
      .select()
      .maybeSingle()

    if (error || !newsletter) throw error ?? new Error("Failed to create newsletter campaign")

    // STEP 3: Fix newsletter_subscribers query — use agents.id not users.id
    const { count } = await supabase
      .from("newsletter_subscribers")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentsTableId) // agents.id NOT params.agentId
      .eq("segment", params.audienceSegment)
      .eq("subscribed", true)

    // Kernel: Fire NEWSLETTER_SCHEDULED if scheduled
    if (params.scheduledAt && newsletter) {
      processKernelEvent({
        event: KernelEvent.NEWSLETTER_SCHEDULED,
        brokerageId: sessionBrokerageId,
        entityType: "newsletter_campaign",
        entityId: newsletter.id,
      }).catch((err) => console.error("[Kernel] NEWSLETTER_SCHEDULED error:", err))
    }

    await incrementFeatureUsage(sessionAgentId ?? sessionUserId, "newsletter_engine")

    revalidatePath("/content-studio")
    revalidatePath("/dashboard/marketing/studio")

    return {
      success: true,
      newsletter,
      audienceSize: count || 0,
    }
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
      .eq("agent_id", sessionAgentId ?? sessionUserId)
      .eq("status", "active")

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
        await supabase.from("newsletter_sends").insert({
          brokerage_id:        sessionBrokerageId,
          campaign_id:         params.newsletterId,
          contact_id:          subscriber.contact_id ?? null,
          template_id:         null,
          subject:             assembled.subject,
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

    const { data: send } = await supabase
      .from("newsletter_scheduled_sends")
      .select("*")
      .eq("newsletter_id", params.newsletterId)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!send) {
      return { success: true, analytics: null, message: "Newsletter not yet sent" }
    }

    // Calculate metrics
    const analytics = {
      recipientCount: send.recipient_count,
      delivered: send.delivered_count || 0,
      opened: send.opened_count || 0,
      clicked: send.clicked_count || 0,
      bounced: send.bounced_count || 0,
      unsubscribed: send.unsubscribed_count || 0,
      openRate: send.recipient_count > 0 ? ((send.opened_count || 0) / send.recipient_count) * 100 : 0,
      clickRate: send.opened_count > 0 ? ((send.clicked_count || 0) / send.opened_count) * 100 : 0,
      bounceRate: send.recipient_count > 0 ? ((send.bounced_count || 0) / send.recipient_count) * 100 : 0,
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

    // Get historical performance
    const { data: sends } = await supabase
      .from("newsletter_scheduled_sends")
      .select("*, newsletter:newsletter_campaigns!inner(*)")
      .eq("agent_id", sessionAgentId ?? sessionUserId)
      .eq("newsletter.brokerage_id", sessionBrokerageId)
      .order("sent_at", { ascending: false })
      .limit(20)

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
    const sessionUserId = ctx.userId
    const sessionAgentId = ctx.agentId

    const supabase = await createClient()

    if (params.action === "add") {
      const { data, error } = await supabase.from("newsletter_subscribers").insert({
        email: params.email,
        agent_id: sessionAgentId ?? sessionUserId,
        brokerage_id: sessionBrokerageId,
        subscribed_at: new Date().toISOString(),
        source: params.source || "manual",
        status: "active",
      })

      if (error) throw error
      revalidatePath("/content-studio")

      return { success: true, subscriber: data }
    }

    if (params.action === "unsubscribe" || params.action === "remove") {
      const { error } = await supabase
        .from("newsletter_subscribers")
        .update({ status: "unsubscribed", unsubscribed_at: new Date().toISOString() })
        .eq("email", params.email)
        .eq("agent_id", sessionAgentId ?? sessionUserId)
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

// Backward compatibility aliases — wrapped because "use server" rejects `const = fn`
export async function createNewsletter(...args: Parameters<typeof createNewsletterCampaign>) {
  return createNewsletterCampaign(...args)
}
export async function generateNewsletterContent(...args: Parameters<typeof aiWriteNewsletterContent>) {
  return aiWriteNewsletterContent(...args)
}

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

    // Record the send intent
    const { data: sendRow, error: insertErr } = await supabase
      .from("newsletter_sends")
      .insert({
        brokerage_id: params.brokerageId,
        contact_id: params.contactId,
        template_id: params.templateId ?? null,
        subject,
        status: "queued",
        queued_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle()

    if (insertErr) {
      // newsletter_sends may not exist yet — proceed without tracking
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

    // Update send status
    if (sendRow?.id) {
      void Promise.resolve(
        supabase
          .from("newsletter_sends")
          .update({ status: result.success ? "sent" : "failed", sent_at: new Date().toISOString() })
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
    const sessionUserId = ctx.userId
    const sessionAgentId = ctx.agentId

    const supabase = await createClient()
    let affected = 0

    for (const contactId of params.contactIds) {
      if (!isValidUUID(contactId)) continue

      // Verify the contact belongs to the session brokerage before mutating subscription
      const { data: contactRow } = await supabase
        .from("contacts")
        .select("brokerage_id")
        .eq("id", contactId)
        .maybeSingle()
      if (!contactRow || contactRow.brokerage_id !== sessionBrokerageId) {
        continue
      }

      if (params.action === "add") {
        await supabase.from("newsletter_subscribers").upsert({
          agent_id: sessionAgentId ?? sessionUserId,
          brokerage_id: sessionBrokerageId,
          contact_id: contactId,
          segment: params.segment || "all",
          subscribed: true,
          subscribed_at: new Date().toISOString(),
        })
        affected++
      } else if (params.action === "remove") {
        await supabase
          .from("newsletter_subscribers")
          .update({ subscribed: false, unsubscribed_at: new Date().toISOString() })
          .eq("contact_id", contactId)
          .eq("agent_id", sessionAgentId ?? sessionUserId)
          .eq("brokerage_id", sessionBrokerageId)
        affected++
      } else if (params.action === "update_segment" && params.segment) {
        await supabase
          .from("newsletter_subscribers")
          .update({ segment: params.segment })
          .eq("contact_id", contactId)
          .eq("agent_id", sessionAgentId ?? sessionUserId)
          .eq("brokerage_id", sessionBrokerageId)
        affected++
      }
    }

    revalidatePath("/content-studio")

    return { success: true, affected }
  } catch (error) {
    console.error("[AI Newsletter] Subscriber management error:", error)
    return handleError(error, "manageSubscriberBatch")
  }
}
