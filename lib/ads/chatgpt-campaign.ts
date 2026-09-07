/**
 * lib/ads/chatgpt-campaign.ts
 *
 * THE CHATGPT ADS LANE — built out fully to the edge of what exists (owner,
 * 2026-09-06/07: "ads are now available with chatgpt … ads for chatgpt and tv
 * capability needs built out fully … each capability should be used
 * autonomously as much as you can").
 *
 * Two halves, both real (2026-09-07 — the owner linked
 * developers.openai.com/ads/api-quickstart: the OpenAI ADVERTISER API exists;
 * the earlier "no public API, partner-only" reading is retired):
 *
 *   AUTONOMOUS (the OS does it): compose the campaign to the Ads Manager's own
 *   structure and limits, Fair-Housing-scan the copy BEFORE it is written down,
 *   stage the ad_campaigns row (platform 'chatgpt', status 'draft') + the
 *   creative in the ONE ad-creative approval queue, resolve the destination
 *   (the listing's own landing page) with UTMs so the click is attributed, and
 *   — once the copy is approved and the brokerage's Ads API key is connected
 *   (provider 'openai_ads') — LAUNCH through the API: launchChatgptCampaignOnOpenai
 *   below delegates to lib/providers/openai-ads.ts dispatchChatgptCampaign
 *   (account → geo lookup → upload → campaign → ad group → ad → activate) and
 *   the Ads Manager's sweep proposes it (lib/ads/ad-manager.ts). Insights come
 *   back through the chatgpt connector into ad_performance.
 *
 *   FALLBACK (no key connected): the same package as a bulk-upload CSV + a
 *   checklist; a human uploads at ads.openai.com, "Marks as launched" with the
 *   campaign id, and imports the report CSV here so the Ads Manager still judges
 *   the campaign on REAL cost-per-lead.
 *
 * Ads Manager structure (searchengineland.com/run-chatgpt-ads-484513,
 * webfx.com/blog/ai/chatgpt-ads-manager): Campaign (objective Reach / Clicks /
 * Conversions; locations country/region/DMA/postal; budget daily or total;
 * $25/day minimum) → Ad group (bid; CPC $2–5 typical, recommended max $3–5, or
 * CPM default max $60; CONTEXT HINTS, not keywords) → Ad (destination URL,
 * headline ≤50 chars aim 16, description ≤100 aim 32, SQUARE PNG/JPG ≥256×256,
 * advertiser name + favicon). Relevance-weighted second-price auction; ads show
 * to 18+ Free/Go users; restricted categories include financial services (so
 * lender/mortgage copy is refused here, not merely warned).
 *
 * Skills consulted for the copy rules (named per the owner's instruction):
 * ads-copy (headline ≤ hard limit, benefit-led, one CTA), ads-audience (geo +
 * intent context, never a protected class), ads-funnel (a listing click lands
 * on the listing page with UTMs; the lead form is the conversion event).
 */
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchChatgptCampaign, type ChatgptDispatchResult } from "@/lib/providers/openai-ads"
import { evaluateContentSafety, type SafetyViolation } from "@/lib/compliance/content-safety-checks"
import { deriveMetrics, type ProviderPerformanceRow } from "./connectors/types"
import { buildListingCreative, type ListingAdKind, type ListingFacts } from "./listing-ad-producer"
// The URL, the $25/day floor and the objective list live in the client-safe
// vocabulary so the "use client" lane never reaches this server module.
import { CHATGPT_ADS_MANAGER_URL, CHATGPT_MIN_DAILY_BUDGET_USD, type ChatgptObjective } from "@/lib/integrations/ad-campaign-vocabulary"
export type { ChatgptObjective }

// ─── the Ads Manager's own limits (one vocabulary for the whole lane) ────────
const CHATGPT_HEADLINE_MAX = 50
const CHATGPT_HEADLINE_AIM = 16
const CHATGPT_DESCRIPTION_MAX = 100
const CHATGPT_DESCRIPTION_AIM = 32
const CHATGPT_IMAGE_MIN_PX = 256
const CHATGPT_RECOMMENDED_MAX_CPC_USD = 4     // inside the documented $3–5 band

/** Restricted-category words that make a ChatGPT ad ineligible outright
 *  (financial services). The lane never writes them; a caller-supplied hint
 *  that carries one is refused, not warned. */
const RESTRICTED_FINANCIAL = /\b(mortgage|loan|lender|refinanc\w*|financing|apr|interest rate|pre-?approv\w*)\b/i

// ─── pure composition ────────────────────────────────────────────────────────

interface ChatgptAdCopy {
  headline: string
  description: string
  /** Ad-group CONTEXT HINTS — the conversations the ad belongs in. Intent only. */
  contextHints: string[]
  /** Fair-Housing / guarantee / PII findings on the composed copy. */
  violations: SafetyViolation[]
  /** Soft notes (over the "aim" length, image unverifiable, …). */
  warnings: string[]
}

function clip(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ")
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const at = cut.lastIndexOf(" ")
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trim()}…`
}

/**
 * Pure: compose ChatGPT ad copy for a listing moment from the SAME
 * Fair-Housing-clean creative builder the Meta/Google lane uses
 * (lib/ads/listing-ad-producer.ts buildListingCreative — one vocabulary), then
 * clip to the Ads Manager's limits and scan. Copy names the home and the market
 * only — never who "should" live there.
 */
function buildChatgptAdCopy(facts: ListingFacts, kind: ListingAdKind): ChatgptAdCopy {
  const base = buildListingCreative(facts, kind)
  const city = facts.city?.trim() || null
  const state = facts.state?.trim() || null
  const where = city ? `${city}${state ? `, ${state}` : ""}` : "your area"
  const specs = [facts.bedrooms ? `${facts.bedrooms} bed` : null, facts.bathrooms ? `${facts.bathrooms} bath` : null].filter(Boolean).join(", ")
  const headline = clip(kind === "just_listed" && city ? `Just listed in ${city}` : base.headline, CHATGPT_HEADLINE_MAX)
  const description = clip(base.primaryText, CHATGPT_DESCRIPTION_MAX)
  const contextHints = [
    `homes for sale in ${where}`,
    kind === "just_sold" ? `what is my home worth in ${where}` : `moving to ${where}`,
    specs ? `${specs} home ${where}` : `real estate agent ${where}`,
    facts.property_type ? `${String(facts.property_type).replace(/_/g, " ")} for sale ${where}` : `open houses ${where}`,
  ].map((h) => h.replace(/\s+/g, " ").trim())
  const warnings: string[] = []
  if (headline.length > CHATGPT_HEADLINE_AIM) warnings.push(`Headline is ${headline.length} chars; the Ads Manager recommends ~${CHATGPT_HEADLINE_AIM} (max ${CHATGPT_HEADLINE_MAX}).`)
  if (description.length > CHATGPT_DESCRIPTION_AIM) warnings.push(`Description is ${description.length} chars; the Ads Manager recommends ~${CHATGPT_DESCRIPTION_AIM} (max ${CHATGPT_DESCRIPTION_MAX}).`)
  const violations = evaluateContentSafety(`${headline}\n${description}\n${contextHints.join("\n")}`)
  return { headline, description, contextHints, violations, warnings }
}

/** Pure: the destination with the attribution the lead intake reads back. */
function withChatgptUtms(destinationUrl: string, campaignId: string): string {
  const u = new URL(destinationUrl)
  u.searchParams.set("utm_source", "chatgpt")
  u.searchParams.set("utm_medium", "paid_ai")
  u.searchParams.set("utm_campaign", campaignId)
  return u.toString()
}

/** Pure: one row of the Ads Manager bulk-upload template (its campaign schema),
 *  quoted for CSV. Columns follow the documented Campaign → Ad group → Ad shape. */
function buildChatgptBulkUploadCsv(row: {
  campaignName: string; objective: ChatgptObjective; dailyBudgetUsd: number
  locations: string[]; adGroupName: string; maxCpcUsd: number; contextHints: string[]
  headline: string; description: string; destinationUrl: string; imageUrl: string | null; advertiserName: string
}): string {
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
  const header = ["campaign_name", "objective", "budget_type", "daily_budget_usd", "locations", "ad_group_name", "bid_model", "max_bid_usd", "context_hints", "headline", "description", "destination_url", "image_url", "advertiser_name"]
  const values = [row.campaignName, row.objective, "daily", row.dailyBudgetUsd.toFixed(2), row.locations.join("; "), row.adGroupName, "cpc", row.maxCpcUsd.toFixed(2), row.contextHints.join("; "), row.headline, row.description, row.destinationUrl, row.imageUrl ?? "", row.advertiserName]
  return `${header.join(",")}\n${values.map(q).join(",")}\n`
}

// ─── performance import (the read-back half, by CSV export) ──────────────────

/**
 * Pure: parse an OpenAI Ads Manager report export (CSV) into ONE provider
 * performance row — sums every data row, so a per-day export and a per-campaign
 * export both work. Header matching is tolerant of the Ads Manager's labels
 * ("Impressions", "Clicks", "Spend"/"Cost", "Conversions", "Conversion value").
 * Returns null when no recognisable metric column exists (never a zero row that
 * would read as "ran and earned nothing").
 */
function parseChatgptPerformanceCsv(csv: string): ProviderPerformanceRow | null {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return null
  const split = (line: string): string[] => {
    const out: string[] = []; let cur = ""; let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++ } else inQ = !inQ }
      else if (ch === "," && !inQ) { out.push(cur); cur = "" }
      else cur += ch
    }
    out.push(cur)
    return out.map((s) => s.trim())
  }
  const headers = split(lines[0]).map((h) => h.toLowerCase())
  const col = (...names: string[]) => headers.findIndex((h) => names.some((n) => h === n || h.startsWith(n)))
  const iImp = col("impressions"), iClk = col("clicks"), iSpend = col("spend", "cost", "amount spent")
  const iConv = col("conversions", "results"), iLeads = col("leads", "lead form"), iRev = col("conversion value", "revenue", "purchase value")
  if (iImp < 0 && iClk < 0 && iSpend < 0) return null
  const num = (cells: string[], i: number) => { if (i < 0) return 0; const v = Number(String(cells[i] ?? "").replace(/[$,%\s]/g, "")); return Number.isFinite(v) ? v : 0 }
  let impressions = 0, clicks = 0, spend = 0, conversions = 0, leads = 0, revenue = 0
  for (const line of lines.slice(1)) {
    const cells = split(line)
    if (/^total/i.test(cells[0] ?? "")) continue // an export's Total row would double-count
    impressions += num(cells, iImp); clicks += num(cells, iClk); spend += num(cells, iSpend)
    conversions += num(cells, iConv); leads += num(cells, iLeads); revenue += num(cells, iRev)
  }
  // With no separate leads column, a Clicks/Conversions campaign's conversion
  // event IS the lead form (ads-funnel) — count conversions as leads.
  if (iLeads < 0) leads = conversions
  spend = Math.round(spend * 100) / 100
  return { spend, impressions, clicks, leads, conversions, revenue: Math.round(revenue * 100) / 100, ...deriveMetrics({ spend, impressions, clicks, leads }) }
}

// ─── staging ─────────────────────────────────────────────────────────────────

export interface StageChatgptCampaignInput {
  brokerageId: string
  agentUserId: string
  listingId: string
  kind?: ListingAdKind
  objective?: ChatgptObjective
  dailyBudgetUsd?: number
  campaignName?: string
  /** Extra context hints from the agent (scanned; a restricted-category word refuses). */
  extraContextHints?: string[]
  client?: ReturnType<typeof createServiceClient>
}

export interface ChatgptLaunchPackage {
  campaignId: string
  creativeId: string
  adsManagerUrl: string
  campaignName: string
  objective: ChatgptObjective
  dailyBudgetUsd: number
  maxCpcUsd: number
  locations: string[]
  headline: string
  description: string
  contextHints: string[]
  destinationUrl: string
  imageUrl: string | null
  bulkUploadCsv: string
  checklist: string[]
  warnings: string[]
}

export interface StageChatgptCampaignResult { success: boolean; error?: string; package?: ChatgptLaunchPackage; alreadyStaged?: boolean }

/**
 * Stage a ChatGPT Ads campaign for a listing moment. Idempotent per
 * (listing, kind). Refuses on a HARD Fair-Housing flag or a restricted-category
 * hint — compliance-first, in the writing, not a post-hoc scan (§5).
 */
export async function stageChatgptCampaign(input: StageChatgptCampaignInput): Promise<StageChatgptCampaignResult> {
  const svc = input.client ?? createServiceClient()
  const kind: ListingAdKind = input.kind ?? "just_listed"
  const objective: ChatgptObjective = input.objective ?? "clicks"
  if (!input.brokerageId || !input.agentUserId || !input.listingId) return { success: false, error: "brokerageId, agentUserId and listingId required" }
  const dailyBudgetUsd = Math.max(CHATGPT_MIN_DAILY_BUDGET_USD, Math.round(Number(input.dailyBudgetUsd ?? CHATGPT_MIN_DAILY_BUDGET_USD)))

  const { data: existing, error: existingError } = await svc.from("ad_campaigns").select("id")
    .eq("brokerage_id", input.brokerageId).eq("platform", "chatgpt")
    .contains("targeting_config", { listing_id: input.listingId, auto_kind: kind }).limit(1).maybeSingle()
  if (existingError) return { success: false, error: `ad_campaigns read refused: ${existingError.message}` }
  if (existing) return { success: false, alreadyStaged: true, error: "A ChatGPT campaign is already staged for this listing and moment" }

  const { data: l, error: lError } = await svc.from("listings")
    .select("address, city, state, zip, list_price, bedrooms, bathrooms, property_type, primary_photo_url, photos, agent_id")
    .eq("id", input.listingId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (lError) return { success: false, error: `listing read refused: ${lError.message}` }
  const listing = l as (ListingFacts & { zip: string | null; primary_photo_url: string | null; photos: unknown; agent_id: string | null }) | null
  if (!listing) return { success: false, error: "Listing not found in this brokerage" }

  const copy = buildChatgptAdCopy(listing, kind)
  const hints = [...copy.contextHints, ...(input.extraContextHints ?? []).map((h) => h.trim()).filter(Boolean)].slice(0, 8)
  const restricted = hints.find((h) => RESTRICTED_FINANCIAL.test(h))
  if (restricted) return { success: false, error: `Context hint "${restricted}" names a restricted category (financial services) — ChatGPT Ads will not run it, and a lender is a vendor, not this ad's subject` }
  const hard = [...copy.violations, ...evaluateContentSafety(hints.join("\n"))].filter((v) => v.severity === "high")
  if (hard.length) return { success: false, error: `Copy refused before it was written down: ${hard.map((v) => `${v.category}: "${v.phrase}"`).join("; ")}` }

  // Destination: the listing's own landing page (fail-closed to null → refuse;
  // never paid traffic to a 404). One resolver: lib/ads/ad-destination.ts.
  let teamId: string | null = null
  if (listing.agent_id) {
    const { data: agentRow } = await svc.from("agents").select("team_id").eq("id", listing.agent_id).maybeSingle()
    teamId = (agentRow as { team_id: string | null } | null)?.team_id ?? null
  }
  const { resolveAdDestination } = await import("./ad-destination")
  const destination = await resolveAdDestination(svc, { brokerageId: input.brokerageId, listingId: input.listingId, teamId })
  if (!destination) return { success: false, error: "No destination: publish the listing's landing page (or set the brokerage website) before staging a ChatGPT ad" }

  // Image: the listing's primary photo, else its first photo. Square ≥256px is
  // the Ads Manager's rule; dimensions are not recorded here, so it is a
  // warning to verify at upload, never a silent pass.
  const photos = Array.isArray(listing.photos) ? (listing.photos as unknown[]).map((p) => typeof p === "string" ? p : (p as { url?: string })?.url).filter((u): u is string => !!u) : []
  const imageUrl = listing.primary_photo_url ?? photos[0] ?? null
  const warnings = [...copy.warnings]
  if (!imageUrl) warnings.push("No listing photo on file — the Ads Manager requires a square PNG/JPG ≥256×256; add one before upload.")
  else warnings.push(`Verify the image is square and ≥${CHATGPT_IMAGE_MIN_PX}×${CHATGPT_IMAGE_MIN_PX} at upload (dimensions are not recorded here).`)

  const locations = [listing.zip ? `${listing.zip} (postal)` : null, listing.city ? `${listing.city}${listing.state ? `, ${listing.state}` : ""}` : null].filter((x): x is string => !!x)
  if (locations.length === 0) {
    const { data: b } = await svc.from("brokerages").select("city, state").eq("id", input.brokerageId).maybeSingle()
    const br = b as { city: string | null; state: string | null } | null
    if (br?.city) locations.push(`${br.city}${br.state ? `, ${br.state}` : ""}`)
  }
  if (locations.length === 0) return { success: false, error: "No geography: the listing has no ZIP/city and the brokerage has no city" }

  const { data: b2 } = await svc.from("brokerages").select("name").eq("id", input.brokerageId).maybeSingle()
  const advertiserName = (b2 as { name: string | null } | null)?.name ?? "Brokerage"
  const kindLabel = kind === "just_sold" ? "Just Sold" : kind === "price_reduction" ? "New Price" : "Just Listed"
  const campaignName = input.campaignName?.trim() || `ChatGPT — ${kindLabel} — ${listing.address ?? listing.city ?? "Listing"}`

  const { data: campaign, error: cErr } = await svc.from("ad_campaigns").insert({
    brokerage_id: input.brokerageId, agent_user_id: input.agentUserId, created_by: input.agentUserId,
    campaign_name: campaignName, platform: "chatgpt", objective: objective === "reach" ? "awareness" : objective === "conversions" ? "leads" : "traffic",
    status: "draft", daily_budget: dailyBudgetUsd, visibility_scope: "agent",
    targeting_config: {
      play: "chatgpt", listing_id: input.listingId, auto_kind: kind,
      chatgpt_objective: objective, locations, context_hints: hints,
      bid: { model: "cpc", max_bid_usd: CHATGPT_RECOMMENDED_MAX_CPC_USD },
      advertiser_name: advertiserName,
    },
  }).select("id").single()
  if (cErr || !campaign) return { success: false, error: `Failed to stage campaign: ${cErr?.message ?? "no row returned"}` }
  const campaignId = (campaign as { id: string }).id
  const destinationUrl = withChatgptUtms(destination, campaignId)

  // The creative rides the ONE ad-creative approval queue (approval_status
  // 'draft' → a human approves the words before they are uploaded anywhere).
  const { data: cr, error: crErr } = await svc.from("ad_creative_variations").insert({
    brokerage_id: input.brokerageId, ad_campaign_id: campaignId, variation_name: `ChatGPT ${kindLabel} — auto`,
    headline: copy.headline, primary_text: copy.description, description: hints.join(" · "), call_to_action: "LEARN_MORE",
    media_asset_url: imageUrl, destination_url: destinationUrl, generated_from: "chatgpt_lane", approval_status: "draft",
  }).select("id").single()
  if (crErr || !cr) return { success: false, error: `Campaign staged (${campaignId}) but the creative failed: ${crErr?.message ?? "no row returned"}` }

  // Record the UTM'd destination on the campaign too, so the lead intake and
  // the package agree on one URL.
  const { error: destErr } = await svc.from("ad_campaigns").update({ targeting_config: { play: "chatgpt", listing_id: input.listingId, auto_kind: kind, chatgpt_objective: objective, locations, context_hints: hints, bid: { model: "cpc", max_bid_usd: CHATGPT_RECOMMENDED_MAX_CPC_USD }, advertiser_name: advertiserName, destination_url: destinationUrl } }).eq("id", campaignId).eq("brokerage_id", input.brokerageId)
  if (destErr) console.error("[chatgpt-campaign] destination_url record refused:", destErr.message)

  const bulkUploadCsv = buildChatgptBulkUploadCsv({
    campaignName, objective, dailyBudgetUsd, locations, adGroupName: `${kindLabel} — ${locations[0]}`,
    maxCpcUsd: CHATGPT_RECOMMENDED_MAX_CPC_USD, contextHints: hints, headline: copy.headline, description: copy.description,
    destinationUrl, imageUrl, advertiserName,
  })
  const checklist = [
    `Approve the creative in the ad approval queue (it is a draft until a human approves the words).`,
    `Sign in at ${CHATGPT_ADS_MANAGER_URL} with the brokerage's own account — an agency may not create the account for you.`,
    `Create a Standard campaign, objective ${objective}, locations ${locations.join(" / ")}, daily budget $${dailyBudgetUsd} (the $${CHATGPT_MIN_DAILY_BUDGET_USD} minimum applies).`,
    `Ad group: CPC with max bid $${CHATGPT_RECOMMENDED_MAX_CPC_USD}; context hints: ${hints.join("; ")}.`,
    `Ad: headline "${copy.headline}", description "${copy.description}", destination ${destinationUrl}, square image${imageUrl ? ` ${imageUrl}` : ""}, advertiser name "${advertiserName}".`,
    `Or bulk-upload the CSV from this package (the campaign schema template columns).`,
    `Install the ChatGPT Ads pixel on the landing page (or the Conversions API) so the lead form counts as the conversion event.`,
    `Launch, then press "Mark as launched" here with the Ads Manager campaign id; export the report CSV weekly and import it in this lane so the Ads Manager can judge cost-per-lead.`,
  ]
  return {
    success: true,
    package: {
      campaignId, creativeId: (cr as { id: string }).id, adsManagerUrl: CHATGPT_ADS_MANAGER_URL, campaignName, objective, dailyBudgetUsd,
      maxCpcUsd: CHATGPT_RECOMMENDED_MAX_CPC_USD, locations, headline: copy.headline, description: copy.description, contextHints: hints,
      destinationUrl, imageUrl, bulkUploadCsv, checklist, warnings,
    },
  }
}

/** Human confirmation that the campaign is live at ads.openai.com. draft → live,
 *  recording the Ads Manager campaign id as `external_campaign_id` (the one key
 *  every ingest reads). An UPDATE matching nothing resolves (§3): counted. */
export async function markChatgptCampaignLaunched(input: {
  brokerageId: string; campaignId: string; actorUserId: string; externalCampaignId?: string | null
  client?: ReturnType<typeof createServiceClient>
}): Promise<{ success: boolean; error?: string }> {
  const svc = input.client ?? createServiceClient()
  const { data: c, error } = await svc.from("ad_campaigns").select("id, platform, status, targeting_config, campaign_name")
    .eq("id", input.campaignId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!c) return { success: false, error: "Campaign not found" }
  if (c.platform !== "chatgpt") return { success: false, error: "Not a ChatGPT campaign" }
  if (c.status !== "draft") return { success: false, error: `Campaign status is '${c.status}', only drafts can be marked launched` }
  const nowIso = new Date().toISOString()
  const { data: flipped, error: uErr } = await svc.from("ad_campaigns").update({
    status: "live", updated_at: nowIso,
    targeting_config: { ...((c.targeting_config as Record<string, unknown>) ?? {}), launched_via: "human_confirmation_chatgpt_ads_manager", launched_at: nowIso, external_campaign_id: input.externalCampaignId?.trim() || null },
  }).eq("id", input.campaignId).eq("brokerage_id", input.brokerageId).select("id")
  if (uErr) return { success: false, error: uErr.message }
  if (!flipped?.length) return { success: false, error: "No row was updated" }
  const { error: eErr } = await svc.from("lifecycle_events").insert({
    brokerage_id: input.brokerageId, entity_type: "ad_campaign", entity_id: input.campaignId, event_type: "ad_campaign_launched",
    actor_user_id: input.actorUserId, metadata: { platform: "chatgpt", campaign_name: c.campaign_name, launched_via: "human_confirmation_chatgpt_ads_manager", external_campaign_id: input.externalCampaignId ?? null },
  })
  if (eErr) return { success: true, error: `Launched, but lifecycle event failed to record: ${eErr.message}` }
  return { success: true }
}

/** Import an Ads Manager report export for a campaign: one ad_performance
 *  snapshot + one ad_performance_history point (the series the fatigue monitor
 *  and the outcome loop read). */
export async function importChatgptPerformance(input: {
  brokerageId: string; campaignId: string; csv: string; client?: ReturnType<typeof createServiceClient>
}): Promise<{ success: boolean; error?: string; row?: ProviderPerformanceRow }> {
  const svc = input.client ?? createServiceClient()
  const { data: c, error } = await svc.from("ad_campaigns").select("id, platform").eq("id", input.campaignId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!c) return { success: false, error: "Campaign not found" }
  if (c.platform !== "chatgpt") return { success: false, error: "Not a ChatGPT campaign" }
  const row = parseChatgptPerformanceCsv(input.csv)
  if (!row) return { success: false, error: "No Impressions / Clicks / Spend column found — export the campaign report from the Ads Manager as CSV" }
  const { toAdPerformanceRow } = await import("./ad-performance-ingest")
  const { error: pErr } = await svc.from("ad_performance").insert(toAdPerformanceRow(input.brokerageId, input.campaignId, row))
  if (pErr) return { success: false, error: `ad_performance insert refused: ${pErr.message}` }
  const { recordAdPerformanceSnapshot } = await import("./creative-fatigue-runner")
  await recordAdPerformanceSnapshot({ brokerageId: input.brokerageId, adCampaignId: input.campaignId, ctr: row.ctr, impressions: row.impressions, clicks: row.clicks, leads: row.leads, costPerLead: row.costPerLead }, svc)
  return { success: true, row }
}

// ─── LAUNCH ON OPENAI ADS — the one place a chatgpt row leaves draft by API ──
//
// dispatch (lib/providers/openai-ads.ts) + flip the row + ledger the launch. The
// server action app/actions/chatgpt-ads.ts::dispatchChatgptCampaignAction and
// the Ads Manager executor (lib/ads/ad-manager.ts launch_ad_campaign, platform
// chatgpt) both call THIS; neither re-spells the flip. No fake live state: the
// row moves only once the campaign is ACTIVE on OpenAI Ads.

export interface LaunchChatgptInput {
  campaignId: string
  brokerageId: string
  /** The human whose approval launched it (null when the Ads Manager ran an
   *  approved action — the approver is on ad_manager_actions). */
  actorUserId: string | null
  launchedVia: "openai_ads_api" | "ads_manager"
  client?: ReturnType<typeof createServiceClient>
}

export async function launchChatgptCampaignOnOpenai(input: LaunchChatgptInput): Promise<ChatgptDispatchResult> {
  const svc = input.client ?? createServiceClient()
  const { data: campaign, error } = await svc
    .from("ad_campaigns").select("id, targeting_config, status")
    .eq("id", input.campaignId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { dispatched: false, reason: `campaign read refused: ${error.message}` }
  if (!campaign) return { dispatched: false, reason: "Campaign not found in this brokerage" }
  if (["live", "launching"].includes(String(campaign.status))) {
    return { dispatched: false, reason: `campaign is already ${campaign.status}` }
  }

  const result = await dispatchChatgptCampaign(input.campaignId)
  if (!(result.dispatched && result.openaiCampaignId)) return result

  const nowIso = new Date().toISOString()
  // `external_campaign_id` is the ONE key every platform's ingest reads
  // (lib/ads/ad-performance-ingest.ts); the openai_* ids are the provider's own.
  const { data: flipped, error: flipError } = await svc
    .from("ad_campaigns")
    .update({
      status: "live",
      updated_at: nowIso,
      targeting_config: {
        ...((campaign.targeting_config as Record<string, unknown>) ?? {}),
        launched_via: input.launchedVia,
        launched_at: nowIso,
        external_campaign_id: result.openaiCampaignId,
        openai_campaign_id: result.openaiCampaignId,
        openai_ad_group_id: result.openaiAdGroupId ?? null,
        openai_ad_id: result.openaiAdId ?? null,
        openai_review_status: result.reviewStatus ?? null,
        openai_location_ids: result.locationIds ?? [],
      },
    })
    .eq("id", input.campaignId).eq("brokerage_id", input.brokerageId)
    .select("id")
  // An UPDATE matching nothing also resolves (§3): count what came back.
  if (flipError || !flipped?.length) {
    return { ...result, reason: `Active on OpenAI Ads (${result.openaiCampaignId}) but the row did NOT flip to live: ${flipError?.message ?? "no row matched"} — mark it launched by hand` }
  }
  const { error: eventError } = await svc.from("lifecycle_events").insert({
    brokerage_id: input.brokerageId,
    entity_type: "ad_campaign",
    entity_id: input.campaignId,
    event_type: "ad_campaign_launched",
    actor_user_id: input.actorUserId,
    metadata: { platform: "chatgpt", launched_via: input.launchedVia, openai_campaign_id: result.openaiCampaignId, review_status: result.reviewStatus ?? null },
  })
  if (eventError) console.error("[chatgpt-campaign] launch ledger refused:", eventError.message)
  return result
}
