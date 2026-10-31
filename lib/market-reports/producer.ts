// lib/market-reports/producer.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE MARKET-REPORT PRODUCER (wave 147, lane 147E — owner ruling 6, 2026-10-31: "Build the market report producer").
//
// SURVIVOR VERDICT. lib/market-intelligence/report-builder.ts buildMarketReportAnalysis (lane 75B) is the PARTIAL survivor of
// "a market report": it hands the model raw rows and lets the MODEL author every figure (avgPriceChange, avgDaysOnMarket,
// hotNeighborhoods[].avgPrice, forecasts, "topPerformingAgents") with no source and no date — generic text the owner ruled is
// not a market report. Its consumers (the agent's on-demand analysis, the AI ISA's send_market_report capability) are routed
// here in the lane notes (Outside-lane); this module is the producer, built on the data survivors (research.ts header).
//
//   topic (topics.ts: evidence-backed, or the caller's) → research (research.ts: dated, sourced facts; unavailable said)
//   → narrative (the routed writer composes with {{datum}} tokens — never a typed figure — or the deterministic data composer
//     when the model is unavailable / refuses / trips fair housing) → fair housing on the PUBLIC copy (scanPublicCopy,
//     surface "lead_magnet") → the C4 final phase (humanize-final: machine phrasing out, the tenant's brand voice; a word the
//     brand prohibits holds it) → the VALIDATOR (validator.ts — no generic text passes) → the approver (C5 approverFor,
//     assetKind "asset" — who may approve this report before anyone outside the tenant receives it) → a TENANT-BRANDED PDF
//     (lib/documents/client-document-producer.ts — brokerage colour/name, agent attribution, licence line, EHO mark) recorded in
//     the document library, under THE ACTION LEDGER (marketing.market_report.produce) → optional NARRATED video: a market_update
//     commissioned through THE video director (lib/video/video-director.ts commissionVideo, pending_review), which the
//     render-landed reaction stages through lib/video/video-staging.ts — this module never publishes a video.
//
// COST: the writer and the strategist are routed calls (generateObjectRouted → ai_tool_usage under the tenant); RentCast spend is
// metered inside its client. The ledger row carries the token counts and names both rails (LAW 5 "what it cost").
// NOT an appraisal: no figure here is a value opinion of any home (CLAUDE.md §5 — nothing model-authored reaches an appraiser).
//
// Not server-only (the proof drives it on the in-memory client with seams); the renderer, the brand, the ledger, the AI and the
// video director are lazy imports at their call. Never throws.

import { formatDatumValue, isoDay, renderDatumTokens, sourceLine, territoryKey, type MarketDatum, type MarketReport, type MarketReportFormat, type MarketReportNarrative, type MarketReportTerritory, type MarketReportTopic, type MarketReportValidation, type NarrativeSection } from "./contract"
import { chooseTerritoryGrain, researchMarket, resolveReportTerritory, MIN_RECORDS_FOR_MEDIAN, type ResearchDeps, type ResearchResult, type TerritoryHint } from "./research"
import { validateMarketReport, MIN_DATED_SOURCED_DATA } from "./validator"
import { buildMarketReportWriterPrompt, MARKET_REPORT_WRITER_SYSTEM, MarketReportNarrativeSchema, type MarketReportNarrativeDraft } from "./prompts"
import { suggestMarketReportTopics, type TopicDeps, type TopicSuggestionResult } from "./topics"

type Db = { from: (table: string) => any }

/** generated_documents.document_type of a produced report (no CHECK on the column — scripts/check-vocabularies.ts). */
const MARKET_REPORT_DOCUMENT_TYPE = "market_report" as const

const MARKET_REPORT_DISCLAIMER =
  "Market statistics come from the sources named beside each figure, as of the dates shown. Listing statistics describe asking prices and listing counts, not closed sales. Closed-sale figures come from MLS records synced to this brokerage and are a sample of the territory. This report is general market information — it is not an appraisal or an opinion of value for any specific property. Equal Housing Opportunity."

interface ProduceMarketReportInput {
  /** The CALLER-VERIFIED tenant (session / the tenant-owned magnet row) — never a request body (§4). */
  brokerageId: string
  /** users.id of the agent whose name the report carries (agents.id and users.id are DISJOINT — §3). */
  agentUserId?: string | null
  /** agents.id of the owning agent — the C5 approval scope. */
  agentId?: string | null
  actor: { type: "user" | "manager" | "system"; userId?: string | null; managerKey?: string | null }
  territory?: MarketReportTerritory | null
  territoryHint?: TerritoryHint | null
  topic?: MarketReportTopic | null
  format?: MarketReportFormat | null
  /** Commission a narrated market_update video (staged — never published here). */
  narrate?: boolean
  /** A report for ONE person (a per-recipient street report) — files the document to that contact. */
  contactId?: string | null
  reasonCode?: "HUMAN_REQUESTED" | "CONVERSATION_RESPONSE" | "SCHEDULED_CONTENT_PUBLISH"
  /** Where the report is for (ledger detail): "lead_magnet_deliverable", "on_request", … */
  purpose: string
}

interface PdfBrandLike { brokerageName: string; agentName?: string | null; agentPhone?: string | null; agentEmail?: string | null; licenseLine?: string | null; primaryColor?: string | null; showEhoMark?: boolean; tagline?: string | null }

export interface ProducerDeps extends ResearchDeps {
  now?: Date
  /** The routed writer (default generateObjectRouted, feature market_report). */
  write?: (a: { brokerageId: string; agentUserId: string | null; system: string; prompt: string }) => Promise<{ draft: MarketReportNarrativeDraft; tokens: number | null; model: string | null }>
  topics?: (svc: Db, a: { brokerageId: string; territory: MarketReportTerritory }, d?: TopicDeps) => Promise<TopicSuggestionResult>
  /** Fair housing on the composed public copy (default scanPublicCopy(text, "lead_magnet")). */
  fairHousing?: (text: string) => Promise<{ ok: boolean; findings: string[] }>
  /** The C4 final phase per text block (default lib/marketing/humanize-final.ts with the tenant's brand). */
  finalize?: (a: { brokerageId: string; agentUserId: string | null; texts: string[] }) => Promise<{ ok: true; texts: string[]; tagline: string | null } | { ok: false; reason: string }>
  brand?: (a: { brokerageId: string; agentUserId: string | null }) => Promise<PdfBrandLike>
  render?: (a: { brokerageId: string; agentUserId: string | null; contactId: string | null; spec: Record<string, unknown>; metadata: Record<string, unknown> }) => Promise<{ ok: boolean; pdfUrl: string | null; documentId: string | null; error: string | null }>
  approver?: (a: { brokerageId: string; agentId: string | null }) => Promise<{ ok: boolean; permittedUserIds: string[]; primaryUserIds: string[]; basis: string; reason: string }>
  commissionVideo?: (a: { brokerageId: string; agentUserId: string; title: string; script: string; discriminator: string; territory: MarketReportTerritory; documentId: string | null }) => Promise<{ ok: boolean; status: string; videoProjectId?: string | null; reason?: string | null }>
  /** The ledger's client (default: the same client the producer reads through). */
  ledgerClient?: Db
}

interface ProducedReportApprover { ok: boolean; permittedUserIds: string[]; primaryUserIds: string[]; basis: string; reason: string }

type ProduceMarketReportResult =
  | {
      ok: true
      report: MarketReport
      validation: MarketReportValidation
      assetUrl: string
      documentId: string | null
      approver: ProducedReportApprover
      video: { status: "not_requested" | "commissioned" | "skipped" | "failed"; videoProjectId: string | null; reason: string | null }
      topicSuggestions: TopicSuggestionResult | null
      notes: string[]
    }
  | { ok: false; stage: "territory" | "research" | "validation" | "compliance" | "render" | "ledger"; reason: string; validation?: MarketReportValidation; report?: MarketReport; notes: string[] }

// ── NARRATIVE ────────────────────────────────────────────────────────────────

const by = (data: MarketDatum[], key: MarketDatum["key"]) => data.find((d) => d.key === key) ?? null

/**
 * PURE — the deterministic DATA composer (authoredBy "data_template"): every sentence states a sourced figure for THIS territory.
 * It is what the report says when the model is unavailable, refuses, or trips fair housing — specific, never filler. Proven
 * through produceMarketReport (scripts/market-report-producer-guard.ts D).
 */
function composeDataNarrative(report: Pick<MarketReport, "territory" | "data" | "comparables" | "asOf">): MarketReportNarrative {
  const t = report.territory.label
  const d = report.data
  const v = (k: MarketDatum["key"]) => { const x = by(d, k); return x ? formatDatumValue(x) : null }
  const sections: NarrativeSection[] = []
  const price: string[] = []
  const priceKeys: MarketDatum["key"][] = []
  if (v("median_asking_price")) { price.push(`In ${t}, the median asking price of homes listed for sale was ${v("median_asking_price")} as of ${by(d, "median_asking_price")!.asOf}.`); priceKeys.push("median_asking_price") }
  if (v("asking_price_yoy_pct")) { price.push(`Compared with a year earlier, the median asking price changed ${v("asking_price_yoy_pct")}.`); priceKeys.push("asking_price_yoy_pct") }
  if (v("median_sold_price")) { price.push(`Among closed sales recorded in this brokerage's MLS records, the median sold price was ${v("median_sold_price")}.`); priceKeys.push("median_sold_price") }
  if (price.length) sections.push({ heading: `Prices in ${t}`, body: price.join(" "), datumKeys: priceKeys })
  const pace: string[] = []
  const paceKeys: MarketDatum["key"][] = []
  if (v("active_listings")) { pace.push(`There were ${v("active_listings")} active listings.`); paceKeys.push("active_listings") }
  if (v("new_listings_30d")) { pace.push(`${v("new_listings_30d")} new listings came to market in the latest 30-day reading.`); paceKeys.push("new_listings_30d") }
  if (v("avg_days_on_market")) { pace.push(`Listings spent an average of ${v("avg_days_on_market")} on the market.`); paceKeys.push("avg_days_on_market") }
  if (pace.length) sections.push({ heading: sections.length ? "Supply and pace" : `Supply and pace in ${t}`, body: pace.join(" "), datumKeys: paceKeys })
  const sold: string[] = []
  const soldKeys: MarketDatum["key"][] = []
  if (v("closed_sales_count")) { sold.push(`${v("closed_sales_count")} closed sales were recorded.`); soldKeys.push("closed_sales_count") }
  if (v("median_days_to_sell")) { sold.push(`The median home sold ${v("median_days_to_sell")} after it was listed.`); soldKeys.push("median_days_to_sell") }
  if (v("sale_to_list_ratio_pct")) { sold.push(`The median sale closed at ${v("sale_to_list_ratio_pct")} of its list price.`); soldKeys.push("sale_to_list_ratio_pct") }
  if (sold.length) sections.push({ heading: sections.length ? "What sold" : `What sold in ${t}`, body: sold.join(" "), datumKeys: soldKeys })
  const lead = by(d, "median_sold_price") ?? by(d, "median_asking_price") ?? d[0]
  const headline = lead ? `${t}: ${lead.label.toLowerCase()} ${formatDatumValue(lead)} as of ${lead.asOf}` : `${t}: market data`
  const dom = by(d, "avg_days_on_market") ?? by(d, "median_days_to_sell")
  const buyerTakeaways = [
    ...(dom ? [`Plan around the pace: homes here are spending about ${formatDatumValue(dom)} on the market.`] : []),
    ...(v("active_listings") ? [`${v("active_listings")} active listings is the choice set to compare against before you write an offer.`] : []),
  ]
  const sellerTakeaways = [
    ...(v("median_asking_price") ? [`Competing listings are asking around ${v("median_asking_price")} at the median — price against the homes buyers are comparing yours to.`] : []),
    ...(v("sale_to_list_ratio_pct") ? [`Recent sales closed at ${v("sale_to_list_ratio_pct")} of list price at the median.`] : []),
  ]
  return { headline, sections, buyerTakeaways, sellerTakeaways, callToAction: `Want this for your street? Ask for a street-level look at what sold near you in ${t}.`, authoredBy: "data_template" }
}

/** PURE — a writer draft → the narrative the reader sees (tokens substituted; a section's keys = the tokens it really used). */
function narrativeFromDraft(draft: MarketReportNarrativeDraft, report: Pick<MarketReport, "data" | "territory" | "asOf">): { narrative: MarketReportNarrative; unknownTokens: string[] } {
  const unknown: string[] = []
  const r = (s: string) => { const x = renderDatumTokens(s, report); unknown.push(...x.unknownTokens); return x }
  const sections = (draft.sections ?? []).map((s) => {
    const body = r(s.body)
    const heading = r(s.heading)
    return { heading: heading.text, body: body.text, datumKeys: body.used }
  })
  return {
    narrative: {
      headline: r(draft.headline).text,
      sections,
      buyerTakeaways: (draft.buyer_takeaways ?? []).map((s) => r(s).text),
      sellerTakeaways: (draft.seller_takeaways ?? []).map((s) => r(s).text),
      callToAction: r(draft.call_to_action ?? "").text,
      authoredBy: "ai",
    },
    unknownTokens: [...new Set(unknown)],
  }
}

function narrativeText(n: MarketReportNarrative): string {
  return [n.headline, ...n.sections.flatMap((s) => [s.heading, s.body]), ...n.buyerTakeaways, ...n.sellerTakeaways, n.callToAction].join("\n")
}

// ── THE PDF ──────────────────────────────────────────────────────────────────

/** PURE — the branded report document (lib/documents/client-pdf.ts ClientPdfSpec shape). Proven through the rendered spec. */
function marketReportPdfSpec(report: MarketReport, brand: PdfBrandLike): Record<string, unknown> {
  const n = report.narrative
  const sections: Array<Record<string, unknown>> = [
    { paragraphs: [n.headline] },
    {
      heading: "Market snapshot",
      table: { header: ["Measure", "Value", "Source and date"], rows: report.data.map((d) => [d.label, formatDatumValue(d), sourceLine(d)]) },
    },
    ...n.sections.map((s) => ({ heading: s.heading, paragraphs: [s.body] })),
  ]
  if (report.comparables.length) {
    sections.push({ heading: report.territory.grain === "street" ? "What sold near you" : "Recent sales", table: { header: ["Address", "Price", "Basis", "Date"], rows: report.comparables.map((c) => [c.address, `$${Math.round(c.price).toLocaleString("en-US")}`, c.priceBasis === "recorded_sale" ? "closed sale" : "last asking price", c.date]) } })
  }
  if (report.trend.length >= 2) {
    sections.push({ heading: "Monthly trend", table: { header: ["Month", "Median price", "Active inventory"], rows: report.trend.map((p) => [p.month, p.medianPrice != null ? `$${Math.round(p.medianPrice).toLocaleString("en-US")}` : "—", p.activeInventory != null ? String(p.activeInventory) : "—"]) } })
  }
  if (report.unavailable.length) sections.push({ heading: "Not available yet", bullets: report.unavailable.map((u) => `${u.label}: ${u.text}`) })
  if (n.buyerTakeaways.length) sections.push({ heading: "What this means for buyers", bullets: n.buyerTakeaways })
  if (n.sellerTakeaways.length) sections.push({ heading: "What this means for sellers", bullets: n.sellerTakeaways })
  sections.push({ heading: "Next step", paragraphs: [n.callToAction] })
  return {
    title: `${report.territory.label} Market Report`,
    subtitle: report.topic.title,
    preparedLine: `Prepared ${report.asOf}${brand.agentName ? ` by ${brand.agentName}` : ""} · ${brand.brokerageName}`,
    brand: { ...brand, showEhoMark: true },
    sections,
    disclaimer: MARKET_REPORT_DISCLAIMER,
  }
}

// ── DEFAULT SEAMS ────────────────────────────────────────────────────────────

const defaultWrite: NonNullable<ProducerDeps["write"]> = async (a) => {
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const r = await generateObjectRouted({
    feature: "market_report", brokerageId: a.brokerageId, userId: a.agentUserId ?? undefined, manager: "campaign_orchestrator",
    system: a.system, prompt: a.prompt, schema: MarketReportNarrativeSchema, maxTokens: 2200, temperature: 0.3,
    contextExtra: { purpose: "market_report_narrative" },
  })
  return { draft: r.object, tokens: r.usage.totalTokens, model: String(r.usage.model) }
}

const defaultFairHousing: NonNullable<ProducerDeps["fairHousing"]> = async (text) => {
  const { scanPublicCopy } = await import("@/lib/kernel/marketing/public-copy-rewrite")
  const scan = await scanPublicCopy(text, "lead_magnet")
  return { ok: scan.ok, findings: scan.findings.map((f) => `${f.phrase} — ${f.fix}`) }
}

const defaultFinalize = (svc: Db): NonNullable<ProducerDeps["finalize"]> => async (a) => {
  const { finalizeForDistribution, resolveTenantBrandForFinal } = await import("@/lib/marketing/humanize-final")
  const brand = await resolveTenantBrandForFinal(svc as never, { brokerageId: a.brokerageId, agentUserId: a.agentUserId })
  const out: string[] = []
  let tagline: string | null = null
  for (const text of a.texts) {
    const f = await finalizeForDistribution({ assetKind: "lead_magnet", text, tenantBrand: brand.brand })
    const hard = [...f.fairHousing, ...f.brandVoice.prohibited.map((w) => `prohibited by the brand voice: "${w}"`)]
    if (hard.length) return { ok: false, reason: hard.join("; ") }
    out.push(f.tagline.applied === "appended" && f.tagline.text ? f.text.replace(f.tagline.text, "").trim() : f.text)
    tagline = f.tagline.text ?? tagline
  }
  return { ok: true, texts: out, tagline }
}

const defaultBrand = (svc: Db): NonNullable<ProducerDeps["brand"]> => async (a) => {
  const { resolvePdfBrand } = await import("@/lib/documents/client-document-producer")
  return resolvePdfBrand(svc, { brokerageId: a.brokerageId, agentUserId: a.agentUserId })
}

const defaultRender = (svc: Db): NonNullable<ProducerDeps["render"]> => async (a) => {
  const { produceClientDocument } = await import("@/lib/documents/client-document-producer")
  return produceClientDocument(svc, { brokerageId: a.brokerageId, agentUserId: a.agentUserId, contactId: a.contactId, documentType: MARKET_REPORT_DOCUMENT_TYPE, spec: a.spec as never, metadata: a.metadata })
}

const defaultApprover = (svc: Db): NonNullable<ProducerDeps["approver"]> => async (a) => {
  const { approverFor } = await import("@/lib/kernel/approval-authority")
  const d = await approverFor({ brokerageId: a.brokerageId, assetKind: "asset", scope: { agentId: a.agentId }, client: svc })
  return d.ok ? { ok: true, permittedUserIds: d.permittedUserIds, primaryUserIds: d.primaryUserIds, basis: d.basis, reason: d.reason } : { ok: false, permittedUserIds: [], primaryUserIds: [], basis: "refused", reason: d.reason }
}

const defaultCommissionVideo = (svc: Db): NonNullable<ProducerDeps["commissionVideo"]> => async (a) => {
  const { commissionVideo } = await import("@/lib/video/video-director")
  const r = await commissionVideo(
    { kind: "market_update", tier: "solo_agent", targetChannel: "youtube", facts: { area: a.territory.label, zip: a.territory.zip ?? null } },
    { brokerageId: a.brokerageId, agentUserId: a.agentUserId, title: a.title, spokenScript: a.script, idempotencyDiscriminator: a.discriminator, meterFeature: "market_report_video", extraMetadata: { market_report_document_id: a.documentId, market_report_territory: a.territory.label } },
    svc as never,
  )
  return { ok: r.ok, status: r.status, videoProjectId: r.videoProjectId ?? null, reason: r.reason ?? null }
}

// ── PRODUCE ──────────────────────────────────────────────────────────────────

export async function produceMarketReport(svc: Db, input: ProduceMarketReportInput, deps: ProducerDeps = {}): Promise<ProduceMarketReportResult> {
  const notes: string[] = []
  try {
    const now = deps.now ?? new Date()
    const asOf = isoDay(now)
    if (!input.brokerageId) return { ok: false, stage: "territory", reason: "no tenant", notes }

    // 1 · TERRITORY — the caller's, else resolved (magnet settings → farm territory → brokerage address), at the right grain.
    let territory = input.territory ?? null
    if (!territory) {
      const resolved = await resolveReportTerritory(svc, { brokerageId: input.brokerageId, agentId: input.agentId ?? null, hint: input.territoryHint ?? null })
      if (resolved.error) return { ok: false, stage: "territory", reason: resolved.error, notes }
      if (!resolved.hint) return { ok: false, stage: "territory", reason: "no territory: set the report's ZIP / city on the magnet, or add a farm territory — a market report must be territory-specific", notes }
      let streetComps = 0
      if (resolved.hint.address && deps.streetComps) {
        streetComps = (await deps.streetComps({ brokerageId: input.brokerageId, agentUserId: input.agentUserId ?? null, address: resolved.hint.address, city: resolved.hint.city ?? null, state: resolved.hint.state ?? null, zip: resolved.hint.zip ?? null }).catch(() => [])).length
      }
      const chosen = chooseTerritoryGrain(resolved.hint, { streetComps })
      if (!chosen.territory) return { ok: false, stage: "territory", reason: chosen.reason, notes }
      territory = chosen.territory
      notes.push(`territory: ${territory.label} (${territory.grain}) — ${chosen.reason}; from ${resolved.basis}`)
    }

    // 2 · RESEARCH — a refused read FAILS CLOSED (a report built on a refused read could omit exactly what was denied).
    const research: ResearchResult = await researchMarket(svc, { brokerageId: input.brokerageId, agentUserId: input.agentUserId ?? null, territory }, deps)
    notes.push(...research.notes)
    if (research.errors.length) return { ok: false, stage: "research", reason: research.errors.join("; "), notes }

    // 3 · TOPIC — the caller's, else the evidence-backed suggestion (topics.ts).
    let topic = input.topic ?? null
    let format: MarketReportFormat = input.format ?? "territory_snapshot"
    let topicSuggestions: TopicSuggestionResult | null = null
    if (!topic) {
      topicSuggestions = await (deps.topics ?? suggestMarketReportTopics)(svc, { brokerageId: input.brokerageId, territory })
      const top = topicSuggestions.suggestions[0]
      topic = { title: top.title, angle: top.angle, evidenceIds: top.evidence.map((e) => e.id) }
      if (!input.format) format = top.format
      notes.push(...topicSuggestions.notes)
    }

    const base: Omit<MarketReport, "narrative"> = { version: 1, brokerageId: input.brokerageId, topic, format, territory, asOf, data: research.data, unavailable: research.unavailable, comparables: research.comparables, trend: research.trend }
    const template = composeDataNarrative(base)

    // 4 · NARRATIVE — the routed writer (tokens only), falling back to the data composer; the validator decides either way.
    let narrative = template
    let ai: { tokens: number | null; model: string | null } = { tokens: null, model: null }
    if (research.data.length >= MIN_DATED_SOURCED_DATA) {
      try {
        const brandName = (await (deps.brand ?? defaultBrand(svc))({ brokerageId: input.brokerageId, agentUserId: input.agentUserId ?? null }).catch(() => ({ brokerageName: "the brokerage" }))).brokerageName
        const written = await (deps.write ?? defaultWrite)({
          brokerageId: input.brokerageId, agentUserId: input.agentUserId ?? null, system: MARKET_REPORT_WRITER_SYSTEM,
          prompt: buildMarketReportWriterPrompt({ territory, asOf, topic, format, brandName, data: research.data, unavailable: research.unavailable, comparables: research.comparables }),
        })
        ai = { tokens: written.tokens, model: written.model }
        if (written.draft.insufficient_data) notes.push(`the writer escalated: ${written.draft.insufficient_reason ?? "insufficient data"} — the data composer wrote it`)
        else {
          const fromDraft = narrativeFromDraft(written.draft, base)
          if (fromDraft.unknownTokens.length) notes.push(`the writer named unavailable facts (${fromDraft.unknownTokens.join(", ")}) — rendered as "not available"`)
          const v = validateMarketReport({ ...base, narrative: fromDraft.narrative }, { now })
          if (v.ok) narrative = fromDraft.narrative
          else notes.push(`the writer's draft was refused by the validator (${v.refusals.slice(0, 3).join(" | ")}) — the data composer wrote it`)
        }
      } catch (e) {
        notes.push(`the writer was unavailable (${e instanceof Error ? e.message : String(e)}) — the data composer wrote it`)
      }
    }

    // 5 · FAIR HOUSING on the public copy (the prompt carried it; the scan still runs — CLAUDE.md §5).
    const fh = deps.fairHousing ?? defaultFairHousing
    let scan = await fh(narrativeText(narrative)).catch((e: unknown) => ({ ok: false, findings: [`fair-housing scan could not run: ${e instanceof Error ? e.message : String(e)}`] }))
    if (!scan.ok && narrative.authoredBy === "ai") {
      notes.push(`fair housing held the writer's draft (${scan.findings.join("; ")}) — the data composer wrote it`)
      narrative = template
      scan = await fh(narrativeText(narrative)).catch((e: unknown) => ({ ok: false, findings: [`fair-housing scan could not run: ${e instanceof Error ? e.message : String(e)}`] }))
    }
    if (!scan.ok) return { ok: false, stage: "compliance", reason: `fair housing: ${scan.findings.join("; ")}`, notes }

    // 6 · THE FINAL PHASE (humanize + the tenant's brand voice), per block, then re-validated (a rewrite must not move a figure).
    const blocks = [narrative.headline, ...narrative.sections.map((s) => s.body), ...narrative.buyerTakeaways, ...narrative.sellerTakeaways, narrative.callToAction]
    const fin = await (deps.finalize ?? defaultFinalize(svc))({ brokerageId: input.brokerageId, agentUserId: input.agentUserId ?? null, texts: blocks })
      .catch((e: unknown) => ({ ok: false as const, reason: `the final phase could not run: ${e instanceof Error ? e.message : String(e)}` }))
    if (!fin.ok) return { ok: false, stage: "compliance", reason: `held by the final phase — ${fin.reason}`, notes }
    let i = 0
    const take = () => fin.texts[i++] ?? ""
    narrative = {
      ...narrative,
      headline: take(),
      sections: narrative.sections.map((s) => ({ ...s, body: take() })),
      buyerTakeaways: narrative.buyerTakeaways.map(() => take()),
      sellerTakeaways: narrative.sellerTakeaways.map(() => take()),
      callToAction: take(),
    }

    // 7 · THE VALIDATOR — no generic text passes as a market report.
    const report: MarketReport = { ...base, narrative }
    const validation = validateMarketReport(report, { now })
    if (!validation.ok) return { ok: false, stage: "validation", reason: validation.refusals.join("; "), validation, report, notes }

    // 8 · WHO APPROVES IT (C5) — recorded with the report; the lead-magnet publish (or the requester's own approval) is the act.
    const approver = await (deps.approver ?? defaultApprover(svc))({ brokerageId: input.brokerageId, agentId: input.agentId ?? null })
      .catch((e: unknown) => ({ ok: false, permittedUserIds: [], primaryUserIds: [], basis: "refused", reason: e instanceof Error ? e.message : String(e) }))

    // 9 · THE BRANDED ASSET, under the action ledger (LAW 5).
    const brand = await (deps.brand ?? defaultBrand(svc))({ brokerageId: input.brokerageId, agentUserId: input.agentUserId ?? null })
    if (fin.tagline) brand.tagline = fin.tagline
    const spec = marketReportPdfSpec(report, brand)
    const compact = { version: 1, territory, topic, format, as_of: asOf, data: report.data, unavailable: report.unavailable, comparables: report.comparables, trend: report.trend, validation: validation.counts, narrative_authored_by: narrative.authoredBy }
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const rendered = await withActionLedger<{ ok: true; pdfUrl: string; documentId: string | null } | { ok: false; error: string }>(
      {
        brokerageId: input.brokerageId,
        action: "marketing.market_report.produce",
        actor: { type: input.actor.type, userId: input.actor.userId ?? null, managerKey: input.actor.managerKey ?? null },
        subject: { type: "market_report", ref: territoryKey(territory) },
        reasonCode: input.reasonCode ?? "HUMAN_REQUESTED",
        reasonDetail: `market report for ${territory.label} (${topic.title}) — ${input.purpose}`,
        riskClass: "LOW_RISK_WRITE",
        systemSource: "market_report_producer",
        detail: {
          purpose: input.purpose, territory: territory.label, grain: territory.grain, topic: topic.title, evidence_ids: topic.evidenceIds,
          data: report.data.length, unavailable: report.unavailable.length, comparables: report.comparables.length, narrative_authored_by: narrative.authoredBy,
          cost_rails: { ai_tool_usage: { feature: "market_report", tokens: ai.tokens, model: ai.model }, vendor_meter: research.refreshed.attempted ? "rentcast meterCall (lib/property/rentcast.ts) via refreshMarketData" : "none (stored market data)" },
          approver: { basis: approver.basis, primary: approver.primaryUserIds, permitted: approver.permittedUserIds.length },
        },
      },
      async () => {
        const r = await (deps.render ?? defaultRender(svc))({ brokerageId: input.brokerageId, agentUserId: input.agentUserId ?? null, contactId: input.contactId ?? null, spec, metadata: { source: "market_report_producer", purpose: input.purpose, market_report: compact } })
        if (!r.ok || !r.pdfUrl || !/^https:\/\//.test(r.pdfUrl)) return { ok: false as const, error: r.error ?? "the report PDF was not hosted" }
        return { ok: true as const, pdfUrl: r.pdfUrl, documentId: r.documentId }
      },
      {
        settle: (r) => r.ok ? { status: "executed", outcome: "produced", providerRef: r.documentId ?? r.pdfUrl, costUsd: null } : { status: "failed", outcome: "render_refused", error: r.error },
        replay: (claim) => ({ ok: false as const, error: `ledger refused the report: ${claim.kind}${claim.kind === "refused" ? ` (${claim.error})` : ""}` }),
      },
      { client: (deps.ledgerClient ?? svc) as never },
    )
    if (!rendered.ok) return { ok: false, stage: /ledger refused/.test(rendered.error) ? "ledger" : "render", reason: rendered.error, validation, report, notes }

    // 10 · NARRATED VERSION (optional) — commissioned through the director, staged on render by video-staging; never published here.
    let video: Extract<ProduceMarketReportResult, { ok: true }>["video"] = { status: "not_requested", videoProjectId: null, reason: null }
    if (input.narrate) {
      if (!input.agentUserId) video = { status: "skipped", videoProjectId: null, reason: "a narrated report needs the agent who presents it" }
      else {
        const script = [narrative.headline, ...narrative.sections.map((s) => s.body), narrative.callToAction].join(" ")
        const c = await (deps.commissionVideo ?? defaultCommissionVideo(svc))({ brokerageId: input.brokerageId, agentUserId: input.agentUserId, title: `${territory.label} market update`, script, discriminator: `${territoryKey(territory)}:${asOf}`, territory, documentId: rendered.documentId })
          .catch((e: unknown) => ({ ok: false, status: "failed", videoProjectId: null, reason: e instanceof Error ? e.message : String(e) }))
        video = c.ok ? { status: "commissioned", videoProjectId: c.videoProjectId ?? null, reason: "staged for approval — lib/video/video-staging.ts stages it when the render lands" } : { status: "failed", videoProjectId: null, reason: c.reason ?? c.status }
      }
    }

    if (report.comparables.length < MIN_RECORDS_FOR_MEDIAN) notes.push(`${report.comparables.length} comparable(s) — said in the report`)
    return { ok: true, report, validation, assetUrl: rendered.pdfUrl, documentId: rendered.documentId, approver, video, topicSuggestions, notes }
  } catch (e) {
    return { ok: false, stage: "render", reason: `produceMarketReport threw: ${e instanceof Error ? e.message : String(e)}`, notes }
  }
}
