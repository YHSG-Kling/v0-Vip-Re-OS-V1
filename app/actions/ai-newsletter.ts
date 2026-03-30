"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
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
  agentId: string
  brokerageId: string
  newsletterTopic: string
  audience?: "all" | "buyers" | "sellers" | "investors" | "past_clients"
  tone?: "professional" | "friendly" | "urgent" | "curious"
  includeEmoji?: boolean
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    // Kernel: Feature access check
    const access = await canAccessFeature("newsletter_engine", params.brokerageId, params.agentId)
    if (!access.allowed) {
      return { success: false, error: access.reason || "Feature not available" }
    }

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

Create:
1. A primary subject line with preheader text
2. 4 alternative variants with different approaches
3. A/B test recommendation

Best practices:
- Keep under 50 characters
- Create urgency or curiosity
- Personalization tokens allowed: {{first_name}}, {{city}}
- Avoid spam trigger words`,
    })

    return { success: true, subjectLines }
  } catch (error) {
    console.error("[AI Newsletter] Subject line error:", error)
    return handleError(error, "aiGenerateSubjectLines")
  }
}

// ============================================
// 2. AI NEWSLETTER CONTENT WRITER
// ============================================
export async function aiWriteNewsletterContent(params: {
  agentId: string
  brokerageId: string
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
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    // Kernel: Feature access check
    const access = await canAccessFeature("newsletter_engine", params.brokerageId, params.agentId)
    if (!access.allowed) {
      return { success: false, error: access.reason || "Feature not available" }
    }

    const supabase = await createClient()

    // Get agent's brand voice
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", params.agentId)
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
          brokerageId: params.brokerageId,
          agentId: params.agentId,
          content: section.content,
          contentType: "newsletter",
        })
        return { ...section, content: branded.brandedContent || section.content }
      })
    )

    // Run compliance check on all content
    for (const section of brandedSections) {
      const compliance = await evaluateOutbound({
        actorContext: { userId: params.agentId, role: "agent", brokerageId: params.brokerageId },
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

    await incrementFeatureUsage("newsletter_engine", params.brokerageId, params.agentId)

    // Build a flat markdown string from sections for simple display
    const flatContent = brandedSections
      .map((s: any) => `## ${s.title}\n\n${s.content}${s.ctaText ? `\n\n**${s.ctaText}**` : ""}`)
      .join("\n\n---\n\n")

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
  agentId: string
  audienceSegment: string
  historicalData?: any[]
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Get historical email performance
    const { data: emailStats } = await supabase
      .from("newsletter_scheduled_sends")
      .select("sent_at, open_rate, click_rate")
      .eq("agent_id", params.agentId)
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
  agentId: string
  newsletterId: string
  contactId: string
}) {
  try {
    if (!isValidUUID(params.agentId) || !isValidUUID(params.contactId)) {
      return { success: false, error: "Invalid IDs" }
    }

    const supabase = await createClient()

    // Get contact data
    const { data: contact } = await supabase
      .from("contacts")
      .select("*, interactions(*), saved_searches(*)")
      .eq("id", params.contactId)
      .maybeSingle()

    // Get newsletter content
    const { data: newsletter } = await supabase
      .from("newsletter_campaigns")
      .select("*")
      .eq("id", params.newsletterId)
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
        dynamicContent: z.record(z.string()),
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
  agentId: string
  brokerageId: string
  title: string
  subjectLine: string
  preheaderText: string
  template: string
  content: NewsletterSection[]
  audienceSegment: string
  scheduledAt?: string
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    // Kernel: Feature access check
    const access = await canAccessFeature("newsletter_engine", params.brokerageId, params.agentId)
    if (!access.allowed) {
      return { success: false, error: access.reason || "Feature not available" }
    }

    const supabase = await createClient()

    const { data: newsletter, error } = await supabase
      .from("newsletter_campaigns")
      .insert({
        agent_id: params.agentId,
        title: params.title,
        subject_line: params.subjectLine,
        preheader_text: params.preheaderText,
        template_id: params.template,
        content: params.content,
        audience_segment: params.audienceSegment,
        status: params.scheduledAt ? "scheduled" : "draft",
        scheduled_at: params.scheduledAt,
      })
      .select()
      .maybeSingle()

    if (error || !newsletter) throw error ?? new Error("Failed to create newsletter campaign")

    // Get subscriber count
    const { count } = await supabase
      .from("newsletter_subscribers")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", params.agentId)
      .eq("segment", params.audienceSegment)
      .eq("subscribed", true)

    // Kernel: Fire NEWSLETTER_SCHEDULED if scheduled
    if (params.scheduledAt && newsletter) {
      processKernelEvent({
        event: KernelEvent.NEWSLETTER_SCHEDULED,
        brokerageId: params.brokerageId,
        entityType: "newsletter_campaign",
        entityId: newsletter.id,
      }).catch((err) => console.error("[Kernel] NEWSLETTER_SCHEDULED error:", err))
    }

    await incrementFeatureUsage("newsletter_engine", params.brokerageId, params.agentId)

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
export async function sendNewsletter(params: { newsletterId: string; agentId: string; brokerageId: string }) {
  try {
    if (!isValidUUID(params.newsletterId) || !isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // Kernel: Feature access check
    const access = await canAccessFeature("newsletter_engine", params.brokerageId, params.agentId)
    if (!access.allowed) {
      return { success: false, error: access.reason || "Feature not available" }
    }

    const supabase = await createClient()

    // Get newsletter and subscribers
    const { data: newsletter } = await supabase
      .from("newsletter_campaigns")
      .select("*")
      .eq("id", params.newsletterId)
      .maybeSingle()

    if (!newsletter) {
      return { success: false, error: "Newsletter not found" }
    }

    // Kernel: Brand compliance check before send
    const compliance = await checkBrandCompliance({
      contentType: "newsletter",
      contentId: params.newsletterId,
      brokerageId: params.brokerageId,
    })
    if (!compliance.passed) {
      return { success: false, error: `Brand compliance failed: ${compliance.violations?.join(", ")}` }
    }

    const { data: subscribers } = await supabase
      .from("newsletter_subscribers")
      .select("*, contact:contacts(*)")
      .eq("agent_id", params.agentId)
      .eq("segment", newsletter.audience_segment)
      .eq("subscribed", true)

    if (!subscribers || subscribers.length === 0) {
      return { success: false, error: "No subscribers in this segment" }
    }

    // Create send record
    const { data: sendRecord } = await supabase
      .from("newsletter_scheduled_sends")
      .insert({
        newsletter_id: params.newsletterId,
        agent_id: params.agentId,
        sent_at: new Date().toISOString(),
        recipient_count: subscribers.length,
        status: "sending",
      })
      .select()
      .maybeSingle()

    // Queue emails for each subscriber
    for (const subscriber of subscribers) {
      // In production, this would integrate with SendGrid, Resend, etc.
      await supabase.from("email_queue").insert({
        send_id: sendRecord?.id,
        subscriber_id: subscriber.id,
        contact_email: subscriber.contact?.email,
        status: "queued",
      })
    }

    // Update newsletter status
    await supabase
      .from("newsletter_campaigns")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", params.newsletterId)

    // Kernel: Fire NEWSLETTER_SENT event
    processKernelEvent({
      event: KernelEvent.NEWSLETTER_SENT,
      brokerageId: params.brokerageId,
      entityType: "newsletter_campaign",
      entityId: params.newsletterId,
    }).catch((err) => console.error("[Kernel] NEWSLETTER_SENT error:", err))

    revalidatePath("/content-studio")
    revalidatePath("/dashboard/marketing/studio")

    return {
      success: true,
      sendId: sendRecord?.id,
      recipientCount: subscribers.length,
    }
  } catch (error) {
    console.error("[AI Newsletter] Send error:", error)
    return handleError(error, "sendNewsletter")
  }
}

// ============================================
// 7. GET NEWSLETTER ANALYTICS
// ============================================
export async function getNewsletterAnalytics(params: { newsletterId: string; agentId: string }) {
  try {
    if (!isValidUUID(params.newsletterId)) {
      return { success: false, error: "Invalid newsletter ID" }
    }

    const supabase = await createClient()

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
export async function aiAnalyzeNewsletterPerformance(params: { agentId: string; newsletterId?: string }) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Get historical performance
    const { data: sends } = await supabase
      .from("newsletter_scheduled_sends")
      .select("*, newsletter:newsletter_campaigns(*)")
      .eq("agent_id", params.agentId)
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
  agentId: string
  source?: string
}) {
  try {
    const supabase = await createClient()

    if (params.action === "add") {
      const { data, error } = await supabase.from("newsletter_subscribers").insert({
        email: params.email,
        agent_id: params.agentId,
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
        .eq("agent_id", params.agentId)

      if (error) throw error
      revalidatePath("/content-studio")

      return { success: true, message: "Subscriber removed" }
    }

    return { success: false, error: "Invalid action" }
  } catch (error) {
    return handleError(error, "manageSubscribers")
  }
}

export async function getNewsletters(agentId: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("newsletter_campaigns")
      .select("*")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, newsletters: data || [] }
  } catch (error) {
    return handleError(error, "getNewsletters")
  }
}

// Backward compatibility aliases
export const createNewsletter = createNewsletterCampaign
export const generateNewsletterContent = aiWriteNewsletterContent

export async function manageSubscriberBatch(params: {
  action: "add" | "remove" | "update_segment"
  contactIds: string[]
  agentId: string
  segment?: string
}) {
  try {
    const supabase = await createClient()
    let affected = 0

    for (const contactId of params.contactIds) {
      if (!isValidUUID(contactId)) continue

      if (params.action === "add") {
        await supabase.from("newsletter_subscribers").upsert({
          agent_id: params.agentId,
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
          .eq("agent_id", params.agentId)
        affected++
      } else if (params.action === "update_segment" && params.segment) {
        await supabase
          .from("newsletter_subscribers")
          .update({ segment: params.segment })
          .eq("contact_id", contactId)
          .eq("agent_id", params.agentId)
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
