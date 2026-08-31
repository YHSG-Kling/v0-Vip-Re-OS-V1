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
import { LIFETIME_CUSTOMER_SEGMENT } from "@/lib/contact-types"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { revalidatePath } from "next/cache"
import { isValidUUID, isValidEmail } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { normalizeSectionType, defaultOrderFor } from "@/lib/kernel/newsletter/section-types"
import { pickTopics, renderTopicsForPrompt, type TopicCandidate } from "@/lib/content-intel/topic-bank"
import { logTopicUses } from "@/lib/content-intel/performance-aggregator"

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
  /** Wave 20 — canonical section taxonomy key. When present, drives ordering
   *  + persona/location targeting on the decomposed newsletter_sections row.
   *  Normalized via lib/kernel/newsletter/section-types::normalizeSectionType. */
  section_type?: string
  /** Wave 20 — empty/undefined = renders for every recipient. When set,
   *  only contacts whose contact_persona is in the list see this section. */
  target_personas?: string[]
  /** Wave 20 — empty/undefined = renders everywhere. When set, only
   *  recipients whose city/state/zip_code matches see this section. */
  target_locations?: {
    cities?:    string[]
    states?:    string[]
    zip_codes?: string[]
  }
  /** Wave 20 — non-flat ordering. When unset, falls back to the section
   *  type's defaultOrder weight from the canonical taxonomy. */
  order_index?: number
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
  /** Wave 20.1 — when the marketing agent's approved plan names specific
   *  topics for the week, the caller passes the topic_ids here so the
   *  section author and the newsletter video render share the SAME source
   *  thread (cohesive issue, not two independently-picked themes). When
   *  omitted, this action runs pickTopics() itself so the manual UI flow
   *  also gets topic-seeded sections. */
  seedTopicIds?: string[]
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

    // Get agent's brand voice. brand_voice_profile.agent_id is agents-class; the
    // session USERS id is not a stand-in for a missing agents row — it just matches
    // nothing, and the newsletter then generates in the default voice while looking
    // like the agent had no brand voice configured.
    let brandVoice: Record<string, unknown> | null = null
    if (sessionAgentId) {
      const { data, error: bvErr } = await supabase
        .from("brand_voice_profile")
        .select("*")
        .eq("agent_id", sessionAgentId)
        .maybeSingle()
      if (bvErr) console.error("[ai-newsletter] brand voice read failed:", bvErr.message)
      brandVoice = data as Record<string, unknown> | null
    }

    const template = NEWSLETTER_TEMPLATES.find((t) => t.id === (params.template ?? "modern")) || NEWSLETTER_TEMPLATES[0]

    // Wave 20 — pull the active subscriber audience shape so the generator can
    // author per-persona / per-location sections instead of one flat blob.
    // Top 5 personas + top 5 city/state buckets are enough signal; we don't
    // need a full distribution and we'd rather keep the prompt short.
    const { data: audienceSubs } = await supabase
      .from("newsletter_subscribers")
      .select("contact:contacts!newsletter_subscribers_contact_id_fkey(contact_persona, city, state)")
      .eq("brokerage_id", sessionBrokerageId)
      .eq("status", "subscribed")
      .limit(500)
    const personaCounts = new Map<string, number>()
    const locationCounts = new Map<string, { city: string | null; state: string | null; count: number }>()
    for (const row of (audienceSubs ?? []) as Array<{ contact?: { contact_persona?: string | null; city?: string | null; state?: string | null } | { contact_persona?: string | null; city?: string | null; state?: string | null }[] | null }>) {
      const c = Array.isArray(row.contact) ? row.contact[0] : row.contact
      const persona = (c?.contact_persona ?? "").trim()
      if (persona) personaCounts.set(persona, (personaCounts.get(persona) ?? 0) + 1)
      const city  = (c?.city  ?? "").trim() || null
      const state = (c?.state ?? "").trim().toUpperCase() || null
      if (city || state) {
        const key = `${city ?? "-"}|${state ?? "-"}`
        const cur = locationCounts.get(key) ?? { city, state, count: 0 }
        cur.count++
        locationCounts.set(key, cur)
      }
    }
    const topPersonas = [...personaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => `${p} (${n})`)
    const topLocations = [...locationCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5)
      .map((l) => `${l.city ?? "(unknown)"} ${l.state ?? ""}`.trim() + ` (${l.count})`)
    const audienceIsSegmentable = topPersonas.length > 1 || topLocations.length > 1

    // Wave 20.1 — value-first topic seed from content_topic_bank. When the
    // marketing agent supplied seedTopicIds via params, fetch those exact
    // rows so video + sections share the same week's thread. Otherwise pick
    // top 4 fresh, brokerage-boosted, geo-aware topics — the same picker
    // surface the video and podcast already use. Failure here is non-fatal:
    // we drop back to evergreen real-estate education so the section author
    // still has something coherent to write about.
    //
    // Wave 23 — when the audience is segmentable, ALSO pull per-persona
    // top picks so the section author has different topic threads to
    // anchor different persona sections around. Each persona's pick uses
    // content_topic_persona_performance: a topic that converted hard with
    // first_time_buyer last week scores higher for first_time_buyer this
    // week than for investor. The brokerage-wide pick still anchors the
    // universal sections (Welcome / Market Update); persona picks anchor
    // the persona-specific sections (first-time tips, investor beat, etc.).
    let topics: TopicCandidate[] = []
    let personaTopicMap = new Map<string, TopicCandidate[]>()  // persona → top 2 topics
    try {
      if (Array.isArray(params.seedTopicIds) && params.seedTopicIds.length > 0) {
        const seedSvc = await createClient()
        const { data: seedRows } = await seedSvc
          .from("content_topic_bank")
          .select("id, topic_title, value_angle, source_url, categories, engagement_score, topic_posted_at, brokerage_id")
          .in("id", params.seedTopicIds)
          .or(`brokerage_id.is.null,brokerage_id.eq.${sessionBrokerageId}`)
        topics = ((seedRows ?? []) as Array<{
          id: string; topic_title: string; value_angle: string | null; source_url: string | null;
          categories: string[] | null; engagement_score: number; topic_posted_at: string | null;
          brokerage_id: string | null
        }>).map((r) => ({
          id:                 r.id,
          topic_title:        r.topic_title,
          value_angle:        r.value_angle,
          source_url:         r.source_url,
          categories:         r.categories ?? [],
          engagement_score:   r.engagement_score,
          topic_posted_at:    r.topic_posted_at,
          is_brokerage_local: r.brokerage_id !== null,
          geo_match:          false,
        }))
      } else {
        topics = await pickTopics({
          brokerageId:   sessionBrokerageId,
          categoriesAny: ["buyer_advice", "finance", "market_education", "neighborhood", "seller_advice"],
          limit:         4,
          markUsed:      false, // the newsletter video also pulls; let one
                                // weekly topic anchor both producers before
                                // the podcast cron flips it to 'used'
        })
        // Wave 23 — persona-specific picks. Cap at top 3 personas to keep
        // the picker query count + prompt size bounded. Only fires on
        // segmentable audiences; flat audiences don't benefit from per-
        // persona threads. Skips when seedTopicIds are supplied — the
        // agent's plan owns the topic set in that path.
        if (audienceIsSegmentable) {
          const topThreePersonas = [...personaCounts.entries()]
            .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p)
          for (const persona of topThreePersonas) {
            try {
              const personaPicks = await pickTopics({
                brokerageId:      sessionBrokerageId,
                categoriesAny:    ["buyer_advice", "finance", "market_education", "neighborhood", "seller_advice"],
                limit:            2,
                markUsed:         false,
                recipientPersona: persona,
              })
              personaTopicMap.set(persona, personaPicks)
            } catch (perPersonaErr) {
              console.warn(`[AI Newsletter] persona pick failed for ${persona}; using brokerage-wide only:`, (perPersonaErr as Error).message)
            }
          }
        }
      }
    } catch (e) {
      console.warn("[AI Newsletter] topic-bank pick failed; falling back to evergreen:", (e as Error).message)
    }

    // Wave 23 — union all persona picks with the brokerage-wide picks,
    // dedupe by topic id, so seedTopicIds reported back to the caller
    // include EVERY topic the section author was seeded with (the Wave 19
    // content_topic_uses ledger captures all of them; the video render path
    // reads back from there for cohesion).
    const allTopicIds = new Set(topics.map((t) => t.id))
    for (const list of personaTopicMap.values()) {
      for (const t of list) allTopicIds.add(t.id)
    }

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
            // Wave 20 — non-flat persona+location targeting. NULL fields =
            // section renders for everyone (the safe default). The assembler
            // (lib/kernel/newsletter/assemble::matchesRecipient) honors both.
            section_type:    z.string().optional().describe("Canonical taxonomy key from lib/kernel/newsletter/section-types"),
            target_personas: z.array(z.string()).optional().describe("contact_persona values this section is written for. Empty = everyone."),
            target_locations: z.object({
              cities:    z.array(z.string()).optional(),
              states:    z.array(z.string()).optional(),
              zip_codes: z.array(z.string()).optional(),
            }).optional().describe("Cities/states/zips to scope this section to. Empty = everyone."),
            order_index: z.number().int().optional().describe("Render order — lower = higher up. Omit to use the section type's default weight."),
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

═══ LEAD CONTENT — TOPIC INTELLIGENCE BANK ═══
These are the audience-relevant value threads the platform's content-
intelligence layer surfaced this week (Reddit + Exa + RSS + Apify ingest,
ranked by engagement + freshness + brokerage-locality + Wave 19 performance
feedback). Build the market_update, tips, neighborhood_spotlight, and
local_news sections AROUND THESE THREADS — do not invent generic copy
when these are sitting here. The newsletter VIDEO produced for this
campaign opens with the strongest single thread; the sections should
develop the same threads in depth so the issue reads as cohesive (video
hook → email substance), not as two unrelated assets.

UNIVERSAL TOPICS (anchor the market_update / agent_intro / cta sections):
${renderTopicsForPrompt(topics)}
${personaTopicMap.size > 0 ? `
═══ Wave 23 — PERSONA-PERFORMANCE TOPICS ═══
These threads scored highest with SPECIFIC subscriber personas over the
last 30 days (per-persona open + click rate aggregated from
newsletter_sends). When authoring persona-targeted sections, anchor each
persona's section on its OWN list — these are the threads that have
ALREADY converted with that persona. Set target_personas on the section
to lock the row to that segment so the assembler only shows it to
matching recipients.

${[...personaTopicMap.entries()].map(([persona, list]) =>
  `── For persona='${persona}' ──\n${renderTopicsForPrompt(list)}`
).join("\n\n")}
` : ""}

═══ AUDIENCE SHAPE ═══
${audienceIsSegmentable
  ? `This brokerage has a segmentable audience — author MULTIPLE versions of
persona-relevant sections (market_update, new_listings, tips, cta), each
scoped via target_personas / target_locations so each subscriber sees the
ONE version that fits them. The assembler stitches the right version per
recipient at send time. Do NOT repeat the same content with different
targeting — write genuinely different copy per segment.

Top subscriber personas: ${topPersonas.join(", ") || "(none on file)"}
Top subscriber locations: ${topLocations.join(", ") || "(none on file)"}`
  : `Audience is small / homogeneous. Author flat sections — leave
target_personas + target_locations empty so every recipient sees them.`}

For each section, set:
  • section_type — pick the canonical key from this taxonomy:
    agent_intro, market_update, new_listings, property_highlight,
    local_news, local_event, neighborhood_spotlight, mortgage_rates,
    tips, testimonial, community_eats, cta, custom
  • target_personas — array of contact_persona values when the section is
    persona-specific (e.g. ["first_time_buyer"] for a buyer-prep tips
    section). Leave empty when the section is for everyone.
  • target_locations — {cities, states, zip_codes} when the section is
    location-specific (e.g. {cities: ["Miami"]} for a Miami market beat).
    Leave empty when the section is for everyone.
  • order_index — optional integer; omit to use the section type's default
    weight (agent_intro=10, market_update=20, new_listings=30, …).

Write engaging content for each section. Keep paragraphs short and scannable.
Include clear CTAs where appropriate.

COMPLIANCE: Never reference protected classes (race, color, religion,
national origin, sex, disability, familial status). When targeting a
persona, target by life-stage / financial readiness / property goal —
NEVER by demographic proxy. "Perfect for families" is illegal; "Move-in
ready with a fenced yard" is not.`,
    })

    // Apply brand voice to generated content. The targeting metadata
    // (section_type, target_personas, target_locations, order_index) flows
    // through untouched — brand voice only rewrites the copy itself.
    // When the AI marked a section persona-specific, seed brandVoice's
    // persona slot with the first target_persona so the resolver returns
    // the per-persona tone overrides if any are configured.
    const brandedSections = await Promise.all(
      content.sections.map(async (section: any) => {
        const seedPersona = Array.isArray(section.target_personas) && section.target_personas[0]
          ? section.target_personas[0]
          : "seller"
        const branded = await applyBrandVoice({
          brokerageId: sessionBrokerageId,
          actorUserId: sessionUserId,
          actorRole: "agent",
          journeyType: "seller",
          persona: seedPersona,
          messageType: "email",
          content: section.content,
        })
        return { ...section, content: branded.content || section.content }
      })
    )

    // Run compliance check on all content
    for (const section of brandedSections) {
      const compliance = await evaluateOutbound({
        actorContext: { userId: sessionUserId, role: "agent", brokerageId: sessionBrokerageId },
        journeyType: "buyer",
        persona: "first_time",
        messageType: "email",
        content: section.content,
        // Broadcast payload — no individual recipient. Omitting `contact`
        // skips the DNC/TCPA gates exactly as the stub did, and lets the
        // compliance_events audit row insert (entity_id is uuid; a stub
        // "broadcast" id made the write fail with 22P02, silently).
      }).catch(() => ({ allowed: true, violations: [] as string[] }))
      if (!compliance.allowed) {
        return { success: false, error: `Compliance violation in ${section.type}: ${compliance.violations.join(", ")}` }
      }
    }

    await incrementFeatureUsage(sessionUserId, "newsletter_engine")

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
      /** Wave 20.1 — the content_topic_bank IDs that seeded this issue.
       *  The caller passes these into createNewsletterCampaign so the
       *  performance loop can log them against the newsletter_campaign
       *  asset (content_topic_uses ledger → daily aggregator → topic
       *  performance_score → next pick scores them higher).
       *  Wave 23 — the union now includes per-persona picks so all
       *  topics actually fed to the section author get attributed. */
      seedTopicIds: [...allTopicIds],
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
  /** Wave 20.1 — content_topic_bank IDs that seeded this campaign's sections.
   *  Pulled from aiWriteNewsletterContent's return shape; the caller passes
   *  them through so the Wave 19 performance loop captures which topics
   *  produced this newsletter. The aggregator reads open/click rates back
   *  per topic and bumps its performance_score for the picker. */
  seedTopicIds?: string[]
  /** newsletter_campaigns.marketing_campaign_id — the umbrella marketing
   *  campaign this issue belongs to. The column is read by the campaign ROI
   *  measurer (lib/marketing/campaign-measurer.ts:28) and by the fan-out that
   *  embeds a finished campaign render into every asset under the same
   *  campaign, and was written by NOBODY — no producer knew both the
   *  newsletter and its umbrella. Optional: most newsletters are standalone
   *  recurring issues; a campaign is a different business process that an
   *  issue can be filed under, never a synonym for one. */
  marketingCampaignId?: string
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

    // STEP 1b: THE UMBRELLA MUST BE ONE OF OURS. The FK proves a
    // marketing_campaigns row exists; it never proves the row belongs to the
    // caller's brokerage, and filing this tenant's newsletter under another
    // tenant's campaign would feed their ROI rollup and pull their campaign's
    // renders into this issue. Same gate, same wording as
    // app/actions/email-campaigns.ts:183 where this pattern already stands.
    let marketingCampaignId: string | null = null
    if (params.marketingCampaignId) {
      if (!isValidUUID(params.marketingCampaignId)) {
        return { success: false, error: "Invalid campaign ID" }
      }
      const { data: umbrella, error: umbrellaError } = await supabase
        .from("marketing_campaigns")
        .select("id")
        .eq("id", params.marketingCampaignId)
        .eq("brokerage_id", sessionBrokerageId)
        .maybeSingle()
      if (umbrellaError) {
        return { success: false, error: `Could not verify that campaign: ${umbrellaError.message}` }
      }
      if (!umbrella) return { success: false, error: "That campaign is not on your brokerage." }
      marketingCampaignId = umbrella.id as string
    }

    // STEP 2: Fix the insert payload with correct field names and values
    const { data: newsletter, error } = await supabase
      .from("newsletter_campaigns")
      .insert({
        campaign_name: params.title, // campaign_name NOT title
        subject_line: params.subjectLine,
        content: typeof params.content === "string" ? params.content : JSON.stringify(params.content),
        status: params.scheduledAt ? "scheduled" : "draft",
        send_date: params.scheduledAt ?? null, // send_date NOT scheduled_at
        brokerage_id: sessionBrokerageId, // session-derived
        agent_id: agentsTableId, // agents.id NOT users.id
        created_by: sessionUserId, // users.id
        marketing_campaign_id: marketingCampaignId, // verified above, never the raw body id
      })
      .select()
      .maybeSingle()

    if (error || !newsletter) throw error ?? new Error("Failed to create newsletter campaign")

    // STEP 2b — Wave 20 decomposer. The campaign envelope is in
    // newsletter_campaigns; the per-section persona+location targeting that
    // makes the newsletter NON-FLAT lives on newsletter_sections rows. The
    // assembler (lib/kernel/newsletter/assemble::resolveSectionsForRecipient)
    // reads from this table — if we don't populate it, every recipient gets
    // the same flat campaign body regardless of persona / location.
    //
    // Each section emitted by the AI writer (or a manual section payload)
    // becomes one row. NULL/empty targeting columns mean "renders for
    // everyone" — the safe default that preserves prior flat behavior when
    // the producer didn't supply targeting metadata.
    if (Array.isArray(params.content) && params.content.length > 0) {
      const sectionRows = params.content.map((s, i) => {
        const tp = Array.isArray(s.target_personas) && s.target_personas.length > 0 ? s.target_personas : null
        const tl = s.target_locations &&
          ((s.target_locations.cities?.length ?? 0) +
           (s.target_locations.states?.length ?? 0) +
           (s.target_locations.zip_codes?.length ?? 0) > 0)
          ? s.target_locations
          : null
        const normalizedType = normalizeSectionType(s.section_type ?? s.type)
        return {
          newsletter_id:    newsletter.id,
          brokerage_id:     sessionBrokerageId,
          title:            s.title ?? null,
          content:          s.content ?? null,
          order_index:      typeof s.order_index === "number" ? s.order_index : defaultOrderFor(normalizedType) + i,
          target_personas:  tp,
          target_locations: tl,
          section_type:     normalizedType,
        }
      })
      const { error: secErr } = await supabase.from("newsletter_sections").insert(sectionRows)
      if (secErr) {
        // Best-effort — the campaign envelope is already persisted. The
        // assembler's fallback (campaign body as one flat block) still works,
        // so a section-decompose failure shouldn't fail the whole create.
        // Surface the error so we see it in cron logs / Sentry without
        // breaking the caller.
        console.error(`[AI Newsletter] section decompose failed for campaign ${newsletter.id}:`, secErr.message)
      }
    }

    // Wave 20.1 — close the loop on the content intelligence layer for the
    // newsletter section channel. The Wave 19 ledger (content_topic_uses)
    // is already wired for newsletter_video and podcast_episode; the
    // newsletter_campaign asset type was reserved but had no producer
    // logging it. Now the campaign create logs which topics seeded the
    // sections, so the daily aggregator can read open/click rates back
    // per topic and bump performance_score → next picker run weighs them.
    if (Array.isArray(params.seedTopicIds) && params.seedTopicIds.length > 0) {
      void logTopicUses({
        topicIds:    params.seedTopicIds,
        brokerageId: sessionBrokerageId,
        assetType:   "newsletter_campaign",
        assetId:     newsletter.id,
      })
    }

    // STEP 3: Fix newsletter_subscribers query — use agents.id not users.id
    const { count } = await supabase
      .from("newsletter_subscribers")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentsTableId) // agents.id NOT params.agentId
      .eq("status", "subscribed")

    // Kernel: Fire NEWSLETTER_SCHEDULED if scheduled
    if (params.scheduledAt && newsletter) {
      processKernelEvent({
        event: KernelEvent.NEWSLETTER_SCHEDULED,
        brokerageId: sessionBrokerageId,
        entityType: "newsletter_campaign",
        entityId: newsletter.id,
      }).catch((err) => console.error("[Kernel] NEWSLETTER_SCHEDULED error:", err))
    }

    await incrementFeatureUsage(sessionUserId, "newsletter_engine")

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
      const { data, error: sendsErr } = await supabase
        .from("newsletter_scheduled_sends")
        .select("*, newsletter:newsletter_campaigns!inner(*)")
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
