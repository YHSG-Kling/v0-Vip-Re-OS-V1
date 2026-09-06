// lib/analytics/territory-coverage.ts
// ─── TERRITORY COVERAGE MAP (owner round 39, rec 2) ──────────────────────────
//
// A PURE READ over the same ground truth the round-38 scrape resolver runs on:
//   • WHO claims each zip → subscriber_service_areas (the per-zip claim roster,
//     synced from lead_scraping_markets by app/actions/lead-scraping-config.ts),
//     filtered by the SAME active-tenant predicate the scrapers use
//     (ACTIVE_SUBSCRIPTION_STATUSES via activeSubscriberBrokerageIds — a claim
//     by a past_due/cancelled tenant is a STALE claim, counted but never shown
//     as live coverage, exactly as the resolver would refuse to scrape for it).
//   • WHAT each zip produced → window-bounded lead volume: raw scraped records
//     (raw_scraped_leads, zip read from normalized_preview) and promoted leads
//     (leads rows carrying raw_record_id — the pipeline-processor promotion
//     stamp), plus platform-origin lead volume per zip.
//   • WHO is waiting → leads with brokerage_id IS NULL: platform-origin leads
//     that promoted with no owning tenant (parked, awaiting a subscriber).
//     This module only READS that signal — the parking/distribution lane is
//     owned elsewhere (lib/platform/distribution-engine.ts, untouched).
//
// HONESTY RULES:
//   • No map library, no geo adjacency data — the board is a sortable
//     state → zip table, and "expansion hints" are SAME-STATE unclaimed zips
//     with real platform-lead volume, explicitly labeled as such (adjacency is
//     not computed because no adjacency source exists in this system).
//   • Every read is window-bounded and row-capped; when a cap is hit the board
//     says so instead of presenting the truncated tally as a total.
//   • Empty states are stated ("no active subscriber claims any zip yet"),
//     never padded with fabricated coverage.
//
// Mounts: the superadmin coverage board (app/dashboard/superadmin/platform)
// and the tenant "Your coverage" card (app/dashboard/admin/scrape-diagnostics).

import { activeSubscriberBrokerageIds, ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/lead-pipeline/subscription-gate"

// ─── Declared constants (named in the labels — never implied) ────────────────

/** Days of lead/raw volume the coverage board counts. */
export const COVERAGE_WINDOW_DAYS = 30
/** Row cap per bounded read — a hit cap is reported, never silently truncated. */
const COVERAGE_ROW_CAP = 5000
/** Max expansion hints shown on the tenant card. */
export const EXPANSION_HINT_LIMIT = 12

// ─── Row shapes (fixture-friendly — the simulator drives these directly) ─────

export interface ServiceAreaClaim {
  brokerage_id: string | null
  zip_code: string | null
  city?: string | null
  state?: string | null
  active?: boolean | null
}

export interface CoverageLeadRow {
  zip_code: string | null
  state?: string | null
  brokerage_id: string | null
  /** Set by the pipeline-processor promotion — marks a scrape-promoted lead. */
  raw_record_id?: string | null
  source_origin?: string | null
  created_at?: string | null
}

export interface ZipCoverageRow {
  zip: string
  /** Best-known state: claim row first, then any lead row; "—" when unknown. */
  state: string
  city: string | null
  /** ACTIVE-subscription claimants only (the resolver's own predicate). */
  claimedBy: Array<{ brokerageId: string; name: string }>
  /** Raw scraped records normalized to this zip inside the window. */
  rawCount: number
  /** Scrape-promoted leads (leads.raw_record_id set) in this zip, window. */
  promotedCount: number
  /** All leads in this zip inside the window (any origin, any owner). */
  leadCount: number
  /** Platform-origin leads in this zip inside the window. */
  platformLeadCount: number
  /** Leads with brokerage_id IS NULL — parked, awaiting a subscriber. */
  awaitingSubscriber: number
}

export interface CoverageTotals {
  /** Distinct zips with at least one ACTIVE-subscriber claim. */
  claimedZips: number
  /** Distinct active-subscription brokerages holding at least one claim. */
  activeClaimants: number
  /** Zips with window volume (raw or lead) that NO active subscriber claims. */
  unclaimedZipsWithVolume: number
  /** Total parked platform leads (brokerage_id IS NULL) in the window. */
  awaitingSubscriberLeads: number
  rawTotal: number
  promotedTotal: number
  /** Claims held by tenants WITHOUT an active subscription — stale, not live coverage. */
  staleClaims: number
}

export interface CoverageBoard {
  zips: ZipCoverageRow[]
  /** state → its zips (already sorted); the board's grouping. */
  byState: Array<{ state: string; zips: ZipCoverageRow[] }>
  totals: CoverageTotals
  windowDays: number
  /** True when any bounded read hit its row cap — tallies are then floors, not totals. */
  capped: boolean
  honestNotes: string[]
  generatedAt: string
}

export interface CoverageInputs {
  subscriptions: Array<{ brokerage_id: string | null; status: string | null }>
  serviceAreas: ServiceAreaClaim[]
  brokerages: Array<{ id: string; name: string | null }>
  leadRows: CoverageLeadRow[]
  /** One entry per raw scraped record in the window: its normalized zip (null = zip unknown). */
  rawZips: Array<string | null>
  windowDays?: number
  capped?: boolean
}

const UNKNOWN_ZIP = "(zip unknown)"
const UNKNOWN_STATE = "—"

const cleanZip = (z: string | null | undefined): string | null => {
  const t = (z ?? "").trim()
  return t.length > 0 ? t : null
}

// ─── PURE: the coverage board from raw inputs ────────────────────────────────

export function composeCoverageBoard(inputs: CoverageInputs): CoverageBoard {
  const windowDays = inputs.windowDays ?? COVERAGE_WINDOW_DAYS
  const activeIds = activeSubscriberBrokerageIds(inputs.subscriptions)
  const nameById = new Map(inputs.brokerages.map((b) => [b.id, b.name?.trim() || b.id.slice(0, 8)]))

  const rows = new Map<string, ZipCoverageRow>()
  const rowFor = (zipRaw: string | null): ZipCoverageRow => {
    const zip = cleanZip(zipRaw) ?? UNKNOWN_ZIP
    let row = rows.get(zip)
    if (!row) {
      row = {
        zip, state: UNKNOWN_STATE, city: null, claimedBy: [],
        rawCount: 0, promotedCount: 0, leadCount: 0, platformLeadCount: 0, awaitingSubscriber: 0,
      }
      rows.set(zip, row)
    }
    return row
  }

  // 1) Claims — ACTIVE tenants only (the resolver predicate, reused verbatim).
  //    Claims by non-active tenants are counted as stale, never shown as coverage.
  let staleClaims = 0
  const activeClaimants = new Set<string>()
  for (const a of inputs.serviceAreas) {
    if (a.active === false) continue
    const zip = cleanZip(a.zip_code)
    if (!zip || !a.brokerage_id) continue
    if (!activeIds.has(a.brokerage_id)) { staleClaims += 1; continue }
    const row = rowFor(zip)
    if (!row.claimedBy.some((c) => c.brokerageId === a.brokerage_id)) {
      row.claimedBy.push({ brokerageId: a.brokerage_id, name: nameById.get(a.brokerage_id) ?? a.brokerage_id.slice(0, 8) })
    }
    activeClaimants.add(a.brokerage_id)
    if (a.state?.trim()) row.state = a.state.trim().toUpperCase()
    if (!row.city && a.city?.trim()) row.city = a.city.trim()
  }

  // 2) Lead volume per zip (window rows, already filtered by the loader).
  let awaitingTotal = 0
  let promotedTotal = 0
  for (const l of inputs.leadRows) {
    const row = rowFor(l.zip_code)
    row.leadCount += 1
    if (l.raw_record_id) { row.promotedCount += 1; promotedTotal += 1 }
    if ((l.source_origin ?? null) === "platform") row.platformLeadCount += 1
    if (l.brokerage_id == null) { row.awaitingSubscriber += 1; awaitingTotal += 1 }
    if (row.state === UNKNOWN_STATE && l.state?.trim()) row.state = l.state.trim().toUpperCase()
  }

  // 3) Raw scraped volume per zip.
  let rawTotal = 0
  for (const z of inputs.rawZips) {
    rowFor(z).rawCount += 1
    rawTotal += 1
  }

  const zips = [...rows.values()].sort((a, b) => a.state.localeCompare(b.state) || a.zip.localeCompare(b.zip))

  const byStateMap = new Map<string, ZipCoverageRow[]>()
  for (const z of zips) byStateMap.set(z.state, [...(byStateMap.get(z.state) ?? []), z])
  const byState = [...byStateMap.entries()]
    .map(([state, stateZips]) => ({ state, zips: stateZips }))
    .sort((a, b) => a.state.localeCompare(b.state))

  const totals: CoverageTotals = {
    claimedZips: zips.filter((z) => z.claimedBy.length > 0).length,
    activeClaimants: activeClaimants.size,
    unclaimedZipsWithVolume: zips.filter((z) => z.claimedBy.length === 0 && (z.rawCount + z.leadCount) > 0).length,
    awaitingSubscriberLeads: awaitingTotal,
    rawTotal,
    promotedTotal,
    staleClaims,
  }

  const honestNotes = [
    `Claims count only tenants with an active subscription (${ACTIVE_SUBSCRIPTION_STATUSES.join("/")}) — the same predicate the scrape resolver enforces; ${staleClaims > 0 ? `${staleClaims} stale claim${staleClaims === 1 ? "" : "s"} by non-active tenants excluded from coverage.` : "no stale claims."}`,
    `"Awaiting subscriber" = promoted platform leads whose leads.brokerage_id is NULL — a real parked row, never an estimate.`,
    `Volume is the last ${windowDays} days, read bounded (cap ${COVERAGE_ROW_CAP} rows per ledger)${inputs.capped ? " — A CAP WAS HIT: counts are floors, not totals." : "."}`,
    `Raw-record zips come from the scraper's normalized preview; records without a normalized zip are tallied under "${UNKNOWN_ZIP}".`,
    "No map library and no adjacency data — this is a sortable state → zip table; nothing is drawn that the data cannot back.",
  ]

  return { zips, byState, totals, windowDays, capped: inputs.capped === true, honestNotes, generatedAt: new Date().toISOString() }
}

// ─── PURE: the tenant "Your coverage" view ───────────────────────────────────

export interface TenantMarketInfo {
  id: string
  name: string | null
  city: string | null
  state: string | null
  zip_codes: string[] | null
  is_active: boolean
}

export interface TenantCoverage {
  brokerageId: string
  /** Their configured scraping markets (lead_scraping_markets). */
  markets: TenantMarketInfo[]
  /** Their claimed zips, each with the board's window volume. */
  claimedZips: ZipCoverageRow[]
  /** Window lead volume across their claimed zips + their own leads. */
  totals: { claimedZips: number; leadCount: number; promotedCount: number; rawCount: number }
  /** SAME-STATE unclaimed zips with real platform-lead volume — honest expansion
   *  hints (no adjacency math exists; the label says exactly what these are). */
  expansionHints: ZipCoverageRow[]
  honestNotes: string[]
}

export function composeTenantCoverage(
  board: CoverageBoard,
  brokerageId: string,
  markets: TenantMarketInfo[],
): TenantCoverage {
  const claimedZips = board.zips.filter((z) => z.claimedBy.some((c) => c.brokerageId === brokerageId))
  const tenantStates = new Set<string>()
  for (const z of claimedZips) if (z.state !== UNKNOWN_STATE) tenantStates.add(z.state)
  for (const m of markets) if (m.state?.trim()) tenantStates.add(m.state.trim().toUpperCase())

  // Expansion hints: unclaimed (by ANY active subscriber) zips in the tenant's
  // states with real platform-lead volume in the window. Only zips a subscriber
  // could actually receive leads from — never a zip with zero observed volume.
  const expansionHints = board.zips
    .filter((z) =>
      z.zip !== UNKNOWN_ZIP &&
      z.claimedBy.length === 0 &&
      tenantStates.has(z.state) &&
      z.platformLeadCount > 0,
    )
    .sort((a, b) => b.platformLeadCount - a.platformLeadCount || a.zip.localeCompare(b.zip))
    .slice(0, EXPANSION_HINT_LIMIT)

  const totals = {
    claimedZips: claimedZips.length,
    leadCount: claimedZips.reduce((s, z) => s + z.leadCount, 0),
    promotedCount: claimedZips.reduce((s, z) => s + z.promotedCount, 0),
    rawCount: claimedZips.reduce((s, z) => s + z.rawCount, 0),
  }

  return {
    brokerageId,
    markets,
    claimedZips,
    totals,
    expansionHints,
    honestNotes: [
      `Volume is the last ${board.windowDays} days across your claimed zips (subscriber_service_areas — synced from your scraping markets).`,
      "Expansion hints are SAME-STATE zips no active subscriber claims that produced real platform-lead volume in the window — adjacency is not computed (no map data exists in this system), and zips with zero observed volume are never suggested.",
      ...(board.capped ? ["A read cap was hit while tallying the window — counts are floors, not totals."] : []),
    ],
  }
}

// ─── IO: bounded loaders (read-only; any supabase client) ────────────────────

type AnyClient = { from: (table: string) => any }

async function loadCoverageInputs(supabase: AnyClient, windowDays: number): Promise<CoverageInputs | { error: string }> {
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  let capped = false

  const { data: subs, error: sErr } = await supabase.from("subscriptions").select("brokerage_id, status")
  if (sErr) return { error: `subscriptions: ${sErr.message}` }

  const { data: areas, error: aErr } = await supabase
    .from("subscriber_service_areas")
    .select("brokerage_id, zip_code, city, state, active")
    .eq("active", true)
    .limit(COVERAGE_ROW_CAP)
  if (aErr) return { error: `subscriber_service_areas: ${aErr.message}` }
  if ((areas ?? []).length >= COVERAGE_ROW_CAP) capped = true

  const claimantIds = [...new Set(((areas ?? []) as ServiceAreaClaim[]).map((a) => a.brokerage_id).filter(Boolean))] as string[]
  let brokerages: Array<{ id: string; name: string | null }> = []
  if (claimantIds.length > 0) {
    const { data: bks } = await supabase.from("brokerages").select("id, name").in("id", claimantIds.slice(0, 500))
    brokerages = (bks ?? []) as Array<{ id: string; name: string | null }>
  }

  const { data: leads, error: lErr } = await supabase
    .from("leads")
    .select("zip_code, state, brokerage_id, raw_record_id, source_origin, created_at")
    .gte("created_at", sinceIso)
    .limit(COVERAGE_ROW_CAP)
  if (lErr) return { error: `leads: ${lErr.message}` }
  if ((leads ?? []).length >= COVERAGE_ROW_CAP) capped = true

  // Raw zips live in the normalized preview jsonb — selected as a computed column.
  const { data: raws, error: rErr } = await supabase
    .from("raw_scraped_leads")
    .select("zip:normalized_preview->>zip, created_at")
    .gte("created_at", sinceIso)
    .limit(COVERAGE_ROW_CAP)
  if (rErr) return { error: `raw_scraped_leads: ${rErr.message}` }
  if ((raws ?? []).length >= COVERAGE_ROW_CAP) capped = true

  return {
    subscriptions: (subs ?? []) as Array<{ brokerage_id: string | null; status: string | null }>,
    serviceAreas: (areas ?? []) as ServiceAreaClaim[],
    brokerages,
    leadRows: (leads ?? []) as CoverageLeadRow[],
    rawZips: ((raws ?? []) as Array<{ zip: string | null }>).map((r) => r.zip ?? null),
    windowDays,
    capped,
  }
}

/** The superadmin coverage board — platform-wide, read-only. Failures degrade
 *  to an honest empty board carrying the why (never a fabricated map). */
export async function loadCoverageBoard(
  supabase: AnyClient,
  opts?: { windowDays?: number },
): Promise<{ board: CoverageBoard | null; error: string | null }> {
  try {
    const inputs = await loadCoverageInputs(supabase, opts?.windowDays ?? COVERAGE_WINDOW_DAYS)
    if ("error" in inputs) return { board: null, error: inputs.error }
    return { board: composeCoverageBoard(inputs), error: null }
  } catch (e) {
    return { board: null, error: e instanceof Error ? e.message : "coverage load failed" }
  }
}

/** The tenant "Your coverage" card — the same board math scoped to one tenant. */
export async function loadTenantCoverage(
  supabase: AnyClient,
  brokerageId: string,
  opts?: { windowDays?: number },
): Promise<{ coverage: TenantCoverage | null; error: string | null }> {
  try {
    const inputs = await loadCoverageInputs(supabase, opts?.windowDays ?? COVERAGE_WINDOW_DAYS)
    if ("error" in inputs) return { coverage: null, error: inputs.error }
    const { data: markets, error: mErr } = await supabase
      .from("lead_scraping_markets")
      .select("id, name, city, state, zip_codes, is_active")
      .eq("brokerage_id", brokerageId)
      .limit(200)
    if (mErr) return { coverage: null, error: `lead_scraping_markets: ${mErr.message}` }
    const board = composeCoverageBoard(inputs)
    const marketRows: TenantMarketInfo[] = ((markets ?? []) as any[]).map((m) => ({
      id: m.id, name: m.name ?? null, city: m.city ?? null, state: m.state ?? null,
      zip_codes: m.zip_codes ?? null, is_active: m.is_active === true,
    }))
    return { coverage: composeTenantCoverage(board, brokerageId, marketRows), error: null }
  } catch (e) {
    return { coverage: null, error: e instanceof Error ? e.message : "coverage load failed" }
  }
}
