// lib/market-reports/topics.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MONTH'S MARKET REPORT SHOULD BE ABOUT (wave 147, lane 147E — lane brief requirement 4: "AI topic suggestions from
// local market signals, competitor intelligence and audience questions, with the evidence behind each suggestion").
//
// NO FOURTH IDEATION PATH (LAW 2). The evidence is read from the survivors that already gather it:
//   · the TOPIC BANK — content_topic_bank rows filed by lib/content-intel/topic-intelligence.ts with raw_data.topic_evidence
//     (source_class: competitor post themes, viral patterns, CUSTOMER QUESTIONS, education / AI-search gaps, market themes —
//     themes only, never a competitor's words or a customer's identity). Read directly (tenant-pinned, fresh, unexpired)
//     because the picker (lib/content-intel/topic-bank.ts pickTopics) is server-only and drops the evidence.
//   · the tenant's own MARKET ROWS — market_data (dated, sourced), the same rows the report is built from.
// The model RANKS and FRAMES; it cannot add evidence: every suggestion must cite ids from the list, an invented id is dropped,
// and a suggestion left with none is discarded. No model, a refused read, or nothing usable → the deterministic fallback
// (a territory snapshot) with the reason said. Cost booked by the routed call (ai_tool_usage).
//
// Never throws.

import { isoDay, type MarketReportFormat, type MarketReportTerritory } from "./contract"
import { buildMarketReportTopicPrompt, MARKET_REPORT_TOPIC_SYSTEM, MarketReportTopicSchema, type MarketReportTopicDraft, type TopicEvidenceItem } from "./prompts"

type Db = { from: (table: string) => any }

interface MarketReportTopicSuggestion {
  title: string
  angle: string
  format: MarketReportFormat
  evidence: TopicEvidenceItem[]
  whyNow: string
  /** "ai" — ranked by the routed strategist; "fallback" — the deterministic snapshot. */
  by: "ai" | "fallback"
}

export interface TopicSuggestionResult {
  suggestions: MarketReportTopicSuggestion[]
  evidenceCount: number
  /** Why the fallback was used / what could not be read — said, never silent. */
  notes: string[]
}

export interface TopicDeps {
  now?: Date
  /** The routed strategist (default: generateObjectRouted, feature market_insight_narrative). Seam for the proof. */
  rank?: (a: { brokerageId: string; system: string; prompt: string }) => Promise<MarketReportTopicDraft>
}

/** Map the topic bank's source classes onto the brief's three evidence kinds (lib/content-intel/topic-themes.ts TopicSourceClass). */
function kindOf(sourceClass: unknown): TopicEvidenceItem["kind"] | null {
  const s = String(sourceClass ?? "")
  if (/question|education|ai_search|search_gap/.test(s)) return "audience_question"
  if (/competitor|viral/.test(s)) return "competitor_theme"
  if (/market|property_value/.test(s)) return "market_signal"
  return null
}

/** Gather the evidence (tenant-pinned). Proven through suggestMarketReportTopics. */
async function gatherTopicEvidence(svc: Db, input: { brokerageId: string; territory: MarketReportTerritory; now?: Date }): Promise<{ evidence: TopicEvidenceItem[]; notes: string[] }> {
  const now = input.now ?? new Date()
  const notes: string[] = []
  const evidence: TopicEvidenceItem[] = []
  const { data: bank, error: bankErr } = await svc.from("content_topic_bank").select("id, topic_title, value_angle, categories, raw_data, scraped_at, expires_at, status")
    .eq("brokerage_id", input.brokerageId).eq("status", "fresh").gt("expires_at", now.toISOString()).order("scraped_at", { ascending: false }).limit(40)
  if (bankErr) notes.push(`content_topic_bank read refused: ${bankErr.message ?? "unknown"} — competitor themes and customer questions are a blind spot this run`)
  for (const r of (bank ?? []) as Array<{ id: string; topic_title: string | null; value_angle: string | null; raw_data: Record<string, unknown> | null; scraped_at: string | null }>) {
    const ev = (r.raw_data?.topic_evidence ?? null) as { source_class?: string; source?: string; observed_at?: string } | null
    const kind = kindOf(ev?.source_class)
    if (!kind || !r.topic_title) continue
    evidence.push({ id: `topic:${r.id}`, kind, summary: `${r.topic_title}${r.value_angle ? ` — ${r.value_angle}` : ""}`, observedAt: ev?.observed_at ?? r.scraped_at ?? null, source: `content_topic_bank (${ev?.source ?? ev?.source_class})` })
  }
  let mq = svc.from("market_data").select("id, data_date, source_type, zip_code, city, median_sale_price, active_listings, avg_days_on_market, price_trend_pct_1yr").eq("brokerage_id", input.brokerageId)
  if (input.territory.zip) mq = mq.eq("zip_code", input.territory.zip)
  const { data: rows, error: mdErr } = await mq.order("data_date", { ascending: false }).limit(6)
  if (mdErr) notes.push(`market_data read refused: ${mdErr.message ?? "unknown"} — local market signals are a blind spot this run`)
  for (const m of (rows ?? []) as Array<{ id: string; data_date: string; source_type: string | null; zip_code: string | null; city: string | null; price_trend_pct_1yr: number | null; active_listings: number | null; avg_days_on_market: number | null }>) {
    if (m.source_type === "cma_aggregate") continue
    const parts: string[] = []
    if (Number(m.price_trend_pct_1yr)) parts.push(`asking prices ${Number(m.price_trend_pct_1yr) > 0 ? "up" : "down"} ${Math.abs(Number(m.price_trend_pct_1yr))}% year over year`)
    if (Number(m.active_listings) > 0) parts.push(`${m.active_listings} active listings`)
    if (Number(m.avg_days_on_market) > 0) parts.push(`${m.avg_days_on_market} average days on market`)
    if (parts.length) evidence.push({ id: `market:${m.id}`, kind: "market_signal", summary: `${m.zip_code ?? m.city ?? input.territory.label}: ${parts.join(", ")}`, observedAt: m.data_date, source: `market_data (${m.source_type})` })
  }
  return { evidence, notes }
}

function fallback(territory: MarketReportTerritory, evidence: TopicEvidenceItem[], reason: string): MarketReportTopicSuggestion {
  return {
    title: `${territory.label} market snapshot`,
    angle: `Where prices, supply and pace stand in ${territory.label} right now.`,
    format: "territory_snapshot",
    evidence: evidence.filter((e) => e.kind === "market_signal").slice(0, 3),
    whyNow: reason,
    by: "fallback",
  }
}

/** Suggest topics for a territory's report, each with the evidence behind it. */
export async function suggestMarketReportTopics(svc: Db, input: { brokerageId: string; territory: MarketReportTerritory }, deps: TopicDeps = {}): Promise<TopicSuggestionResult> {
  const now = deps.now ?? new Date()
  try {
    const { evidence, notes } = await gatherTopicEvidence(svc, { brokerageId: input.brokerageId, territory: input.territory, now })
    if (evidence.length === 0) return { suggestions: [fallback(input.territory, [], "no topic evidence on record — a plain snapshot of the territory")], evidenceCount: 0, notes: [...notes, "no evidence — fallback topic"] }
    const rank = deps.rank ?? (async (a) => (await (await import("@/lib/ai/models")).generateObjectRouted({
      feature: "market_insight_narrative", brokerageId: a.brokerageId, manager: "campaign_orchestrator",
      system: a.system, prompt: a.prompt, schema: MarketReportTopicSchema, maxTokens: 1200, temperature: 0.4,
      contextExtra: { purpose: "market_report_topic_suggestion" },
    })).object)
    let draft: MarketReportTopicDraft
    try {
      draft = await rank({ brokerageId: input.brokerageId, system: MARKET_REPORT_TOPIC_SYSTEM, prompt: buildMarketReportTopicPrompt({ territory: input.territory, asOf: isoDay(now), evidence }) })
    } catch (e) {
      return { suggestions: [fallback(input.territory, evidence, "the topic strategist was unavailable — a plain snapshot")], evidenceCount: evidence.length, notes: [...notes, `strategist unavailable: ${e instanceof Error ? e.message : String(e)}`] }
    }
    const byId = new Map(evidence.map((e) => [e.id, e]))
    const dropped: string[] = []
    const suggestions: MarketReportTopicSuggestion[] = []
    for (const s of draft.suggestions ?? []) {
      const cited = (s.evidence_ids ?? []).map((id) => { const e = byId.get(id); if (!e) dropped.push(id); return e }).filter((e): e is TopicEvidenceItem => !!e)
      if (cited.length === 0) continue // a suggestion with no real evidence is not a suggestion
      const title = s.title.toLowerCase().includes(input.territory.label.toLowerCase()) ? s.title : `${input.territory.label}: ${s.title}`
      suggestions.push({ title, angle: s.angle, format: s.format, evidence: cited, whyNow: s.why_now, by: "ai" })
    }
    if (dropped.length) notes.push(`dropped ${dropped.length} evidence id(s) the strategist invented: ${dropped.slice(0, 5).join(", ")}`)
    if (suggestions.length === 0) return { suggestions: [fallback(input.territory, evidence, "no suggestion cited real evidence — a plain snapshot")], evidenceCount: evidence.length, notes }
    return { suggestions, evidenceCount: evidence.length, notes }
  } catch (e) {
    return { suggestions: [fallback(input.territory, [], "topic suggestion failed — a plain snapshot")], evidenceCount: 0, notes: [`suggestMarketReportTopics threw: ${e instanceof Error ? e.message : String(e)}`] }
  }
}
