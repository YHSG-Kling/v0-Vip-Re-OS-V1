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

// TOMBSTONE (§1.3, 2026-08-31, lane M4): `DirectMailCopyShape` deleted — the
// postcard/letter distinction lives as two named functions (draftPostcardCopy
// / draftLetterCopy below), each with its own prompt and copy shape; no caller
// ever carried the union as a value.

/** The client the compliance gate reads and audits through (lane 86C). Mail copy is drafted
 *  from send orchestration and manager reactors with NO cookie session, so the default cookie
 *  client read no brand voice and the compliance_events row was refused (findRecentComplianceEventId
 *  below then found nothing). ctx.brokerageId comes from the caller's verified row or session
 *  (render-postcard / render-letter / manager-signals / the session-gated preview action). */
async function tenantGateClient() {
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient()
}

/** Map any incoming persona string to the canonical Persona union.
 *  Anything unrecognized falls to "other" so we never narrow off a
 *  valid CRM persona that the compliance gate just doesn't enumerate. */
function normalizePersona(p: string): Persona {
  const KNOWN: Persona[] = [
    "first_time", "relocated", "luxury", "fsbo", "probate",
    "upsize", "downsize", "military", "divorce", "senior",
    "expired", "foreclosure", "investor", "other",
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
  /** Wave 151 (151H / 151I seam): THE SENDER'S VOICE, conditioning the FIRST draft (owner: copy is written in the sender's
   *  voice from the first draft — never "generate generic then let the human rewrite"). Read once by the orchestrator
   *  (readSenderVoiceBrief below) and carried here so both shapes draft from it. */
  senderVoice?: SenderVoiceBrief | null
  /** Wave 151 (151H): the PRINT format the copy is for. `personal_letter` is the handwriting-style printed note — a short
   *  body in the note's layout (a length constraint of the layout, not a different writer). */
  format?: "letter" | "personal_letter" | "postcard" | "handwritten_card"
}

// ─── WAVE 151 — THE SENDER-VOICE BRIEF (lane 151H owns the shape and the hook; lane 151I owns the reader) ────────────
//
// 151I HOOK. Lane 151I (sender-voice copy) builds the brief from the user's settings — words, tagline, tone, signature,
// example sentences — in its own module and plugs it in HERE: replace the body of `readSenderVoiceBrief` with (or have the
// integrator import) 151I's reader, keeping this SHAPE. Everything downstream (both prompts, the orchestrator, the
// renderers) already consumes the brief through `DirectMailCopyContext.senderVoice`, so the plug is one function body and
// no caller changes. Until 151I lands, the brief is read from the data the tree already holds: brand_voice_profile (tone,
// preferred / prohibited words, tone_examples) and the brand cascade (display name, tagline, legal brokerage).
export interface SenderVoiceBrief {
  /** The person or team whose voice this is — the name the signature carries. */
  senderDisplayName: string
  /** The legal brokerage of record (printed by the layout, never typed into the copy). */
  legalBrokerageName: string
  tagline: string | null
  tone: string | null
  /** The sender's own words (used), and the words the sender never uses (avoided). */
  preferredWords: readonly string[]
  prohibitedWords: readonly string[]
  /** Sentences from the sender's prior writing — the output should SOUND like these. */
  exampleSentences: readonly string[]
  /** How the sender signs off ("— Maya", "Warmly, Luis"), or null to let the format decide. */
  signature: string | null
  /** Where the brief came from, for the audit trail. */
  source: "brand_voice_profile+brand_cascade" | "brand_cascade_only" | "lane_151I_reader"
}

/**
 * Read the sender's voice brief for ONE copy context — THE plug point for lane 151I (see the HOOK note above). Today it
 * folds the agent-tier distilled voice profile (Wave 36.5) and the brand cascade into the one brief shape; a refused read
 * falls through to the cascade alone and is said in the source. Never throws.
 */
export async function readSenderVoiceBrief(ctx: Pick<DirectMailCopyContext, "brokerageId" | "teamId" | "agentUserId">): Promise<SenderVoiceBrief> {
  const brand = await resolveBrandContext({ brokerageId: ctx.brokerageId, teamId: ctx.teamId ?? null, agentUserId: ctx.agentUserId ?? null })
  const base: SenderVoiceBrief = {
    senderDisplayName: brand.agentName ?? brand.displayName,
    legalBrokerageName: brand.brokerageName,
    tagline: brand.display.tagline ?? null,
    tone: null, preferredWords: [], prohibitedWords: [], exampleSentences: [],
    signature: brand.agentName ? `— ${brand.agentName.split(" ")[0] ?? brand.agentName}` : null,
    source: "brand_cascade_only",
  }
  if (!ctx.agentUserId) return base
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("brand_voice_profile")
      .select("tone_examples, tone, preferred_words, prohibited_words")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("agent_id", ctx.agentUserId)
      .eq("is_active", true)
      .maybeSingle()
    if (error) { console.error(`[draft-copy] brand_voice_profile read refused: ${error.message}`); return base }
    const row = data as { tone_examples: string[] | null; tone: string | null; preferred_words: string[] | null; prohibited_words: string[] | null } | null
    if (!row) return base
    return {
      ...base,
      tone: row.tone ?? null,
      preferredWords: (row.preferred_words ?? []).slice(0, 8),
      prohibitedWords: (row.prohibited_words ?? []).slice(0, 6),
      exampleSentences: (row.tone_examples ?? []).slice(0, 4),
      source: "brand_voice_profile+brand_cascade",
    }
  } catch {
    return base
  }
}

/** PURE — the prompt block the brief becomes. The FIRST draft is written in this voice; nothing here is a post-hoc rewrite. */
function renderSenderVoiceBlock(brief: SenderVoiceBrief | null | undefined): string {
  if (!brief) return ""
  const lines: string[] = [`\n\n──── THE SENDER'S VOICE (write the FIRST draft in it) ────`, `Sender: ${brief.senderDisplayName} (under ${brief.legalBrokerageName})`]
  if (brief.tagline) lines.push(`Tagline (the layout prints it; do not type it into the copy): ${brief.tagline}`)
  if (brief.tone) lines.push(`TONE: ${brief.tone}`)
  if (brief.preferredWords.length) lines.push(`Words this sender uses: ${brief.preferredWords.join(", ")}`)
  if (brief.prohibitedWords.length) lines.push(`Words this sender NEVER uses: ${brief.prohibitedWords.join(", ")}`)
  if (brief.exampleSentences.length) {
    lines.push(`EXAMPLE SENTENCES from this sender's prior writing (the output should SOUND like these):`)
    for (const ex of brief.exampleSentences) lines.push(`  · "${ex}"`)
  }
  if (brief.signature) lines.push(`Sign-off the sender uses: ${brief.signature}`)
  return lines.join("\n")
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
  // Wave 151 (151H): the handwriting-style PRINTED note's LAYOUT holds a short body — a length constraint of the
  // personal-note layout (piece-type.ts MAIL_LAYOUT_LIBRARY.personal_letter), not a second writer. The words come from
  // the sender's voice brief like every other shape.
  "personal-note":
    `\n\nLAYOUT: HANDWRITING-STYLE PRINTED NOTE\n- body: 60-110 words in ONE or TWO short paragraphs — the layout is a note card set in a handwriting-style typeface and PRINTED; if the piece describes itself, it says "handwriting-style, printed", never that a person wrote it by hand.\n- greeting is the first name only; signoff is the sender's own sign-off, one line.\n- one specific, personal fact; one gentle next step; nothing promotional.\n`,
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
      }, { client: await tenantGateClient() })
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
  const finalBody = await finalizeMailText(ctx, parsed.body)
  if (!finalBody.ok) return { ok: false, violations: finalBody.violations, complianceEventId }
  return { ok: true, copy: { ...parsed, body: finalBody.text }, complianceEventId }
}

/** Wave 36.5 — pull the agent-tier distilled voice profile and format
 *  3 example sentences inline for the AI prompt. The cascade resolver
 *  (lib/kernel/brand-voice.applyBrandVoice) already runs upstream of
 *  the gate; this lookup is voice-EXAMPLES-only, separate from the
 *  voice RULES the gate enforces. Returns "" when no distilled row
 *  exists. */
async function buildVoiceExamplesBlock(ctx: DirectMailCopyContext): Promise<string> {
  // Wave 151 (151H): ONE brief shape. The orchestrator stamps ctx.senderVoice (readSenderVoiceBrief — 151I's plug point);
  // a caller that did not is read here, so the first draft is always in the sender's voice. TOMBSTONE: the inline
  // brand_voice_profile read + ad-hoc block that lived here MERGED onto readSenderVoiceBrief / renderSenderVoiceBlock above.
  const brief = ctx.senderVoice ?? (await readSenderVoiceBrief(ctx))
  if (!ctx.senderVoice) ctx.senderVoice = brief
  return renderSenderVoiceBlock(brief)
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
  // The handwriting-style printed note takes the personal-note layout overlay unless the bandit chose a style (151H).
  const styleOverlay = LETTER_COPY_STYLE_OVERLAYS[ctx.copyStyle ?? (ctx.format === "personal_letter" ? "personal-note" : "default")]
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
      }, { client: await tenantGateClient() })
      return { allowed: r.allowed, violations: r.violations }
    },
  })
  const complianceEventId = await findRecentComplianceEventId(ctx.brokerageId, gateStartedAt)
  if (!result.ok) return { ok: false, violations: result.violations, complianceEventId }

  const parsed = parseJsonObject<LetterCopy>(result.script)
  if (!parsed || !parsed.body) {
    return { ok: false, violations: ["model returned non-JSON or missing required keys"], complianceEventId }
  }
  const finalBody = await finalizeMailText(ctx, parsed.body)
  if (!finalBody.ok) return { ok: false, violations: finalBody.violations, complianceEventId }
  return { ok: true, copy: { ...parsed, body: finalBody.text }, complianceEventId }
}

/**
 * THE FINAL PERSONALIZATION PHASE ON MAIL (owner ruling 20 / contract C4 — wave 145, lane 145Z; lane 145G Outside-lane 3): the
 * AI-drafted body passes lib/marketing/humanize-final.ts finalizeForDistribution (assetKind direct_mail) — machine phrasing
 * removed, facts kept; the tagline and logo are PLACED by the renderer (the kind's profile is "render"), never typed into the
 * copy. A final that still carries what no approval waives (a hard fair-housing finding, a brand-prohibited word) refuses the AI
 * copy — the caller falls back to the brokerage's static template, exactly as on a compliance failure. A phase that cannot run
 * (the brand unreadable) keeps the gated draft and says so — the draft already passed the outbound compliance gate.
 */
async function finalizeMailText(ctx: DirectMailCopyContext, body: string): Promise<{ ok: true; text: string } | { ok: false; violations: string[] }> {
  try {
    const { finalizeForDistribution, resolveTenantBrandForFinal } = await import("@/lib/marketing/humanize-final")
    const { createServiceClient } = await import("@/lib/supabase/service")
    const brand = await resolveTenantBrandForFinal(createServiceClient(), { brokerageId: ctx.brokerageId, teamId: ctx.teamId ?? null, agentUserId: ctx.agentUserId ?? null })
    const final = await finalizeForDistribution({ assetKind: "direct_mail", text: body, tenantBrand: brand.brand })
    const hard = [...final.fairHousing.map((f) => `fair housing: ${f}`), ...final.brandVoice.prohibited.map((w) => `prohibited by the brand voice: "${w}"`)]
    if (hard.length) return { ok: false, violations: hard }
    return { ok: true, text: final.text }
  } catch (err) {
    console.error(`[draft-copy] the final personalization phase could not run (the gated draft is kept): ${(err as Error)?.message ?? err}`)
    return { ok: true, text: body }
  }
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
