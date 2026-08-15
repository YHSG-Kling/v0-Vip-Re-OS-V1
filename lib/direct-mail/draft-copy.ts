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
  /** Wave 36 — A/B bandit pick. The orchestrator stamps this with the
   *  copy_style chosen by pickVariantArm so draftPostcardCopy / draft
   *  LetterCopy actually swap their prompt template per arm. Without
   *  this the bandit rotated labels but not real creative; with it,
   *  each arm renders a structurally different piece. */
  copyStyle?: string
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

/** Wave 36 — copy-style overlays the bandit picks per arm. Each style
 *  appends structural rules ON TOP OF the shared rules above so the
 *  Fair Housing + Them-First + brand voice gates still apply. The
 *  bandit picks the style; this map translates it into the prompt
 *  variation that distinguishes one arm from another.
 *
 *  Adding a new style: extend this map AND add an arm to
 *  variant-bandit.ts PLATFORM_CATALOG with the same copy_style key. */
const POSTCARD_COPY_STYLE_OVERLAYS: Record<string, string> = {
  // Default / fallback — exact behavior as before this commit
  "default": "",

  // Direct-fact: lead with a number, no question, statement headline
  "direct-fact":
    `\n\nCOPY STYLE: DIRECT-FACT (this arm's twist)\n` +
    `- headline must be a STATEMENT, not a question — start with a number or a noun phrase\n` +
    `- body opens with the fact and closes with a single soft suggestion\n` +
    `- avoid words like "imagine" / "wouldn't" / "should" — keep it declarative\n`,

  // Question-hook: open with a curiosity question
  "question-hook":
    `\n\nCOPY STYLE: QUESTION-HOOK (this arm's twist)\n` +
    `- headline must be a QUESTION the recipient is likely already wondering\n` +
    `- body answers the question with a specific local fact + a microcopy CTA\n` +
    `- do NOT use "What if" — use direct questions ("How long…", "What's your block worth?")\n`,

  // Social-proof: reference recent neighbor activity
  "social-proof":
    `\n\nCOPY STYLE: SOCIAL-PROOF (this arm's twist)\n` +
    `- headline references that NEIGHBORS / OTHERS already did the thing the CTA invites\n` +
    `- body cites a specific recent sale or activity without naming the seller\n` +
    `- the body MUST imply momentum without manufactured urgency\n`,

  // Photo-led (6×9 only): minimal copy, photo carries the impact
  "photo-led":
    `\n\nCOPY STYLE: PHOTO-LED (this arm's twist — for 6×9 with hero photo)\n` +
    `- headline: 3-5 words MAX (the photo is the headline; copy is the caption)\n` +
    `- body: 18-30 words. One specific fact, one CTA. Nothing else.\n` +
    `- assume the recipient looks at the photo first; copy is the "now what"\n`,

  // Intro-warm (welcome kit): introduce the agent + brokerage warmly
  "intro-warm":
    `\n\nCOPY STYLE: INTRO-WARM (welcome-kit arm)\n` +
    `- headline introduces the SENDER, not the offer ("Your new neighborhood resource")\n` +
    `- body in first person, warm, references "we're here when you're ready"\n` +
    `- CTA is low-commitment ("Save my number", "See my recent work")\n`,

  // Intro-credibility (welcome kit): lead with proof
  "intro-credibility":
    `\n\nCOPY STYLE: INTRO-CREDIBILITY (welcome-kit arm)\n` +
    `- headline leads with a CREDIBILITY anchor ("123 closings on this side of town")\n` +
    `- body cites ONE specific number or testimonial-style fact\n` +
    `- CTA invites a low-pressure first conversation\n`,

  // Checkin-personal (sphere outreach): "thinking of you" tone
  "checkin-personal":
    `\n\nCOPY STYLE: CHECKIN-PERSONAL (sphere outreach arm)\n` +
    `- headline is conversational ("Thinking of you" energy without being saccharine)\n` +
    `- body references that the recipient is a known contact, not a stranger\n` +
    `- CTA is relationship-not-transaction ("Catch up over coffee" beats "Get a CMA")\n`,

  // Appointment-prep (pre-listing kit): seller-appointment specific
  "appointment-prep":
    `\n\nCOPY STYLE: APPOINTMENT-PREP (pre-listing kit arm)\n` +
    `- headline names the upcoming appointment specifically ("Looking forward to Saturday")\n` +
    `- body sets ONE expectation the seller can walk into the meeting with\n` +
    `- CTA points to a prep resource (sample CMA, prep checklist), not "schedule"\n`,
}

const LETTER_COPY_STYLE_OVERLAYS: Record<string, string> = {
  "default": "",
  "intro-warm":
    `\n\nCOPY STYLE: INTRO-WARM\n- Greeting + first paragraph introduce the sender, second paragraph proves competence with one specific fact, third paragraph invites a low-commitment next step.\n`,
  "intro-credibility":
    `\n\nCOPY STYLE: INTRO-CREDIBILITY\n- Lead the body with a specific credibility anchor (closings count, market share in the area, etc.); keep the warm voice but anchor in proof.\n`,
  "appointment-prep":
    `\n\nCOPY STYLE: APPOINTMENT-PREP\n- This letter PRECEDES the listing appointment. Tell the seller what to expect and what to have ready. End with a single ask, not three.\n`,
}

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
  // Wave 36 — copy-style overlay. Defaults to "default" (no overlay)
  // so non-bandit callers keep their prior behavior. The bandit picks
  // a copy_style; this swaps in the matching prompt block.
  const styleOverlay = POSTCARD_COPY_STYLE_OVERLAYS[ctx.copyStyle ?? "default"]
    ?? POSTCARD_COPY_STYLE_OVERLAYS["default"]
  // Wave 36.5 — per-agent voice examples. When the distiller has
  // populated brand_voice_profile.tone_examples for THIS agent (the
  // tier resolver picked the agent row), the examples land inline in
  // the prompt as concrete voice anchors. Without this, the prompt
  // only knew abstract tone tags ("warm", "direct") — the examples
  // make the AI's output actually SOUND like the agent's writing.
  const voiceBlock = await buildVoiceExamplesBlock(ctx)
  const promptHead =
    `${POSTCARD_PROMPT}${styleOverlay}${voiceBlock}\n\n` +
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

/** Wave 36.5 — pull the agent-tier distilled voice profile and format
 *  3 example sentences inline for the AI prompt. The cascade resolver
 *  (lib/kernel/brand-voice.applyBrandVoice) already runs upstream of
 *  the gate; this lookup is voice-EXAMPLES-only, separate from the
 *  voice RULES the gate enforces. Returns "" when no distilled row
 *  exists. */
async function buildVoiceExamplesBlock(ctx: DirectMailCopyContext): Promise<string> {
  if (!ctx.agentUserId) return ""
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data } = await svc
      .from("brand_voice_profile")
      .select("tone_examples, tone, preferred_words, prohibited_words")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("agent_id", ctx.agentUserId)
      .eq("is_active", true)
      .maybeSingle()
    const row = data as {
      tone_examples: string[] | null
      tone: string | null
      preferred_words: string[] | null
      prohibited_words: string[] | null
    } | null
    if (!row) return ""
    const lines: string[] = []
    if (row.tone) lines.push(`\nAGENT VOICE TONE: ${row.tone}`)
    if (row.preferred_words && row.preferred_words.length > 0) {
      lines.push(`Preferred words this agent uses: ${row.preferred_words.slice(0, 8).join(", ")}`)
    }
    if (row.prohibited_words && row.prohibited_words.length > 0) {
      lines.push(`Words to AVOID (the agent never uses these): ${row.prohibited_words.slice(0, 6).join(", ")}`)
    }
    if (row.tone_examples && row.tone_examples.length > 0) {
      lines.push(`\nEXAMPLE SENTENCES from this agent's prior writing (your output should SOUND like these):`)
      for (const ex of row.tone_examples.slice(0, 4)) {
        lines.push(`  · "${ex}"`)
      }
    }
    return lines.length === 0 ? "" : `\n\n──── PER-AGENT VOICE ANCHORS (Wave 36.5) ────${lines.join("\n")}`
  } catch {
    return ""
  }
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
  const styleOverlay = LETTER_COPY_STYLE_OVERLAYS[ctx.copyStyle ?? "default"]
    ?? LETTER_COPY_STYLE_OVERLAYS["default"]
  const voiceBlock = await buildVoiceExamplesBlock(ctx)
  const promptHead =
    `${LETTER_PROMPT}${styleOverlay}${voiceBlock}\n\n` +
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
