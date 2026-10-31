// lib/market-reports/prompts.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE MARKET REPORT'S PROMPTS (wave 147, lane 147E — preamble "PROMPT QUALITY IS A DELIVERABLE"; owner ruling 18).
//
// Two model calls, each an expert, structured prompt with role · business context · the facts it may rely on (and must not
// invent) · the decision it owns · a typed output contract · the compliance boundary · the escalation rule:
//   1. THE WRITER   — turns a dated, sourced fact table into a territory report's narrative. Numbers are NEVER typed by the
//                     model: it writes `{{datum_key}}` tokens the composer substitutes (lib/market-reports/contract.ts
//                     renderDatumTokens), and the validator refuses any figure that is not a sourced datum.
//   2. THE TOPIC STRATEGIST — chooses what this month's report should be ABOUT from evidence the OS already holds (the topic
//                     bank's competitor / customer-question / market themes, the tenant's own market rows), citing evidence ids.
//
// Fair housing belongs HERE (CLAUDE.md §5 "compliance-first — fair housing in the writing prompt, not only in the post-hoc
// scan"): the report is PUBLIC marketing copy. The post-hoc scan (scanPublicCopy, surface "lead_magnet") still runs on the
// composed text in lib/market-reports/producer.ts.
//
// Skills applied (named in the lane notes): realestate-market (market classification table, quality rules: hyper-local,
// recency, trend over snapshot, no predictions as facts, acknowledge uncertainty), realestate-comps (comp recency/distance
// windows, price basis), real-estate-real-estate-marketing (Fair Housing list + compliant alternatives),
// real-estate:market-update (headline stat → snapshot → what it means for buyers / sellers → a specific CTA; "use only the
// statistics provided — do not fabricate market data"; neighbourly, confident, not alarmist).
//
// PURE — no I/O.

import { z } from "zod"
import { formatDatumValue, sourceLine, type ComparableSale, type MarketDatum, type MarketReportFormat, type MarketReportTerritory, type MarketReportTopic, type UnavailableDatum } from "./contract"

// ── 1 · THE WRITER ───────────────────────────────────────────────────────────

export const MarketReportNarrativeSchema = z.object({
  insufficient_data: z.boolean().describe("true when the facts cannot support an honest report — then explain in insufficient_reason and keep sections empty"),
  insufficient_reason: z.string().nullable(),
  headline: z.string().describe("ONE sentence that names the territory and leads with the most meaningful fact as a {{token}}"),
  sections: z.array(z.object({
    heading: z.string(),
    body: z.string().describe("2-4 sentences; every figure is a {{datum_key}} token; interprets what the figure means"),
    datum_keys: z.array(z.string()).describe("the datum keys whose tokens appear in this body"),
  })).max(5),
  buyer_takeaways: z.array(z.string()).max(3),
  seller_takeaways: z.array(z.string()).max(3),
  call_to_action: z.string().describe("one specific, low-pressure offer (e.g. a street-level value review on request)"),
})
export type MarketReportNarrativeDraft = z.infer<typeof MarketReportNarrativeSchema>

export const MARKET_REPORT_WRITER_SYSTEM = `ROLE
You are a senior local real-estate market analyst who also writes compliance-first consumer copy for a licensed brokerage.
You explain what a territory's verified numbers MEAN to a homeowner or buyer the way a knowledgeable neighbour would: calm,
specific, never alarmist, never salesy.

BUSINESS CONTEXT
The brokerage publishes a branded market report for ONE territory. People request it from a lead-magnet page and receive it
by email and in their secure portal; it may also be narrated as a short video. A licensed agent's name and the brokerage's
brand sit on it, so every sentence must be defensible against the cited source.

THE FACTS YOU MAY RELY ON — AND NOTHING ELSE
You receive a FACT TABLE: each fact has a key, a label, the value as it will be printed, the unit, the date it describes and
its source. You also receive the facts that are NOT AVAILABLE for this territory, and (sometimes) comparable sales.
- Write every figure as its token, exactly {{key}} — e.g. "The median asking price was {{median_asking_price}}." Never type a
  number, a dollar amount, a percentage or a count yourself; the system substitutes the verified value. A typed figure is
  treated as invented and the whole report is refused.
- A percentage token renders WITH its sign ("+3.2%" / "-1.5%"); write around it accordingly ("changed {{asking_price_yoy_pct}}").
- Asking prices are LISTING statistics, not sale prices. Never call median_asking_price a "sale price" or "what homes sold for".
  Only median_sold_price / closed_sales_count describe closed sales.
- Never mention a fact listed as NOT AVAILABLE except to say plainly that it is not available yet; never estimate it.
- Never add neighbourhood names, employers, schools, events, interest rates or national statistics that are not in the table.

THE DECISION YOU OWN
Which facts tell this territory's story best, in what order, and what they mean for buyers and for sellers. Classify the
market only when the facts support it: months of supply < 3 with days on market < 30 reads as seller-leaning; > 6 months with
> 60 days reads as buyer-leaning; otherwise balanced or "not enough data to classify" (say which).

OUTPUT CONTRACT (typed JSON — the schema you were given)
- headline: names the territory label verbatim and leads with one {{token}}.
- sections: 2-4 sections; each body 2-4 sentences, each section uses at least one token and lists those keys in datum_keys.
  Suggested arc: the headline number → supply and pace → (if present) what sold nearby → what changed.
- buyer_takeaways / seller_takeaways: practical and specific to these facts, no generic advice.
- call_to_action: one concrete, low-pressure offer.

COMPLIANCE BOUNDARY (Fair Housing Act — this is public housing marketing)
Describe homes, prices, supply and pace — never people. Do not describe or imply the race, colour, religion, national origin,
sex, disability or familial status of residents or buyers; no "family-friendly", "great for young professionals", "ideal for
retirees", "exclusive", "safe neighbourhood", school quality or ratings, religious landmarks, or crime. Name a school district
only as "within <District>" if it is in the facts (it never is here — so don't). No guarantees, no forecasts stated as fact
("prices will rise"); a projection must be labelled as one and only when a fact supports a direction.

ESCALATION RULE
If fewer than three facts are available, or the facts contradict each other, set insufficient_data true, explain why in
insufficient_reason, and return empty sections. Do not pad. A person will decide what to do; a thin honest answer beats a
confident generic one.`

interface WriterFacts {
  territory: MarketReportTerritory
  asOf: string
  topic: MarketReportTopic
  format: MarketReportFormat
  brandName: string
  data: MarketDatum[]
  unavailable: UnavailableDatum[]
  comparables: ComparableSale[]
}

const FORMAT_BRIEFS: Record<MarketReportFormat, string> = {
  territory_snapshot: "A territory snapshot: the one number that matters most this month, then supply and pace.",
  what_sold_near_you: "What sold near you: lead with the closed sales (count, median sold price, days to sell), then the comparables.",
  equity_this_quarter: "What your equity did: lead with the price direction (year-over-year asking-price change), then what it means for an owner thinking about timing — no individual home value.",
  inventory_watch: "Inventory watch: lead with active and new listings and days on market — the pace a buyer or seller will feel.",
}

export function buildMarketReportWriterPrompt(f: WriterFacts): string {
  const facts = f.data.map((d) => `- {{${d.key}}} = ${formatDatumValue(d)} · ${d.label} · ${d.basis === "computed_from_records" ? `computed from ${d.sampleSize ?? "?"} records` : "provider-reported"} · ${sourceLine(d)}${d.caveat ? ` · caveat: ${d.caveat}` : ""}`)
  const missing = f.unavailable.map((u) => `- ${u.label}: ${u.text} (${u.reason})`)
  const comps = f.comparables.slice(0, 8).map((c) => `- ${c.address} · ${c.priceBasis === "recorded_sale" ? "sold" : "last asking"} $${Math.round(c.price).toLocaleString("en-US")} · ${c.date} · ${c.source.provider}`)
  return [
    `TERRITORY: ${f.territory.label} (grain: ${f.territory.grain})`,
    `REPORT DATE: ${f.asOf}`,
    `BRAND: ${f.brandName}`,
    `TOPIC: ${f.topic.title}${f.topic.angle ? ` — ${f.topic.angle}` : ""}`,
    `FORMAT: ${FORMAT_BRIEFS[f.format]}`,
    "",
    "FACT TABLE (write figures ONLY as these tokens):",
    ...(facts.length ? facts : ["- (none)"]),
    "",
    "NOT AVAILABLE for this territory:",
    ...(missing.length ? missing : ["- (nothing missing)"]),
    "",
    "COMPARABLE SALES (context only; do not restate their prices in prose — the report prints them in a table):",
    ...(comps.length ? comps : ["- (none)"]),
    "",
    "Write the report now, following the output contract.",
  ].join("\n")
}

// ── 2 · THE TOPIC STRATEGIST ─────────────────────────────────────────────────

export const MarketReportTopicSchema = z.object({
  suggestions: z.array(z.object({
    title: z.string().describe("the report's working title, naming the territory"),
    angle: z.string().describe("one sentence: the question this report answers for a neighbour"),
    format: z.enum(["territory_snapshot", "what_sold_near_you", "equity_this_quarter", "inventory_watch"]),
    evidence_ids: z.array(z.string()).min(1).describe("ids from the EVIDENCE list only"),
    why_now: z.string().describe("one sentence tying the evidence to this month"),
  })).max(5),
})
export type MarketReportTopicDraft = z.infer<typeof MarketReportTopicSchema>

export const MARKET_REPORT_TOPIC_SYSTEM = `ROLE
You are the content strategist for a local real-estate brokerage who decides what this month's market report should be
ABOUT, so that a neighbour would forward it.

BUSINESS CONTEXT
The brokerage's OS already gathered evidence: what its own market rows show changing, which themes competitors' public posts
are winning attention with (themes only — never their words), and which questions this brokerage's own customers keep asking
(counted, never quoted, never attributed to a person). You pick report topics the evidence supports.

THE FACTS YOU MAY RELY ON
Only the EVIDENCE list. Each item has an id, a kind (market_signal · competitor_theme · audience_question), a summary, the
date observed and its source. Cite evidence by id. Never invent an id, a statistic, a competitor or a question.

THE DECISION YOU OWN
Up to five ranked topic suggestions for the named territory, each with the format that serves it best:
territory_snapshot · what_sold_near_you · equity_this_quarter · inventory_watch. Prefer topics where a market_signal and an
audience_question agree; a competitor theme is inspiration, never a topic to copy.

OUTPUT CONTRACT
Typed JSON (the schema you were given). Every suggestion names the territory in its title and cites ≥1 evidence id.

COMPLIANCE BOUNDARY
Topics describe homes, prices, supply and pace. No topic about who lives somewhere, school ratings, crime or safety,
religious places, or any protected class; no topic that steers a group toward or away from an area.

ESCALATION RULE
If the evidence cannot support a topic, return an empty suggestions list — the system falls back to a plain territory
snapshot and says so. Do not pad.`

export interface TopicEvidenceItem {
  id: string
  kind: "market_signal" | "competitor_theme" | "audience_question"
  summary: string
  observedAt: string | null
  source: string
}

export function buildMarketReportTopicPrompt(input: { territory: MarketReportTerritory; asOf: string; evidence: TopicEvidenceItem[] }): string {
  return [
    `TERRITORY: ${input.territory.label}`,
    `TODAY: ${input.asOf}`,
    "",
    "EVIDENCE:",
    ...(input.evidence.length ? input.evidence.map((e) => `- [${e.id}] (${e.kind}) ${e.summary} · observed ${e.observedAt ?? "date unknown"} · ${e.source}`) : ["- (none)"]),
    "",
    "Suggest the topics now, following the output contract.",
  ].join("\n")
}
