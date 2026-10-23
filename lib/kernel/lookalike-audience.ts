// lib/kernel/lookalike-audience.ts
//
// LOOKALIKE FROM THE CLOSING TABLE — the Ads Manager's first-party superpower. Every
// competitor targets generic "homebuyer" interest segments. We have something they
// don't: the brokerage's ACTUAL closings. Each closed buyer is a proven conversion;
// the Ads Manager seeds a lookalike audience from the closing table (who really bought,
// where) so paid spend chases people like the ones who already said yes — staged as a
// draft ad campaign for the human to approve. NOT server-only.
//
// WAVE 143 (lane 143D) adds the half that was missing: the RESEARCH — what the tenant's own customers have in common —
// is now its own capability (runLookalikeResearch), decoupled from the ad draft, and it has READERS: content briefs
// land in content_topic_bank (read by pickTopics and every content generator), and lead-acquisition inputs are STAGED as
// inactive lead_scraping_keywords rows (read by resolveSourceKeywords once a human turns them on) beside a free Versium
// audience-size estimate of the research-derived territory. The PURE half (ad-policy verdict, attribute registry, seed
// profile, research, briefs, acquisition inputs) lives in lib/kernel/lookalike-research.ts; this file is the entry point
// and the I/O: the seed read, the bounded online-behaviour pass, the staging, the ledgered action, the ad draft.

import { createServiceClient } from "@/lib/supabase/service"
import { realEstateIndicatorsFromProfile, REAL_ESTATE_INDICATORS_KEY } from "@/lib/enrichment/online-presence-store"
import { KEYWORD_SOURCE_KEYS } from "@/lib/lead-pipeline/scrape-keywords"
import type { VersiumAudienceEstimate } from "@/lib/external/versium-client"
import {
  LOOKALIKE_AD_POLICY, RESEARCH_MIN_SEED, researchLookalikeDenominators, lookalikeSeedProfile, composeResearchBriefs, composeAcquisitionInputs,
  type LookalikeResearch, type ResearchBrief, type LookalikeAcquisitionInputs,
} from "@/lib/kernel/lookalike-research"

type Svc = ReturnType<typeof createServiceClient>

const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "")

/** A seed needs at least this many closings to be a meaningful lookalike AD seed (the draft campaign). */
export const MIN_SEED = 5


export interface ClosingSeed { seedCount: number; cities: string[] }

/** Pure: the lookalike ad spec from the closing-table seed. Null when the seed is too
 *  thin (a 2-closing lookalike is noise, not signal). Wave 142: the spec names the policy it
 *  runs under — a LOCATION seed, never a platform look-alike model (LOOKALIKE_AD_POLICY). */
export function composeLookalike(seed: ClosingSeed): { name: string; targeting: Record<string, unknown> } | null {
  if (seed.seedCount < MIN_SEED) return null
  return {
    name: `Lookalike — ${seed.seedCount} past buyers`,
    targeting: {
      audience: "lookalike", seed_source: "closing_table", seed_count: seed.seedCount,
      locations: seed.cities.slice(0, 10),
      policy: LOOKALIKE_AD_POLICY.summary,
      lookalike_model: "not_available_for_housing",
    },
  }
}

// ─── I/O: THE SEED — the tenant's own closed customers ───────────────────────────────────────────────────────────────
/** Closed deals read per run, and contacts per `.in()` chunk (100 uuids ≈ 3.7 KB of query string — well under a gateway's URL limit). */
const SEED_DEAL_LIMIT = 2000
const SEED_CHUNK = 100
/**
 * The contact columns the seed reads — every one is asserted against the live schema snapshot (a PGRST204 refuses the WHOLE read).
 * @proofSeam kept exported for scripts/versium-capability-matrix-guard.ts, which checks each column against SCHEMA_SNAPSHOT
 */
export const LOOKALIKE_SEED_CONTACT_COLUMNS = "id, first_name, last_name, email, phone, address, city, mailing_address, mailing_city, mailing_state, mailing_zip, home_owner_status, household_income, occupation, length_of_residence, property_type, source, enrichment_profile"
/**
 * The transactions columns the seed reads (same assertion as the contact columns).
 * @proofSeam kept exported for scripts/versium-capability-matrix-guard.ts, which checks each column against SCHEMA_SNAPSHOT
 */
export const LOOKALIKE_SEED_DEAL_COLUMNS = "id, buyer_contact_id, seller_contact_id, purchase_price, financing_type, property_city, property_state, property_zip, close_date"

interface LookalikeSeedMember {
  contactId: string
  profile: Record<string, unknown>
  contact: Record<string, unknown>
  /** The person's most recent closed deal and which side of it they were — kept so a profile can be rebuilt after an enrichment lands. */
  deal: Record<string, unknown>
  side: "buyer" | "seller"
}

/**
 * The tenant's CONSENTED closed customers: buyers and sellers of its closed transactions, one record per person (their most
 * recent closing), minus anyone deleted, anonymized for a privacy request, or opted out of everything. Every query is
 * tenant-anchored; every `{ error }` is read — a refused read returns the error, never an empty seed passed off as "no customers".
 */
async function loadLookalikeSeed(svc: Svc, brokerageId: string): Promise<{ members: LookalikeSeedMember[]; error?: string }> {
  if (!brokerageId) return { members: [], error: "brokerageId is required" }
  const { data: deals, error: dealError } = await svc.from("transactions")
    .select(LOOKALIKE_SEED_DEAL_COLUMNS)
    .eq("brokerage_id", brokerageId).eq("status", "closed").is("deleted_at", null)
    .order("close_date", { ascending: false, nullsFirst: false }).limit(SEED_DEAL_LIMIT)
  if (dealError) return { members: [], error: `closed deals: ${dealError.message}` }
  const latest = new Map<string, { deal: Record<string, unknown>; side: "buyer" | "seller" }>()
  for (const d of (deals ?? []) as Array<Record<string, unknown>>) {
    // newest first: the first closing seen for a person is their most recent one
    for (const [col, side] of [["buyer_contact_id", "buyer"], ["seller_contact_id", "seller"]] as const) {
      const id = typeof d[col] === "string" ? (d[col] as string) : null
      if (id && !latest.has(id)) latest.set(id, { deal: d, side })
    }
  }
  const ids = [...latest.keys()]
  const members: LookalikeSeedMember[] = []
  for (let i = 0; i < ids.length; i += SEED_CHUNK) {
    const { data: rows, error: contactError } = await svc.from("contacts")
      .select(LOOKALIKE_SEED_CONTACT_COLUMNS)
      .eq("brokerage_id", brokerageId)
      .in("id", ids.slice(i, i + SEED_CHUNK))
      .is("deleted_at", null).is("privacy_anonymized_at", null).is("opted_out_at", null)
    if (contactError) return { members: [], error: `seed contacts: ${contactError.message}` }
    for (const c of (rows ?? []) as Array<Record<string, unknown>>) {
      const hit = latest.get(c.id as string)
      if (!hit) continue
      members.push({ contactId: c.id as string, contact: c, deal: hit.deal, side: hit.side, profile: lookalikeSeedProfile({ contact: c, deal: hit.deal, side: hit.side }) })
    }
  }
  return { members }
}

// ─── I/O: THE BOUNDED ONLINE-BEHAVIOUR PASS — Versium's real-estate indicators, persisted ───────────────────────────
/**
 * Contacts a weekly research run may buy online-presence indicators for (3 credits each, budget-gated). Owner-tunable; 0 turns the spend off.
 * @proofSeam kept exported for scripts/versium-capability-matrix-guard.ts, which asserts the default is a small bounded number and that 0 spends nothing
 */
export const LOOKALIKE_RESEARCH_ENRICH_MAX_PER_RUN = 10
/** A wall-clock bound on that pass so one tenant cannot hold the weekly cron. */
const LOOKALIKE_RESEARCH_ENRICH_MAX_MS = 25_000

export interface LookalikeEnrichmentSummary { eligible: number; asked: number; answered: number; persisted: number; costUsd: number; skipped: string | null }

/**
 * Asks Versium's online_presence capability for the seed members that have no stored indicators — the GAP only — up to
 * `maxContacts`, and stores each answer (persistRealEstateIndicators) so the research can read it. Skips, by name: no
 * identity Versium accepts; a contact in a live deal (the owner's suppression rule, fail-closed); a budget refusal / an
 * unconfigured or failing provider (the first such skip ends the pass — it does not hammer). Returns the profile updates.
 */
async function enrichSeedOnlinePresence(
  svc: Svc, brokerageId: string, members: LookalikeSeedMember[],
  opts: { maxContacts: number; maxMs: number; now: Date; leg?: typeof import("@/lib/ai-isa/property-lookup-rail").runVersiumOnlinePresenceLeg; suppressed?: (ids: string[]) => Promise<{ suppressed: Set<string>; degraded: boolean }> },
): Promise<LookalikeEnrichmentSummary> {
  const out: LookalikeEnrichmentSummary = { eligible: 0, asked: 0, answered: 0, persisted: 0, costUsd: 0, skipped: null }
  if (opts.maxContacts <= 0) return { ...out, skipped: "disabled" }
  try {
    const { versiumQueryFor } = await import("@/lib/external/versium-client")
    const { persistRealEstateIndicators } = await import("@/lib/enrichment/online-presence-store")
    const gaps = members.filter((m) => !realEstateIndicatorsFromProfile((m.contact.enrichment_profile as Record<string, unknown> | null) ?? null))
    const identityOf = (c: Record<string, unknown>) => ({
      firstName: asText(c.first_name) || null, lastName: asText(c.last_name) || null, email: asText(c.email) || null, phone: asText(c.phone) || null,
      address: asText(c.mailing_address) || asText(c.address) || null, city: asText(c.mailing_city) || asText(c.city) || null, state: asText(c.mailing_state) || null, zip: asText(c.mailing_zip) || null,
    })
    const eligible = gaps.filter((m) => versiumQueryFor(identityOf(m.contact)) !== null)
    out.eligible = eligible.length
    if (eligible.length === 0) return { ...out, skipped: "no_gap" }
    // Only a window of candidates is checked and asked: the live-deal check is one `.in()` read per table, and a thousand
    // uuids would blow a gateway's URL limit — which the check would then read as "unreadable" and suppress EVERYONE.
    // The window ROTATES with the ISO week: a no-match is free but is asked again every run, so a fixed window would let the
    // same unmatchable contacts hold the front of the line forever and starve everyone behind them.
    const size = Math.max(opts.maxContacts * 3, 10)
    const weekIndex = Math.floor(opts.now.getTime() / (7 * 86_400_000))
    const from = eligible.length > size ? (weekIndex * size) % eligible.length : 0
    const askable = eligible.length > size ? [...eligible.slice(from), ...eligible.slice(0, from)].slice(0, size) : eligible
    const suppress = opts.suppressed ?? (async (ids: string[]) => (await import("@/lib/enrichment/deal-suppression")).contactsInLiveDeals({ contactIds: ids, brokerageId, supabase: svc }))
    const live = await suppress(askable.map((m) => m.contactId))
    const leg = opts.leg ?? (await import("@/lib/ai-isa/property-lookup-rail")).runVersiumOnlinePresenceLeg
    const started = Date.now()
    for (const m of askable) {
      if (out.asked >= opts.maxContacts) break
      if (Date.now() - started > opts.maxMs) { out.skipped = "time_budget"; break }
      if (live.suppressed.has(m.contactId)) continue // in a live deal, or the deal check could not run — fail closed
      out.asked += 1
      const r = await leg({
        brokerageId, identity: identityOf(m.contact), systemSource: "lookalike_research",
        metadata: { contactId: m.contactId, purpose: "lookalike_research" }, attribution: { contactId: m.contactId },
      })
      out.costUsd += r.cost
      if (r.indicators) {
        out.answered += 1
        const w = await persistRealEstateIndicators(svc, { contactId: m.contactId, brokerageId }, r.indicators, r.provenance)
        if (w.ok && w.wrote) {
          out.persisted += 1
          m.contact.enrichment_profile = { ...((m.contact.enrichment_profile as Record<string, unknown> | null) ?? {}), [REAL_ESTATE_INDICATORS_KEY]: { provider: "versium", ...r.indicators } }
          m.profile = lookalikeSeedProfile({ contact: m.contact, deal: m.deal, side: m.side })
        } else if (!w.ok) out.skipped = `persist_refused: ${w.error}`
      } else if (r.skipped && /^(budget|unconfigured|no_brokerage|provider_failing|budget_unavailable)/.test(r.skipped)) { out.skipped = r.skipped; break }
    }
    if (live.degraded && !out.skipped) out.skipped = "live_deal_check_degraded"
  } catch (e) {
    out.skipped = `error: ${e instanceof Error ? e.message : String(e)}`
  }
  return out
}

// ─── I/O: THE RESEARCH RUN ───────────────────────────────────────────────────────────────────────────────────────────
export interface LookalikeResearchRun {
  brokerageId: string
  seedCount: number
  research: LookalikeResearch | null
  enrichment: LookalikeEnrichmentSummary
  estimate: { asked: boolean; estimatedRecords: number | null; skipped: string | null }
  briefs: { composed: number; staged: number; existing: number }
  keywords: { composed: number; staged: number; existing: number }
  skipped: string | null
  errors: string[]
}

/** ISO week stamp — the cycle the weekly staging is idempotent on. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7)).padStart(2, "0")}`
}

/** Content briefs into content_topic_bank — the same rows the competitor promoter writes, so pickTopics / farm-mail / every generator read them without knowing the source. Idempotent on `raw_data.lookalike_research_key`. */
async function stageBriefs(svc: Svc, brokerageId: string, briefs: ResearchBrief[], ctx: { seedCount: number; estimate: VersiumAudienceEstimate | null; now: Date }): Promise<{ staged: number; existing: number; error?: string }> {
  if (briefs.length === 0) return { staged: 0, existing: 0 }
  const nowIso = ctx.now.toISOString()
  const { data: live, error: readError } = await svc.from("content_topic_bank").select("id, raw_data").eq("brokerage_id", brokerageId).gte("expires_at", nowIso)
  if (readError) return { staged: 0, existing: 0, error: `topic bank read: ${readError.message}` }
  const have = new Set<string>()
  for (const r of (live ?? []) as Array<{ raw_data: Record<string, unknown> | null }>) { const k = r.raw_data?.lookalike_research_key; if (typeof k === "string") have.add(k) }
  let staged = 0
  for (const b of briefs) {
    if (have.has(b.key)) continue
    const { error } = await svc.from("content_topic_bank").insert({
      brokerage_id: brokerageId, topic_title: b.title, value_angle: b.valueAngle, source_url: null,
      categories: ["customer_lookalike_research"], engagement_score: b.engagement, topic_posted_at: nowIso, scraped_at: nowIso,
      expires_at: new Date(ctx.now.getTime() + 30 * 86_400_000).toISOString(), status: "fresh", geo_relevance: null,
      raw_data: {
        lookalike_research_key: b.key, generated_at: nowIso, seed_count: ctx.seedCount, attributes: b.attributes,
        fair_housing: "describes the home and the moment — never the person; the Fair Housing gate still runs on the written copy",
        audience_estimate: ctx.estimate && ctx.estimate.estimatedRecords !== null ? { estimated_records: ctx.estimate.estimatedRecords, source: "versium_b2c_listgen_estimate" } : null,
      },
    })
    if (error) return { staged, existing: have.size, error: `topic bank insert: ${error.message}` }
    staged += 1
  }
  return { staged, existing: briefs.length - staged }
}

/** Acquisition keywords STAGED INACTIVE in lead_scraping_keywords — the tenant-managed table the acquisition sourcers read; a human enables them in the existing scraping config. Idempotent on (brokerage, keyword). */
async function stageKeywords(svc: Svc, brokerageId: string, keywords: LookalikeAcquisitionInputs["keywords"]): Promise<{ staged: number; existing: number; error?: string }> {
  if (keywords.length === 0) return { staged: 0, existing: 0 }
  const { data: rows, error: readError } = await svc.from("lead_scraping_keywords").select("keyword").eq("brokerage_id", brokerageId)
  if (readError) return { staged: 0, existing: 0, error: `keywords read: ${readError.message}` }
  const have = new Set(((rows ?? []) as Array<{ keyword: string | null }>).map((r) => (r.keyword ?? "").trim().toLowerCase()))
  let staged = 0
  for (const k of keywords) {
    if (have.has(k.keyword.toLowerCase())) continue
    const { error } = await svc.from("lead_scraping_keywords").insert({
      brokerage_id: brokerageId, keyword: k.keyword, keyword_type: k.keyword_type, sources: [...KEYWORD_SOURCE_KEYS], weight: k.weight, is_active: false,
    })
    if (error) return { staged, existing: have.size, error: `keywords insert: ${error.message}` }
    staged += 1
  }
  return { staged, existing: keywords.length - staged }
}

type ResearchOpts = { now?: Date; enrich?: { maxContacts?: number; maxMs?: number } | false }
type ResearchDeps = {
  leg?: typeof import("@/lib/ai-isa/property-lookup-rail").runVersiumOnlinePresenceLeg
  estimateLeg?: typeof import("@/lib/ai-isa/property-lookup-rail").runVersiumAudienceEstimateLeg
  suppressed?: (ids: string[]) => Promise<{ suppressed: Set<string>; degraded: boolean }>
}

function emptyRun(brokerageId: string): LookalikeResearchRun {
  return {
    brokerageId, seedCount: 0, research: null,
    enrichment: { eligible: 0, asked: 0, answered: 0, persisted: 0, costUsd: 0, skipped: "disabled" },
    estimate: { asked: false, estimatedRecords: null, skipped: null },
    briefs: { composed: 0, staged: 0, existing: 0 }, keywords: { composed: 0, staged: 0, existing: 0 }, skipped: null, errors: [],
  }
}

/** The whole research pass — seed → bounded online-behaviour pass → picture → briefs + acquisition inputs → free estimate → staging. */
async function researchPipeline(svc: Svc, brokerageId: string, now: Date, opts: ResearchOpts, deps: ResearchDeps): Promise<LookalikeResearchRun> {
  const run = emptyRun(brokerageId)
  const seed = await loadLookalikeSeed(svc, brokerageId)
  if (seed.error) { run.errors.push(seed.error); run.skipped = "seed_unreadable"; return run }
  const members = seed.members
  run.seedCount = members.length
  if (members.length < RESEARCH_MIN_SEED) { run.skipped = `seed too thin (${members.length} < ${RESEARCH_MIN_SEED})`; return run }

  if (opts.enrich !== false) {
    run.enrichment = await enrichSeedOnlinePresence(svc, brokerageId, members, {
      maxContacts: opts.enrich?.maxContacts ?? LOOKALIKE_RESEARCH_ENRICH_MAX_PER_RUN, maxMs: opts.enrich?.maxMs ?? LOOKALIKE_RESEARCH_ENRICH_MAX_MS,
      now, leg: deps.leg, suppressed: deps.suppressed,
    })
  }
  const research = researchLookalikeDenominators(members.map((m) => m.profile))
  run.research = research
  if (!research) { run.skipped = "no research"; return run }

  const briefs = composeResearchBriefs(research)
  const acquisition = composeAcquisitionInputs(research)
  run.briefs.composed = briefs.length
  run.keywords.composed = acquisition.keywords.length

  let estimate: VersiumAudienceEstimate | null = null
  if (acquisition.estimateFilters) {
    run.estimate.asked = true
    const leg = deps.estimateLeg ?? (await import("@/lib/ai-isa/property-lookup-rail")).runVersiumAudienceEstimateLeg
    const r = await leg({ brokerageId, filters: acquisition.estimateFilters })
    estimate = r.estimate
    run.estimate.estimatedRecords = r.estimate?.estimatedRecords ?? null
    run.estimate.skipped = r.skipped
  }

  const b = await stageBriefs(svc, brokerageId, briefs, { seedCount: research.seedCount, estimate, now })
  const k = await stageKeywords(svc, brokerageId, acquisition.keywords)
  run.briefs = { composed: briefs.length, staged: b.staged, existing: b.existing }
  run.keywords = { composed: acquisition.keywords.length, staged: k.staged, existing: k.existing }
  if (b.error) run.errors.push(b.error)
  if (k.error) run.errors.push(k.error)
  return run
}

/**
 * THE LOOK-ALIKE RESEARCH (wave 143, lane 143D): what the tenant's own closed customers have in common → content briefs
 * (content_topic_bank) → staged lead-acquisition inputs (inactive lead_scraping_keywords) + a free Versium audience-size
 * read of the research-derived territory. Independent of the ad draft: a seed too thin to seed an ad (MIN_SEED 5) can
 * still be researched (RESEARCH_MIN_SEED 3). NOTHING here targets anyone, sends anything, or spends beyond the bounded,
 * budget-gated, live-deal-suppressed online-presence pass.
 *
 * ONE LEDGERED ACTION PER TENANT PER ISO WEEK (withActionLedger — who / why / what / cost, LAW 5), claimed BEFORE anything is
 * read or bought: a cron retry, a double-fire or a second caller in the same week REPLAYS (`skipped: already_ran_this_week`)
 * instead of buying a second batch of indicators or staging twice, so the weekly spend cap really is weekly. A failed run
 * (an unreadable seed, a refused insert) settles `failed` and is re-claimed by the next attempt.
 */
export async function runLookalikeResearch(
  brokerageId: string,
  opts: ResearchOpts = {},
  client?: Svc,
  deps: ResearchDeps = {},
): Promise<LookalikeResearchRun> {
  const svc = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<LookalikeResearchRun>({
    brokerageId, action: "ads.lookalike_research.stage",
    actor: { type: "manager", managerKey: "ads_manager" }, subject: { type: "brokerage", id: brokerageId }, cycle: isoWeek(now),
    reasonCode: "CAMPAIGN_STEP", reasonDetail: "weekly look-alike research: content briefs + inactive acquisition keywords from the tenant's own closed customers (research, not targeting)",
    riskClass: "LOW_RISK_WRITE", systemSource: "lookalike_research",
    detail: { enrichCapPerRun: opts.enrich === false ? 0 : opts.enrich?.maxContacts ?? LOOKALIKE_RESEARCH_ENRICH_MAX_PER_RUN },
  }, () => researchPipeline(svc, brokerageId, now, opts, deps), {
    settle: (r) => ({
      status: r.errors.length > 0 ? "failed" : "executed",
      outcome: `seed=${r.seedCount};briefs=${r.briefs.staged};keywords=${r.keywords.staged};asked=${r.enrichment.asked};estimate=${r.estimate.estimatedRecords ?? "none"}${r.skipped ? `;skipped=${r.skipped}` : ""}`.slice(0, 500),
      provider: r.enrichment.asked > 0 ? "versium" : null, costUsd: r.enrichment.costUsd, error: r.errors[0] ?? null,
    }),
    replay: (claim) => ({ ...emptyRun(brokerageId), skipped: `already_ran_this_week (${claim.kind})` }),
  }, { client: svc as unknown as { from: (t: string) => any } })
}

export interface LookalikeResult { seedCount: number; staged: boolean; reason?: string }

/**
 * Build the closing-table seed for a brokerage and stage (draft) a lookalike ad
 * campaign. Idempotent per week (campaign_name keyed). Nothing launches.
 * Wave 143: this is the AD DRAFT only. The research is its own capability (runLookalikeResearch) — the weekly cron
 * (app/api/cron/lookalike-audience/route.ts) runs both, each isolated, so a seed too thin for an ad is still researched.
 */
export async function runLookalikeAudience(
  brokerageId: string, opts: { now?: Date } = {}, client?: Svc,
): Promise<LookalikeResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()

  // The closing table — closed deals with a buyer + their listing's city.
  const { data: closed } = await supabase.from("transactions")
    .select("buyer_contact_id, listing_id").eq("brokerage_id", brokerageId)
    .eq("status", "closed").not("buyer_contact_id", "is", null).limit(2000)
  const rows = (closed ?? []) as Array<{ buyer_contact_id: string; listing_id: string | null }>
  const buyers = new Set(rows.map((r) => r.buyer_contact_id))
  const listingIds = Array.from(new Set(rows.map((r) => r.listing_id).filter((x): x is string => !!x)))

  let cities: string[] = []
  if (listingIds.length > 0) {
    const { data: ls } = await supabase.from("listings").select("city").in("id", listingIds.slice(0, 500))
    cities = Array.from(new Set(((ls ?? []) as any[]).map((l) => l.city).filter(Boolean)))
  }

  const spec = composeLookalike({ seedCount: buyers.size, cities })
  if (!spec) return { seedCount: buyers.size, staged: false, reason: `seed too thin (${buyers.size} < ${MIN_SEED})` }

  const weekStamp = now.toISOString().slice(0, 10)
  const campaignName = `${spec.name} — ${weekStamp}`
  const { data: existing } = await supabase.from("ad_campaigns").select("id")
    .eq("brokerage_id", brokerageId).eq("campaign_name", campaignName).limit(1).maybeSingle()
  if (existing) return { seedCount: buyers.size, staged: false, reason: "already staged this week" }

  // 143D: the targeting spec carries the LOCATION seed only — the research picture (people-traits) lives in
  // runLookalikeResearch's outputs, never inside something a human could push to an ad platform.
  const { error } = await supabase.from("ad_campaigns").insert({
    brokerage_id: brokerageId, campaign_name: campaignName, platform: "facebook",
    status: "draft", objective: "lead_generation", targeting_config: { ...spec.targeting },
  })
  return { seedCount: buyers.size, staged: !error, reason: error ? error.message : undefined }
}
