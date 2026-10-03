/**
 * lib/kernel/content-creators.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE CREATOR PER CONTENT TYPE, for every door that stages content: newsletter (and its
 * writer), email campaign, blog draft, podcast episode (and its writer), video project.
 * Wave 85F, the follow-up lane 85D named when it fixed direct mail the same way
 * (lib/kernel/marketing.ts createDirectMailCampaign).
 *
 * THE DEFECT. The ElevenLabs voice webhook (app/api/agent-assistant/tool-call) has no cookie
 * session. It verifies a shared-secret header and attributes the call through
 * conversation_id → agent_assistant_sessions. Five of its eight stage_* helpers
 * (lib/wizard-staging/content-staging.ts) reached a "use server" action that reads the
 * COOKIE session, so from the webhook each one was refused ("Unauthorized", "Not
 * authenticated", "Missing agent context"), or wrote through the anon client and was
 * refused by RLS. Blog and podcast then fell back to raw service-role inserts that skipped
 * the gate, the counter and the compliance pass.
 *
 * THE CONTRACT. This module is server-only and is NOT a "use server" file, so nothing reaches
 * it from a request body. Every caller hands in an actor it has ALREADY verified:
 *   · the user-facing "use server" actions: the cookie SESSION (getAgentContext /
 *     requireCaller). A foreign body brokerageId is refused before the call.
 *   · lib/wizard-staging/content-staging.ts: ctx from the voice webhook's session row
 *     (secret verified before any read) or from the copilot's cookie session.
 * The tenant is ctx.brokerageId and the actor is ctx.userId (users.id). agents.id is resolved
 * HERE (resolveActorAgentId): a supplied ctx.agentId is VERIFIED as an agents row in the
 * tenant, else the actor's own row is crossed via agents.user_id pinned to the tenant. It is
 * never the users id (CLAUDE.md §3: the two are DISJOINT).
 *
 * The default client is the SERVICE client, so RLS is not guarding these reads: every read
 * carries an explicit brokerage predicate, every caller-named id (umbrella campaign, source
 * video, template, script) is verified in-tenant, and every insert is COUNTED
 * (`.select()`, exactly one row, else refused).
 *
 * WRITERS ARE COMPLIANCE-FIRST (CLAUDE.md §5). authorNewsletterContent and writePodcastScript
 * put buildComplianceSystemBlocks (brand voice + ThemFirst + Fair Housing + the brokerage's
 * own prohibited phrases) into the model's SYSTEM prompt and grade the output with
 * postcheckScript (gradeWrittenCopy). Warnings pass through; a hard fair-housing flag
 * refuses the draft (a podcast/newsletter has no human queue of its own). The video creator
 * does not write: it holds a red-flag or unevaluated script through evaluateVideoRenderHold.
 *
 * MERGED ONTO THESE SURVIVORS (§1.1), each with a tombstone at its old site:
 *   · app/actions/ai-newsletter.ts aiWriteNewsletterContent + createNewsletterCampaign bodies
 *   · lib/kernel/marketing.ts createNewsletterCampaign (unwired): its AI-authored stamp
 *     (approval_status 'pending_review' → the marketing-ai-approvals queue) as `aiAuthored`
 *   · app/actions/email-campaigns.ts createEmailCampaign body (no kernel half existed: BUILT)
 *   · app/actions/blog.ts saveBlogPost body
 *   · app/actions/podcast-generation.ts createPodcastEpisode + generateScriptFromKeywords
 *   · lib/kernel/marketing.ts createPodcastEpisodeKernel (unwired; nothing unique left)
 *   · app/actions/video/create-video-project.ts createVideoProject body
 *   · lib/kernel/marketing.ts createVideoProject (unwired): its brand_voice_context stamp and
 *     its audience_type default ('customer_facing'), which the survivor wrote as NULL into a
 *     NOT NULL column (23502 for every caller but the listing media panel)
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { isValidUUID } from "@/lib/validations"
import type { MarketingActorContext } from "@/lib/kernel/marketing"

type ContentClient = ReturnType<typeof createServiceClient>
type FeatureClient = Parameters<typeof canAccessFeature>[3]

/** Refusal shape shared by every creator here. */
interface ContentRefusal { success: false; error: string; complianceWarnings?: string[] }

// ─── shared gates ─────────────────────────────────────────────────────────────

/** Fail closed on a missing actor (§4): "nobody said who" is never "the platform". */
function actorRefusal(ctx: MarketingActorContext | undefined, what: string): ContentRefusal | null {
  if (!ctx?.userId) return { success: false, error: `No verified user on the ${what} request — it is filed by a known user.` }
  if (!ctx?.brokerageId) return { success: false, error: `No verified brokerage on the ${what} request — it belongs to a brokerage.` }
  return null
}

/**
 * agents.id for the actor, in the actor's tenant. A supplied ctx.agentId is VERIFIED as an
 * agents row in ctx.brokerageId (a users id, or another tenant's agent, is refused). Absent,
 * the actor's own agents row is crossed via agents.user_id; a seat with none returns null.
 */
async function resolveActorAgentId(
  client: ContentClient,
  ctx: MarketingActorContext,
): Promise<{ ok: true; agentId: string | null } | { ok: false; error: string }> {
  if (ctx.agentId) {
    const { data, error } = await client
      .from("agents").select("id").eq("id", ctx.agentId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    if (error) return { ok: false, error: `Could not verify the agent: ${error.message}` }
    if (!data) return { ok: false, error: "That agent is not an agents row in this brokerage. agent_id takes an agents id, not a users id." }
    return { ok: true, agentId: (data as { id: string }).id }
  }
  return { ok: true, agentId: await resolveAgentIdInBrokerage(client, ctx.userId, ctx.brokerageId) }
}

/**
 * A caller-named id must be a row in THIS tenant. A foreign key proves the row exists, never
 * that it is ours, and the service client has no RLS to say so.
 */
async function verifyInTenant(
  client: ContentClient, table: string, id: string, brokerageId: string, label: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!isValidUUID(id)) return { ok: false, error: `Invalid ${label} ID` }
  const { data, error } = await client.from(table).select("id").eq("id", id).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `Could not verify that ${label}: ${error.message}` }
  if (!data) return { ok: false, error: `That ${label} is not on your brokerage.` }
  return { ok: true, id: (data as { id: string }).id }
}

/**
 * Grade model-written copy (§5): postcheckScript's flat findings, split into the HARD flags
 * (the deterministic fair-housing scan + the brokerage's BLOCKING phrases) and everything
 * else (advisory, and UNKNOWN lines when a gate could not run — those pass through, said out
 * loud, never read as clean).
 */
async function gradeWrittenCopy(
  actor: { userId: string; brokerageId: string },
  text: string,
  client: ContentClient,
): Promise<{ redFlags: string[]; warnings: string[] }> {
  const { postcheckScript, detectFairHousingRedFlags, detectProhibitedPhraseRedFlags } = await import("@/lib/video/script-compliance")
  const flat = (await postcheckScript(actor, text, "buyer", { client })) ?? []
  const redFlags = [...new Set([
    ...detectFairHousingRedFlags(text, "buyer"),
    ...detectProhibitedPhraseRedFlags(flat),
  ])]
  return { redFlags, warnings: flat.filter((f) => !redFlags.includes(f)) }
}

/** COUNTED insert result (§3): a refusal or an empty return is a refusal, never a create. */
function exactlyOne(
  rows: unknown, error: { message: string } | null, what: string,
): { ok: true; row: Record<string, any> } | { ok: false; error: string } {
  if (error) return { ok: false, error: `${what} was not created: ${error.message}` }
  const list = (Array.isArray(rows) ? rows : rows ? [rows] : []) as Array<Record<string, any>>
  if (list.length !== 1 || !list[0]?.id) {
    return { ok: false, error: `${what} insert returned ${list.length} rows (expected 1), so it was not created.` }
  }
  return { ok: true, row: list[0] }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. NEWSLETTER — the writer (authorNewsletterContent) and the creator
// ═════════════════════════════════════════════════════════════════════════════

export interface NewsletterSectionInput {
  type: string
  title: string
  content: string
  imageUrl?: string
  listings?: any[]
  ctaText?: string
  ctaUrl?: string
  section_type?: string
  target_personas?: string[]
  target_locations?: { cities?: string[]; states?: string[]; zip_codes?: string[] }
  order_index?: number
}

interface NewsletterTemplate { id: string; name: string; style: "modern" | "classic" | "minimal" | "luxury"; sections: string[] }

const NEWSLETTER_TEMPLATES: NewsletterTemplate[] = [
  { id: "modern",  name: "Modern Real Estate", style: "modern",  sections: ["hero", "featured_listings", "market_update", "tips", "cta"] },
  { id: "luxury",  name: "Luxury Collection",  style: "luxury",  sections: ["hero", "featured_listings", "testimonial", "cta"] },
  { id: "minimal", name: "Clean & Simple",     style: "minimal", sections: ["hero", "market_update", "tips", "cta"] },
  // "The Insider Edit" curated format (merged §1.1, lane N3a 2026-09-01, from the deleted
  // app/api/ai/insider-edit-* route trio). Voice + section direction: lib/newsletter/insider-edit.ts.
  { id: "insider", name: "The Insider Edit",   style: "minimal", sections: ["hook", "events", "civic", "deal", "eats"] },
]

interface AuthorNewsletterContentInput {
  ctx: MarketingActorContext
  client?: ContentClient
  topic: string
  template?: string
  targetAudience?: string
  tone?: string
  featuredListings?: any[]
  marketStats?: any
  customSections?: string[]
  /** content_topic_bank ids the approved plan names; otherwise pickTopics() runs here. */
  seedTopicIds?: string[]
}

/**
 * THE NEWSLETTER WRITER (moved here from app/actions/ai-newsletter.ts aiWriteNewsletterContent,
 * which is now its session door). Topic-seeded, persona/location-targeted sections, the brand
 * voice pass, a per-section blocking compliance gate, the them-first quality verdict and the
 * ai_generated_content artifact row, all for a VERIFIED actor.
 *
 * Compliance-first (§5): the four buildComplianceSystemBlocks go into the SYSTEM prompt, so the
 * rules are an input and not only a grade. The per-section evaluateOutbound gate used to
 * `.catch(() => ({ allowed: true }))`: a thrown evaluator read as CLEAN. It now falls back to
 * the deterministic detectFairHousingRedFlags scan (no database needed) and records an UNKNOWN
 * line, and postcheckScript grades the whole issue once (advisory, returned as
 * complianceWarnings).
 */
export async function authorNewsletterContent(input: AuthorNewsletterContentInput): Promise<
  | ContentRefusal
  | {
      success: true
      content: string
      sections: Array<NewsletterSectionInput & Record<string, unknown>>
      estimatedReadTime: number | null
      wordCount: number | null
      quality: ReturnType<typeof import("@/lib/quality-checker").analyzeContentQuality>
      contentId: string | null
      seedTopicIds: string[]
      complianceWarnings?: string[]
    }
> {
  const { ctx } = input
  const refused = actorRefusal(ctx, "newsletter")
  if (refused) return refused
  if (!input.topic?.trim()) return { success: false, error: "A newsletter topic is required." }

  const supabase: ContentClient = input.client ?? createServiceClient()
  const featureClient = supabase as unknown as FeatureClient
  const brokerageId = ctx.brokerageId
  const userId = ctx.userId

  const access = await canAccessFeature(userId, "newsletter_engine", undefined, featureClient)
  if (!access.allowed) return { success: false, error: access.reason || "Feature not available" }

  const agent = await resolveActorAgentId(supabase, ctx)
  if (!agent.ok) return { success: false, error: agent.error }
  const agentId = agent.agentId

  const [{ escapeHtmlFull: escapeHtml }, { generateObject }, { resolveModel }, { z },
    { applyTenantBrandVoice, evaluateTenantOutbound }, topicBank, { analyzeContentQuality }, insider, compliance] =
    await Promise.all([
      import("@/lib/format/html"), import("@/lib/ai/generate"), import("@/lib/ai/resolve-model"), import("zod"),
      // The SESSIONLESS door (86C): ctx is verified by this module's contract, so brand voice and
      // the gate read the tenant's rows on the service client instead of an anon cookie client.
      import("@/lib/kernel/tenant-config-reads"), import("@/lib/content-intel/topic-bank"),
      import("@/lib/quality-checker"), import("@/lib/newsletter/insider-edit"), import("@/lib/video/script-compliance"),
    ])
  type TopicCandidate = Awaited<ReturnType<typeof topicBank.pickTopics>>[number]

  // brand_voice_profile.agent_id is agents-class; the users id is not a stand-in (it matches
  // nothing and the issue silently generates in the default voice). Tenant-pinned: this is the
  // service client.
  let brandVoice: Record<string, unknown> | null = null
  if (agentId) {
    const { data, error: bvErr } = await supabase
      .from("brand_voice_profile").select("*").eq("agent_id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
    if (bvErr) console.error("[content-creators] newsletter brand voice read failed:", bvErr.message)
    brandVoice = data as Record<string, unknown> | null
  }

  const template = NEWSLETTER_TEMPLATES.find((t) => t.id === (input.template ?? "modern")) || NEWSLETTER_TEMPLATES[0]

  // Wave 20 — the active subscriber audience shape (top personas + city/state buckets).
  const { data: audienceSubs, error: audienceErr } = await supabase
    .from("newsletter_subscribers")
    .select("contact:contacts!newsletter_subscribers_contact_id_fkey(contact_persona, city, state)")
    .eq("brokerage_id", brokerageId)
    .eq("status", "subscribed")
    .limit(500)
  if (audienceErr) console.error("[content-creators] newsletter audience read failed (writing flat):", audienceErr.message)
  const personaCounts = new Map<string, number>()
  const locationCounts = new Map<string, { city: string | null; state: string | null; count: number }>()
  for (const row of (audienceSubs ?? []) as Array<{ contact?: any }>) {
    const c = Array.isArray(row.contact) ? row.contact[0] : row.contact
    const persona = String(c?.contact_persona ?? "").trim()
    if (persona) personaCounts.set(persona, (personaCounts.get(persona) ?? 0) + 1)
    const city = String(c?.city ?? "").trim() || null
    const state = String(c?.state ?? "").trim().toUpperCase() || null
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

  // Wave 20.1 / 23 — value-first topic seed from content_topic_bank (+ per-persona picks).
  // Failure is non-fatal: the section author falls back to evergreen education.
  let topics: TopicCandidate[] = []
  const personaTopicMap = new Map<string, TopicCandidate[]>()
  try {
    if (Array.isArray(input.seedTopicIds) && input.seedTopicIds.length > 0) {
      const { data: seedRows, error: seedErr } = await supabase
        .from("content_topic_bank")
        .select("id, topic_title, value_angle, source_url, categories, engagement_score, topic_posted_at, brokerage_id")
        .in("id", input.seedTopicIds)
        .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
      if (seedErr) console.warn("[content-creators] seed topic read failed:", seedErr.message)
      topics = ((seedRows ?? []) as Array<any>).map((r) => ({
        id: r.id, topic_title: r.topic_title, value_angle: r.value_angle, source_url: r.source_url,
        categories: r.categories ?? [], engagement_score: r.engagement_score, topic_posted_at: r.topic_posted_at,
        is_brokerage_local: r.brokerage_id !== null, geo_match: false,
      })) as TopicCandidate[]
    } else {
      const categoriesAny = ["buyer_advice", "finance", "market_education", "neighborhood", "seller_advice"]
      topics = await topicBank.pickTopics({ brokerageId, categoriesAny, limit: 4, markUsed: false })
      if (audienceIsSegmentable) {
        const topThree = [...personaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p)
        for (const persona of topThree) {
          try {
            personaTopicMap.set(persona, await topicBank.pickTopics({ brokerageId, categoriesAny, limit: 2, markUsed: false, recipientPersona: persona }))
          } catch (perPersonaErr) {
            console.warn(`[content-creators] persona pick failed for ${persona}; brokerage-wide only:`, (perPersonaErr as Error).message)
          }
        }
      }
    }
  } catch (e) {
    console.warn("[content-creators] topic-bank pick failed; falling back to evergreen:", (e as Error).message)
  }
  const allTopicIds = new Set(topics.map((t) => t.id))
  for (const list of personaTopicMap.values()) for (const t of list) allTopicIds.add(t.id)

  const isInsiderTemplate = template.id === "insider"
  const insiderBlock = isInsiderTemplate
    ? `\n═══ THE INSIDER EDIT — SECTION DIRECTION ═══
This issue is a curated "deal of the week" newsletter, NOT a property blast.
Author exactly these sections, in this order, with these titles:
${template.sections.map((s) => `• ${s} — titled "${insider.INSIDER_SECTION_TITLES[s] ?? s}": ${insider.INSIDER_SECTION_PROMPTS[s] ?? ""}`).join("\n")}
Each section is 150-200 words, specific, and free of hard-sell language.\n`
    : ""

  // COMPLIANCE-FIRST: the rules are an INPUT to the writer (§5), read for THIS tenant through
  // THIS client (the webhook has no session for the phrase catalogue's RLS to evaluate).
  const complianceBlocks = await compliance.buildComplianceSystemBlocks(brokerageId, undefined, supabase)
  const system = [isInsiderTemplate ? insider.INSIDER_CURATOR_SYSTEM_PROMPT : "", ...complianceBlocks]
    .filter(Boolean).join("\n\n")

  const { object: content } = await generateObject({
    model: resolveModel("openai/gpt-4o"),
    system,
    schema: z.object({
      sections: z.array(z.object({
        type: z.string(),
        title: z.string(),
        content: z.string(),
        ctaText: z.string().optional(),
        ctaUrl: z.string().optional(),
        section_type: z.string().optional().describe("Canonical taxonomy key from lib/kernel/newsletter/section-types"),
        target_personas: z.array(z.string()).optional().describe("contact_persona values this section is written for. Empty = everyone."),
        target_locations: z.object({
          cities: z.array(z.string()).optional(),
          states: z.array(z.string()).optional(),
          zip_codes: z.array(z.string()).optional(),
        }).optional().describe("Cities/states/zips to scope this section to. Empty = everyone."),
        order_index: z.number().int().optional().describe("Render order — lower = higher up. Omit to use the section type's default weight."),
      })),
      estimatedReadTime: z.number(),
      wordCount: z.number(),
    }),
    prompt: `Write newsletter content for a real estate agent.

Template Style: ${template.style}
Topic: ${input.topic}
Sections needed: ${template.sections.join(", ")}
${brandVoice ? `Brand Voice: ${brandVoice.tone}, ${brandVoice.style}` : ""}
${input.tone ? `Tone: ${input.tone}` : ""}

${input.featuredListings?.length ? `Featured Listings: ${JSON.stringify(input.featuredListings)}` : ""}
${input.marketStats ? `Market Stats: ${JSON.stringify(input.marketStats)}` : ""}

═══ LEAD CONTENT — TOPIC INTELLIGENCE BANK ═══
These are the audience-relevant value threads the platform's content-intelligence layer
surfaced this week. Build the market_update, tips, neighborhood_spotlight, and local_news
sections AROUND THESE THREADS — do not invent generic copy when these are sitting here. The
newsletter VIDEO for this campaign opens with the strongest single thread; the sections should
develop the same threads in depth so the issue reads as cohesive.

UNIVERSAL TOPICS (anchor the market_update / agent_intro / cta sections):
${topicBank.renderTopicsForPrompt(topics)}
${personaTopicMap.size > 0 ? `
═══ PERSONA-PERFORMANCE TOPICS ═══
These threads scored highest with SPECIFIC subscriber personas over the last 30 days. When
authoring persona-targeted sections, anchor each persona's section on its OWN list and set
target_personas on the section to lock the row to that segment.

${[...personaTopicMap.entries()].map(([persona, list]) => `── For persona='${persona}' ──\n${topicBank.renderTopicsForPrompt(list)}`).join("\n\n")}
` : ""}

═══ AUDIENCE SHAPE ═══
${audienceIsSegmentable
  ? `This brokerage has a segmentable audience — author MULTIPLE versions of persona-relevant
sections (market_update, new_listings, tips, cta), each scoped via target_personas /
target_locations so each subscriber sees the ONE version that fits them. Write genuinely
different copy per segment.

Top subscriber personas: ${topPersonas.join(", ") || "(none on file)"}
Top subscriber locations: ${topLocations.join(", ") || "(none on file)"}`
  : `Audience is small / homogeneous. Author flat sections — leave target_personas +
target_locations empty so every recipient sees them.`}

For each section, set:
  • section_type — pick the canonical key from this taxonomy:
    agent_intro, market_update, new_listings, property_highlight, local_news, local_event,
    neighborhood_spotlight, mortgage_rates, tips, testimonial, community_eats, cta, custom
  • target_personas — contact_persona values when persona-specific; empty for everyone.
  • target_locations — {cities, states, zip_codes} when location-specific; empty for everyone.
  • order_index — optional integer; omit to use the section type's default weight.

Write engaging content for each section. Keep paragraphs short and scannable.
Include clear CTAs where appropriate.

COMPLIANCE: Never reference protected classes (race, color, religion, national origin, sex,
disability, familial status). When targeting a persona, target by life-stage / financial
readiness / property goal — NEVER by demographic proxy. "Perfect for families" is illegal;
"Move-in ready with a fenced yard" is not.
${insiderBlock}`,
  })

  // Brand voice on the copy (targeting metadata flows through). Insider: the curator tone pass.
  const brandedSections = await Promise.all(
    (content.sections as Array<any>).map(async (section) => {
      if (isInsiderTemplate) {
        const validated = await insider.enforceInsiderTone(section.content, { userId, brokerageId, agentId })
        return { ...section, content: validated.content || section.content }
      }
      const seedPersona = Array.isArray(section.target_personas) && section.target_personas[0] ? section.target_personas[0] : "seller"
      const branded = await applyTenantBrandVoice({
        brokerageId, actorUserId: userId, actorRole: "agent", journeyType: "seller",
        persona: seedPersona, messageType: "email", content: section.content,
      })
      return { ...section, content: branded.content || section.content }
    }),
  )

  // THE BLOCKING GATE, per section. Broadcast payload: no `contact`, so DNC/TCPA are skipped
  // and the compliance_events audit row can land. A THROWN evaluator is no longer "allowed":
  // the deterministic fair-housing scan still runs, and the gap is said out loud.
  const unknownNotes: string[] = []
  for (const section of brandedSections) {
    let verdict: { allowed: boolean; violations: string[] }
    try {
      verdict = await evaluateTenantOutbound({
        actorContext: { userId, role: "agent", brokerageId },
        journeyType: "buyer", persona: "first_time", messageType: "email", content: section.content,
      })
    } catch (err) {
      const flags = compliance.detectFairHousingRedFlags(section.content, "buyer")
      verdict = { allowed: flags.length === 0, violations: flags }
      if (flags.length === 0) {
        unknownNotes.push(`${compliance.COMPLIANCE_UNKNOWN_PREFIX} — the compliance evaluator could not run on "${section.title}" (${err instanceof Error ? err.message : String(err)}). Fair Housing was checked deterministically; review before sending.`)
      }
    }
    if (!verdict.allowed) {
      return { success: false, error: `Compliance violation in ${section.type}: ${verdict.violations.join(", ")}` }
    }
  }

  const plainText = brandedSections.map((s: any) => `${s.title}\n${s.content}`).join("\n\n")
  // Post-check over the whole issue (§5): warnings PASS THROUGH; a hard fair-housing flag or a
  // phrase the brokerage marked blocking refuses the draft before anything is stored or counted.
  const graded = await gradeWrittenCopy({ userId, brokerageId }, plainText, supabase)
  if (graded.redFlags.length > 0) {
    return { success: false, error: `The drafted newsletter tripped a hard compliance flag and was not kept: ${graded.redFlags.join("; ")}`, complianceWarnings: graded.redFlags }
  }
  const complianceWarnings = [...graded.warnings, ...unknownNotes]

  const usage = await incrementFeatureUsage(userId, "newsletter_engine", featureClient)
  if (!usage.success) console.error("[content-creators] newsletter_engine usage NOT counted:", usage.error)

  const flatContent = brandedSections
    .map((s: any) =>
      `<section style="margin-bottom:1.5rem">` +
      `<h2 style="font-size:1.1rem;font-weight:600;margin-bottom:0.5rem">${escapeHtml(s.title)}</h2>` +
      `<div style="line-height:1.6"><p>${escapeHtml(s.content).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p></div>` +
      (s.ctaText ? `<p style="margin-top:0.75rem"><strong>${escapeHtml(s.ctaText)}</strong></p>` : "") +
      `</section>`)
    .join('<hr style="margin:1.5rem 0;border-color:#e5e7eb">')

  // Them-first quality verdict + the ai_generated_content artifact row (merged §1.1 from the
  // deleted /api/generate/newsletter route). Non-fatal on refusal, but the error is READ.
  const quality = analyzeContentQuality(plainText)
  const { data: savedContent, error: saveError } = await supabase
    .from("ai_generated_content")
    .insert({
      content_type: "newsletter",
      content: plainText,
      generated_content: flatContent,
      user_id: userId,        // users-class
      agent_id: agentId,      // agents-class
      brokerage_id: brokerageId,
      title: `Newsletter — ${input.topic || template.name}`,
      quality_score: quality.score / 100,
      metadata: {
        source: "aiWriteNewsletterContent",
        template: template.id,
        them_percentage: quality.themPercentage,
        agent_percentage: quality.agentPercentage,
        warnings: quality.warnings,
      },
    })
    .select("id")
  if (saveError) console.error("[content-creators] ai_generated_content artifact insert refused:", saveError.message)
  const artifactId = ((savedContent ?? []) as Array<{ id: string }>).length === 1 ? (savedContent as Array<{ id: string }>)[0].id : null

  return {
    success: true,
    content: flatContent,
    sections: brandedSections,
    estimatedReadTime: (content as any).estimatedReadTime ?? null,
    wordCount: (content as any).wordCount ?? null,
    quality,
    contentId: artifactId,
    seedTopicIds: [...allTopicIds],
    ...(complianceWarnings.length > 0 ? { complianceWarnings } : {}),
  }
}

interface CreateNewsletterCampaignInput {
  ctx: MarketingActorContext
  client?: ContentClient
  title: string
  subjectLine: string
  preheaderText?: string
  template?: string
  content: NewsletterSectionInput[] | string
  audienceSegment?: string
  scheduledAt?: string
  seedTopicIds?: string[]
  /** Edit-in-place (merged from the deleted insider-edit-save route): verified in-tenant. */
  campaignId?: string
  /** Umbrella marketing_campaigns id, verified in-tenant (the ROI measurer reads it). */
  marketingCampaignId?: string
  /** The content was model-written (authorNewsletterContent). Stamps is_ai_generated and
   *  approval_status 'pending_review' so it lands in the marketing-ai-approvals queue —
   *  merged from the unwired lib/kernel/marketing.ts createNewsletterCampaign. Omitted, the
   *  column defaults stand, exactly as the manual editor always wrote them. */
  aiAuthored?: boolean
}

/**
 * THE NEWSLETTER CREATOR (moved here from app/actions/ai-newsletter.ts createNewsletterCampaign,
 * now its session door). Envelope in newsletter_campaigns, the Wave 20 per-section decompose
 * into newsletter_sections, the topic-use ledger, NEWSLETTER_SCHEDULED and the usage counter.
 */
export async function createNewsletterCampaign(input: CreateNewsletterCampaignInput): Promise<
  ContentRefusal | { success: true; newsletter: Record<string, any>; audienceSize: number }
> {
  const { ctx } = input
  const refused = actorRefusal(ctx, "newsletter")
  if (refused) return refused
  if (!input.title?.trim()) return { success: false, error: "A newsletter title is required." }
  if (!input.subjectLine?.trim()) return { success: false, error: "A subject line is required." }

  const supabase: ContentClient = input.client ?? createServiceClient()
  const featureClient = supabase as unknown as FeatureClient
  const brokerageId = ctx.brokerageId
  const userId = ctx.userId

  const access = await canAccessFeature(userId, "newsletter_engine", undefined, featureClient)
  if (!access.allowed) return { success: false, error: access.reason || "Feature not available" }

  // agents.id (newsletter_campaigns.agent_id FKs agents), pinned to the tenant. The action's
  // old fallback read `.eq("user_id")` with no tenant predicate.
  const agent = await resolveActorAgentId(supabase, ctx)
  if (!agent.ok) return { success: false, error: agent.error }
  const agentsTableId = agent.agentId

  let marketingCampaignId: string | null = null
  if (input.marketingCampaignId) {
    const v = await verifyInTenant(supabase, "marketing_campaigns", input.marketingCampaignId, brokerageId, "campaign")
    if (!v.ok) return { success: false, error: v.error }
    marketingCampaignId = v.id
  }

  const body = typeof input.content === "string" ? input.content : JSON.stringify(input.content)
  let newsletter: Record<string, any>
  if (input.campaignId) {
    const owned = await verifyInTenant(supabase, "newsletter_campaigns", input.campaignId, brokerageId, "newsletter")
    if (!owned.ok) return { success: false, error: owned.error }
    // COUNTED update: a matched-nothing update resolves exactly like one that worked (§3).
    const { data: updated, error: updateError } = await supabase
      .from("newsletter_campaigns")
      .update({
        campaign_name: input.title,
        subject_line: input.subjectLine,
        content: body,
        status: input.scheduledAt ? "scheduled" : "draft",
        send_date: input.scheduledAt ?? null,
        marketing_campaign_id: marketingCampaignId,
      })
      .eq("id", owned.id)
      .eq("brokerage_id", brokerageId)
      .select()
    const one = exactlyOne(updated, updateError, "Newsletter update")
    if (!one.ok) return { success: false, error: one.error }
    newsletter = one.row
    // Re-decompose: the sections below replace the old ones.
    const { error: clearError } = await supabase
      .from("newsletter_sections").delete().eq("newsletter_id", owned.id).eq("brokerage_id", brokerageId)
    if (clearError) console.error(`[content-creators] stale-section clear failed for ${owned.id}:`, clearError.message)
  } else {
    const { data: created, error } = await supabase
      .from("newsletter_campaigns")
      .insert({
        campaign_name: input.title,                // campaign_name NOT title
        subject_line: input.subjectLine,
        content: body,
        status: input.scheduledAt ? "scheduled" : "draft",
        send_date: input.scheduledAt ?? null,      // send_date NOT scheduled_at
        brokerage_id: brokerageId,                 // the verified actor's tenant
        agent_id: agentsTableId,                   // agents.id NOT users.id
        created_by: userId,                        // users.id
        marketing_campaign_id: marketingCampaignId,
        ...(input.aiAuthored ? { is_ai_generated: true, approval_status: "pending_review" } : {}),
      })
      .select()
    const one = exactlyOne(created, error, "Newsletter campaign")
    if (!one.ok) return { success: false, error: one.error }
    newsletter = one.row
  }
  const savedCampaign = newsletter

  // Wave 20 decomposer — the non-flat per-section targeting the assembler reads. Best-effort:
  // the assembler falls back to the flat campaign body, so a decompose failure is logged.
  if (Array.isArray(input.content) && input.content.length > 0) {
    const { normalizeSectionType, defaultOrderFor } = await import("@/lib/kernel/newsletter/section-types")
    const sectionRows = input.content.map((s, i) => {
      const tp = Array.isArray(s.target_personas) && s.target_personas.length > 0 ? s.target_personas : null
      const tl = s.target_locations &&
        ((s.target_locations.cities?.length ?? 0) + (s.target_locations.states?.length ?? 0) + (s.target_locations.zip_codes?.length ?? 0) > 0)
        ? s.target_locations : null
      const normalizedType = normalizeSectionType(s.section_type ?? s.type)
      return {
        newsletter_id: savedCampaign.id,
        brokerage_id: brokerageId,
        title: s.title ?? null,
        content: s.content ?? null,
        order_index: typeof s.order_index === "number" ? s.order_index : defaultOrderFor(normalizedType) + i,
        target_personas: tp,
        target_locations: tl,
        section_type: normalizedType,
      }
    })
    const { data: secRows, error: secErr } = await supabase.from("newsletter_sections").insert(sectionRows).select("id")
    if (secErr || (secRows ?? []).length !== sectionRows.length) {
      console.error(`[content-creators] section decompose for ${savedCampaign.id}: ${secErr?.message ?? `${(secRows ?? []).length}/${sectionRows.length} rows landed`}`)
    }
  }

  if (Array.isArray(input.seedTopicIds) && input.seedTopicIds.length > 0) {
    const { logTopicUses } = await import("@/lib/content-intel/performance-aggregator")
    void logTopicUses({ topicIds: input.seedTopicIds, brokerageId, assetType: "newsletter_campaign", assetId: String(savedCampaign.id) })
  }

  let audienceSize = 0
  if (agentsTableId) {
    const { count, error: countErr } = await supabase
      .from("newsletter_subscribers")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentsTableId)           // agents.id
      .eq("brokerage_id", brokerageId)
      .eq("status", "subscribed")
    if (countErr) console.error("[content-creators] audience count failed:", countErr.message)
    audienceSize = count ?? 0
  }

  if (input.scheduledAt) {
    processKernelEvent({
      event: KernelEvent.NEWSLETTER_SCHEDULED, brokerageId, entityType: "newsletter_campaign", entityId: String(savedCampaign.id),
    }).catch((err) => console.error("[content-creators] NEWSLETTER_SCHEDULED error:", err))
  }

  const usage = await incrementFeatureUsage(userId, "newsletter_engine", featureClient)
  if (!usage.success) console.error("[content-creators] newsletter_engine usage NOT counted:", usage.error)

  return { success: true, newsletter: savedCampaign, audienceSize }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. EMAIL CAMPAIGN — no kernel half existed; BUILT (§1.2)
// ═════════════════════════════════════════════════════════════════════════════

interface CreateEmailCampaignInput {
  ctx: MarketingActorContext
  client?: ContentClient
  campaignName: string
  subjectLine: string
  content?: string
  sendDate?: string
  /** marketing_campaigns.id — verified in-tenant (ROI rollup + video fan-out read it). */
  marketingCampaignId?: string
  /** contact_segments.segment_id — must have ACTIVE members in this tenant (Path B sender). */
  audienceSegmentId?: string
}

/**
 * THE EMAIL CAMPAIGN CREATOR (moved here from app/actions/email-campaigns.ts
 * createEmailCampaign, now its session door). email_campaigns = one-off blasts / drips /
 * segmented sends, NOT newsletter_campaigns. agent_id is an agents id VERIFIED in the tenant:
 * the door used to write a caller-supplied `params.agentId` unchecked.
 */
export async function createEmailCampaign(input: CreateEmailCampaignInput): Promise<
  ContentRefusal | { success: true; campaign: Record<string, any> }
> {
  const { ctx } = input
  const refused = actorRefusal(ctx, "email campaign")
  if (refused) return refused
  if (!input.campaignName?.trim()) return { success: false, error: "Campaign name is required." }
  if (!input.subjectLine?.trim()) return { success: false, error: "Subject line is required." }

  const supabase: ContentClient = input.client ?? createServiceClient()
  const featureClient = supabase as unknown as FeatureClient
  const brokerageId = ctx.brokerageId

  const access = await canAccessFeature(ctx.userId, "email_campaigns", undefined, featureClient)
  if (!access.allowed) return { success: false, error: access.reason ?? "Email campaigns feature not available" }

  const agent = await resolveActorAgentId(supabase, ctx)
  if (!agent.ok) return { success: false, error: agent.error }

  let marketingCampaignId: string | null = null
  if (input.marketingCampaignId) {
    const v = await verifyInTenant(supabase, "marketing_campaigns", input.marketingCampaignId, brokerageId, "campaign")
    if (!v.ok) return { success: false, error: v.error }
    marketingCampaignId = v.id
  }

  // contact_segments.segment_id has no FK and no catalogue: "does it exist" can only mean
  // "does anyone in THIS brokerage belong to it" — the question the sender will ask.
  let audienceSegmentId: string | null = null
  if (input.audienceSegmentId) {
    if (!isValidUUID(input.audienceSegmentId)) return { success: false, error: "Invalid segment ID" }
    const { data: member, error: segmentError } = await supabase
      .from("contact_segments").select("id")
      .eq("segment_id", input.audienceSegmentId).eq("brokerage_id", brokerageId).is("removed_at", null)
      .limit(1).maybeSingle()
    if (segmentError) return { success: false, error: `Could not verify that segment: ${segmentError.message}` }
    if (!member) return { success: false, error: "That segment has no active members on your brokerage." }
    audienceSegmentId = input.audienceSegmentId
  }

  const { data: rows, error } = await supabase
    .from("email_campaigns")
    .insert({
      brokerage_id: brokerageId,                 // the verified actor's tenant
      agent_id: agent.agentId,                   // agents.id, verified or crossed — never users.id
      marketing_campaign_id: marketingCampaignId,
      audience_segment_id: audienceSegmentId,
      campaign_name: input.campaignName.trim(),
      subject_line: input.subjectLine.trim(),
      content: input.content ?? "",
      status: "draft",
      approval_status: "pending",
      created_by: ctx.userId,                    // users.id
      send_date: input.sendDate ?? null,
      brand_compliance_passed: false,
    })
    .select()
  const one = exactlyOne(rows, error, "Email campaign")
  if (!one.ok) return { success: false, error: one.error }
  const campaign = one.row

  const usage = await incrementFeatureUsage(ctx.userId, "email_campaigns", featureClient)
  if (!usage.success) console.error("[content-creators] email_campaigns usage NOT counted:", usage.error)

  await processKernelEvent({
    event: KernelEvent.EMAIL_CAMPAIGN_CREATED, brokerageId, entityType: "newsletter_campaign", entityId: String(campaign.id),
  }).catch((err) => console.error("[content-creators] EMAIL_CAMPAIGN_CREATED not processed (non-blocking):", err))

  return { success: true, campaign }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. BLOG DRAFT
// ═════════════════════════════════════════════════════════════════════════════

interface CreateBlogPostDraftInput {
  ctx: MarketingActorContext
  client?: ContentClient
  title: string
  slug?: string
  excerpt?: string
  content?: string
  featuredImageUrl?: string
  category?: string
  callToAction?: string
  publishStatus?: "draft" | "pending_review"
  keywords?: string[]
}

/**
 * THE MANUAL/STAGED BLOG DRAFT CREATOR (moved here from app/actions/blog.ts saveBlogPost, now
 * its session door; also the survivor of lib/wizard-staging/content-staging.ts's raw
 * blog_posts fallback insert, which skipped the gate and the counter). No model writes here:
 * the model-written post is app/actions/blog.ts generateBlogPost.
 */
export async function createBlogPostDraft(input: CreateBlogPostDraftInput): Promise<
  ContentRefusal | { success: true; postId: string }
> {
  const { ctx } = input
  const refused = actorRefusal(ctx, "blog post")
  if (refused) return refused
  if (!input.title?.trim()) return { success: false, error: "A blog post title is required." }

  const supabase: ContentClient = input.client ?? createServiceClient()
  const featureClient = supabase as unknown as FeatureClient
  const brokerageId = ctx.brokerageId
  const userId = ctx.userId

  const access = await canAccessFeature(userId, "seo_blog_engine", undefined, featureClient)
  if (!access.allowed) return { success: false, error: access.reason || "Feature access denied" }

  const slug = (input.slug || input.title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)) || `post-${Date.now()}`

  const insertData: Record<string, unknown> = {
    brokerage_id: brokerageId,
    agent_user_id: userId,        // FK users
    created_by: userId,           // FK users
    title: input.title,
    slug,
    excerpt: input.excerpt || null,
    content: input.content || null,
    featured_image_url: input.featuredImageUrl || null,
    publish_status: input.publishStatus ?? "draft",
    visibility_scope: "agent",
    approval_status: "pending",
  }
  if (input.category) insertData.category = input.category
  if (input.callToAction) insertData.call_to_action = input.callToAction

  const { data: rows, error: insertError } = await supabase.from("blog_posts").insert(insertData).select("id")
  const one = exactlyOne(rows, insertError, "Blog post")
  if (!one.ok) {
    console.error("[content-creators] blog insert:", one.error)
    return { success: false, error: one.error }
  }
  const postId = String(one.row.id)

  if (input.keywords?.length) {
    for (let i = 0; i < input.keywords.length; i++) {
      const keyword = input.keywords[i]
      const isPrimary = i === 0
      const { data: existingKw, error: kwReadErr } = await supabase
        .from("seo_keywords").select("id").eq("brokerage_id", brokerageId).eq("keyword", keyword).maybeSingle()
      if (kwReadErr) return { success: false, error: `Post saved but keywords could not be read: ${kwReadErr.message}` }
      let seoKeywordId: string
      if (existingKw) {
        seoKeywordId = (existingKw as { id: string }).id
      } else {
        const { data: newKw, error: kwErr } = await supabase
          .from("seo_keywords")
          .insert({
            brokerage_id: brokerageId, keyword, keyword_type: isPrimary ? "primary" : "secondary",
            search_intent: "informational", visibility_scope: "agent", created_by: userId, is_active: true,
          })
          .select("id")
        const kw = exactlyOne(newKw, kwErr, "SEO keyword")
        if (!kw.ok) return { success: false, error: "Post saved but failed to create keywords" }
        seoKeywordId = String(kw.row.id)
      }
      const { error: linkError } = await supabase.from("blog_post_keywords").insert({
        brokerage_id: brokerageId, blog_post_id: postId, seo_keyword_id: seoKeywordId, is_primary: isPrimary,
      })
      if (linkError) {
        console.error("[content-creators] keyword link insert failed:", linkError.message)
        return { success: false, error: "Post saved but failed to link keywords" }
      }
    }
  }

  // Increment usage only after all writes succeed
  const usage = await incrementFeatureUsage(userId, "seo_blog_engine", featureClient)
  if (!usage.success) console.error("[content-creators] seo_blog_engine usage NOT counted:", usage.error)
  return { success: true, postId }
}

/** The AI blog writer's input. The tenant and the actor are ctx (VERIFIED by the caller); the
 *  rest is the brief. `agentUserId` attributes the post to another seat of the SAME tenant
 *  (users id, verified here) — the cadence cron writes for the scope's agent. */
interface WriteBlogPostInput {
  ctx: MarketingActorContext
  client?: ContentClient
  agentUserId?: string
  title?: string
  keywords: string[]
  campaignId?: string
  tone?: string
  /** Source material to repurpose (e.g. a video transcript) — the article is written FROM it. */
  sourceContent?: string
  /** When true, generate a branded cover image and set featured_image_url. */
  generateCoverImage?: boolean
  /** Topic-bank persona (m136 per-persona weighting) when pullFromTopicBank is set. */
  recipientPersona?: string
  /** Cadence-cron path: pick topics from content_topic_bank instead of keywords alone. */
  pullFromTopicBank?: boolean
}

interface BlogPostDraftJson {
  title: string
  slug: string
  excerpt: string
  content: string
  featuredImagePrompt: string
}

/**
 * THE AI BLOG WRITER (lane 86C). The body moved here from app/actions/blog.ts generateBlogPost,
 * which is now its SESSION door; the cadence cron (app/api/cron/blog-cadence-tick) calls it
 * directly with the scope row's tenant. Merged onto it (§1.1) from the unwired duplicate
 * lib/kernel/marketing.ts createBlogPost, deleted with a tombstone:
 *   · the caller-named umbrella campaign is VERIFIED in this tenant before it is written (the
 *     survivor wrote `params.campaignId` raw — a foreign id would file this tenant's post under
 *     another tenant's campaign ROI, lib/marketing/campaign-measurer.ts);
 *   · the insert runs on the service client after the gate (the survivor wrote through the
 *     COOKIE client, so the sessionless cadence cron was refused by brok_blog_posts every run,
 *     and its feature gate read feature_flags as anon and refused first).
 * What neither copy had — COMPLIANCE-FIRST (§5), the same kit the newsletter and podcast
 * writers carry: the brief is pre-checked for fair housing before any model sees it,
 * buildComplianceSystemBlocks (brand voice + ThemFirst + Fair Housing + the brokerage's own
 * prohibited phrases) is in the SYSTEM prompt, and postcheckScript (gradeWrittenCopy) grades the
 * article. A hard fair-housing / blocking-phrase flag refuses the draft; advisory findings pass
 * through as complianceWarnings. evaluateOutbound still runs as the blocking gate.
 */
export async function writeBlogPost(input: WriteBlogPostInput): Promise<
  ContentRefusal | { success: true; postId: string; title: string; content: string; keywordWarnings?: string[]; complianceWarnings: string[] }
> {
  const { ctx } = input
  const refused = actorRefusal(ctx, "blog post")
  if (refused) return refused
  const keywords = (input.keywords ?? []).map((k) => String(k).trim()).filter(Boolean)

  const supabase: ContentClient = input.client ?? createServiceClient()
  const featureClient = supabase as unknown as FeatureClient
  const brokerageId = ctx.brokerageId
  const userId = ctx.userId

  // ── 1. Feature gate (through the caller's client — never the anon cookie) ──
  const access = await canAccessFeature(userId, "seo_blog_engine", undefined, featureClient)
  if (!access.allowed) return { success: false, error: access.reason || "Feature access denied" }

  // ── 2. Every caller-named id is verified in THIS tenant ──────────────────
  let agentUserId: string | null = null
  if (input.agentUserId && input.agentUserId !== userId) {
    const v = await verifyInTenant(supabase, "users", input.agentUserId, brokerageId, "agent")
    if (!v.ok) return { success: false, error: v.error }
    agentUserId = v.id
  } else if (input.agentUserId) {
    agentUserId = userId
  }
  let marketingCampaignId: string | null = null
  if (input.campaignId) {
    const v = await verifyInTenant(supabase, "marketing_campaigns", input.campaignId, brokerageId, "campaign")
    if (!v.ok) return { success: false, error: v.error }
    marketingCampaignId = v.id
  }

  const [compliance, { applyTenantBrandVoice, evaluateTenantOutbound }, topicBank, { logTopicUses }, { generateTextRouted }] =
    await Promise.all([
      import("@/lib/video/script-compliance"), import("@/lib/kernel/tenant-config-reads"),
      import("@/lib/content-intel/topic-bank"), import("@/lib/content-intel/performance-aggregator"),
      import("@/lib/ai/models"),
    ])
  const actor = { userId, brokerageId }

  // ── 3. The brief is screened before any model sees it (deterministic first) ──
  const brief = [input.title ?? "", keywords.join(", "), (input.sourceContent ?? "").slice(0, 6000)].filter(Boolean).join("\n")
  if (brief.trim()) {
    const pre = await compliance.precheckBriefForFairHousing(actor, brief, "buyer", { client: supabase })
    if (pre.blocked) return { success: false, error: `This topic cannot be written as asked: ${pre.reason}` }
  }

  // ── 4. Brand voice (the tenant's, on the service client — 86C) ────────────
  const brandVoice = await applyTenantBrandVoice({
    brokerageId, actorUserId: agentUserId ?? userId, actorRole: "agent", journeyType: "buyer",
    persona: "first_time", messageType: "email", content: keywords.join(", "),
  }, supabase)
  const toneDescription = input.tone || brandVoice.tone || "professional and helpful"

  // ── 5. Topic-bank seeding (cadence path) ──────────────────────────────────
  type TopicCandidate = Awaited<ReturnType<typeof topicBank.pickTopics>>[number]
  let topicSeeds: TopicCandidate[] = []
  if (input.pullFromTopicBank) {
    try {
      topicSeeds = await topicBank.pickTopics({
        brokerageId,
        categoriesAny: keywords.length > 0 ? keywords : undefined,
        limit: 3,
        markUsed: false,
        recipientPersona: input.recipientPersona ?? null,
        assetType: "blog_post",
      })
    } catch (e) {
      console.warn("[content-creators] blog topic-bank pick failed; falling back to keywords-only:", (e as Error).message)
    }
  }
  if (keywords.length === 0 && topicSeeds.length === 0 && !input.sourceContent?.trim()) {
    return { success: false, error: "Provide keywords, source material or a topic-bank pick to write a blog post." }
  }
  const topicSeedBlock = topicSeeds.length > 0
    ? `\n\nTOPIC INTELLIGENCE THREADS (build the article around these):
The platform's content-intelligence bank surfaced these as the highest-engagement
threads for this brokerage's audience right now. Lead with the strongest
single thread; weave the others as supporting structure.

${topicBank.renderTopicsForPrompt(topicSeeds)}`
    : ""

  // ── 6. Write — compliance-first: the rules are in the SYSTEM prompt ───────
  const blocks = await compliance.buildComplianceSystemBlocks(brokerageId, undefined, supabase)
  const systemPrompt = [
    `You are a real estate content writer for a professional brokerage. Write in a ${toneDescription} style.
${brandVoice.keyBrandMessages?.length ? `Key messages to incorporate: ${brandVoice.keyBrandMessages.join(", ")}` : ""}
${brandVoice.prohibitedWords?.length ? `Avoid these words: ${brandVoice.prohibitedWords.join(", ")}` : ""}

ONLINE VISIBILITY (this brokerage's chosen positioning — NOT SEO keyword stuffing):
  · Be CITABLE by AI search (Google AI Overviews, ChatGPT, Claude, Perplexity, Gemini). Use clear facts with named entities + named sources where applicable.
  · Open with a 2-3 sentence summary that an AI engine can pull as a citation snippet.
  · Use FAQ-style H2/H3 headings written as the QUESTIONS a real-estate buyer/seller actually types.
  · Attribute non-obvious claims to a source. Never invent a source — when uncertain, soften with "in many markets" rather than fabricate a citation.
  · Make the article shareable: end with a single specific takeaway readers can quote on social.`,
    ...blocks,
  ].join("\n\n")

  const userPrompt = `Write a 700-900 word blog post about real estate topics related to: ${keywords.join(", ") || "the source material below"}.
${input.sourceContent ? `Base the article on this source material (repurpose its key points; do not invent specific properties, prices, or guarantees):\n"""${input.sourceContent.slice(0, 6000)}"""\n` : ""}${input.title ? `Use this title: ${input.title}` : "Create an engaging title — written as a question or a specific claim the reader is searching for."}
${topicSeedBlock}

Structure (online-visibility format):
1. 2-3 sentence opening summary (the citation snippet).
2. 3-5 H2 sections written as questions the reader would search for.
3. Each section: a direct answer in the first sentence, then supporting context.
4. Closing takeaway — one specific actionable sentence (not "contact us").

Compliance fence (non-negotiable):
  · Never reference protected characteristics (race, color, religion, national origin, sex, disability, familial status).
  · No "perfect for families", "great for empty-nesters", or similar demographic proxies.
  · No guaranteed appreciation / valuation / rate claims.
  · No predictive market direction claims without an attributed source.

Return ONLY valid JSON with this exact structure (no markdown, no code blocks):
{
  "title": "The blog post title",
  "slug": "the-blog-post-slug",
  "excerpt": "A compelling 150-160 character meta description (also the OG card description)",
  "content": "The full blog post content with proper HTML headings (h2, h3) and paragraphs",
  "featuredImagePrompt": "A descriptive prompt for generating a featured image"
}`

  let draft: BlogPostDraftJson
  try {
    const { text } = await generateTextRouted({
      feature: "blog_post_generation",
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.7,
      brokerageId,
      userId,
    })
    draft = JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim()) as BlogPostDraftJson
  } catch (err) {
    console.error("[content-creators] blog generation failed:", err)
    return { success: false, error: `Failed to generate blog content: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!draft?.content?.trim() || !draft?.title?.trim()) {
    return { success: false, error: "The model returned a blog post with no title or body." }
  }

  // ── 7. The blocking gate, then the post-check grade ───────────────────────
  const gate = await evaluateTenantOutbound({
    actorContext: { userId, role: "agent", brokerageId },
    journeyType: "buyer", persona: "first_time", messageType: "email", content: draft.content,
    // Broadcast payload — no stub contact (lib/video/script-compliance.ts explains why).
  }, supabase)
  if (!gate.allowed) return { success: false, error: `Compliance check failed: ${gate.violations.join(", ")}` }

  const graded = await gradeWrittenCopy(actor, `${draft.title}\n\n${draft.content}`, supabase)
  if (graded.redFlags.length > 0) {
    return { success: false, error: `The drafted post tripped a hard compliance flag and was not kept: ${graded.redFlags.join("; ")}`, complianceWarnings: graded.redFlags }
  }

  // ── 8. Optional branded cover image ───────────────────────────────────────
  let featuredImageUrl: string | null = null
  if (input.generateCoverImage && draft.featuredImagePrompt) {
    try {
      const { generateImage } = await import("@/lib/ai/image-generation")
      const { data: brokerage } = await supabase
        .from("brokerages")
        .select("name, dba_name:dba, license_number, license_state, logo_url, brand_primary_color:primary_color")
        .eq("id", brokerageId)
        .maybeSingle()
      const b = brokerage as { name: string | null; dba_name: string | null; license_number: string | null; license_state: string | null; logo_url: string | null; brand_primary_color: string | null } | null
      const img = await generateImage({
        prompt: draft.featuredImagePrompt,
        purpose: "blog_hero",
        size: "1792x1024",
        quality: "standard",
        brand: {
          brokerageName: b?.name ?? null,
          brokerageDba: b?.dba_name ?? null,
          brokerageLicense: b?.license_number ?? null,
          brokerageLicenseState: b?.license_state ?? null,
          logoUrl: b?.logo_url ?? null,
          primaryColor: b?.brand_primary_color ?? null,
        },
      })
      if (img.success && img.imageUrl) featuredImageUrl = img.imageUrl
    } catch (imgErr) {
      console.error("[content-creators] blog cover image failed (non-blocking):", imgErr)
    }
  }

  // ── 9. COUNTED insert ─────────────────────────────────────────────────────
  const { data: rows, error: insertError } = await supabase
    .from("blog_posts")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: agentUserId,          // FK users
      marketing_campaign_id: marketingCampaignId,
      title: draft.title,
      slug: draft.slug || draft.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `post-${Date.now()}`,
      excerpt: draft.excerpt ?? null,
      content: draft.content,
      featured_image_url: featuredImageUrl,
      publish_status: "draft",
      visibility_scope: agentUserId ? "agent" : "brokerage",
      created_by: userId,                  // FK users
      is_ai_generated: true,
    })
    .select("id")
  const one = exactlyOne(rows, insertError, "Blog post")
  if (!one.ok) {
    console.error("[content-creators] AI blog insert:", one.error)
    return { success: false, error: one.error }
  }
  const postId = String(one.row.id)

  if (topicSeeds.length > 0) {
    void logTopicUses({ topicIds: topicSeeds.map((t) => t.id), brokerageId, assetType: "blog_post", assetId: postId })
  }

  // ── 10. Keywords — a keyword that cannot be stored is named, never dropped ──
  const keywordFailures: string[] = []
  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i]
    const isPrimary = i === 0
    const { data: existingKeyword, error: kwReadErr } = await supabase
      .from("seo_keywords").select("id").eq("brokerage_id", brokerageId).eq("keyword", keyword).maybeSingle()
    if (kwReadErr) { keywordFailures.push(`${keyword}: ${kwReadErr.message}`); continue }
    let seoKeywordId: string
    if (existingKeyword) {
      seoKeywordId = (existingKeyword as { id: string }).id
    } else {
      const { data: newKeyword, error: kwError } = await supabase
        .from("seo_keywords")
        .insert({
          brokerage_id: brokerageId, keyword, keyword_type: isPrimary ? "primary" : "secondary",
          search_intent: "informational", visibility_scope: agentUserId ? "agent" : "brokerage",
          created_by: userId, is_active: true,
        })
        .select("id")
      const kw = exactlyOne(newKeyword, kwError, "SEO keyword")
      if (!kw.ok) { keywordFailures.push(`${keyword}: ${kw.error}`); continue }
      seoKeywordId = String(kw.row.id)
    }
    const { error: linkError } = await supabase.from("blog_post_keywords").insert({
      brokerage_id: brokerageId, blog_post_id: postId, seo_keyword_id: seoKeywordId, is_primary: isPrimary,
    })
    if (linkError) keywordFailures.push(`${keyword}: link refused (${linkError.message})`)
  }

  // ── 11. Usage + kernel event (the compliance officer's pre-publish pass) ──
  const usage = await incrementFeatureUsage(userId, "seo_blog_engine", featureClient)
  if (!usage.success) console.error("[content-creators] seo_blog_engine usage NOT counted:", usage.error)
  await processKernelEvent({
    event: KernelEvent.BLOG_POST_GENERATED,
    brokerageId,
    entityType: "blog_post",
    entityId: postId,
  }).catch((err) => console.error("[content-creators] BLOG_POST_GENERATED event failed (non-blocking):", err))

  return {
    success: true,
    postId,
    title: draft.title,
    content: draft.content,
    ...(keywordFailures.length ? { keywordWarnings: keywordFailures } : {}),
    complianceWarnings: graded.warnings,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. PODCAST — the writer (writePodcastScript) and the creator
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE PODCAST SCRIPT WRITER (moved here from app/actions/podcast-generation.ts
 * generateScriptFromKeywords, a private helper of a "use server" file). It used to write with
 * a bare "professional podcast script writer" system prompt: no fair housing, no brand voice,
 * no post-check. It is now compliance-first (§5): the buildComplianceSystemBlocks are the
 * system prompt, and postcheckScript (gradeWrittenCopy) grades the output. A hard fair-housing flag
 * REFUSES the script; advisory findings pass through as warnings.
 */
export async function writePodcastScript(input: {
  ctx: MarketingActorContext
  client?: ContentClient
  keywords: string[]
  category?: string
}): Promise<ContentRefusal | { success: true; script: string; complianceWarnings: string[] }> {
  const { ctx } = input
  const refused = actorRefusal(ctx, "podcast script")
  if (refused) return refused
  const seed = (input.keywords ?? []).map((k) => String(k).trim()).filter(Boolean)
  if (seed.length === 0) return { success: false, error: "Provide a topic or at least one keyword." }
  const supabase: ContentClient = input.client ?? createServiceClient()

  const access = await canAccessFeature(ctx.userId, "podcast_generation", undefined, supabase as unknown as FeatureClient)
  if (!access.allowed) return { success: false, error: access.reason ?? "Podcast generation not available" }

  const compliance = await import("@/lib/video/script-compliance")
  const actor = { userId: ctx.userId, brokerageId: ctx.brokerageId }

  // The brief itself is screened before any model sees it (deterministic first; a throw is
  // reported, never read as clean).
  const brief = seed.join(", ")
  const pre = await compliance.precheckBriefForFairHousing(actor, brief, "buyer", { client: supabase })
  if (pre.blocked) return { success: false, error: `This topic cannot be written as asked: ${pre.reason}` }

  const blocks = await compliance.buildComplianceSystemBlocks(ctx.brokerageId, undefined, supabase)
  // A podcast script is SPOKEN (ElevenLabs renders it in the agent's voice), so it carries the
  // shared spoken-script standards (SCRIPT_QUALITY_CHARTER + SPOKEN_REALISM_DIRECTIVE) through
  // the ONE composer, and the AI-tell scan grades the output (advisory, never a hold).
  const { withSpokenScriptStandards, scanForAiTells } = await import("@/lib/video/realism-profile")
  const { gatewayChat } = await import("@/lib/ai/gateway-chat")
  const response = await gatewayChat({
    model: "xai/grok-beta",
    temperature: 0.7,
    maxTokens: 2048,
    messages: [
      { role: "system", content: ["You are a professional podcast script writer for real estate agents.", ...blocks].join("\n\n") },
      {
        role: "user",
        content: withSpokenScriptStandards(`Generate a 3-5 minute podcast script for a real estate agent based on these keywords: ${brief}.
  Category: ${input.category || "general real estate"}

  The script should:
  - Have a friendly, conversational tone
  - Include an intro, main content, and outro
  - Be engaging and informative
  - Include transitions between topics
  - End with a call-to-action

  Format: Return only the script text, no additional formatting.`),
      },
    ],
  })
  if (!response.ok) return { success: false, error: `Script generation failed: ${response.error}` }
  const script = String(response.content ?? "").trim()
  if (!script) return { success: false, error: "The model returned an empty script." }

  const graded = await gradeWrittenCopy(actor, script, supabase)
  if (graded.redFlags.length > 0) {
    return { success: false, error: `The drafted script tripped a hard compliance flag and was not kept: ${graded.redFlags.join("; ")}`, complianceWarnings: graded.redFlags }
  }
  return { success: true, script, complianceWarnings: [...graded.warnings, ...scanForAiTells(script)] }
}

interface CreatePodcastEpisodeInput {
  ctx: MarketingActorContext
  client?: ContentClient
  title: string
  description?: string
  script?: string
  keywords?: string[]
  templateId?: string
  voiceId?: string
  category?: string
  sourceVideoProjectId?: string
  sourceVideoAssetId?: string
  marketingCampaignId?: string
  publishChannels?: string[]
}

/**
 * THE PODCAST EPISODE CREATOR (moved here from app/actions/podcast-generation.ts
 * createPodcastEpisode, now its session door; survivor of lib/kernel/marketing.ts
 * createPodcastEpisodeKernel and of content-staging's raw podcast_episodes fallback).
 * podcast_episodes.agent_id is a NOT NULL FK to agents: a seat with no agents row in this
 * tenant is refused, never filed under its users id.
 */
export async function createPodcastEpisode(input: CreatePodcastEpisodeInput): Promise<
  | ContentRefusal & { violations?: string[] }
  | { success: true; episode: Record<string, any>; brandVoiceNotes: string[]; complianceWarnings?: string[] }
> {
  const { ctx } = input
  const refused = actorRefusal(ctx, "podcast episode")
  if (refused) return refused
  if (!input.title?.trim()) return { success: false, error: "Episode title is required." }

  const supabase: ContentClient = input.client ?? createServiceClient()
  const featureClient = supabase as unknown as FeatureClient
  const brokerageId = ctx.brokerageId
  const userId = ctx.userId

  const access = await canAccessFeature(userId, "podcast_generation", undefined, featureClient)
  if (!access.allowed) return { success: false, error: access.reason || "Feature access denied" }

  const agent = await resolveActorAgentId(supabase, ctx)
  if (!agent.ok) return { success: false, error: agent.error }
  if (!agent.agentId) {
    return { success: false, error: "No agent profile for this user in this brokerage — the episode has no owner to file it under." }
  }
  const agentId = agent.agentId

  // Every caller-named id is verified in THIS tenant before it is written.
  const verified: Record<string, string | null> = { marketing_campaign_id: null, source_video_project_id: null, source_video_asset_id: null }
  for (const [col, table, id, label] of [
    ["marketing_campaign_id", "marketing_campaigns", input.marketingCampaignId, "campaign"],
    ["source_video_project_id", "ai_video_projects", input.sourceVideoProjectId, "source video"],
    ["source_video_asset_id", "video_assets", input.sourceVideoAssetId, "source video asset"],
  ] as const) {
    if (!id) continue
    const v = await verifyInTenant(supabase, table, id, brokerageId, label)
    if (!v.ok) return { success: false, error: v.error }
    verified[col] = v.id
  }

  // Sessionless door (86C): provider_overrides is readable by platform admins only, so the
  // cookie read answered "system default" for every tenant; ctx is verified, read on service.
  const { resolveTenantProvider, applyTenantBrandVoice, evaluateTenantOutbound } = await import("@/lib/kernel/tenant-config-reads")
  const provider = await resolveTenantProvider({ providerType: "video", actorContext: { userId, brokerageId, teamId: undefined } })

  let templateData: Record<string, any> | null = null
  if (input.templateId) {
    if (!isValidUUID(input.templateId)) return { success: false, error: "Invalid template ID" }
    const { data: template, error: templateErr } = await supabase
      .from("podcast_templates").select("*").eq("id", input.templateId).eq("brokerage_id", brokerageId).maybeSingle()
    if (templateErr) return { success: false, error: `Could not read that template: ${templateErr.message}` }
    if (!template) return { success: false, error: "That podcast template is not on your brokerage." }
    templateData = template as Record<string, any>
  }

  // The agent's ElevenLabs clone (agent_voice_profiles, keyed by agents.id).
  const { data: voiceProfile, error: voiceErr } = await supabase
    .from("agent_voice_profiles").select("elevenlabs_voice_id")
    .eq("agent_id", agentId).eq("brokerage_id", brokerageId)
    .order("is_default", { ascending: false }).limit(1).maybeSingle()
  if (voiceErr) console.error("[content-creators] voice profile read failed:", voiceErr.message)
  const agentVoiceId = (voiceProfile as { elevenlabs_voice_id?: string | null } | null)?.elevenlabs_voice_id ?? null

  let finalScript = input.script
  let complianceWarnings: string[] = []
  if (!finalScript?.trim() && input.keywords && input.keywords.length > 0) {
    const written = await writePodcastScript({ ctx, client: supabase, keywords: input.keywords, category: input.category })
    if (!written.success) return written
    finalScript = written.script
    complianceWarnings = written.complianceWarnings
  }
  if (!finalScript?.trim()) return { success: false, error: "Script or keywords required" }

  const brandVoiceResult = await applyTenantBrandVoice({
    brokerageId, actorUserId: userId, actorRole: "agent", journeyType: "buyer",
    persona: "first_time", messageType: "social", content: finalScript,
  })
  if (brandVoiceResult.violations.some((v) => v.toLowerCase().includes("prohibited"))) {
    return { success: false, error: `Brand voice violation: ${brandVoiceResult.violations[0]}`, violations: brandVoiceResult.violations }
  }

  // Broadcast content: the agent is not a recipient, so no `contact` (DNC/TCPA skipped, and the
  // compliance_events row can land — an agents id in a contact slot never matched a contact).
  const complianceResult = await evaluateTenantOutbound({
    actorContext: { userId, brokerageId, teamId: undefined, role: "agent" },
    journeyType: "buyer", persona: "first_time", messageType: "social", content: finalScript,
  })
  if (!complianceResult.allowed) {
    return { success: false, error: `Compliance violation: ${complianceResult.blockedReason}`, violations: complianceResult.violations }
  }

  const { data: rows, error } = await supabase
    .from("podcast_episodes")
    .insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      template_id: templateData ? String(templateData.id) : null,
      marketing_campaign_id: verified.marketing_campaign_id,
      source_video_project_id: verified.source_video_project_id,
      source_video_asset_id: verified.source_video_asset_id,
      title: input.title,
      description: input.description || "",
      script: finalScript,
      keywords: input.keywords || [],
      primary_voice_id: input.voiceId || agentVoiceId || templateData?.default_voice_id || (provider as any).config?.default_voice_id || "default",
      voice_settings: templateData?.voice_settings || (provider as any).config?.voice_settings || {
        stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true,
      },
      category: input.category || "general",
      status: "draft",
      publish_channels: input.publishChannels || [],
    })
    .select()
  const one = exactlyOne(rows, error, "Podcast episode")
  if (!one.ok) return { success: false, error: one.error }
  const episode = one.row

  // The template's use counter (rendered "Used {n} times"). Read-then-write, counted, never
  // blocking the episode.
  if (templateData) {
    const { data: bumped, error: bumpErr } = await supabase
      .from("podcast_templates")
      .update({ use_count: Number(templateData.use_count ?? 0) + 1 })
      .eq("id", String(templateData.id)).eq("agent_id", agentId).eq("brokerage_id", brokerageId)
      .select("id")
    if (bumpErr) console.error("[content-creators] template use_count not bumped:", bumpErr.message)
    else if ((bumped ?? []).length === 0) console.error(`[content-creators] template ${templateData.id} matched no row of this agent when bumping use_count`)
  }

  const usage = await incrementFeatureUsage(userId, "podcast_generation", featureClient)
  if (!usage.success) console.error("[content-creators] podcast_generation usage NOT counted:", usage.error)

  const { checkBrandCompliance } = await import("@/lib/kernel/brand-compliance")
  await checkBrandCompliance({ contentType: "podcast", contentId: String(episode.id), brokerageId })
    .catch((err: unknown) => console.error("[content-creators] podcast brand compliance (non-blocking):", err))

  return {
    success: true,
    episode,
    brandVoiceNotes: brandVoiceResult.notes,
    ...(complianceWarnings.length > 0 ? { complianceWarnings } : {}),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. VIDEO PROJECT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ai_video_projects_video_type_check, the ONE list in app code (moved here from
 * app/api/video/projects/route.ts, retired wave 86 — tombstone at app/actions/video.ts).
 * Regenerated source of truth:
 * scripts/check-vocabularies.ts (never hand-edit that cache).
 */
export const AI_VIDEO_PROJECT_TYPES = [
  "listing_tour", "pre_appointment", "coming_soon", "just_listed", "open_house_promo",
  "just_sold", "agent_intro", "market_update", "education", "social_reel",
  "listing_promo", "testimonial", "welcome", "presentation_chapter", "memory_video",
  "avatar_explainer", "home_anniversary",
] as const

/** ai_video_projects_audience_type_check: in_house | customer_facing. The door's type spelled
 *  the internal kind "internal" (§6) — folded here. Absent → customer_facing (the column
 *  default and the safer gate; the survivor used to write NULL into this NOT NULL column). */
type VideoAudienceType = "in_house" | "customer_facing"
function canonicalVideoAudienceType(v: string | null | undefined): VideoAudienceType | null {
  if (v === undefined || v === null || v === "") return "customer_facing"
  if (v === "customer_facing") return "customer_facing"
  if (v === "in_house" || v === "internal") return "in_house"
  return null
}

interface VideoProjectFields {
  title: string
  /** The spoken script. Optional ONLY in the scriptPending shell lane. */
  script?: string
  /** The scriptless shell (app/actions/video.ts generateVideoScriptAction fills it later). */
  scriptPending?: boolean
  videoType: string
  avatarId?: string
  voiceId?: string
  backgroundType: "solid" | "gradient" | "branded" | "custom" | "property"
  backgroundUrl?: string
  backgroundColorHex?: string
  format: "horizontal" | "square" | "vertical"
  durationSeconds: number
  captionsEnabled: boolean
  listingId?: string
  templateId?: string
  audienceType?: "customer_facing" | "in_house" | "internal"
  brandComplianceCheck?: boolean
  campaignId?: string
  sourceType?: "property" | "campaign" | "manual"
  sourceId?: string
  description?: string
  sourceScriptId?: string
}

interface CreateVideoProjectInput extends VideoProjectFields {
  ctx: MarketingActorContext
  client?: ContentClient
}

interface CreatedVideoProjectResult {
  success: boolean
  project?: Record<string, any>
  error?: string
  complianceHold?: boolean
  complianceReviewId?: string
  complianceReasons?: string[]
  realismWarnings?: string[]
  /** What the tier meter said about this creation (within / approaching / overage / unlimited / unchecked). */
  videoMeter?: { verdict: string; reason: string }
}

/**
 * THE VIDEO PROJECT CREATOR (moved here from app/actions/video/create-video-project.ts
 * createVideoProject, now its session door; survivor of lib/kernel/marketing.ts
 * createVideoProject). No model writes here. The fair-housing render HOLD runs before the row
 * exists (red_flag and unknown hold; advisory passes, §5), the realism scan is advisory, and
 * every caller-named id is resolved inside the tenant.
 */
export async function createVideoProject(input: CreateVideoProjectInput): Promise<CreatedVideoProjectResult> {
  const { ctx } = input
  const refused = actorRefusal(ctx, "video project")
  if (refused) return refused
  if (!isValidUUID(ctx.brokerageId) || !isValidUUID(ctx.userId)) return { success: false, error: "Invalid brokerage or agent ID" }
  if (!input.title?.trim()) return { success: false, error: "Title is required" }
  if (!input.script?.trim() && !input.scriptPending) return { success: false, error: "Script is required" }
  if (!(AI_VIDEO_PROJECT_TYPES as readonly string[]).includes(input.videoType)) {
    return { success: false, error: `Unknown video type "${input.videoType}". Use one of ${AI_VIDEO_PROJECT_TYPES.join(", ")}.` }
  }
  const audienceType = canonicalVideoAudienceType(input.audienceType)
  if (!audienceType) return { success: false, error: `Unknown audience type "${input.audienceType}". Use customer_facing or in_house.` }

  const supabase: ContentClient = input.client ?? createServiceClient()
  const brokerageId = ctx.brokerageId
  const userId = ctx.userId

  // THE HOLD (owner ruling): a big red flag, or a script nobody could evaluate, holds the
  // video for a human. The review row is filed in THIS tenant through THIS client.
  if (input.script?.trim()) {
    const { evaluateVideoRenderHold } = await import("@/lib/video/video-render-hold")
    const hold = await evaluateVideoRenderHold({
      supabase, actor: { userId, brokerageId }, script: input.script, scriptId: undefined,
      videoType: input.videoType, title: input.title,
    })
    if (hold.hold) {
      return {
        success: false, complianceHold: true, complianceReviewId: hold.reviewId, complianceReasons: hold.reasons,
        error: hold.reasons[0] ?? "This video is held for human compliance review.",
      }
    }
  }

  // THE VIDEO GATE IS A METER (owner answer 4; lib/video/video-metering.ts): the tier's
  // video_minutes allowance is COUNTED against, over-allowance is billed as overage, and
  // the ONE refusal is a tier that explicitly excludes video (allowance 0).
  const { gateVideoCreation, meterVideoCreation } = await import("@/lib/video/video-metering")
  const videoMeter = await gateVideoCreation({ brokerageId, plannedSeconds: input.durationSeconds })
  if (!videoMeter.allowed) return { success: false, error: videoMeter.reason }

  // REALISM — advisory, never a hold (§5).
  let realismWarnings: string[] = []
  if (input.script?.trim()) {
    const { scanForAiTells } = await import("@/lib/video/realism-profile")
    realismWarnings = scanForAiTells(input.script)
  }

  let marketingCampaignId: string | null = null
  if (input.campaignId) {
    const v = await verifyInTenant(supabase, "marketing_campaigns", input.campaignId, brokerageId, "marketing campaign")
    if (!v.ok) return { success: false, error: v.error }
    marketingCampaignId = v.id
  }
  // public.scripts provenance (the viral-share rule follows it). A platform-catalogue script
  // (brokerage_id NULL) is deliberately not matched.
  let sourceScriptId: string | null = null
  if (input.sourceScriptId) {
    const v = await verifyInTenant(supabase, "scripts", input.sourceScriptId, brokerageId, "script")
    if (!v.ok) return { success: false, error: v.error }
    sourceScriptId = v.id
  }
  let listingId: string | null = null
  if (input.listingId) {
    const v = await verifyInTenant(supabase, "listings", input.listingId, brokerageId, "listing")
    if (!v.ok) return { success: false, error: v.error }
    listingId = v.id
  }

  const { resolveVideoProvider, initialProviderColumns } = await import("@/lib/marketing/video-provider-resolver")
  const provider = await resolveVideoProvider(supabase as any, { brokerageId, agentUserId: userId })
  const providerCols = initialProviderColumns(provider)

  // ai_video_projects.agent_id: NOT NULL FK agents. Resolved, never substituted.
  const agent = await resolveActorAgentId(supabase, ctx)
  if (!agent.ok) return { success: false, error: agent.error }
  if (!agent.agentId) {
    return { success: false, error: "No agent profile for this user in this brokerage — the video project has no owner to file it under." }
  }

  // brand_voice_context (merged from lib/kernel/marketing.ts createVideoProject, its only
  // writer): what the approvals reviewer reads beside the script. Best-effort, tenant-pinned.
  const [{ data: brokerage }, { data: bv }] = await Promise.all([
    supabase.from("brokerages").select("name, about_text, bio_text").eq("id", brokerageId).maybeSingle(),
    supabase.from("brand_voice_profile").select("tone").eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])
  const brandVoiceContext = {
    brokerage_name: (brokerage as any)?.name ?? null,
    brokerage_about: (brokerage as any)?.about_text ?? null,
    brokerage_bio: (brokerage as any)?.bio_text ?? null,
    brand_voice_tone: (bv as any)?.tone ?? null,
    applied_at: new Date().toISOString(),
  }

  const videoMetadata: Record<string, unknown> = {}
  if (input.backgroundColorHex) videoMetadata.background_color = input.backgroundColorHex
  if (input.description !== undefined) videoMetadata.description = input.description
  if (input.sourceType !== undefined) videoMetadata.source_type = input.sourceType
  if (input.sourceId !== undefined) videoMetadata.source_id = input.sourceId

  const { data: rows, error } = await supabase
    .from("ai_video_projects")
    .insert({
      brokerage_id: brokerageId,
      agent_id: agent.agentId,
      title: input.title,
      script_content: input.script ?? null,
      video_type: input.videoType,
      provider_avatar_id: input.avatarId ?? null,
      provider_voice_id: input.voiceId ?? null,
      provider_template_id: input.templateId ?? null,
      audience_type: audienceType,
      brand_voice_context: brandVoiceContext,
      background_type: input.backgroundType,
      background_url: input.backgroundUrl ?? null,
      video_metadata: Object.keys(videoMetadata).length > 0 ? videoMetadata : null,
      marketing_campaign_id: marketingCampaignId,
      source_script_id: sourceScriptId,
      format: input.format,
      duration_seconds: input.durationSeconds,
      captions_enabled: input.captionsEnabled,
      listing_id: listingId,
      // No script yet → 'draft'; a script in hand → 'script_ready' (the next step is a render).
      status: input.script?.trim() ? "script_ready" : "draft",
      retry_count: 0,
      video_provider: provider,
      ...providerCols,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
  const one = exactlyOne(rows, error, "Video project")
  if (!one.ok) return { success: false, error: one.error }
  const project = one.row

  // The creation is real — COUNT it (usage_events row + allowance + billing meter).
  await meterVideoCreation({
    brokerageId, agentId: agent.agentId, userId, plannedSeconds: input.durationSeconds,
    feature: "video_project", projectId: String(project.id), autonomous: false, decision: videoMeter,
  })

  const kernelEmit = await import("@/lib/kernel/emit")
  const { error: eventError } = kernelEmit.asWriteResult(await kernelEmit.emitKernelEvent({
    entityType: "video_project",
    entityId: project.id,
    brokerageId: brokerageId,
    event: KernelEvent.VIDEO_GENERATION_REQUESTED,
    actorUserId: userId,     // users-class
    metadata: {
      video_type: input.videoType, title: input.title, campaign_id: marketingCampaignId,
      source_type: input.sourceType ?? null, source_id: input.sourceId ?? null,
    },
    auditOnly: true,
  }))
  if (eventError) console.error("[content-creators] lifecycle_events insert error:", eventError.message)

  await processKernelEvent({
    event: KernelEvent.VIDEO_GENERATION_REQUESTED, brokerageId, entityType: "video_project", entityId: String(project.id),
  }).catch((err) => console.error("[content-creators] VIDEO_GENERATION_REQUESTED not processed (non-blocking):", err))

  if (input.brandComplianceCheck) {
    const { checkBrandCompliance } = await import("@/lib/kernel/brand-compliance")
    await checkBrandCompliance({ contentType: "video", contentId: String(project.id), brokerageId })
      .catch((e: unknown) => console.error("[content-creators] video brand compliance queue failed:", e))
  }

  return {
    success: true, project, videoMeter: { verdict: videoMeter.verdict, reason: videoMeter.reason },
    ...(realismWarnings.length > 0 ? { realismWarnings } : {}),
  }
}
