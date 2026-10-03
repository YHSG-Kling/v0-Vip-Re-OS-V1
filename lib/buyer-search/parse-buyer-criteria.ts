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
  type ConversationCriteria,
  type CriteriaGap,
  type ModelCriteria,
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
})

const SYSTEM = [
  "You extract a home buyer's search criteria from their own message.",
  "Return ONLY what the buyer literally stated. Never guess a budget, a bedroom count or a place they did not say.",
  "Fair housing: never output anything about schools' quality, safety, age, children, family, religion, race, national origin, disability or who lives in an area. Those are not fields and must not be inferred.",
  "A price a buyer says without a unit about a home ('under 450') is in thousands of dollars. A rent is per month and is not scaled.",
].join(" ")

export async function parseBuyerCriteria(text: string, ctx: ParseBuyerCriteriaContext): Promise<ParsedBuyerCriteria> {
  const body = (text ?? "").trim().slice(0, 1200)
  const rules = extractCriteriaFromTranscript(body)
  const notes = unsearchableAsks(body)
  let criteria = rules.criteria
  let via: ParsedBuyerCriteria["via"] = "rules"

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
          maxTokens: 300,
          temperature: 0,
          schema: MODEL_SCHEMA,
        })
        const merged = mergeModelCriteria(criteria, object as ModelCriteria, body)
        if (JSON.stringify(merged) !== JSON.stringify(criteria)) via = "rules+model"
        criteria = merged
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
  }
}
