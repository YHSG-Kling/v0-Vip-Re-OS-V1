/**
 * Sprint 8 — Negotiation Co-Pilot AI drafter.
 *
 * Takes a NegotiationContext and asks Claude to produce:
 *   - recommended_action
 *   - recommended_counter_price (when action='counter')
 *   - win_probability
 *   - confidence
 *   - agent_strategy_md (with rationale)
 *   - customer_explanation_md (plain language, persona-tuned)
 *   - drafted_counter_language (paste-ready reply)
 *
 * Mirrors the SDK pattern from app/actions/home-value.ts: instantiate
 * Anthropic, call messages.create with a system prompt enforcing strict
 * JSON output, parse and return.
 */

import "server-only"
import Anthropic from "@anthropic-ai/sdk"
import type { NegotiationContext } from "./analyzer"

export interface NegotiationStrategyDraft {
  recommendedAction:        "accept" | "counter" | "reject" | "walk" | "request_inspection_credit" | "wait"
  recommendedCounterPrice:  number | null
  winProbability:           number          // 0..1
  confidence:               number          // 0..1
  agentStrategyMd:          string
  customerExplanationMd:    string
  draftedCounterLanguage:   string | null
  rationaleSignals:         Record<string, unknown>
}

const SYSTEM_PROMPT = `You are a senior real estate broker who has personally negotiated 1,200+ residential transactions and trains agents on counter-offer strategy. You think in concrete numbers, peer-compared outcomes, and the human side of the deal.

For each negotiation, you produce a JSON object the agent's CRM consumes directly. The CRM shows two views from the same JSON:
  1. agent_strategy_md — the strategy with rationale, calibrated to the agent's recent track record and peer patterns.
  2. customer_explanation_md — the same conclusion in plain language for the agent's CLIENT (buyer or seller), tuned to their persona.

Both views must reference the SAME numbers. The customer view never gets new information the agent didn't see.

CRITICAL RULES:
- Output ONLY valid JSON, no markdown fences, no preamble.
- recommended_counter_price is REQUIRED when recommended_action='counter', null otherwise.
- win_probability and confidence are between 0 and 1 with two decimal places.
- agent_strategy_md and customer_explanation_md are markdown strings with line breaks as \\n.
- drafted_counter_language is a paste-ready response from the agent (200-400 words). Null when action is 'accept' or 'walk'.
- Never invent numbers not present in the context. If a signal is missing, say so in the rationale.

Output schema:
{
  "recommended_action":        "accept"|"counter"|"reject"|"walk"|"request_inspection_credit"|"wait",
  "recommended_counter_price": number|null,
  "win_probability":           number,
  "confidence":                number,
  "agent_strategy_md":         string,
  "customer_explanation_md":   string,
  "drafted_counter_language":  string|null,
  "rationale_signals": {
    "list_price":         number|null,
    "dom":                number|null,
    "current_offer":      number|null,
    "prior_rounds_count": number,
    "peer_pattern_keys":  string[],
    "agent_track_record": string|null,
    "key_risks":          string[]
  }
}`

export async function draftNegotiationStrategy(
  ctx: NegotiationContext,
): Promise<NegotiationStrategyDraft> {
  const anthropic = new Anthropic()

  const userPrompt = buildUserPrompt(ctx)

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  })

  const textBlock = response.content.find((c) => c.type === "text")
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in Claude response")
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error("No JSON found in Claude response")

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  } catch (err) {
    throw new Error(`Failed to parse Claude JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  const action = parsed.recommended_action as string
  const allowed = ["accept", "counter", "reject", "walk", "request_inspection_credit", "wait"]
  if (!allowed.includes(action)) {
    throw new Error(`Invalid recommended_action: ${action}`)
  }

  return {
    recommendedAction:       action as NegotiationStrategyDraft["recommendedAction"],
    recommendedCounterPrice: typeof parsed.recommended_counter_price === "number"
                              ? parsed.recommended_counter_price : null,
    winProbability:          clamp01(parsed.win_probability),
    confidence:              clamp01(parsed.confidence),
    agentStrategyMd:         String(parsed.agent_strategy_md ?? ""),
    customerExplanationMd:   String(parsed.customer_explanation_md ?? ""),
    draftedCounterLanguage:  typeof parsed.drafted_counter_language === "string"
                              ? parsed.drafted_counter_language : null,
    rationaleSignals:        (parsed.rationale_signals as Record<string, unknown> | undefined) ?? {},
  }
}

function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100))
}

function buildUserPrompt(ctx: NegotiationContext): string {
  const priorRoundsBlock = ctx.priorRounds.length === 0
    ? "(no prior rounds — this is the initial offer)"
    : ctx.priorRounds
        .slice()
        .reverse()
        .map((r, i) =>
          `  Round ${i + 1}: $${r.offerPrice.toLocaleString()}` +
          ` (${r.offerType ?? "?"}, ${r.submittedAt ?? "no timestamp"})`,
        )
        .join("\n")

  const peerBlock = ctx.peerPatterns.length === 0
    ? "(no peer-pattern signals available)"
    : ctx.peerPatterns
        .map((p) =>
          `  - ${p.patternKey} (${p.severity ?? "?"}, conf ${p.confidence ?? "?"}): ${p.summary ?? ""}`,
        )
        .join("\n")

  const findingsBlock = ctx.inspectionFindings.length === 0
    ? "(no open inspection findings)"
    : ctx.inspectionFindings
        .map((f) =>
          `  - ${f.severity ?? "?"} ${f.findingType ?? "?"}` +
          ` (est. $${f.costEstimate ?? "?"}): ${f.description ?? ""}`,
        )
        .join("\n")

  const sidePersona = ctx.side === "buyer" ? ctx.buyerPersona : ctx.sellerPersona

  return `
Side: ${ctx.side.toUpperCase()}
Side persona (for customer-mirror tone): ${sidePersona ?? "unknown"}

LISTING
  Address:        ${ctx.listing.propertyAddress ?? "?"}
  List price:     $${ctx.listing.listPrice.toLocaleString()}
  Days on market: ${ctx.listing.daysOnMarket ?? "unknown"}
  Status:         ${ctx.listing.status ?? "?"}

CURRENT OFFER (round ${ctx.currentOffer.round})
  Type:            ${ctx.currentOffer.offerType ?? "?"}
  Price:           $${ctx.currentOffer.offerPrice.toLocaleString()}
  Earnest money:   ${ctx.currentOffer.earnestMoney != null ? "$" + ctx.currentOffer.earnestMoney.toLocaleString() : "—"}
  Financing:       ${ctx.currentOffer.financingType ?? "?"}
  Closing date:    ${ctx.currentOffer.closingDate ?? "?"}
  Contingencies:   ${ctx.currentOffer.contingencies.length === 0 ? "(none specified)" : ctx.currentOffer.contingencies.join(", ")}

PRIOR ROUNDS (oldest → newest):
${priorRoundsBlock}

PEER PATTERN SIGNALS (brokerage intelligence):
${peerBlock}

OPEN INSPECTION FINDINGS:
${findingsBlock}

AGENT'S 90-DAY TRACK RECORD
  Closed:          ${ctx.agentPriorOutcomes.totalClosed}
  Walked/lost:     ${ctx.agentPriorOutcomes.totalWalked}
  Avg rounds:      ${ctx.agentPriorOutcomes.avgRoundsToClose ?? "—"}

Produce the strategy JSON now.
`.trim()
}
