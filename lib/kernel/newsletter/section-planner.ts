/**
 * lib/kernel/newsletter/section-planner.ts
 *
 * WAVE 155 (lane 155G2 — directive G3, owner ruling R8): THE NEWSLETTER SECTION SELECTOR.
 *
 * Owner: "newsletters should also have education about the market, local event, an active listing, something of value for
 * their community." The writer (lib/kernel/content-creators.ts authorNewsletterContent — the Campaign Manager's newsletter
 * author) used to impose a FIXED template ("Sections needed: hero, featured_listings, market_update, tips, cta") on every
 * issue whether or not a fact existed for a slot, so the model filled a listing slot with no listing and a market slot with
 * no numbers. This module decides WHICH sections an issue carries from what is REAL, and records where each fact came from:
 *
 *   gatherSectionCandidates  — reads the verified inputs (market_data rows, the tenant's own ACTIVE listings, the local facts
 *                              and topic picks the writer already loaded). Unmeasured figures stay out (market_data writes 0
 *                              for "unknown"; a 0 is never rendered as a statistic).
 *   selectNewsletterSections — PURE. 2–5 sections by quality, locality, asset existence and frequency. A module without a
 *                              fact is OMITTED with its reason, never filled. Always a next action.
 *   enforcePlanOnSections    — PURE. A fact-bearing section the plan did not select (the model wrote a listing / event /
 *                              statistic / testimonial anyway) is DROPPED. Kept sections carry their provenance.
 *   stampSectionProvenance   — PURE. The creator stamps provenance server-side from the authored plan (never from the
 *                              browser: client-supplied `provenance` is stripped).
 *   verifyIssueProvenance    — at SEND: a canceled / postponed / expired event, a listing no longer active (sold), a
 *                              retired resource or a stale market row invalidates the issue BEFORE any recipient is mailed.
 *   newsletterQrDestination  — the optional QR's REAL public page (/listings/<id> for a planned listing, else the agent's
 *                              /p/<public_slug>, else none). The code itself is minted by THE ONE minter
 *                              (lib/marketing/tracked-qr.ts resolveArtifactQrSlot) — this module never mints.
 *
 * Not server-only and not a new store: provenance rides on the section objects inside newsletter_campaigns.content (the
 * stored issue the approval covers) and on ai_generated_content.metadata.section_plan; the event lineage stays
 * content_topic_uses (lib/newsletter/local-events.ts correctEvent already holds derived drafts through it). Every DB edge
 * takes an injected client so scripts/newsletter-sections-guard.ts drives it on the in-memory client.
 */
import { normalizeSectionType, NEWSLETTER_SECTION_TYPES, type NewsletterSectionType } from "./section-types"

type Db = { from: (table: string) => any }

const SECTION_PLAN_FORMAT = "newsletter_section_plan_v1"
const DAY_MS = 86_400_000
/** A market row older than this at PLANNING is not "current"; at SEND the allowance is MARKET_SEND_MAX_AGE_DAYS. */
const MARKET_PLAN_MAX_AGE_DAYS = 45
const MARKET_SEND_MAX_AGE_DAYS = 60
/** An event further out than this is not "upcoming" for this issue. */
const EVENT_HORIZON_DAYS = 45
const MIN_QUALITY = 0.5
const MAX_SECTIONS = 5
const MIN_SECTIONS = 2

type SectionModule =
  | "market_education" | "local_event" | "active_listing" | "community_value" | "evergreen_education" | "next_action"

type SectionProvenance =
  | { kind: "market_data"; id: string; dataDate: string; area: string | null; source: string | null }
  | { kind: "local_event"; topicId: string; eventStart: string; eventEnd: string | null; url: string | null; publisher: string | null }
  | { kind: "listing"; listingId: string; statusAtSelection: "active"; listPrice: number }
  | { kind: "topic"; topicId: string; sourceUrl: string | null }

interface SectionCandidate {
  module: SectionModule
  sectionType: NewsletterSectionType
  /** 0..1 — how complete / trustworthy the underlying fact is. */
  quality: number
  /** The fact is in a place the audience actually lives. */
  local: boolean
  /** The supporting asset exists (a listing photo, a source link). */
  assetReady: boolean
  /** Lines the writer may state — and the ONLY lines it may state for this section. */
  facts: string[]
  provenance: SectionProvenance | null
  label: string
}

interface PlannedSection extends SectionCandidate { score: number; why: string }

export interface SectionPlan {
  format: typeof SECTION_PLAN_FORMAT
  decidedAt: string
  selected: PlannedSection[]
  omitted: Array<{ module: SectionModule; reason: string }>
}

/** Module → the canonical section types a section written for it may carry. */
const MODULE_SECTION_TYPES: Readonly<Record<SectionModule, readonly NewsletterSectionType[]>> = {
  market_education: ["market_update"],
  local_event: ["local_event", "local_news"],
  active_listing: ["property_highlight", "new_listings"],
  community_value: ["neighborhood_spotlight", "tips", "mortgage_rates", "local_news"],
  evergreen_education: ["tips"],
  next_action: ["cta"],
}

/** Section types that STATE a fact (a number, a listing, an event, a business, a client quote). Only a selected module
 *  may carry one; agent_intro / tips / cta / custom are voice and advice, and pass. */
const FACT_SECTION_TYPES: ReadonlySet<NewsletterSectionType> = new Set<NewsletterSectionType>([
  "market_update", "new_listings", "property_highlight", "local_news", "local_event",
  "neighborhood_spotlight", "mortgage_rates", "testimonial", "community_eats",
])

const FACT_MODULES: readonly SectionModule[] = ["market_education", "local_event", "active_listing", "community_value"]
const COMMUNITY_CATEGORIES = ["neighborhood", "buyer_advice", "seller_advice", "finance"]

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim()
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const pos = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`

// ── Candidates ───────────────────────────────────────────────────────────────────────────────────────────────────

interface LocalFactLike {
  topicId: string; kind: string; title: string; url: string | null; publisher: string | null
  eventStart: string | null; eventEnd: string | null; venue: string | null; city: string | null; state: string | null
  confidence: number | null; temporal: string
}
interface TopicLike {
  id: string; topic_title: string; value_angle: string | null; source_url: string | null; categories: string[]; is_brokerage_local?: boolean
}
interface MarketRow {
  id: string; market_area: string | null; city: string | null; state: string | null; data_date: string; source_type: string | null
  median_sale_price: unknown; sold_listings_30d: unknown; active_listings: unknown; new_listings_30d: unknown
  avg_days_on_market: unknown; months_of_inventory: unknown; price_trend_pct_1yr: unknown
}
interface ListingRow {
  id: string; address: string | null; city: string | null; state: string | null; list_price: unknown; bedrooms: unknown
  bathrooms: unknown; sqft: unknown; status: string | null; primary_photo_url: string | null; photos: unknown
}

const MARKET_SOURCE_LABEL: Record<string, string> = {
  rentcast: "RentCast market data",
  cma_aggregate: "the brokerage's recent comparable-sales analyses",
}

/** PURE — the measured figures of one market row, as sentences. A null / 0 figure is UNKNOWN and is not stated. */
function marketFactLines(r: MarketRow): string[] {
  const area = clean(r.market_area) || [clean(r.city), clean(r.state)].filter(Boolean).join(", ") || "this market"
  const out: string[] = []
  const median = pos(r.median_sale_price); if (median) out.push(`Median sale price in ${area}: ${usd(median)}`)
  const sold = pos(r.sold_listings_30d); if (sold) out.push(`Homes sold in ${area} in the last 30 days: ${Math.round(sold)}`)
  const active = pos(r.active_listings); if (active) out.push(`Active listings in ${area}: ${Math.round(active)}`)
  const fresh = pos(r.new_listings_30d); if (fresh) out.push(`New listings in ${area} in the last 30 days: ${Math.round(fresh)}`)
  const dom = pos(r.avg_days_on_market); if (dom) out.push(`Average days on market in ${area}: ${Math.round(dom)}`)
  const moi = pos(r.months_of_inventory); if (moi) out.push(`Months of inventory in ${area}: ${moi.toFixed(1)}`)
  const trend = Number(r.price_trend_pct_1yr)
  if (Number.isFinite(trend) && trend !== 0) out.push(`Price change in ${area} over 12 months: ${trend > 0 ? "+" : ""}${trend.toFixed(1)}%`)
  return out
}

/**
 * Reads the verified inputs and turns each into at most one candidate per module. Tenant-pinned; a refused read is
 * returned as an error and that module is simply absent (never invented). The local facts and topics are the ones the
 * writer already loaded — passed in, not re-read.
 */
export async function gatherSectionCandidates(db: Db, a: {
  brokerageId: string
  /** agents.id of the author — only the author's OWN active listings are offered (an agent may advertise their own). */
  agentId: string | null
  now?: Date
  localFacts: readonly LocalFactLike[]
  topics: readonly TopicLike[]
  audienceCities: readonly (string | null)[]
  /** Listing ids the author asked to feature — preferred, but only if they pass the same checks. */
  preferredListingIds?: readonly string[]
}): Promise<{ candidates: SectionCandidate[]; errors: string[] }> {
  const now = a.now ?? new Date()
  const cities = new Set(a.audienceCities.map((c) => clean(c).toLowerCase()).filter(Boolean))
  const isLocal = (city: string | null | undefined) => cities.size > 0 && cities.has(clean(city).toLowerCase())
  const candidates: SectionCandidate[] = []
  const errors: string[] = []
  if (!a.brokerageId) return { candidates, errors: ["no tenant"] }

  // 1 · market education — the freshest row with at least two MEASURED figures.
  try {
    const { data, error } = await db.from("market_data")
      .select("id, market_area, city, state, data_date, source_type, median_sale_price, sold_listings_30d, active_listings, new_listings_30d, avg_days_on_market, months_of_inventory, price_trend_pct_1yr")
      .eq("brokerage_id", a.brokerageId)
      .gte("data_date", ymd(new Date(now.getTime() - MARKET_PLAN_MAX_AGE_DAYS * DAY_MS)))
      .order("data_date", { ascending: false })
      .limit(10)
    if (error) errors.push(`market_data read refused: ${error.message ?? "unknown"}`)
    const rows = ((data ?? []) as MarketRow[]).map((r) => ({ r, lines: marketFactLines(r) })).filter((x) => x.lines.length >= 2)
    rows.sort((x, y) => Number(isLocal(y.r.city)) - Number(isLocal(x.r.city)) || y.lines.length - x.lines.length)
    const best = rows[0]
    if (best) {
      const src = MARKET_SOURCE_LABEL[clean(best.r.source_type)] ?? (clean(best.r.source_type) || "recorded market data")
      candidates.push({
        module: "market_education", sectionType: "market_update", quality: Math.min(1, 0.5 + 0.1 * best.lines.length),
        local: isLocal(best.r.city), assetReady: true, label: "Local market education",
        facts: [...best.lines, `As of ${best.r.data_date}, per ${src}.`],
        provenance: { kind: "market_data", id: best.r.id, dataDate: best.r.data_date, area: best.r.market_area ?? best.r.city ?? null, source: best.r.source_type ?? null },
      })
    }
  } catch (e) { errors.push(`market_data read threw: ${(e as Error)?.message ?? String(e)}`) }

  // 2 · an upcoming, verified local event (the writer's local-facts read — local-intel is the source; never invented here).
  const horizon = ymd(new Date(now.getTime() + EVENT_HORIZON_DAYS * DAY_MS))
  const events = a.localFacts
    .filter((f) => f.kind === "local_event" && (f.temporal === "upcoming" || f.temporal === "ongoing") && !!f.eventStart && f.eventStart.slice(0, 10) <= horizon && (f.eventEnd ?? f.eventStart).slice(0, 10) >= ymd(now))
    .sort((x, y) => Number(isLocal(y.city)) - Number(isLocal(x.city)) || (y.confidence ?? 0) - (x.confidence ?? 0) || String(x.eventStart).localeCompare(String(y.eventStart)))
  const ev = events[0]
  if (ev) {
    const where = [clean(ev.venue), [clean(ev.city), clean(ev.state)].filter(Boolean).join(", ")].filter(Boolean).join(" · ")
    candidates.push({
      module: "local_event", sectionType: "local_event", quality: Math.max(0.5, Math.min(1, ev.confidence ?? 0.6)),
      local: isLocal(ev.city), assetReady: !!ev.url, label: "Upcoming local event",
      facts: [`${clean(ev.title)} — ${ev.eventStart!.slice(0, 10)}${ev.eventEnd && ev.eventEnd !== ev.eventStart ? ` to ${ev.eventEnd.slice(0, 10)}` : ""}${where ? ` · ${where}` : ""}`, `Source: ${ev.publisher ?? "the organizer"}${ev.url ? ` <${ev.url}>` : ""} — credit and link it; never imply who attends.`],
      provenance: { kind: "local_event", topicId: ev.topicId, eventStart: ev.eventStart!.slice(0, 10), eventEnd: ev.eventEnd ? ev.eventEnd.slice(0, 10) : null, url: ev.url, publisher: ev.publisher },
    })
  }

  // 3 · the author's own ACTIVE listing (never sold inventory, never another agent's listing).
  if (a.agentId) {
    try {
      const { data, error } = await db.from("listings")
        .select("id, address, city, state, list_price, bedrooms, bathrooms, sqft, status, primary_photo_url, photos")
        .eq("brokerage_id", a.brokerageId).eq("agent_id", a.agentId).eq("status", "active").is("deleted_at", null)
        .order("updated_at", { ascending: false }).limit(10)
      if (error) errors.push(`listings read refused: ${error.message ?? "unknown"}`)
      const prefer = new Set(a.preferredListingIds ?? [])
      const ok = ((data ?? []) as ListingRow[]).filter((l) => l.status === "active" && clean(l.address) && pos(l.list_price))
      ok.sort((x, y) => Number(prefer.has(y.id)) - Number(prefer.has(x.id)) || Number(isLocal(y.city)) - Number(isLocal(x.city)))
      const l = ok[0]
      if (l) {
        const hasPhoto = !!l.primary_photo_url || (Array.isArray(l.photos) && l.photos.length > 0)
        const specs = [pos(l.bedrooms) && `${pos(l.bedrooms)} bd`, pos(l.bathrooms) && `${pos(l.bathrooms)} ba`, pos(l.sqft) && `${Math.round(pos(l.sqft)!).toLocaleString("en-US")} sq ft`].filter(Boolean).join(" · ")
        candidates.push({
          module: "active_listing", sectionType: "property_highlight", quality: hasPhoto ? 0.85 : 0.7,
          local: isLocal(l.city), assetReady: hasPhoto, label: "Current listing",
          facts: [`${clean(l.address)}, ${[clean(l.city), clean(l.state)].filter(Boolean).join(", ")} — listed at ${usd(pos(l.list_price)!)}${specs ? ` · ${specs}` : ""}`, `Status: ACTIVE as of ${ymd(now)} (re-checked before sending; describe the home, never who it suits).`],
          provenance: { kind: "listing", listingId: l.id, statusAtSelection: "active", listPrice: pos(l.list_price)! },
        })
      }
    } catch (e) { errors.push(`listings read threw: ${(e as Error)?.message ?? String(e)}`) }
  }

  // 4 · something of community value — a sourced guide / tip / financing explainer / neighborhood resource.
  // … OR a question this tenant's OWN customers keep asking (wave 155, at merge of lanes 155F / 155G2 / 155L; owner note: a
  // question asked consistently becomes a topic, and a newsletter carries something of value). Such a topic is first-party
  // and de-identified, so it has no source link — and this filter required one, so it could drive a video and a refurbish
  // but never a newsletter section. It is admitted ONLY when it is the tenant's own row (is_brokerage_local): another
  // tenant's question, or a platform-wide row with no source, is not this tenant's evidence.
  const community = a.topics
    .filter((t) => ((!!t.source_url && (t.categories ?? []).some((c) => COMMUNITY_CATEGORIES.includes(c))) || (!t.source_url && !!t.is_brokerage_local && (t.categories ?? []).includes("faq"))) && !(t.categories ?? []).includes("local_intel"))
  const ct = community[0]
  if (ct) {
    const finance = (ct.categories ?? []).includes("finance")
    candidates.push({
      module: "community_value", sectionType: finance ? "mortgage_rates" : (ct.categories ?? []).includes("neighborhood") ? "neighborhood_spotlight" : "tips",
      quality: ct.is_brokerage_local ? 0.7 : 0.6, local: !!ct.is_brokerage_local, assetReady: true, label: finance ? "Financing explainer" : ct.source_url ? "Community guide" : "A question your clients ask",
      facts: [`${clean(ct.topic_title)}${ct.value_angle ? ` — ${clean(ct.value_angle)}` : ""}`, ct.source_url ? `Source: <${ct.source_url}> — explain it in the agent's own words${finance ? "; no rate, payment or approval promise" : ""}.` : "A question your own clients keep asking (first-party, de-identified) — answer it in the agent's own words; state no figure, date or rate."],
      provenance: { kind: "topic", topicId: ct.id, sourceUrl: ct.source_url },
    })
  }
  return { candidates, errors }
}

// ── Selection (pure) ─────────────────────────────────────────────────────────────────────────────────────────────

const EVERGREEN: SectionCandidate = {
  module: "evergreen_education", sectionType: "tips", quality: 0.5, local: false, assetReady: true, label: "Homeowner education",
  facts: ["Evergreen advice only: no statistic, price, date, business, event or listing may be named."], provenance: null,
}
const NEXT_ACTION: SectionCandidate = {
  module: "next_action", sectionType: "cta", quality: 1, local: false, assetReady: true, label: "Next step",
  facts: ["One clear, low-pressure next step (reply, book a call, ask for a home value)."], provenance: null,
}

/**
 * PURE — choose 2–5 sections. Score = quality + locality + asset existence − repetition of last issue's module. One
 * section per module; fact modules below MIN_QUALITY are omitted; with no fact module the issue is evergreen education +
 * a next action (2 sections) — still nothing stated that is not verified.
 */
export function selectNewsletterSections(candidates: readonly SectionCandidate[], opts: { recentModules?: readonly string[]; now?: Date } = {}): SectionPlan {
  const recent = new Set(opts.recentModules ?? [])
  const scored = candidates
    .filter((c) => FACT_MODULES.includes(c.module))
    .map((c) => {
      const score = c.quality + (c.local ? 0.15 : 0) + (c.assetReady ? 0.05 : 0) - (recent.has(c.module) ? 0.2 : 0)
      const why = [`quality ${c.quality.toFixed(2)}`, c.local ? "in the audience's area" : null, c.assetReady ? "asset on file" : null, recent.has(c.module) ? "ran last issue (-0.2)" : null].filter(Boolean).join(", ")
      return { ...c, score, why }
    })
  const bestPerModule = new Map<SectionModule, PlannedSection>()
  for (const c of scored) { const cur = bestPerModule.get(c.module); if (!cur || c.score > cur.score) bestPerModule.set(c.module, c) }
  const omitted: SectionPlan["omitted"] = []
  const facts: PlannedSection[] = []
  for (const m of FACT_MODULES) {
    const c = bestPerModule.get(m)
    if (!c) omitted.push({ module: m, reason: "no_verified_fact" })
    else if (c.quality < MIN_QUALITY) omitted.push({ module: m, reason: `below_quality:${c.quality.toFixed(2)}` })
    else facts.push(c)
  }
  facts.sort((x, y) => y.score - x.score)
  const kept = facts.slice(0, MAX_SECTIONS - 1)
  for (const c of facts.slice(MAX_SECTIONS - 1)) omitted.push({ module: c.module, reason: "over_capacity" })
  const body: PlannedSection[] = kept.length > 0 ? kept : [{ ...EVERGREEN, score: EVERGREEN.quality, why: "no verified fact module — evergreen only" }]
  const selected = [...body, { ...NEXT_ACTION, score: 1, why: "every issue ends with one next step" }]
    .sort((x, y) => NEWSLETTER_SECTION_TYPES[x.sectionType].defaultOrder - NEWSLETTER_SECTION_TYPES[y.sectionType].defaultOrder)
  return { format: SECTION_PLAN_FORMAT, decidedAt: (opts.now ?? new Date()).toISOString(), selected: selected.slice(0, Math.max(MIN_SECTIONS, Math.min(MAX_SECTIONS, selected.length))), omitted }
}

/** PURE — the writer's section directive. It replaces the template's fixed list; it is also the RULE. */
export function renderPlanForPrompt(plan: SectionPlan): string {
  const lines = plan.selected.map((s, i) => `${i + 1}. section_type="${s.sectionType}" — ${s.label}\n${s.facts.map((f) => `   • ${f}`).join("\n")}`)
  const omitted = plan.omitted.length ? `\nOMITTED (no verified fact — do NOT write these): ${plan.omitted.map((o) => o.module.replace(/_/g, " ")).join(", ")}` : ""
  return `═══ SECTIONS SELECTED FOR THIS ISSUE (from verified facts) ═══\nWrite EXACTLY these ${plan.selected.length} sections (persona / location variants of the same section are allowed). State only the facts listed under each section; a figure, listing, event, business or client quote that is not listed must not appear.\n${lines.join("\n")}${omitted}`
}

type AnySection = { type?: string; section_type?: string; title?: string; provenance?: unknown; plan_module?: unknown }

function moduleForType(plan: SectionPlan, t: NewsletterSectionType): PlannedSection | null {
  return plan.selected.find((s) => MODULE_SECTION_TYPES[s.module].includes(t)) ?? null
}

/** PURE — drop fact-bearing sections the plan did not select; stamp provenance on the rest. */
export function enforcePlanOnSections<T extends AnySection>(sections: readonly T[], plan: SectionPlan): { sections: T[]; dropped: Array<{ title: string; sectionType: string; reason: string }> } {
  const dropped: Array<{ title: string; sectionType: string; reason: string }> = []
  const kept: T[] = []
  for (const s of sections) {
    const t = normalizeSectionType(s.section_type ?? s.type)
    const owner = moduleForType(plan, t)
    if (FACT_SECTION_TYPES.has(t) && !owner) { dropped.push({ title: clean(s.title), sectionType: t, reason: "no_verified_fact_for_section" }); continue }
    kept.push(stampOne(s, owner))
  }
  return { sections: kept, dropped }
}

function stampOne<T extends AnySection>(s: T, owner: PlannedSection | null): T {
  const { provenance: _clientProvenance, plan_module: _clientModule, ...rest } = s
  void _clientProvenance; void _clientModule
  return (owner ? { ...rest, plan_module: owner.module, provenance: owner.provenance ? [owner.provenance] : [] } : rest) as unknown as T
}

/** PURE — the creator's stamp: client-supplied provenance is stripped; the authored plan (read server-side) stamps. */
export function stampSectionProvenance<T extends AnySection>(sections: readonly T[], plan: SectionPlan | null): T[] {
  return sections.map((s) => stampOne(s, plan ? moduleForType(plan, normalizeSectionType(s.section_type ?? s.type)) : null))
}

/** PURE — read back a stored plan (ai_generated_content.metadata.section_plan); anything else → null. */
export function parseSectionPlan(v: unknown): SectionPlan | null {
  if (!v || typeof v !== "object") return null
  const p = v as Partial<SectionPlan>
  if (p.format !== SECTION_PLAN_FORMAT || !Array.isArray(p.selected)) return null
  return { format: SECTION_PLAN_FORMAT, decidedAt: String(p.decidedAt ?? ""), selected: p.selected as PlannedSection[], omitted: Array.isArray(p.omitted) ? p.omitted : [] }
}

/** PURE — a plan rebuilt from an already-stored issue (edit-in-place keeps the provenance it had). */
export function planFromStoredIssue(content: unknown): SectionPlan | null {
  const issue = parseStoredIssue(content)
  if (!issue.sections) return null
  const selected: PlannedSection[] = []
  for (const s of issue.sections as AnySection[]) {
    const m = typeof s.plan_module === "string" ? (s.plan_module as SectionModule) : null
    if (!m || !(m in MODULE_SECTION_TYPES) || selected.some((x) => x.module === m)) continue
    const prov = Array.isArray(s.provenance) ? (s.provenance[0] as SectionProvenance | undefined) ?? null : null
    selected.push({ module: m, sectionType: normalizeSectionType(s.section_type ?? s.type), quality: 1, local: false, assetReady: true, facts: [], provenance: prov, label: m, score: 1, why: "carried from the stored issue" })
  }
  return selected.length ? { format: SECTION_PLAN_FORMAT, decidedAt: "", selected, omitted: [] } : null
}

/**
 * PURE — newsletter_campaigns.content is either HTML / prose (the manual editor) or the creator's JSON section array.
 * The array is NOT an intro: its sections are already rendered from newsletter_sections, so the intro is empty. (Before
 * this, both senders put the raw JSON text at the top of every email.)
 */
export function parseStoredIssue(content: unknown): { introHtml: string | null; sections: unknown[] | null; provenance: SectionProvenance[] } {
  if (Array.isArray(content)) return { introHtml: null, sections: content, provenance: collect(content) }
  if (typeof content !== "string") return { introHtml: null, sections: null, provenance: [] }
  const t = content.trim()
  if (t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t)
      if (Array.isArray(parsed) && parsed.every((s) => s && typeof s === "object")) return { introHtml: null, sections: parsed, provenance: collect(parsed) }
    } catch { /* prose that starts with a bracket */ }
  }
  return { introHtml: t || null, sections: null, provenance: [] }
}

function provKey(p: SectionProvenance): string {
  return p.kind === "market_data" ? `m:${p.id}` : p.kind === "listing" ? `l:${p.listingId}` : `t:${p.topicId}`
}
function collect(sections: unknown[]): SectionProvenance[] {
  const out = new Map<string, SectionProvenance>()
  for (const s of sections) {
    const list = (s as AnySection)?.provenance
    if (!Array.isArray(list)) continue
    for (const p of list as SectionProvenance[]) if (p && typeof p === "object" && typeof p.kind === "string") out.set(provKey(p), p)
  }
  return [...out.values()]
}

/** The modules the author's previous issue carried (the frequency signal). Never throws. */
export async function recentPlanModules(db: Db, a: { brokerageId: string; agentId: string | null }): Promise<string[]> {
  if (!a.brokerageId || !a.agentId) return []
  try {
    const { data, error } = await db.from("newsletter_campaigns").select("content").eq("brokerage_id", a.brokerageId).eq("agent_id", a.agentId)
      .order("created_at", { ascending: false }).limit(1)
    if (error) return []
    const issue = parseStoredIssue(((data ?? []) as Array<{ content: unknown }>)[0]?.content)
    return [...new Set((issue.sections ?? []).map((s) => (s as AnySection).plan_module).filter((m): m is string => typeof m === "string"))]
  } catch { return [] }
}

// ── Send-time verification ───────────────────────────────────────────────────────────────────────────────────────

type ProvenanceVerdict =
  | { ok: true; checked: number }
  | { ok: false; hold: boolean; reason: string; invalid: Array<{ kind: SectionProvenance["kind"]; id: string; reason: string }>; unverifiable: string[] }

/**
 * Re-checks every fact an issue states, against the live rows, before a send. INVALID (hold: the content must be revised
 * and re-approved): an event canceled / postponed / rescheduled / withdrawn / past, a listing that is not ACTIVE (sold,
 * pending, withdrawn, deleted, gone), a retired resource, a market row gone or older than 60 days. UNVERIFIABLE (a read
 * refused or threw) fails CLOSED too, as a plain deferral. Tenant-pinned. Never throws.
 */
export async function verifyIssueProvenance(db: Db, brokerageId: string, provenance: readonly SectionProvenance[], now: Date = new Date()): Promise<ProvenanceVerdict> {
  if (provenance.length === 0) return { ok: true, checked: 0 }
  const invalid: Array<{ kind: SectionProvenance["kind"]; id: string; reason: string }> = []
  const unverifiable: string[] = []
  const today = ymd(now)
  const ids = <K extends SectionProvenance["kind"]>(k: K) => provenance.filter((p): p is Extract<SectionProvenance, { kind: K }> => p.kind === k)
  const read = async (table: string, cols: string, list: string[], scope: "tenant" | "tenant_or_platform") => {
    try {
      let q = db.from(table).select(cols).in("id", list)
      q = scope === "tenant" ? q.eq("brokerage_id", brokerageId) : q.or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
      const { data, error } = await q
      if (error) { unverifiable.push(`${table}: ${error.message ?? "refused"}`); return null }
      return new Map(((data ?? []) as Array<Record<string, any>>).map((r) => [String(r.id), r]))
    } catch (e) { unverifiable.push(`${table}: ${(e as Error)?.message ?? String(e)}`); return null }
  }

  const listings = ids("listing")
  if (listings.length) {
    const rows = await read("listings", "id, status, deleted_at", listings.map((p) => p.listingId), "tenant")
    if (rows) for (const p of listings) {
      const r = rows.get(p.listingId)
      const reason = !r ? "listing_gone" : r.deleted_at ? "listing_deleted" : r.status === "sold" ? "listing_sold" : r.status !== "active" ? `listing_not_active:${r.status}` : null
      if (reason) invalid.push({ kind: "listing", id: p.listingId, reason })
    }
  }
  const events = ids("local_event")
  const topics = ids("topic")
  if (events.length || topics.length) {
    const rows = await read("content_topic_bank", "id, status, raw_data", [...events.map((p) => p.topicId), ...topics.map((p) => p.topicId)], "tenant_or_platform")
    if (rows) {
      for (const p of events) {
        const r = rows.get(p.topicId)
        const le = r?.raw_data?.local_event as Record<string, any> | undefined
        const st = clean(le?.status).toLowerCase()
        const end = (p.eventEnd ?? p.eventStart).slice(0, 10)
        const reason = !r ? "event_gone"
          : r.status === "rejected" ? "event_retired"
          : st === "canceled" || st === "cancelled" ? "event_canceled"
          : st === "postponed" ? "event_postponed"
          : le?.rescheduled_to || (le?.corrected_at && st === "rescheduled") ? "event_rescheduled"
          : r.raw_data?.local_fact == null ? "event_fact_withdrawn"
          : end < today ? "event_expired"
          : null
        if (reason) invalid.push({ kind: "local_event", id: p.topicId, reason })
      }
      for (const p of topics) {
        const r = rows.get(p.topicId)
        const reason = !r ? "resource_gone" : r.status === "rejected" ? "resource_retired" : null
        if (reason) invalid.push({ kind: "topic", id: p.topicId, reason })
      }
    }
  }
  const markets = ids("market_data")
  if (markets.length) {
    const rows = await read("market_data", "id, data_date", markets.map((p) => p.id), "tenant")
    const floor = ymd(new Date(now.getTime() - MARKET_SEND_MAX_AGE_DAYS * DAY_MS))
    if (rows) for (const p of markets) {
      const r = rows.get(p.id)
      const reason = !r ? "market_fact_gone" : String(r.data_date ?? "") < floor ? "market_fact_stale" : null
      if (reason) invalid.push({ kind: "market_data", id: p.id, reason })
    }
  }
  if (invalid.length) return { ok: false, hold: true, reason: `provenance_invalid:${invalid.map((i) => `${i.reason}:${i.id}`).join("|")}`.slice(0, 300), invalid, unverifiable }
  if (unverifiable.length) return { ok: false, hold: false, reason: `provenance_unverifiable:${unverifiable.join("|")}`.slice(0, 300), invalid, unverifiable }
  return { ok: true, checked: provenance.length }
}

// ── The optional QR's destination (the code is minted by THE ONE minter, never here) ─────────────────────────────

/** PURE — a REAL public page or null: the planned listing's public page, else the agent's public profile. */
function newsletterQrDestination(provenance: readonly SectionProvenance[], agentPublicSlug: string | null, origin: string): { url: string; type: "listing_detail" | "landing_page"; listingId: string | null } | null {
  const o = origin.replace(/\/$/, "")
  const listing = provenance.find((p): p is Extract<SectionProvenance, { kind: "listing" }> => p.kind === "listing")
  if (listing) return { url: `${o}/listings/${encodeURIComponent(listing.listingId)}`, type: "listing_detail", listingId: listing.listingId }
  const slug = clean(agentPublicSlug)
  if (slug) return { url: `${o}/p/${encodeURIComponent(slug)}`, type: "landing_page", listingId: null }
  return null
}

type SlotResolver = (args: Record<string, unknown>, client?: unknown) => Promise<{ status: string; scanUrl?: string; qrCodeDataUrl?: string | null; reason?: string }>

/**
 * The newsletter's ONE email QR slot (155E carry-in): resolved ONCE per campaign, before the recipient loop. The email form
 * is a clickable TRACKED link (lib/kernel/newsletter/assemble.ts newsletterQrBlock). No real destination, a tenant who
 * chose none, a held / cross-tenant code → no block (the issue still sends). Never throws.
 */
export async function resolveNewsletterEmailQr(db: Db, c: { id: string; brokerage_id: string; agent_id: string | null; created_by: string | null; marketing_campaign_id: string | null }, provenance: readonly SectionProvenance[], deps: { resolve?: SlotResolver; origin?: string } = {}): Promise<{ qr: { form: "email"; scanUrl: string } | null; status: string }> {
  try {
    let slug: string | null = null
    if (c.agent_id) {
      const { data, error } = await db.from("agents").select("public_slug").eq("id", c.agent_id).eq("brokerage_id", c.brokerage_id).limit(1)
      if (!error) slug = ((data ?? []) as Array<{ public_slug: string | null }>)[0]?.public_slug ?? null
    }
    const tracked = deps.resolve && deps.origin ? null : await import("@/lib/marketing/tracked-qr")
    const origin = deps.origin ?? tracked!.normalizeOrigin()
    const dest = newsletterQrDestination(provenance, slug, origin)
    if (!dest) return { qr: null, status: "no_public_destination" }
    const resolve: SlotResolver = deps.resolve ?? (tracked!.resolveArtifactQrSlot as unknown as SlotResolver)
    const r = await resolve({
      brokerageId: c.brokerage_id, sourceTable: "newsletter_campaigns", sourceId: c.id, slot: "email_link",
      destinationUrl: dest.url, destinationType: dest.type, purpose: dest.listingId ? "listing" : "general",
      creatorUserId: c.created_by ?? null, marketingCampaignId: c.marketing_campaign_id ?? null, listingId: dest.listingId, origin,
    }, db)
    return r.status === "placed" && r.scanUrl ? { qr: { form: "email", scanUrl: r.scanUrl }, status: "placed" } : { qr: null, status: `${r.status}${r.reason ? `:${r.reason}` : ""}` }
  } catch (e) {
    return { qr: null, status: `error:${(e as Error)?.message ?? String(e)}` }
  }
}
