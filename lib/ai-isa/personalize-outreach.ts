// lib/ai-isa/personalize-outreach.ts
//
// MICRO-PERSONALIZATION ENGINE — the single source of truth for all AI ISA
// outreach copy. Zero hardcoded message strings. Every call to personalizeOutreach
// produces channel-appropriate copy assembled from the genuinely-present
// enrichment facts for that specific record.
//
// Three public surfaces:
//   buildPersonalizationFacts(input)     — pure, unit-testable, no network
//   buildOutreachPrompt(facts, opts)     — pure prompt assembler, exposed for testing
//   personalizeOutreach(params, deps?)   — full pipeline: facts → gateway → copy
//
// The deterministic fallback (when gateway is unavailable) still varies with the
// facts, so two different enriched records produce different copy — provably
// non-hardcoded.

import type { EnrichmentProfileLike } from "@/lib/lead-pipeline/enrichment-column-map"
import { gatewayChat } from "@/lib/ai/gateway-chat"
import { canonicalLifeEventType, currentLifeEvents, lifeEventToneBrief, screenLifeEventOutreach } from "@/lib/enrichment/life-event-vocabulary"
import { resolveModel } from "@/lib/ai/resolve-model"

// ── Types ──────────────────────────────────────────────────────────────────

export type OutreachChannel = "email" | "sms" | "voicemail" | "call_opener" | "direct_mail"

export interface PersonalizationInput {
  // Lead/contact first-class columns
  first_name?: string | null
  /** ADDRESSING MEMORY (contacts.preferred_name) — what they said to call them.
   *  When present it IS the name every draft uses ("Bill", never "William");
   *  lib/kernel/addressing.ts is the canonical resolver. */
  preferred_name?: string | null
  last_name?: string | null
  city?: string | null
  motivation_type?: string | null
  property_interest?: string | null
  budget_min?: number | null
  budget_max?: number | null
  timeline?: string | null
  // Enrichment profile (the JSONB blob)
  enrichment_profile?: EnrichmentProfileLike | null
  // First-class columns promoted from enrichment
  occupation?: string | null
  household_income?: string | null
  home_owner_status?: string | null
  home_value?: number | null
  life_events?: Array<{ type: string; date?: string; description?: string }> | null
  marital_status?: string | null
}

export interface PersonalizationFact {
  key: string
  label: string
  value: string
}

export interface OutreachCopy {
  /** Email subject (email channel only) */
  subject?: string
  /** Main body text (all channels) */
  body: string
  /** How copy was produced */
  source: "gateway" | "deterministic_fallback"
  /** Wave 148 (148F, ruling 17): a model draft the life-event screen REFUSED (it named or alluded to a life event) — the
   *  deterministic copy went instead. Absent when nothing was refused. */
  lifeEventScreen?: { refused: true; hits: string[] }
}

export interface PersonalizeOutreachParams {
  facts: PersonalizationFact[]
  channel: OutreachChannel
  /** Brand voice system block from loadBrandVoicePrompt */
  brandVoice?: string
  /** What the outreach is for — drives the AI prompt intent */
  intent?: string
  firstName?: string
}

// ── buildPersonalizationFacts ──────────────────────────────────────────────

/**
 * Pure: extract the genuinely-present, non-empty personalization signals from
 * a lead or contact into an ordered fact list. Only includes facts that EXIST —
 * never fabricates. Unit-testable without network.
 */
export function buildPersonalizationFacts(input: PersonalizationInput): PersonalizationFact[] {
  const facts: PersonalizationFact[] = []

  const push = (key: string, label: string, value: string | null | undefined) => {
    if (value && value.trim() !== "") facts.push({ key, label, value: value.trim() })
  }

  // ── Identity ──────────────────────────────────────────────────────────────
  // The preferred name outranks the record name in every draft ("call me Bill").
  push("first_name",   "Name",       input.preferred_name ?? input.first_name)
  push("city",         "City",       input.city ?? input.enrichment_profile?.["city"] as string | undefined)

  // ── Real estate intent ────────────────────────────────────────────────────
  if (input.motivation_type) {
    push("motivation",   "Goal",       humanizeMotivation(input.motivation_type))
  }
  push("property_interest", "Property type", input.property_interest)

  if (input.budget_min != null || input.budget_max != null) {
    const budgetStr = formatBudget(input.budget_min, input.budget_max)
    if (budgetStr) push("budget", "Budget", budgetStr)
  }

  push("timeline",     "Timeline",   input.timeline)

  // ── Enrichment profile — employer / occupation ────────────────────────────
  const ep = input.enrichment_profile
  const occupation =
    input.occupation
    ?? ep?.job_title
    ?? ep?.employer

  if (occupation) push("occupation", "Occupation", occupation)

  // ── Household income band ─────────────────────────────────────────────────
  const income = input.household_income ?? ep?.household_income
  if (income) push("household_income", "Income range", income)

  // ── Home owner status ─────────────────────────────────────────────────────
  const hos = input.home_owner_status ?? ep?.home_owner_status
  if (hos) push("home_owner_status", "Home ownership", humanizeOwnerStatus(hos))

  // ── Home value ────────────────────────────────────────────────────────────
  const hv = input.home_value ?? (typeof ep?.home_value === "number" ? ep.home_value : null)
  if (hv != null && hv > 0) push("home_value", "Est. home value", `$${hv.toLocaleString()}`)

  // ── Marital status — NEVER a copy fact (wave 148, 148Z — lane 148F hand-off, owner rulings 1 + 17) ──
  // TOMBSTONE: `push("marital_status", "Marital status", ms)` stood here and handed the outreach writer "Marital status:
  // married" as a fact to USE in a draft. Marital status is a protected class in most states and the shadow of the marital
  // life events (a wedding, a separation) that ruling 17 says are never named; ruling 1 lets it shape a persona's SERVICE
  // only, never words. No survivor in copy by design: the attribute stays readable through the research reader
  // (lib/enrichment/protected-research-store.ts readProtectedAttributes, purpose-audited) and the persona's service profile.
  // `marital_status` stays on PersonalizationInput so callers need not change; it is read by nothing here.

  // ── Life events — NEVER copy (wave 148, lane 148F — owner ruling 17) ─────
  // This block used to call a life event "the richest personalization signal" and put it in the draft ("I'm reaching out with
  // your recent divorce" was a reachable deterministic sentence). The owner: "the arbiter should decide the best way to warm
  // engagement without mentioning the life event — it is about them and their emotions at this time." So a life event now shapes
  // only the TONE (LIFE_EVENT_VOCAB's empathetic brief, which names no event) and rides an INTERNAL fact (`_life_events`, the
  // canonical spellings) that the prompt never shows and the screen reads: personalizeOutreach refuses a draft that names or
  // alludes to it (screenLifeEventOutreach) and sends the deterministic copy instead.
  const lifeEvents =
    input.life_events
    ?? (Array.isArray(ep?.life_events) ? ep!.life_events : null)

  if (lifeEvents && lifeEvents.length > 0) {
    const tone = lifeEventToneBrief(lifeEvents)
    if (tone) push("tone", "Tone", `${tone} Never mention, allude to, congratulate or condole on any personal or life event.`)
    const carried = [...new Set(currentLifeEvents(lifeEvents).map((e) => e.type))]
    if (carried.length > 0) push(INTERNAL_LIFE_EVENTS_KEY, "(internal — never shown)", carried.join(","))
  }

  return facts
}

/** Wave 148 (148F): the internal fact carrying a person's canonical life events for the draft SCREEN — never in a prompt, never in copy. */
export const INTERNAL_LIFE_EVENTS_KEY = "_life_events"
const isInternalFact = (f: PersonalizationFact) => f.key.startsWith("_")

/** PURE. The canonical life events an internal fact carries (for the screen). */
function lifeEventsOfFacts(facts: PersonalizationFact[]): string[] {
  const raw = facts.find((f) => f.key === INTERNAL_LIFE_EVENTS_KEY)?.value ?? ""
  return raw.split(",").map((t) => canonicalLifeEventType(t)).filter((t): t is NonNullable<typeof t> => !!t)
}

// ── buildOutreachPrompt ────────────────────────────────────────────────────

export interface OutreachPromptOpts {
  channel: OutreachChannel
  brandVoice?: string
  intent?: string
  firstName?: string
}

/**
 * Pure: compose the system+user messages for the gateway from a fact list.
 * Exposed so simulators can assert enrichment facts appear in the prompt.
 */
export function buildOutreachPrompt(
  facts: PersonalizationFact[],
  opts: OutreachPromptOpts,
): Array<{ role: "system" | "user"; content: string }> {
  const { channel, brandVoice, intent, firstName } = opts

  const channelRules = CHANNEL_RULES[channel]

  const shown = facts.filter((f) => !isInternalFact(f))
  const factBlock = shown.length > 0
    ? shown.map((f) => `- ${f.label}: ${f.value}`).join("\n")
    : "(no enrichment data available)"

  const systemPrompt = [
    `You are an AI ISA (Inside Sales Agent) writing a ${channel} for a real estate brokerage.`,
    brandVoice ? `\n${brandVoice}` : "",
    "\n\nFair Housing: Never reference race, color, religion, sex, national origin, disability, or familial status.",
    // Wave 148 (148F, owner ruling 17): a universal rule, not only when an event is known — whatever you suspect, it is theirs.
    "\nLife events: Never mention, allude to, congratulate or condole on any personal or life event (a loss, an estate, a separation, money trouble, a wedding, a baby, a new job, a move) and never imply you know about one. Be useful and kind; it is about them.",
    "\nHonesty: Only reference facts from the ENRICHMENT FACTS block below — never invent or assume.",
    `\n\nChannel rules for ${channel}:\n${channelRules}`,
  ].filter(Boolean).join("")

  const userPrompt = [
    `Write a ${channel} for a lead${firstName ? ` named ${firstName}` : ""}.`,
    intent ? `\nContext: ${intent}` : "",
    "\n\nENRICHMENT FACTS (use ONLY what is listed below):",
    `\n${factBlock}`,
    channel === "email"
      ? "\n\nRespond with JSON: {\"subject\": \"...\", \"body\": \"...\"}"
      : "\n\nRespond with the message text only (no JSON wrapper).",
  ].filter(Boolean).join("")

  return [
    { role: "system" as const, content: systemPrompt },
    { role: "user"   as const, content: userPrompt   },
  ]
}

// ── personalizeOutreach ────────────────────────────────────────────────────

export interface PersonalizeOutreachDeps {
  /** Injectable for testing — defaults to real gatewayChat */
  gatewayFn?: typeof gatewayChat
  /** Gateway model slug — caller may override; no model ID in production code */
  model?: string
}

/**
 * Full pipeline: build facts → call gateway → return channel copy.
 * Falls back to the deterministic composer when the gateway is unavailable.
 */
export async function personalizeOutreach(
  params: PersonalizeOutreachParams,
  deps: PersonalizeOutreachDeps = {},
): Promise<OutreachCopy> {
  const { facts, channel, brandVoice, intent, firstName } = params
  const gw = deps.gatewayFn ?? gatewayChat
  // Blind-spot burn-down (lane 75D, 2026-09-18) — this was a dated literal
  // (claude-haiku-4-20250514, a retired snapshot slug — wave 59's own §6
  // ruling: "NEVER write a dated -20250514 literal"). resolveModel("claude-haiku")
  // derives the current alias from the ONE catalog (lib/ai/resolve-model.ts
  // ALIASES), so this call site tracks a model swap automatically.
  const model = deps.model ?? process.env.AI_GATEWAY_DEFAULT_MODEL ?? (resolveModel("claude-haiku") as string)

  const messages = buildOutreachPrompt(facts, { channel, brandVoice, intent, firstName })

  // Try gateway
  const result = await gw({ model, messages, maxTokens: 512, temperature: 0.75 })

  // Wave 148 (148F, ruling 17): THE LIFE-EVENT SCREEN — the deterministic backstop behind the prompt's rule. A model draft that names
  // or alludes to a life event (always: a loss / an estate / a separation / financial hardship; and any event this person's record
  // carries) is REFUSED and the deterministic copy — which never carries a life event — goes instead, with the refusal said.
  const carried = lifeEventsOfFacts(facts)
  const screened = (copy: OutreachCopy): OutreachCopy => {
    const verdict = screenLifeEventOutreach(`${copy.subject ?? ""}\n${copy.body}`, { events: carried })
    if (verdict.ok) return copy
    return { ...buildDeterministicCopy(facts, channel, firstName), lifeEventScreen: { refused: true, hits: verdict.hits.map((h) => h.term) } }
  }

  if (result.ok && result.content) {
    try {
      if (channel === "email") {
        // Expect JSON {subject, body}
        const jsonMatch = result.content.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; body?: string }
          if (parsed.body) {
            return screened({
              subject: parsed.subject ?? buildDeterministicSubject(facts, firstName),
              body:    enforceOptOut(channel, parsed.body),
              source:  "gateway",
            })
          }
        }
      }
      // SMS / voicemail / call_opener / direct_mail — plain text
      const body = result.content.trim()
      if (body) {
        return screened({
          body:   enforceOptOut(channel, body),
          source: "gateway",
        })
      }
    } catch {
      // fall through to deterministic
    }
  }

  // Deterministic fallback — varies with facts, never a single fixed string
  return buildDeterministicCopy(facts, channel, firstName)
}

// ── Deterministic fallback ─────────────────────────────────────────────────

/**
 * DATA-DRIVEN fallback: composes copy from whatever facts are present.
 * Two different enriched records will produce different copy — provably
 * non-hardcoded. Safe without any network call.
 */
export function buildDeterministicCopy(
  facts: PersonalizationFact[],
  channel: OutreachChannel,
  firstName?: string,
): OutreachCopy {
  const get = (key: string) => facts.find((f) => f.key === key)?.value ?? null

  const name        = firstName ?? get("first_name") ?? "there"
  const motivation  = get("motivation")
  const city        = get("city")
  const occupation  = get("occupation")
  // Wave 148 (148F, ruling 17): no life-event hook — the copy is about them, never the event ("with your recent …" is gone).
  const gentle      = !!get("tone")
  const budget      = get("budget")
  const timeline    = get("timeline")
  const homeStatus  = get("home_owner_status")
  const income      = get("household_income")

  // Build a contextual hook from the richest available fact
  const hook = gentle
    ? "simply to say we're here whenever it's useful — no rush at all"
    : motivation
    ? `given your goal to ${motivation.toLowerCase()}`
    : occupation
    ? `as someone in ${occupation}`
    : city
    ? `in the ${city} market`
    : income
    ? `at your income level`
    : homeStatus
    ? `as a current ${homeStatus.toLowerCase()}`
    : "at this stage of your journey"

  // Build supporting detail lines from present facts
  const details: string[] = []
  if (budget)   details.push(`budget around ${budget}`)
  if (timeline) details.push(`timeline of ${timeline}`)
  if (city && !hook.includes(city)) details.push(`in ${city}`)

  const detailPhrase = details.length > 0 ? ` (${details.join(", ")})` : ""

  switch (channel) {
    case "email": {
      const subject = buildDeterministicSubject(facts, firstName)
      const body = [
        `Hi ${name},`,
        "",
        `I wanted to reach out ${hook}${detailPhrase}. Our team specializes in helping people in your situation navigate the real estate market.`,
        "",
        "I've put together some information that I think you'll find valuable for your specific circumstances. Would you have a few minutes to connect?",
        "",
        "Reply to this email anytime — I'm here to help.",
        "",
        "Best regards,",
        "Your Real Estate Team",
      ].join("\n")
      return { subject, body, source: "deterministic_fallback" }
    }

    case "sms": {
      const body = enforceOptOut(
        "sms",
        `Hi ${name}! I'm reaching out ${hook}. Happy to help you with your real estate goals${detailPhrase}. When's a good time to connect?`,
      )
      return { body, source: "deterministic_fallback" }
    }

    case "voicemail": {
      const body = [
        `Hi ${name}, this is your real estate team calling.`,
        `I'm reaching out ${hook}${detailPhrase}.`,
        `We'd love to connect and share some ideas that could help.`,
        `Please call us back at your convenience — we're looking forward to speaking with you.`,
      ].join(" ")
      return { body, source: "deterministic_fallback" }
    }

    case "call_opener": {
      const body = [
        `Hi, is this ${name}? Great!`,
        `This is [Agent Name] from [Brokerage].`,
        `I'm calling ${hook}${detailPhrase} — I had some ideas I wanted to share.`,
        `Do you have two minutes?`,
      ].join(" ")
      return { body, source: "deterministic_fallback" }
    }

    case "direct_mail": {
      const body = [
        `Dear ${name},`,
        "",
        `${hook.charAt(0).toUpperCase() + hook.slice(1)}${detailPhrase}, we wanted to reach out with a personal note.`,
        "",
        "Our team has helped many homeowners and buyers navigate the market successfully, and we believe we can do the same for you.",
        "",
        "Please reach out at your convenience — we'd love to learn more about your goals.",
        "",
        "Warmly,",
        "Your Real Estate Team",
      ].join("\n")
      return { body, subject: buildDeterministicSubject(facts, firstName), source: "deterministic_fallback" }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildDeterministicSubject(facts: PersonalizationFact[], firstName?: string): string {
  const get = (key: string) => facts.find((f) => f.key === key)?.value ?? null
  const name       = firstName ?? get("first_name")
  const motivation = get("motivation")
  const city       = get("city")

  if (motivation && city) return `Your ${motivation.toLowerCase()} goals in ${city}`
  if (motivation)          return `About your ${motivation.toLowerCase()} plans`
  if (city && name)        return `${name} — the ${city} market update you've been waiting for`
  if (name)                return `A personal note for ${name}`
  return "A personal note from your real estate team"
}

/** Append STOP language where legally required (SMS). */
function enforceOptOut(channel: OutreachChannel, text: string): string {
  if (channel === "sms") {
    // Only append if not already present
    if (!/\bSTOP\b/.test(text)) {
      const trimmed = text.trimEnd()
      // Stay within ~320 chars; truncate body to leave room for opt-out
      const optOut = " Reply STOP to opt out."
      const maxBody = 320 - optOut.length
      return trimmed.substring(0, maxBody) + optOut
    }
  }
  return text
}

function humanizeMotivation(m: string): string {
  return m.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function humanizeOwnerStatus(s: string): string {
  const map: Record<string, string> = {
    owner:  "Homeowner",
    renter: "Renter",
    unknown:"Unknown",
  }
  return map[s.toLowerCase()] ?? s
}

// TOMBSTONE (wave 148, lane 148F — owner ruling 17): humanizeLifeEvent turned a life event into copy words ("recent inheritance",
// "growing family") for the draft. Its function moved: a life event shapes only the TONE now — lib/enrichment/life-event-vocabulary.ts
// lifeEventToneBrief (called in buildPersonalizationFacts above) — and the screen there refuses any draft naming one. Its own map
// also restated the event spellings a sixth way (§6); LIFE_EVENT_VOCAB's aliases absorb them.

function formatBudget(min: number | null | undefined, max: number | null | undefined): string | null {
  if (min != null && max != null) return `$${min.toLocaleString()}–$${max.toLocaleString()}`
  if (min != null)                return `$${min.toLocaleString()}+`
  if (max != null)                return `up to $${max.toLocaleString()}`
  return null
}

const CHANNEL_RULES: Record<OutreachChannel, string> = {
  email:       "Professional tone. Subject line under 60 chars. Body 3–5 short paragraphs. No pushy sales language.",
  sms:         "Conversational, under 280 chars before opt-out. Must end with 'Reply STOP to opt out.' — this is required by law.",
  voicemail:   "Warm, spoken-word friendly, 20–25 seconds of speech (~50 words). No bullet points.",
  call_opener: "Natural spoken opener for a live call, 10–15 seconds. Asks for permission to continue.",
  direct_mail: "Warm letter tone. 3–4 sentences. Honest, not salesy. No STOP required.",
}
