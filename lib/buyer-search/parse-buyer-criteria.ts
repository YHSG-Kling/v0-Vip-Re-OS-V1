/**
 * lib/buyer-search/parse-buyer-criteria.ts — THE ONE natural-language buyer
 * criteria parser (lane 91C).
 *
 * Owner (wave 91, verbatim): "remember we use rentcast for property listings
 * to send to the buyers that reflect their criteria (even nlp natural
 * language)".
 *
 * A buyer writes "3 bed under 450 near good schools in Frisco, need a yard" in
 * a chat, an email or the portal search box. This turns it into the EXISTING
 * criteria shape (ConversationCriteria — lib/buyer-search/conversation-
 * criteria.ts, the shape the alert rows, the proposal rail and the RentCast
 * search all already read) in two passes:
 *
 *   1. RULES (free) — extractCriteriaFromTranscript → parseNaturalLanguageQuery
 *      (lib/buyer-search/intent-parser.ts). Always runs.
 *   2. MODEL ASSIST (cheap, optional) — only when the rules leave a concrete
 *      gap (criteriaGaps: location / price / beds), the Haiku lane
 *      AI_TASK_ROUTING.buyer_criteria_parse answers with structured output
 *      through generateObjectRouted (Vercel AI SDK + AI Gateway, ledgered to
 *      the tenant). mergeModelCriteria then lets it FILL gaps only, with values
 *      the buyer's own words contain, and its schema has no school, age or
 *      household field at all.
 *
 * NOT A SECOND PARSER. The survivor is the rules pair above; this file is the
 * entry point that composes them with the model lane. The duplicate it retired
 * is the inline prompt in app/actions/idx-search.ts smartSearch, which asked a
 * model (un-routed → Sonnet) for its own JSON shape on every search — that
 * function now calls this one (tombstone at its call site).
 *
 * SPEND IS TENANT-LEDGERED OR NOT MADE. With no brokerageId the model is never
 * called (generateObjectRouted books cost only against a tenant; an un-booked
 * call is a wrong invoice — CLAUDE.md §5). A failed model call degrades to the
 * rules answer and says so in `via`/`notes`; it never throws.
 *
 * NOT marked `server-only`, deliberately, like its caller lib/buyer-search/
 * search-engine.ts: the live layer of scripts/buyer-nl-search-simulator.ts runs
 * searchPropertiesCore under plain tsx, where a `server-only` import throws and
 * would turn a real search into a refusal. The model call is reached only by a
 * dynamic import of lib/ai/models.ts inside the function, never at module load,
 * and nothing here is exported to a client.
 */
import { z } from "zod"
import {
  extractCriteriaFromTranscript,
  countCriteriaSignals,
  criteriaGaps,
  mergeModelCriteria,
  unsearchableAsks,
  extractLifestyleAsks,
  detectStatedDealBreakers,
  detectPriorityShift,
  clarifyingQuestions,
  LIFESTYLE_KINDS,
  type ConversationCriteria,
  type CriteriaGap,
  type ModelCriteria,
  type LifestyleAsk,
  type LifestyleKind,
  type ClarifyingQuestion,
} from "./conversation-criteria"

export interface ParsedBuyerCriteria {
  criteria: ConversationCriteria
  confidence: "high" | "low"
  signalCount: number
  /** The buyer's own sentences the rules pass took criteria from. */
  evidence: string[]
  /** Which passes produced the answer. `rules+model` = the Haiku lane filled
   *  at least one gap; `rules` = it was not needed, not allowed, or failed. */
  via: "rules" | "rules+model"
  /** Gaps still open after both passes — the ISA asks about these next. */
  gaps: CriteriaGap[]
  /** Plain sentences for the conversation: asks no feed can filter on (school
   *  quality), or why the model assist did not run. */
  notes: string[]
  /** Wave 147C (C10): the buyer's lifestyle asks (natural light, commute, layout, …),
   *  each with their literal words. Answered later only from source data. */
  lifestyle: LifestyleAsk[]
  /** Wave 147C: what they said they do NOT want ("no HOA", "not a condo"). */
  dealBreakers: string[]
  /** Wave 147C: a stated reprioritisation ("light matters more than the yard now"). */
  priority: { up: LifestyleKind | null; down: LifestyleKind | null }
  /** Wave 147C: "what you didn't say" — the next questions, in search-impact order. */
  clarifications: ClarifyingQuestion[]
}

export interface ParseBuyerCriteriaContext {
  /** Tenant the model spend books against — from the session or a row read
   *  under a tenant predicate, never a request body (CLAUDE.md §4). Null →
   *  rules only. */
  brokerageId: string | null
  userId?: string | null
  /** false → rules only (a caller that must not spend, e.g. a proof). */
  allowModelAssist?: boolean
}

const MODEL_SCHEMA = z.object({
  minPrice: z.number().nullable().describe("Lowest price the buyer stated, in dollars (450 said about a home = 450000), or null"),
  maxPrice: z.number().nullable().describe("Highest price the buyer stated, in dollars, or null"),
  minBeds: z.number().nullable().describe("Minimum bedrooms the buyer stated, or null"),
  minBaths: z.number().nullable().describe("Minimum bathrooms the buyer stated, or null"),
  propertyTypes: z.array(z.enum(["single_family", "condo", "townhouse", "multi_family", "land"])).nullable(),
  cities: z.array(z.string()).nullable().describe("City names exactly as the buyer wrote them"),
  state: z.string().nullable().describe("Two-letter USPS state code for the city named, or null"),
  zipCodes: z.array(z.string()).nullable().describe("Five-digit ZIP codes the buyer wrote"),
  features: z.array(z.string()).nullable().describe("Physical home features the buyer asked for, in their words (yard, pool, garage, office)"),
  listingType: z.enum(["sale", "rent"]).nullable().describe("'rent' only if the buyer said they want to rent/lease"),
  // Wave 147C (C10): the buyer's own lifestyle asks. `phrase` must be copied verbatim from the
  // message — the merge below drops any phrase the buyer's words do not contain.
  lifestyle: z.array(z.object({
    kind: z.enum(LIFESTYLE_KINDS),
    phrase: z.string().describe("The buyer's exact words for this ask, copied verbatim"),
    direction: z.enum(["more", "less", "must", "avoid"]),
    target: z.string().nullable().describe("A named place or amenity the buyer gave (e.g. 'Medical Center', 'parks'), else null"),
  })).nullable(),
})

/**
 * THE PARSING PROMPT (wave 147C — preamble rule: prompt quality is a deliverable). Structured as
 * role → business context → what it may rely on → what it must not do → the decision it owns →
 * units → output contract → escalation. Its output is RE-CHECKED in code (mergeModelCriteria /
 * mergeModelLifestyle): a value the buyer's words do not contain is dropped whatever the model said.
 */
const SYSTEM = [
  "ROLE: You are the criteria-intake specialist on a real-estate brokerage's buyer team. You turn what a home buyer or renter says into their saved search criteria, the way a careful buyer's agent takes notes at a first consultation.",
  "BUSINESS CONTEXT: The person is talking to their brokerage's home-search assistant in the client portal, by email, by text or on a voice call. Your output becomes their saved criteria. They will see every field you fill, labelled 'you said', and can edit it. A wrong field sends them the wrong homes and costs their trust; a missing field is fine, because the assistant will ask.",
  "WHAT YOU MAY RELY ON: only the buyer's message between the triple quotes. Nothing else exists for this task — no prior conversation, no assumptions about their market, their household or their finances.",
  "WHAT YOU MUST NOT DO: never guess a budget, a bedroom count, a city or a property type they did not state. Never output or infer anything about household composition, children, age, religion, race, national origin, sex, disability (other than an accessibility need they state for their own home), familial status, or school quality, and never characterize a neighborhood's people, safety or 'feel' — those are not fields. Never capture a place of worship or a school as an amenity.",
  "THE DECISION YOU OWN: mapping stated facts to fields. You do not decide which homes they see, and you do not answer them.",
  "UNITS: a home price said without a unit ('under 450') means thousands of dollars ($450,000); '1.2 million' is $1,200,000. A rent is per month and is never scaled. '3 or 4 bedrooms' means minBeds 3. 'At least 2 baths' means minBaths 2.",
  "LIFESTYLE: capture the buyer's own lifestyle asks — natural light, a commute to a named place (with any time limit), layout (open floor plan, single level, primary bedroom on the main level, split bedrooms), an accessibility need they state, nearby neutral amenities (parks, trails, grocery, coffee, restaurants, transit, downtown, the beach), more or less outdoor space, a quiet street — each with the exact words they used.",
  "OUTPUT CONTRACT: JSON matching the schema exactly. null or an empty list for anything not stated. Every city, feature and lifestyle phrase is copied verbatim from the message.",
  "ESCALATION: if the message asks for something you must not capture (for example a neighborhood described by who lives there), leave it out silently — the application tells the buyer what it can and cannot search on. Do not refuse, explain or lecture inside the JSON.",
].join("\n")

/** PURE. The model's lifestyle asks, kept only when the buyer's words contain the phrase. */
function mergeModelLifestyle(rules: LifestyleAsk[], model: unknown, text: string): LifestyleAsk[] {
  if (!Array.isArray(model)) return rules
  const out = [...rules]
  for (const raw of model as Array<Record<string, unknown>>) {
    const phrase = typeof raw?.phrase === "string" ? raw.phrase.trim() : ""
    const kind = raw?.kind as LifestyleKind
    if (!phrase || !(LIFESTYLE_KINDS as readonly string[]).includes(kind)) continue
    if (!text.toLowerCase().includes(phrase.toLowerCase())) continue // not the buyer's words → dropped
    if (out.some((a) => a.kind === kind)) continue // the rules already captured this kind
    const direction = (["more", "less", "must", "avoid"] as const).includes(raw.direction as never) ? raw.direction as LifestyleAsk["direction"] : "must"
    const target = typeof raw.target === "string" && raw.target.trim() && text.toLowerCase().includes(raw.target.trim().toLowerCase()) ? raw.target.trim() : null
    out.push({ kind, label: target && kind === "commute" ? `commute to ${target}` : phrase.toLowerCase(), direction, target, maxMinutes: null, evidence: phrase })
  }
  return out
}

export async function parseBuyerCriteria(text: string, ctx: ParseBuyerCriteriaContext): Promise<ParsedBuyerCriteria> {
  const body = (text ?? "").trim().slice(0, 1200)
  const rules = extractCriteriaFromTranscript(body)
  const notes = unsearchableAsks(body)
  let criteria = rules.criteria
  let via: ParsedBuyerCriteria["via"] = "rules"
  let lifestyle = extractLifestyleAsks(body)
  const stated = detectStatedDealBreakers(body)

  // The model is asked only when a concrete gap is open (the cost rule above); lifestyle asks
  // the rules missed ride along on that same call — they never trigger one on their own.
  const open = criteriaGaps(criteria)
  if (open.length > 0 && body.length >= 5) {
    if (ctx.allowModelAssist === false) {
      // Rules only by the caller's choice — not a failure, nothing to report.
    } else if (!ctx.brokerageId) {
      notes.push("Model assist skipped: no tenant to book the AI spend against — rules-only criteria.")
    } else {
      try {
        const { generateObjectRouted } = await import("@/lib/ai/models")
        const { object } = await generateObjectRouted({
          feature: "buyer_criteria_parse",
          brokerageId: ctx.brokerageId,
          userId: ctx.userId ?? null,
          system: SYSTEM,
          prompt: `Buyer's message:\n"""${body}"""`,
          maxTokens: 450, // wave 147C: the lifestyle array rides the same call
          temperature: 0,
          schema: MODEL_SCHEMA,
        })
        const merged = mergeModelCriteria(criteria, object as ModelCriteria, body)
        const mergedLifestyle = mergeModelLifestyle(lifestyle, (object as { lifestyle?: unknown }).lifestyle, body)
        if (JSON.stringify(merged) !== JSON.stringify(criteria) || mergedLifestyle.length !== lifestyle.length) via = "rules+model"
        criteria = merged
        lifestyle = mergedLifestyle
      } catch (err) {
        notes.push(`Model assist unavailable (${err instanceof Error ? err.message : "error"}) — rules-only criteria.`)
      }
    }
  }

  const signalCount = countCriteriaSignals(criteria)
  return {
    criteria,
    confidence: signalCount >= 2 ? "high" : "low",
    signalCount,
    evidence: rules.evidence,
    via,
    gaps: criteriaGaps(criteria),
    notes,
    lifestyle,
    dealBreakers: stated.dealBreakers,
    priority: detectPriorityShift(body),
    clarifications: clarifyingQuestions(criteria, lifestyle, { text: body }),
  }
}
