// lib/lead-magnets/suggestions.ts
//
// PROACTIVE LEAD-MAGNET IDEAS — wave 141, lane 141E (owner: "AI proactively suggests ideas
// (seasonal, local-market, audience gaps, underperformers, tests)").
//
// SURVIVOR EVALUATED, REUSED: the suggestion rides the manager-signal bus (lib/kernel/manager-signals.ts
// publishManagerSignal → manager_signals, feed_only — the same rail channel_order_recommendation and
// agent_reassignment_suggested already ride) with the registered type LEAD_MAGNET_SUGGESTION_SIGNAL.
// improvement_proposals was evaluated and NOT used: its subject kinds are CHECK-constrained
// (policy / prompt / variant / threshold / allocation / strategy / experiment / law_rule) and an idea
// for a page a human has not built yet is a recommendation, not a promotable change — widening
// the CHECK for it would be a migration with no evaluator behind it. An accepted idea becomes a
// REAL draft through draftLeadMagnetFromConcept (lib/lead-magnets/ai-draft.ts), and a drafted
// magnet's outcomes flow back through the same ledgers every other magnet's do.
//
// DETERMINISTIC (no model call): every idea names its evidence. Territories come from the tenant's
// farm_territories rows (never a hard-coded city / state — tenants are nationwide); the season from
// `now`; the audience mix from the tenant's own contacts; underperformers from the magnet's own
// views vs submissions. The pure half is proven directly; the runner publishes.

import type { MagnetType } from "@/lib/marketing/lead-magnet-copy"

/** @proofSeam the registered signal type (lib/kernel/signal-registry.ts keys it literally); the proof asserts the registry entry against it. */
export const LEAD_MAGNET_SUGGESTION_SIGNAL = "lead_magnet_suggestion"

type LeadMagnetSuggestionKind = "seasonal" | "local_market" | "audience_gap" | "underperformer" | "test"

interface LeadMagnetSuggestion {
  /** Stable per-idea key — the dedupe identity on the bus (payload.key). */
  key: string
  kind: LeadMagnetSuggestionKind
  magnetType: MagnetType
  /** The concept a human hands to the AI draft ("Draft this with AI"). */
  concept: string
  why: string
  evidence: Record<string, unknown>
  /** The magnet the idea is about (underperformer / test), else null. */
  magnetId: string | null
}

interface SuggestionMagnet {
  id: string
  name: string
  magnetType: string
  isActive: boolean
  views30d: number
  submissions30d: number
}

interface SuggestionInputs {
  now: Date
  magnets: SuggestionMagnet[]
  /** New contacts in the look-back window, by intent side (the tenant's own book). */
  contactMix: { buyers: number; sellers: number }
  /** The tenant's active farm territory names — read from farm_territories, never typed here. */
  territories: string[]
}

const SUGGESTION_LIMIT = 5
/** An active magnet needs this many views before "nobody submits" is a finding, not noise. */
const UNDERPERFORMER_MIN_VIEWS = 50
const UNDERPERFORMER_MAX_RATE = 0.02
/** A magnet with this much traffic is worth a headline test. */
const TEST_MIN_VIEWS = 100

interface Season { label: string; magnetType: MagnetType; concept: string }

/** The season by month (UTC) — a calendar fact, not a market claim. @proofSeam asserted directly by the proof. */
export function seasonFor(now: Date): Season {
  const m = now.getUTCMonth() // 0..11
  if (m <= 1) return { label: "new-year", magnetType: "home_valuation", concept: "A new-year home value check: what your home is worth going into the year and what the next 12 months could mean for your equity" }
  if (m <= 4) return { label: "spring", magnetType: "seller_guide", concept: "A spring selling guide: how to prep, price and market a home for the busiest listing season" }
  if (m <= 7) return { label: "summer", magnetType: "buyer_guide", concept: "A summer home-buying guide: moving between school years, writing a strong offer and what to budget beyond the price" }
  if (m <= 10) return { label: "fall", magnetType: "market_report", concept: "A fall market report: how prices and days on market are shifting locally and what it means for timing a move" }
  return { label: "year-end", magnetType: "home_valuation", concept: "A year-end equity review: what your home is worth now and whether a move or a refinance makes sense next year" }
}

const SELLER_TYPES = new Set(["home_valuation", "seller_guide", "market_report"])
const BUYER_TYPES = new Set(["buyer_guide", "listing_alert", "open_house"])

/** PURE — the ideas, deterministic and evidence-bearing, at most SUGGESTION_LIMIT, in rank order.
 *  @proofSeam the proof drives the matrix (each kind with its control) directly; the runner is the product caller. */
export function suggestLeadMagnetIdeas(input: SuggestionInputs): LeadMagnetSuggestion[] {
  const out: LeadMagnetSuggestion[] = []
  const active = input.magnets.filter((m) => m.isActive)
  const activeTypes = new Set(active.map((m) => m.magnetType))

  // 1. Underperformers — traffic without conversions on a LIVE page is the strongest, most specific finding.
  for (const m of active) {
    if (m.views30d < UNDERPERFORMER_MIN_VIEWS) continue
    const rate = m.views30d > 0 ? m.submissions30d / m.views30d : 0
    if (rate < UNDERPERFORMER_MAX_RATE) {
      out.push({
        key: `underperformer:${m.id}`, kind: "underperformer", magnetType: (m.magnetType as MagnetType) || "generic_form", magnetId: m.id,
        concept: `Refresh "${m.name}": a sharper headline, a clearer offer and fewer questions on the form`,
        why: `${m.views30d} views and ${m.submissions30d} submissions in 30 days (${(rate * 100).toFixed(1)}% — under ${(UNDERPERFORMER_MAX_RATE * 100).toFixed(0)}%)`,
        evidence: { views30d: m.views30d, submissions30d: m.submissions30d, rate },
      })
    }
  }

  // 2. Audience gap — the tenant's own book leans one way and no live magnet serves the other side.
  const { buyers, sellers } = input.contactMix
  if (sellers >= 10 && sellers > buyers * 2 && ![...activeTypes].some((t) => BUYER_TYPES.has(t))) {
    out.push({ key: "audience_gap:buyers", kind: "audience_gap", magnetType: "buyer_guide", magnetId: null,
      concept: "A buyer guide for the buyers your seller clients keep referring: pre-approval, offers and what to budget beyond the price",
      why: `${sellers} new seller contacts vs ${buyers} buyers in 90 days, and no live buyer-side magnet`, evidence: { buyers, sellers } })
  }
  if (buyers >= 10 && buyers > sellers * 2 && ![...activeTypes].some((t) => SELLER_TYPES.has(t))) {
    out.push({ key: "audience_gap:sellers", kind: "audience_gap", magnetType: "home_valuation", magnetId: null,
      concept: "A home value check for the owners behind your buyer pipeline: an instant estimate, then a precise agent-prepared number",
      why: `${buyers} new buyer contacts vs ${sellers} sellers in 90 days, and no live seller-side magnet`, evidence: { buyers, sellers } })
  }

  // 3. Seasonal — only when the tenant has no live magnet of that type already.
  const season = seasonFor(input.now)
  if (!activeTypes.has(season.magnetType)) {
    out.push({ key: `seasonal:${season.label}:${season.magnetType}`, kind: "seasonal", magnetType: season.magnetType, magnetId: null,
      concept: season.concept, why: `it is ${season.label} season and no live ${season.magnetType.replace(/_/g, " ")} magnet exists`, evidence: { season: season.label, month: input.now.getUTCMonth() + 1 } })
  }

  // 4. Local market — a market report per territory the TENANT farms (never a typed location).
  if (!activeTypes.has("market_report")) {
    for (const t of input.territories.filter((x) => typeof x === "string" && x.trim()).slice(0, 2)) {
      out.push({ key: `local_market:${t.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, kind: "local_market", magnetType: "market_report", magnetId: null,
        concept: `A monthly market report for ${t}: prices, days on market and what it means for homeowners there`,
        why: `${t} is an active farm territory with no live market-report magnet`, evidence: { territory: t } })
    }
  }

  // 5. Tests — a live page with real traffic earns a headline test.
  for (const m of active) {
    if (m.views30d >= TEST_MIN_VIEWS && !out.some((s) => s.magnetId === m.id)) {
      out.push({ key: `test:${m.id}`, kind: "test", magnetType: (m.magnetType as MagnetType) || "generic_form", magnetId: m.id,
        concept: `Clone "${m.name}" as a B variant with a different headline and offer framing, and compare submissions`,
        why: `${m.views30d} views in 30 days — enough traffic to learn from a second headline`, evidence: { views30d: m.views30d, submissions30d: m.submissions30d } })
    }
  }

  return out.slice(0, SUGGESTION_LIMIT)
}

// ── Runner (tenant-scoped reads; publishes on the bus) ─────────────────────────────────────

type Svc = { from: (t: string) => any }

interface SuggestionRunResult {
  ok: boolean
  suggestions: LeadMagnetSuggestion[]
  published: number
  deduped: number
  error?: string
}

/**
 * Gather the tenant's own evidence, suggest, and publish each NEW idea as a feed-only manager signal
 * (ai_isa — the intake desk that sees the audience mix — → campaign_orchestrator, who owns the lead-magnet
 * surfaces). Deduped per idea key against OPEN signals of this type, so a sweep that runs daily never
 * repeats itself. Reads are pinned to `brokerageId` (the caller's verified tenant). Never throws.
 */
export async function runLeadMagnetSuggestions(
  svc: Svc,
  brokerageId: string,
  opts: { now?: Date; publish?: boolean } = {},
): Promise<SuggestionRunResult> {
  if (!brokerageId) return { ok: false, suggestions: [], published: 0, deduped: 0, error: "no brokerage" }
  const now = opts.now ?? new Date()
  const d30 = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const d90 = new Date(now.getTime() - 90 * 86_400_000).toISOString()
  try {
    const { data: forms, error: formsErr } = await svc.from("lead_capture_forms")
      .select("id, name, magnet_type, is_active").eq("brokerage_id", brokerageId).limit(500)
    if (formsErr) return { ok: false, suggestions: [], published: 0, deduped: 0, error: `lead_capture_forms read refused: ${formsErr.message}` }
    const rows = (forms ?? []) as Array<{ id: string; name: string; magnet_type: string | null; is_active: boolean | null }>
    const ids = rows.map((r) => r.id)

    const views = new Map<string, number>()
    const subs = new Map<string, number>()
    if (ids.length > 0) {
      const { data: viewRows, error: viewErr } = await svc.from("lifecycle_events").select("entity_id")
        .eq("brokerage_id", brokerageId).eq("event_type", "lead_magnet_view").in("entity_id", ids).gte("created_at", d30).limit(5000)
      if (viewErr) console.warn("[lead-magnet-suggestions] view read refused:", viewErr.message)
      for (const v of (viewRows ?? []) as Array<{ entity_id: string }>) views.set(v.entity_id, (views.get(v.entity_id) ?? 0) + 1)
      const { data: subRows, error: subErr } = await svc.from("form_submissions").select("form_id")
        .eq("brokerage_id", brokerageId).in("form_id", ids).gte("submitted_at", d30).limit(5000)
      if (subErr) console.warn("[lead-magnet-suggestions] submission read refused:", subErr.message)
      for (const s of (subRows ?? []) as Array<{ form_id: string }>) subs.set(s.form_id, (subs.get(s.form_id) ?? 0) + 1)
    }

    const { data: contactRows, error: cErr } = await svc.from("contacts").select("contact_type")
      .eq("brokerage_id", brokerageId).gte("created_at", d90).in("contact_type", ["buyer", "seller", "both"]).limit(5000)
    if (cErr) console.warn("[lead-magnet-suggestions] contact mix read refused:", cErr.message)
    let buyers = 0, sellers = 0
    for (const c of (contactRows ?? []) as Array<{ contact_type: string | null }>) {
      if (c.contact_type === "buyer" || c.contact_type === "both") buyers++
      if (c.contact_type === "seller" || c.contact_type === "both") sellers++
    }

    const { data: terrRows, error: tErr } = await svc.from("farm_territories").select("name")
      .eq("brokerage_id", brokerageId).eq("is_active", true).limit(20)
    if (tErr) console.warn("[lead-magnet-suggestions] territory read refused:", tErr.message)
    const territories = ((terrRows ?? []) as Array<{ name: string | null }>).map((t) => t.name ?? "").filter(Boolean)

    const suggestions = suggestLeadMagnetIdeas({
      now,
      magnets: rows.map((r) => ({ id: r.id, name: r.name, magnetType: r.magnet_type ?? "generic_form", isActive: r.is_active === true, views30d: views.get(r.id) ?? 0, submissions30d: subs.get(r.id) ?? 0 })),
      contactMix: { buyers, sellers },
      territories,
    })
    if (opts.publish === false || suggestions.length === 0) return { ok: true, suggestions, published: 0, deduped: 0 }

    // Dedupe per idea key against OPEN signals of this type (the bus dedupes on entity_id, which several
    // brokerage-level ideas share — so the key, not the entity, is the identity here).
    const { data: openRows, error: openErr } = await svc.from("manager_signals").select("payload")
      .eq("brokerage_id", brokerageId).eq("to_manager", "campaign_orchestrator").eq("signal_type", LEAD_MAGNET_SUGGESTION_SIGNAL).eq("status", "open").limit(200)
    if (openErr) return { ok: false, suggestions, published: 0, deduped: 0, error: `open-signal read refused: ${openErr.message}` }
    const openKeys = new Set(((openRows ?? []) as Array<{ payload: Record<string, unknown> | null }>).map((r) => String(r.payload?.key ?? "")))

    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    let published = 0, deduped = 0
    for (const s of suggestions) {
      if (openKeys.has(s.key)) { deduped++; continue }
      const r = await publishManagerSignal({
        brokerageId, fromManager: "ai_isa", toManager: "campaign_orchestrator", signalType: LEAD_MAGNET_SUGGESTION_SIGNAL,
        message: `Lead-magnet idea (${s.kind.replace(/_/g, " ")}): ${s.concept} — ${s.why}`,
        entityType: s.magnetId ? "lead_capture_form" : "brokerage", entityId: s.magnetId ?? brokerageId,
        payload: { key: s.key, kind: s.kind, magnetType: s.magnetType, concept: s.concept, why: s.why, evidence: s.evidence, magnetId: s.magnetId },
        dedupe: false,
      }, svc as any)
      if (r.ok) published++
      else console.warn(`[lead-magnet-suggestions] signal not published (${s.key}): ${r.reason}`)
    }
    return { ok: true, suggestions, published, deduped }
  } catch (e) {
    return { ok: false, suggestions: [], published: 0, deduped: 0, error: (e as Error)?.message ?? String(e) }
  }
}
