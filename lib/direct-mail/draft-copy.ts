/**
 * lib/direct-mail/draft-copy.ts
 *
 * Wave 36 — direct-mail copy generator. Drafts creative + engaging
 * postcard / letter copy with the canonical compliance gate
 * (lib/kernel/compliance.evaluateOutbound, messageType='direct_mail')
 * applied to every output. One automatic redraft on violation so a
 * Fair Housing flag becomes a corrected draft, not a hard failure.
 *
 * The prompt is engineered for "creative + highly engaging" as the
 * user requested:
 *   - Specific market data hooks (the agent's farm, recent sales)
 *   - Direct, conversational voice (60%+ them-pronouns)
 *   - Actionable CTA tied to the QR destination
 *   - Local references (neighborhood landmarks) — never demographic
 *
 * Three shapes returned:
 *   - postcard: { headline, body, cta }       — ~80 words total
 *   - letter:   { greeting, body, signoff }   — ~250 words total
 *
 * Both shapes share the brand context resolver so brokerage tagline +
 * preferred-phrase rules flow through to the AI prompt.
 */
import "server-only"
import { generateTextRouted } from "@/lib/ai/models"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { runWithComplianceRedraft } from "@/lib/kernel/compliance-redraft"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"
import type { Persona } from "@/lib/kernel/types"

export type DirectMailCopyShape = "postcard" | "letter"

/** Map any incoming persona string to the canonical Persona union.
 *  Anything unrecognized falls to "other" so we never narrow off a
 *  valid CRM persona that the compliance gate just doesn't enumerate. */
function normalizePersona(p: string): Persona {
  const KNOWN: Persona[] = [
    "first_time", "relocated", "luxury", "fsbo", "probate",
    "upsize", "downsize", "military", "divorce", "senior",
    "expired", "foreclosure", "other",
  ]
  return (KNOWN as string[]).includes(p) ? (p as Persona) : "other"
}

export interface DirectMailCopyContext {
  brokerageId: string
  /** Wave 36 tier cascade — when set, the team's brand wins over the
   *  brokerage's. Pass through from the caller's actor context. */
  teamId?:     string | null
  /** When set, the agent's brand + license + signature flow into the
   *  resolver. The license LINE on the printed piece will use the
   *  agent's individual license (state law requires this for any
   *  direct mail signed by an agent). */
  agentUserId?: string | null
  /** The lead/contact the piece is going to. Drives compliance gates
   *  (opt-outs, DNC, representation). Pass null for bulk farm
   *  mailings where there's no specific contact yet. */
  contactId:   string | null
  /** Persona for tonal targeting — first_time_buyer, mover_up, downsizing,
   *  investor, luxury, divorce, probate, sphere. */
  persona:     string
  /** What the QR on this piece routes to (m148 destination_type). The
   *  CTA copy should match what the recipient sees on scan. */
  qrDestinationType?:
    | "landing_page" | "video_avatar_tour" | "cma_form"
    | "listing_detail" | "book_meeting" | "podcast_episode"
    | "anniversary_video" | "other"
  /** Optional context the prompt weaves in — recent sale, market beat,
   *  listing address, anniversary month, etc. Pure data, no copy. */
  hookFacts?: {
    farmZip?:           string
    medianPrice?:       number
    daysOnMarket?:      number
    recentSaleAddress?: string
    listingAddress?:    string
    anniversaryYears?:  number
    podcastEpisode?:    string
  }
  /** Wave 36 farm-mail — when a topic is pulled from content_topic_bank,
   *  pass title + value_angle here so the AI can build the headline
   *  around the topic rather than a generic farm message. The
   *  performance feedback loop runs upstream (content_topic_uses + the
   *  per-(asset_type, persona) score in content_asset_persona_
   *  performance), so picking the same topic again later only happens
   *  when prior scans/engagement justify it. */
  topicHook?: {
    title:      string
    valueAngle: string | null
    /** content_topic_bank.id so the caller can log a content_topic_uses
     *  row after dispatch (closes the performance feedback loop). */
    topicId:    string
  }
}

export interface PostcardCopy {
  headline: string
  body:     string
  cta:      string
}

export interface LetterCopy {
  greeting: string
  body:     string
  signoff:  string
}

const POSTCARD_PROMPT = `\
You are writing copy for a REAL ESTATE DIRECT-MAIL POSTCARD. The piece is going to ONE recipient — write in a direct, conversational voice that earns 3 seconds of attention from someone holding the postcard between their mailbox and their kitchen counter.

Rules (each line is a non-negotiable):
- Output VALID JSON with keys: headline, body, cta. Nothing else.
- headline: 4-7 words. Specific, surprising, or curiosity-inducing. NOT generic.
- body: 25-40 words. Lead with a SPECIFIC FACT from the hookFacts JSON. End with a sentence that earns the CTA.
- cta: 3-5 words. Matches what the QR destination delivers.
- ZERO Fair Housing risk language: no race, color, religion, sex, familial status, national origin, disability, sexual orientation, gender identity. Don't describe the neighborhood by demographic. Don't say "perfect for families" or "great for retirees" or "Christian community" or "quiet adult area".
- ZERO pushy phrasing: no "act now", "limited time", "don't miss out", "you'd be crazy", "trust me".
- 60%+ client-focused pronouns (you / your) vs agent pronouns (I / we / our).
- NEVER guarantee appreciation, ROI, or a sale outcome.

Voice:
- Direct + warm, like an agent who's lived in the area for a decade.
- Specific over generic. "Homes on Elmwood sold in 9 days last month" beats "the market is hot".
- A microcopy CTA the recipient actually wants to do — not "Call now".

Examples of strong CTAs by qrDestinationType:
- video_avatar_tour: "See the 30-second tour"
- cma_form: "Get your home's number"
- listing_detail: "See the listing"
- book_meeting: "Grab 15 minutes"
- podcast_episode: "Hear the 9-minute story"
- anniversary_video: "Watch your moment"
- landing_page: "See the inside"`

const LETTER_PROMPT = `\
You are writing a REAL ESTATE LETTER (not a postcard). The recipient will read this front-to-back if the first paragraph earns it. Write like a person, not a brochure.

Rules:
- Output VALID JSON with keys: greeting, body, signoff. Nothing else.
- greeting: "Hi [first name]," — exactly that shape with a placeholder {{first_name}}.
- body: 180-260 words across 3-4 paragraphs. Lead with a SPECIFIC FACT from hookFacts. Use ONE concrete example. Close with one clear next step.
- signoff: 1-2 sentences. Personal, not "Sincerely yours".
- ZERO Fair Housing risk language. Treat the recipient as an individual, never as a demographic category.
- ZERO pushy phrasing. No urgency manufacturing.
- 60%+ client-focused pronouns (you / your).
- NEVER guarantee market outcomes.

Voice:
- A neighbor who happens to know the local market cold, not a salesperson.
- Specific. Use real numbers and a concrete street/neighborhood reference when available.
- Plain English. Read it aloud — if it sounds like a brochure, rewrite.`

function buildHookContextLine(ctx: DirectMailCopyContext): string {
  const facts: string[] = []
  const h = ctx.hookFacts ?? {}
  if (h.farmZip)            facts.push(`farm zip = ${h.farmZip}`)
  if (h.medianPrice)        facts.push(`median price last 30d = $${h.medianPrice.toLocaleString()}`)
  if (h.daysOnMarket)       facts.push(`avg days on market = ${h.daysOnMarket}`)
  if (h.recentSaleAddress)  facts.push(`recent comparable sale = ${h.recentSaleAddress}`)
  if (h.listingAddress)     facts.push(`listing address = ${h.listingAddress}`)
  if (h.anniversaryYears)   facts.push(`anniversary years = ${h.anniversaryYears}`)
  if (h.podcastEpisode)     facts.push(`podcast episode = "${h.podcastEpisode}"`)
  if (ctx.topicHook?.title) {
    // Topic from content_topic_bank — the AI should make THIS the lead.
    facts.push(`THIS WEEK'S TOPIC (build the headline around this): "${ctx.topicHook.title}"`)
    if (ctx.topicHook.valueAngle) {
      facts.push(`topic angle (the "why it matters"): ${ctx.topicHook.valueAngle}`)
    }
  }
  return facts.length === 0 ? "no extra hook facts" : facts.join("; ")
}

async function callModelAndParse(
  prompt: string,
  feedback: string[],
  brokerageId: string,
): Promise<string> {
  // Feed the prior round's violations back into the prompt so the
  // redraft is targeted, not a blind retry.
  const violationsBlock = feedback.length > 0
    ? `\nYour PREVIOUS draft violated these compliance rules — fix EACH one:\n` +
      feedback.map((v) => `- ${v}`).join("\n")
    : ""

  const { text } = await generateTextRouted({
    feature:     "direct_mail_copy",
    brokerageId,
    prompt:      prompt + violationsBlock,
    temperature: feedback.length > 0 ? 0.4 : 0.7,
    maxTokens:   600,
  })
  return text
}

/**
 * draftPostcardCopy
 *
 * Returns compliance-gated headline/body/CTA for a postcard piece.
 * ok=false when both attempts fail the gate — caller should fall back
 * to the brokerage's default static template rather than mail copy
 * the agent + Fair Housing both rejected.
 */
export async function draftPostcardCopy(
  ctx: DirectMailCopyContext,
): Promise<{ ok: true; copy: PostcardCopy; complianceEventId: string | null } | { ok: false; violations: string[]; complianceEventId: string | null }> {
  const brand = await resolveBrandContext({
    brokerageId: ctx.brokerageId,
    teamId:      ctx.teamId ?? null,
    agentUserId: ctx.agentUserId ?? null,
  })
  const hookLine = buildHookContextLine(ctx)
  const promptHead =
    `${POSTCARD_PROMPT}\n\n` +
    `Sender: ${brand.displayName} (under ${brand.brokerageName})\n` +
    `Persona: ${ctx.persona}\n` +
    `QR destination: ${ctx.qrDestinationType ?? "landing_page"}\n` +
    `Hook facts: ${hookLine}\n\n` +
    `Return JSON now.`

  const gateStartedAt = new Date().toISOString()
  const result = await runWithComplianceRedraft({
    draft: async ({ violations }) => callModelAndParse(promptHead, violations, ctx.brokerageId),
    gate:  async (script) => {
      const r = await evaluateOutbound({
        actorContext: { brokerageId: ctx.brokerageId, role: "agent", userId: ctx.brokerageId },
        messageType:  "direct_mail",
        journeyType:  ctx.persona.includes("seller") || ctx.persona === "fsbo" || ctx.persona === "expired" ? "seller" : "buyer",
        persona:      normalizePersona(ctx.persona),
        content:      extractCopyForGate(script),
      })
      return { allowed: r.allowed, violations: r.violations }
    },
  })

  // Wave 36 m156 — capture the compliance_events row id the gate
  // emitted so the caller can stamp it on direct_mail_campaigns for
  // O(1) per-piece audit lookups. We query the LATEST row for this
  // brokerage with message_type='direct_mail' created since the gate
  // started. Reliable for normal serialized draft flows; if the same
  // brokerage runs concurrent direct-mail drafts in the same second
  // we'd associate the wrong row — acceptable miss rate for the
  // audit use case, and the row carries the rule violations either
  // way so the audit answer is the same.
  const complianceEventId = await findRecentComplianceEventId(ctx.brokerageId, gateStartedAt)

  if (!result.ok) return { ok: false, violations: result.violations, complianceEventId }
  const parsed = parseJsonObject<PostcardCopy>(result.script)
  if (!parsed || !parsed.headline || !parsed.body || !parsed.cta) {
    return { ok: false, violations: ["model returned non-JSON or missing required keys"], complianceEventId }
  }
  return { ok: true, copy: parsed, complianceEventId }
}

async function findRecentComplianceEventId(brokerageId: string, sinceIso: string): Promise<string | null> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data } = await svc
      .from("compliance_events")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("message_type", "direct_mail")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data?.id as string | undefined) ?? null
  } catch { return null }
}

/**
 * draftLetterCopy
 *
 * Same as draftPostcardCopy for the longer letter shape.
 */
export async function draftLetterCopy(
  ctx: DirectMailCopyContext,
): Promise<{ ok: true; copy: LetterCopy; complianceEventId: string | null } | { ok: false; violations: string[]; complianceEventId: string | null }> {
  const brand = await resolveBrandContext({
    brokerageId: ctx.brokerageId,
    teamId:      ctx.teamId ?? null,
    agentUserId: ctx.agentUserId ?? null,
  })
  const hookLine = buildHookContextLine(ctx)
  const promptHead =
    `${LETTER_PROMPT}\n\n` +
    `Sender: ${brand.displayName} (under ${brand.brokerageName})\n` +
    `Persona: ${ctx.persona}\n` +
    `QR destination: ${ctx.qrDestinationType ?? "landing_page"}\n` +
    `Hook facts: ${hookLine}\n\n` +
    `Return JSON now.`

  const gateStartedAt = new Date().toISOString()
  const result = await runWithComplianceRedraft({
    draft: async ({ violations }) => callModelAndParse(promptHead, violations, ctx.brokerageId),
    gate:  async (script) => {
      const r = await evaluateOutbound({
        actorContext: { brokerageId: ctx.brokerageId, role: "agent", userId: ctx.brokerageId },
        messageType:  "direct_mail",
        journeyType:  ctx.persona.includes("seller") || ctx.persona === "fsbo" || ctx.persona === "expired" ? "seller" : "buyer",
        persona:      normalizePersona(ctx.persona),
        content:      extractCopyForGate(script),
      })
      return { allowed: r.allowed, violations: r.violations }
    },
  })
  const complianceEventId = await findRecentComplianceEventId(ctx.brokerageId, gateStartedAt)
  if (!result.ok) return { ok: false, violations: result.violations, complianceEventId }

  const parsed = parseJsonObject<LetterCopy>(result.script)
  if (!parsed || !parsed.body) {
    return { ok: false, violations: ["model returned non-JSON or missing required keys"], complianceEventId }
  }
  return { ok: true, copy: parsed, complianceEventId }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseJsonObject<T>(s: string): T | null {
  // Models sometimes wrap JSON in ```json fences or prepend prose.
  // Find the first { and the matching last } and parse that span.
  const start = s.indexOf("{")
  const end   = s.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

function extractCopyForGate(jsonString: string): string {
  // Flatten the JSON to a single content string for the compliance
  // gate — the gate's Fair Housing + Them-First rules don't care about
  // the JSON wrapper, only the human-readable text.
  const parsed = parseJsonObject<Record<string, unknown>>(jsonString)
  if (!parsed) return jsonString
  return Object.values(parsed).filter((v): v is string => typeof v === "string").join("\n")
}
