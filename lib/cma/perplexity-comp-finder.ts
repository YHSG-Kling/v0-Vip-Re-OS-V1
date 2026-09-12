/**
 * PERPLEXITY COMP FINDER — THE LABELLED GAP-FILLER
 *
 * Uses Perplexity Sonar's web-search grounding to look up comparable properties
 * near a subject from public sources (Redfin, Zillow, Realtor.com, county
 * records).
 *
 * ─── STATUS: GAP-FILLER ONLY. NEVER A PRIMARY COMP SOURCE. ──────────────────
 * This module's status has been through two rulings and the current one is a
 * deliberate correction of the previous one.
 *
 *   Ruling 1 (commit 4495bb6): "AI must never be the comp source." This module
 *   was removed from the CMA path entirely and RentCast/IDX became the only
 *   sources — correct as far as it went, but it left the 1-PENDING requirement
 *   permanently unservable. RentCast's comparable feed carries NO under-contract
 *   status at all, and a connected IDX key only reports a pending listing if the
 *   brokerage's own featured feed happens to contain one. So the pending slot
 *   came back empty in the ordinary case, not the exceptional one.
 *
 *   Ruling 2 (owner, verbatim): "perplexitycma can fill in if comps cant be
 *   found like under contract/pending."
 *
 * So this is now reachable again — through EXACTLY ONE door,
 * lib/cma/comp-provider.sourceCompsForCma, and under these terms:
 *
 *   · PROVIDERS FIRST, ALWAYS. Nothing here runs until RentCast and (when
 *     connected) IDX Broker have been tried and a slot is still short.
 *   · PER-SLOT, NEVER WHOLESALE. If RentCast served 3 sold and 2 active but no
 *     pending, only the PENDING slot is filled from here.
 *   · THE SOLD SIDE IS NOT ADMITTED. Closed sales are the only input to a CMA's
 *     dollar range and to an appraiser packet's comparable-sales table, so they
 *     stay provider-verified. comp-provider.ts never requests the `closed` slot
 *     and states the refusal on the provenance. See AI_GAP_FILL_SLOTS there.
 *   · EVERY ROW IS LABELLED. `sourceProvider: "perplexity"` rides on each comp,
 *     the slot is recorded on `CompProvenance.aiGapFilledSlots`, and the
 *     seller-facing disclaimers say plainly that the row came from an AI web
 *     search and is unverified.
 *
 * ─── WHAT IT WILL NOT RETURN ────────────────────────────────────────────────
 * A row with no address, a non-positive price, or no citation is DROPPED rather
 * than carried. A comparable we cannot point at is not a comparable, and the one
 * thing this module must never do is manufacture one.
 *
 * ─── A KNOWN WEAKNESS, STATED OUT LOUD ──────────────────────────────────────
 * generateTextRouted routes `pricing_research` to perplexity-sonar with an
 * automatic fallback to claude-sonnet (lib/ai/models.ts AI_TASK_ROUTING). The
 * fallback model has NO web access, so on a Perplexity outage the "web search"
 * is answered from model memory. The citation requirement below is the guard
 * against that: an ungrounded model most often returns rows with no citation at
 * all, and those never leave this function. It is a mitigation, not a proof —
 * which is precisely why nothing sourced here is allowed near the sold side.
 *
 * Cost: ~$0.005-0.015 per call (Perplexity Sonar at $1/M input tokens, $1/M
 * output tokens, ~3-5k tokens per call). Metered — see PERPLEXITY_COMP_SEARCH_COST_USD.
 */

import "server-only"
import { generateTextRouted } from "@/lib/ai/models"
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"
import type { ScoredComp } from "./comp-types"

export type { ScoredComp } from "./comp-types"

/**
 * Estimated spend for one grounded comp search, in USD. Perplexity Sonar bills
 * per token; this is the midpoint of the observed 3-5k-token range at $1/M in +
 * $1/M out. Telemetry only — actual billing happens at the vendor.
 */
export const PERPLEXITY_COMP_SEARCH_COST_USD = 0.01

/** Which comp slots a caller may ask this finder for. */
// TOMBSTONE (§1.3 + §6, 2026-08-31, lane M4): `PerplexityCompSlot` deleted —
// a second spelling of the slot vocabulary that PerplexityCompSlotRequest
// below already carries as its keys (the shape every caller actually uses).
// Need the union? `keyof PerplexityCompSlotRequest` derives it from the one
// live source.

/** How many rows the caller needs per slot. Omitted/0 → that slot is not asked for. */
export interface PerplexityCompSlotRequest {
  closed?: number
  pending?: number
  active?: number
}

export interface PerplexityCompFinderInput {
  /**
   * REQUIRED — the tenant this search is billed to. Not optional: a paid
   * outbound provider call that cannot be attributed to a brokerage cannot be
   * governed, and this call costs money on every invocation.
   */
  brokerageId: string
  subjectAddress: string
  subjectCity?: string | null
  subjectState?: string | null
  subjectZip?: string | null
  subjectBeds?: number | null
  subjectBaths?: number | null
  subjectSqft?: number | null
  subjectYearBuilt?: number | null
  subjectPropertyType?: string | null  // 'single_family' | 'condo' | 'townhouse'
  searchRadiusMiles?: number           // default 1.0
  monthsBack?: number                  // default 6
  /**
   * Which slots to ask for, and how many of each.
   *
   * DEFAULT: 0 closed / 1 pending / 1 active — the pending and active sides
   * RentCast structurally cannot hold, and nothing else.
   *
   * The default used to be 3 CLOSED / 1 pending / 1 active, which is the exact
   * thing the header of this file says this module must never supply. It never
   * fired — comp-provider.ts, the one door in, passes `closed: 0` explicitly —
   * so the defect was a loaded gun rather than a wound: the next caller to omit
   * `want` would have asked an AI web search for recorded sales, and a wrong AI
   * sale price does not degrade a CMA's estimate, it BECOMES it. A default is
   * what the module does when nobody is looking, so it now defaults to the rule
   * the rest of the lane enforces (AI_GAP_FILL_SLOTS in comp-provider.ts,
   * proven by cma-provider-lane check P2b).
   *
   * `closed` remains REQUESTABLE rather than deleted: a caller that genuinely
   * wants AI-sourced closed rows must now type the number, and the CMA path
   * refuses them at the caller regardless of what this finder returns.
   */
  want?: PerplexityCompSlotRequest
  /** Vendor-ledger attribution for the lane making the call. */
  systemSource?: string
  /**
   * For investor ARV mode — search for the BEST condition / recently
   * renovated comps to estimate the post-renovation value. Suppresses
   * condition-based downward adjustments.
   */
  arvMode?: boolean
}

export interface PerplexityCompFinderResult {
  /** Only ever populated when the caller explicitly asked for the closed slot. */
  closedComps: ScoredComp[]
  pendingComps: ScoredComp[]
  activeComps: ScoredComp[]
  citations: string[]
  searchQuery: string
  rawAnalysis: string
  arvMode: boolean
  /** Rows the model returned that were dropped for having no address, no
   *  positive price, or no citation. Surfaced so a caller can say the search
   *  ran and produced nothing usable, rather than "the search found nothing". */
  droppedUnusableRows: number
}

/**
 * Search for comps via Perplexity Sonar with web grounding. Returns structured
 * JSON parsed from the model's response, with unusable rows dropped.
 *
 * Every call is metered to the vendor ledger before it returns — including the
 * calls that come back empty, because an empty paid call still costs money.
 */
export async function findCompsViaPerplexity(
  input: PerplexityCompFinderInput
): Promise<PerplexityCompFinderResult> {
  const radius = input.searchRadiusMiles ?? 1.0
  const months = input.monthsBack ?? 6
  const propType = input.subjectPropertyType ?? "single-family"
  const want = {
    // 0, not 3. See PerplexityCompFinderInput.want — the sold side is not this
    // module's to serve, and the default is the one place a caller's silence
    // gets to decide that.
    closed: Math.max(0, input.want?.closed ?? 0),
    pending: Math.max(0, input.want?.pending ?? 1),
    active: Math.max(0, input.want?.active ?? 1),
  }

  const empty = (searchQuery: string): PerplexityCompFinderResult => ({
    closedComps: [],
    pendingComps: [],
    activeComps: [],
    citations: [],
    searchQuery,
    rawAnalysis: "",
    arvMode: input.arvMode ?? false,
    droppedUnusableRows: 0,
  })

  // Nothing asked for → nothing to search for, and no reason to spend.
  if (want.closed === 0 && want.pending === 0 && want.active === 0) {
    return empty("(no slots requested)")
  }

  const subjectDescription = [
    input.subjectAddress,
    input.subjectCity ? `, ${input.subjectCity}` : "",
    input.subjectState ? `, ${input.subjectState}` : "",
    input.subjectZip ? ` ${input.subjectZip}` : "",
  ]
    .join("")
    .trim()

  const subjectFeatures = [
    input.subjectBeds != null ? `${input.subjectBeds} bed` : null,
    input.subjectBaths != null ? `${input.subjectBaths} bath` : null,
    input.subjectSqft != null ? `${input.subjectSqft} sqft` : null,
    input.subjectYearBuilt != null ? `built ${input.subjectYearBuilt}` : null,
  ]
    .filter(Boolean)
    .join(" / ")

  const arvAddendum = input.arvMode
    ? "\n\nINVESTOR ARV MODE: Find the BEST-condition (recently renovated, " +
      "high-finish) comparable closed sales in the area. The subject is " +
      "being evaluated for its post-renovation value. Skip distressed/REO/ " +
      "tear-down comps — only updated/move-in-ready properties."
    : ""

  // Ask ONLY for the slots the caller is short on. This is what makes the
  // gap-fill per-slot rather than wholesale: when the CMA needs a pending comp,
  // the model is never even invited to produce a closed sale.
  const askLines = [
    want.closed > 0 ? `  - ${want.closed} CLOSED comp(s) that sold within the last ${months} months` : null,
    want.pending > 0 ? `  - ${want.pending} PENDING comp(s) (under contract / contingent, not yet closed)` : null,
    want.active > 0 ? `  - ${want.active} ACTIVE comp(s) (currently for sale)` : null,
  ].filter(Boolean)

  const jsonShape = [
    want.closed > 0 ? `  "closed_comps": [ { ... } ],   // at most ${want.closed}` : null,
    want.pending > 0 ? `  "pending_comps": [ { ... } ],  // at most ${want.pending}` : null,
    want.active > 0 ? `  "active_comps": [ { ... } ],   // at most ${want.active}` : null,
    `  "citations": [ "url1", "url2", ... ]`,
  ].filter(Boolean)

  const prompt = `You are a real estate analyst pulling comparable properties for a sales-comparison CMA.

SUBJECT PROPERTY:
  Address: ${subjectDescription}
  ${subjectFeatures ? `Features: ${subjectFeatures}` : ""}
  Type: ${propType}

TASK:
Search Redfin, Zillow, Realtor.com, and public county records for comparable
${propType} properties that match the subject's bed/bath/sqft profile within
${radius} mile of the subject address.

Return:
${askLines.join("\n")}

For each comp, capture: full address, sale/list price, sale/list date, beds,
baths, sqft, lot size (acres), year built, garage spaces, pool (yes/no),
waterfront (yes/no), notable view (yes/no), property condition grade (1-5
with 1=poor 5=excellent), days on market.

Pick the comps with the closest sqft and bed/bath count to the subject —
prioritize same property type (${propType}).${arvAddendum}

HARD RULES:
  - Every comp MUST carry a "citation" that is the URL of the page you read it
    from. A comp you cannot cite must be OMITTED, not guessed at.
  - Return FEWER comps rather than filling the list with properties you are not
    confident exist. An empty list is an acceptable and useful answer.
  - Never report a listing that is still for sale or under contract as a sale.

OUTPUT FORMAT — strict JSON only, no prose:
{
${jsonShape.join("\n")}
}

Each comp object:
{
  "address": "123 Main St, City, State Zip",
  "status": "closed" | "pending" | "active",
  "sale_price": 450000,        // closed → sale price; pending/active → list price
  "sale_date": "2024-09-15",   // closed → close date; pending → contract date; active → list date
  "beds": 3,
  "full_baths": 2,
  "half_baths": 1,
  "sqft": 1800,
  "lot_size_acres": 0.25,
  "year_built": 2005,
  "garage_spaces": 2,
  "has_pool": false,
  "is_waterfront": false,
  "has_view": false,
  "condition_grade": 4,
  "is_new_construction": false,
  "is_gated": false,
  "basement_finished": false,
  "days_on_market": 18,
  "citation": "https://..."
}

Return JSON only.`

  let raw = ""
  let callOk = false
  try {
    const { text } = await generateTextRouted({
      feature: "pricing_research",  // routes to perplexity-sonar per lib/ai/models.ts
      prompt,
      temperature: 0.2,
      maxTokens: 4000,
      brokerageId: input.brokerageId,
    })
    raw = text
    callOk = true
  } catch {
    raw = ""
  }

  // Meter BEFORE returning, on success and failure alike — a call that failed
  // after the vendor accepted it still spent. Fire-and-forget so a ledger
  // outage never becomes a CMA outage.
  void logVendorUsage({
    vendorName: "perplexity",
    usageType: "api_call",
    unitCount: 1,
    estimatedCost: PERPLEXITY_COMP_SEARCH_COST_USD,
    systemSource: input.systemSource ?? "cma_comp_gap_fill",
    brokerageId: input.brokerageId,
    metadata: {
      endpoint: "generateTextRouted(pricing_research)",
      purpose: "comp_gap_fill",
      ok: callOk,
      requested_closed: want.closed,
      requested_pending: want.pending,
      requested_active: want.active,
      radius_miles: radius,
      months_back: months,
    },
  }).catch(() => null)

  if (!callOk) return empty(prompt)

  return parseCompResult(raw, prompt, input.arvMode ?? false, want)
}

function parseCompResult(
  raw: string,
  searchQuery: string,
  arvMode: boolean,
  want: { closed: number; pending: number; active: number }
): PerplexityCompFinderResult {
  // Strip code fences if present
  const cleaned = raw
    .replace(/```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()

  let parsed: {
    closed_comps?: RawComp[]
    // Older single-comp keys are still accepted so a model that answers in the
    // previous shape is not thrown away.
    pending_comps?: RawComp[]
    pending_comp?: RawComp | null
    active_comps?: RawComp[]
    active_comp?: RawComp | null
    citations?: string[]
  } = {}

  try {
    // Find the first { ... } block
    const match = cleaned.match(/\{[\s\S]*\}/)
    parsed = match ? JSON.parse(match[0]) : {}
  } catch {
    parsed = {}
  }

  let dropped = 0
  const take = (rows: (RawComp | null | undefined)[], status: ScoredComp["status"], limit: number): ScoredComp[] => {
    if (limit <= 0) return []
    const out: ScoredComp[] = []
    for (const r of rows) {
      if (!r) continue
      const comp = toScoredComp(r, status)
      if (!isUsable(comp)) {
        dropped++
        continue
      }
      out.push(comp)
      if (out.length >= limit) break
    }
    return out
  }

  const closedComps = take(parsed.closed_comps ?? [], "closed", want.closed)
  const pendingComps = take(
    parsed.pending_comps ?? (parsed.pending_comp ? [parsed.pending_comp] : []),
    "pending",
    want.pending
  )
  const activeComps = take(
    parsed.active_comps ?? (parsed.active_comp ? [parsed.active_comp] : []),
    "active",
    want.active
  )

  return {
    closedComps,
    pendingComps,
    activeComps,
    citations: (parsed.citations ?? []).filter((c) => typeof c === "string" && c.trim().length > 0),
    searchQuery,
    rawAnalysis: raw,
    arvMode,
    droppedUnusableRows: dropped,
  }
}

/**
 * A row is usable only when it names a property, carries a positive price, and
 * points at where it was read. Anything else is a shape, not a comparable, and
 * carrying it forward would put an invented address in front of a seller or an
 * appraiser. Dropped, counted, and reported.
 */
function isUsable(comp: ScoredComp): boolean {
  if (!comp.address || comp.address.trim().length < 5) return false
  if (!(comp.salePrice > 0)) return false
  const cite = (comp.citation ?? "").trim()
  if (!/^https?:\/\/\S+/i.test(cite)) return false
  return true
}

interface RawComp {
  address?: string
  status?: "closed" | "pending" | "active"
  sale_price?: number
  sale_date?: string
  beds?: number
  full_baths?: number
  half_baths?: number
  sqft?: number
  lot_size_acres?: number
  year_built?: number
  garage_spaces?: number
  has_pool?: boolean
  is_waterfront?: boolean
  has_view?: boolean
  condition_grade?: number
  is_new_construction?: boolean
  is_gated?: boolean
  basement_finished?: boolean
  days_on_market?: number
  citation?: string
}

function toScoredComp(c: RawComp, slotStatus: ScoredComp["status"]): ScoredComp {
  // The SLOT the caller asked for wins over whatever the model labelled the row.
  // A model that returns an "active" listing inside the pending array must not
  // be able to promote it into a different price basis by mislabelling it.
  const status = slotStatus
  return {
    address: (c.address ?? "").trim(),
    status,
    salePrice: typeof c.sale_price === "number" && Number.isFinite(c.sale_price) ? c.sale_price : 0,
    saleDate: c.sale_date ?? new Date().toISOString().slice(0, 10),
    sqftLiving: c.sqft ?? null,
    bedrooms: c.beds ?? null,
    fullBaths: c.full_baths ?? null,
    halfBaths: c.half_baths ?? null,
    garageSpaces: c.garage_spaces ?? null,
    hasPool: c.has_pool ?? null,
    isWaterfront: c.is_waterfront ?? null,
    hasView: c.has_view ?? null,
    lotSizeAcres: c.lot_size_acres ?? null,
    yearBuilt: c.year_built ?? null,
    conditionGrade: c.condition_grade ?? null,
    basementFinished: c.basement_finished ?? null,
    isNewConstruction: c.is_new_construction ?? null,
    isGated: c.is_gated ?? null,
    daysOnMarket: c.days_on_market ?? null,
    pricePerSqft:
      c.sale_price && c.sqft && c.sqft > 0 ? Math.round(c.sale_price / c.sqft) : null,
    /**
     * Explicitly NEUTRAL, not the model's self-assessment. The old shape asked
     * the model to score its own comps 0-1 and that number then ranked them
     * against provider comps carrying RentCast's measured `correlation`. A
     * model's opinion of its own work is not comparable to a measured
     * correlation. comp-provider.ts recomputes this deterministically from the
     * attributes the subject and comp actually share.
     */
    similarityScore: 0.5,
    citation: c.citation ?? null,
    // No web-search result carries a computed distance from the subject, and
    // the model is not asked to estimate one — unknown, never 0.
    distanceMiles: null,
    sourceProvider: "perplexity",
    priceBasis: status === "closed" ? "closed_sale" : "list_price",
  }
}
