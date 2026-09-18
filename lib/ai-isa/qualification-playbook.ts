/**
 * lib/ai-isa/qualification-playbook.ts
 *
 * Lane 74B — owner verbatim (wave 74): "the ai agents need to not be salesy
 * but also try to get them qualified so that they can setup a
 * meeting/showing, get their contact info, what their intent is, property
 * address that they are selling, determine their persona, etc. they can
 * setup followup whether calling them again when they are ready, sending a
 * list of properties that they just told us their criteria for, setting up a
 * time to look up their property value and give them a call back to discuss
 * or did they want to setup an appt for an agent to come out to
 * discuss/no obligation, etc. typical real estate talk unless there is a
 * competitor which is doing this another more inventive way. this goes for
 * the platform ai agents."
 *
 * THE ONE QUALIFICATION PLAYBOOK (CLAUDE.md §6 — one vocabulary per
 * function). Before this file, every customer-facing AI surface hand-rolled
 * its own qualification prose in its own words:
 *   - app/actions/ai-isa/handle-inbound-email.ts's baseSystem bullet list
 *     ("Qualify leads with genuine warmth…", "mark_qualification: when the
 *     lead reveals stronger or weaker buying signals…")
 *   - app/api/widget/message/route.ts's inline template literal ("qualify
 *     their intent (buying or selling), and naturally collect their name,
 *     email, and phone number…")
 *   - lib/voice/reception-brain.ts's buildReceptionPrompt job list ("(1)
 *     learn who is calling… (2) find out what they need… (3) offer to book
 *     an appointment… (5) if they mention selling… offer a real valuation
 *     and capture their property address…")
 *   - app/api/portal/ai-chat/route.ts and app/api/did/custom-llm/route.ts's
 *     servicing rules (no qualification prose, but the SAME follow-up menu
 *     belongs there once a known contact raises new intent mid-conversation)
 * Four spellings of the same six goals, drifting independently every time
 * one surface's prose was tuned and the other three were not. This file is
 * the merge target — every surface below MOUNTS `buildQualificationPrompt`
 * instead of writing its own qualification bullets; the old prose is
 * tombstoned in place (file:line) naming this file as the survivor.
 *
 * ── THE GOALS (never invented per-surface — one list, `QUALIFICATION_GOALS`) ──
 *   1. contact_info    — name + (email OR phone), collected naturally, never
 *                         demanded up front.
 *   2. intent          — buy / sell / both / invest / rent / relocate.
 *   3. persona         — the m589 contact_persona vocabulary (divorce,
 *                         downsize, expired, first_time, foreclosure, fsbo,
 *                         investor, luxury, military, other, probate,
 *                         relocated, senior, upsize) — inferred from what
 *                         they SAY, never guessed from demographics.
 *   4. seller_address   — when intent includes selling: the property address
 *                         they are selling (their OWN home — contacts.address
 *                         / leads.address already carries this; no new column).
 *   5. buyer_criteria   — when intent includes buying/renting: area, price
 *                         range, beds/baths, property type.
 *   6. timeline         — the live CHECK bucket vocabulary ONLY (CLAUDE.md §5:
 *                         "Timeline stays in buckets 1-3 / 3-6 / 6-12, never
 *                         30/60/90"): immediate / 1-3_months / 3-6_months /
 *                         6-12_months / 12+_months / researching.
 *   7. financing_status — for a buyer: cash / pre_approved /
 *                         needs_pre_approval / unknown (contacts.lender_status
 *                         / leads.lender_status — the live CHECK vocabulary).
 *
 * ── THE CONVERSATIONAL RULES (never salesy — the owner's own words) ────────
 * Helpful and curious, not a script being read at someone. One question at a
 * time — never a form disguised as a sentence. Mirror the person's own words
 * back rather than reframing them in sales language. Offer something useful
 * BEFORE asking for something (a real answer, a market fact, an honest "I
 * don't know, let me find out") — value first, ask second. Never manufacture
 * urgency or pressure toward a decision; the follow-up menu below exists
 * exactly so nobody has to be pushed into a same-call yes. Plain, typical
 * real-estate conversation — the tone a good local agent already uses on the
 * phone, not a chatbot script. This block doubles as the
 * fair-housing-safe-phrasing rule for the WRITING prompt (CLAUDE.md §5: fair
 * housing belongs in the writing prompt, not only a post-hoc scan) — capture
 * only what the PERSON states about the property/criteria they want; never
 * characterize a neighborhood, steer toward or away from an area, or infer a
 * demographic fact about them.
 *
 * ── THE FOLLOW-UP MENU (never invented — mirrors the ACTION tools in
 *    lib/ai-isa/customer-context-tools.ts) ───────────────────────────────────
 *   - schedule_callback         — call them back when THEY say they're ready
 *   - send_matching_listings    — the properties matching the criteria they
 *                                 just described
 *   - schedule_home_value_review — look up what their property is worth and
 *                                 call back to discuss it
 *   - book_agent_appointment    — a no-obligation in-person/video visit from
 *                                 the agent, nothing required
 *   - request_showing           — see a specific property, meet, or call now
 * The model picks ONE that matches what the PERSON asked for — never all
 * five, never a forced choice.
 *
 * ── COMPETITOR AWARENESS (wave 74, "unless there is a competitor which is
 *    doing this another more inventive way") ──────────────────────────────
 * docs/ai-agent-tool-surfaces-2026-09.md §"Qualification playbook" records
 * the 2026 conversational-AI-ISA competitive scan (Structurely, Ylopo, Lofty,
 * Follow Up Boss AI, Roof AI) and which of their more inventive moves this
 * playbook adopted vs. declined, with reasons — this file is where the
 * ADOPTED ones live in the actual prompt, not a second list.
 *
 * ── SURFACE VARIANTS ────────────────────────────────────────────────────────
 * `buildQualificationPrompt` is mounted on EVERY AI-agent surface (tenant and
 * platform), but not every surface talks to a real-estate buyer/seller under
 * a persona:
 *   - isa_email / widget / did_avatar / voice_reception / voice_outbound /
 *     portal — the FULL playbook: goals + conversational rules + follow-up
 *     menu, persona-flavored.
 *   - platform_reception — the PLATFORM's own line answers PROSPECTS ASKING
 *     ABOUT THE SOFTWARE, not a home buyer/seller; mounting the real-estate
 *     goals there would be inventing facts about a caller who is not
 *     discussing a property. This surface gets the CONVERSATIONAL RULES ONLY
 *     (never salesy, one question at a time, value first) — the "this goes
 *     for the platform ai agents" half of the ruling — never the
 *     buyer/seller goal list.
 *   - staff_copilot — the in-app agent copilot never itself talks to a
 *     client; it DRAFTS on staff's behalf (draft_ai_reply). It gets a
 *     COMPACT reference block so a drafted client message follows the same
 *     non-salesy discipline, not the full first-person goal list.
 */

import type { ToolPersona } from "./persona-tool-policy"

export type QualificationSurface =
  | "isa_email"
  | "widget"
  | "portal"
  | "did_avatar"
  | "voice_reception"
  | "voice_outbound"
  | "platform_reception"
  | "staff_copilot"

/** Surfaces that get the FULL real-estate qualification goal list. */
const REAL_ESTATE_SURFACES: readonly QualificationSurface[] = [
  "isa_email", "widget", "portal", "did_avatar", "voice_reception", "voice_outbound",
]

export interface QualificationGoal {
  key: string
  label: string
  detail: string
}

/** ONE list — the seven goals, in the order a natural conversation actually
 *  surfaces them. Every surface reads THIS list; none writes its own. */
export const QUALIFICATION_GOALS: readonly QualificationGoal[] = [
  { key: "contact_info", label: "Contact info", detail: "their name and a way to reach them (email or phone) — collected naturally as the conversation earns it, never demanded up front" },
  { key: "intent", label: "Intent", detail: "are they buying, selling, both, investing, renting, or relocating" },
  { key: "persona", label: "Persona", detail: "what's driving the move — first-time buyer, downsizing, upsizing, relocating, investor, luxury, military, senior, or a situation like divorce, probate, foreclosure, or an expired/FSBO listing — read from what they SAY, never guessed" },
  { key: "seller_address", label: "Property they're selling", detail: "if they mention selling, the address of the home they own and are selling" },
  { key: "buyer_criteria", label: "Buyer criteria", detail: "if they're buying or renting: the area, price range, bedrooms/bathrooms, and property type they want" },
  { key: "timeline", label: "Timeline", detail: "a realistic window — right away, 1-3 months, 3-6 months, 6-12 months, 12+ months, or still just researching" },
  { key: "financing_status", label: "Financing status", detail: "for a buyer: paying cash, already pre-approved, still needs pre-approval, or not sure yet" },
] as const

export interface FollowUpOption {
  tool: string
  label: string
  when: string
}

/** ONE menu — mirrors the free tools in lib/ai-isa/customer-context-tools.ts. */
export const QUALIFICATION_FOLLOW_UP_MENU: readonly FollowUpOption[] = [
  { tool: "schedule_callback", label: "Call them back later", when: "they're interested but not ready to talk further right now — ask when a good time to call back is" },
  { tool: "send_matching_listings", label: "Send matching listings", when: "they described buyer/renter criteria — send what matches, and keep sending as new matches come in" },
  { tool: "schedule_home_value_review", label: "Look up their home's value", when: "they mentioned selling or asked what their home is worth — look it up and schedule a callback to discuss it" },
  { tool: "book_agent_appointment", label: "Book a no-obligation agent visit", when: "they want an agent to come out (in person or video) and talk it through — make clear it's no-obligation" },
  { tool: "request_showing", label: "Request a showing / meeting / call now", when: "they want to see a specific property, meet, or talk right away" },
] as const

/** PURE — the "never salesy" conversational rules, shared by every surface
 *  that talks to a person (customer-facing or platform-prospect-facing
 *  alike). Doubles as the fair-housing-safe-phrasing rule for the writing
 *  prompt (CLAUDE.md §5). */
export function conversationalRulesBlock(): string {
  return [
    "CONVERSATION STYLE — never salesy:",
    "- Be helpful and curious, not a script being read at someone.",
    "- Ask ONE question at a time — never stack several into one message; a form disguised as a sentence is still a form.",
    "- Mirror the person's own words back rather than reframing them in sales language.",
    "- If an answer is vague or conditional (\"it depends on the school district\", \"maybe next year\"), ask ONE gentle follow-up to understand the real constraint rather than recording it as a flat field — a real conversation, not a dropdown.",
    "- Offer something useful BEFORE asking for something — a real answer, a market fact, or an honest \"I don't know, let me find out\" — value first, ask second.",
    "- Never manufacture urgency or pressure toward a decision on this call/message. The follow-up menu exists so nobody has to be pushed into a same-conversation yes.",
    "- Fair housing: capture only what THEY state about the property or criteria they want; never characterize a neighborhood, never steer toward or away from an area, never infer a demographic fact about them.",
    "- Keep it typical real-estate conversation — the tone a good local agent already uses, not a chatbot script.",
  ].join("\n")
}

function goalsBlock(persona: ToolPersona | null | undefined): string {
  const lines = ["WHAT TO LEARN, OVER THE COURSE OF THE CONVERSATION (one at a time, as it comes up naturally):"]
  for (const g of QUALIFICATION_GOALS) {
    if (g.key === "seller_address" && persona && persona !== "seller") continue
    if (g.key === "buyer_criteria" && persona === "seller") continue
    if (g.key === "financing_status" && (persona === "seller" || persona === "sphere")) continue
    lines.push(`- ${g.label}: ${g.detail}`)
  }
  return lines.join("\n")
}

function followUpMenuBlock(): string {
  const lines = ["FOLLOW-UP MENU — once you understand what they want, offer ONE of these that fits (never all five, never forced):"]
  for (const f of QUALIFICATION_FOLLOW_UP_MENU) {
    lines.push(`- ${f.label} (${f.tool}): ${f.when}`)
  }
  return lines.join("\n")
}

export interface QualificationKnownFacts {
  hasContactInfo?: boolean
  intent?: string | null
  persona?: string | null
  timeline?: string | null
}

function knownFactsBlock(known: QualificationKnownFacts | undefined): string {
  if (!known) return ""
  const have: string[] = []
  if (known.hasContactInfo) have.push("contact info")
  if (known.intent) have.push(`intent (${known.intent})`)
  if (known.persona) have.push(`persona (${known.persona})`)
  if (known.timeline) have.push(`timeline (${known.timeline})`)
  if (have.length === 0) return ""
  return `ALREADY ON FILE — do not re-ask: ${have.join(", ")}.`
}

export interface BuildQualificationPromptInput {
  /** The tool persona this conversation resolved to (buyer/seller/investor/
   *  renter/relocation/sphere), when known. Null/undefined for a not-yet-
   *  captured or platform/staff surface. */
  persona?: ToolPersona | null
  surface: QualificationSurface
  /** What this conversation already knows, so the prompt does not ask the
   *  model to re-collect it. */
  known?: QualificationKnownFacts
}

/**
 * THE shared builder — every mounting surface calls this instead of writing
 * its own qualification prose. Additive: callers still prepend their own
 * identity/brand-voice/hard-rules blocks; this is the ONE qualification
 * section every one of them shares.
 */
export function buildQualificationPrompt(input: BuildQualificationPromptInput): string {
  if (input.surface === "platform_reception") {
    // "this goes for the platform ai agents" — the conversational discipline
    // applies; the real-estate goal list does not (a platform prospect is not
    // discussing a property).
    return conversationalRulesBlock()
  }
  if (input.surface === "staff_copilot") {
    return [
      "WHEN DRAFTING A CLIENT-FACING MESSAGE (draft_ai_reply), follow the shared qualification playbook:",
      conversationalRulesBlock(),
      goalsBlock(input.persona ?? null),
      followUpMenuBlock(),
    ].filter(Boolean).join("\n\n")
  }

  const parts = [
    conversationalRulesBlock(),
    goalsBlock(REAL_ESTATE_SURFACES.includes(input.surface) ? (input.persona ?? null) : null),
    followUpMenuBlock(),
    knownFactsBlock(input.known),
  ].filter(Boolean)
  return parts.join("\n\n")
}
