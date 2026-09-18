/**
 * lib/ai-isa/persona-tool-policy.ts
 *
 * Lane 73B — owner verbatim: "there should be tools for the ai agents that
 * will help with their chats and calls for a real estate customer which can
 * be all different personas. if batchdata is going to be expensive, tools
 * should be constricted."
 *
 * Before this file, lib/ai-isa/batchdata-isa-tools.ts admitted exactly TWO
 * customer personas — "isa" (a catch-all covering both buyer and seller
 * qualification) and "investor" (property-only). This file is the missing
 * half: it derives a WIDER, still-narrow `ToolPersona` catalogue from the
 * vocabulary the database already enforces — never a second vocabulary
 * (CLAUDE.md §6) — and gives each persona its own tool allowlist, its own
 * per-conversation BatchData spend cap, and a RentCast name-pattern filter.
 *
 * ── WHERE THE VOCABULARY COMES FROM (never invented here) ───────────────────
 *   contacts_contact_type_check (m563, lib/contact-types.ts CONTACT_TYPES):
 *     lead, prospect, lifetime_customer, sphere, vendor, referral_partner,
 *     buyer, seller, both, other.
 *   contacts_contact_persona_check (m589, scripts/check-vocabularies.ts):
 *     divorce, downsize, expired, first_time, foreclosure, fsbo, investor,
 *     luxury, military, other, probate, relocated, senior, upsize. "investor"
 *     is a PERSONA, not a contact_type (owner ruling, m593 — the contact_type
 *     'investor' value was retired for exactly this reason).
 *   contacts.home_owner_status ("renter" | "owner" | "any" — lib/kernel/ads.ts,
 *     lib/ads/ad-creator-types.ts; live column, scripts/schema-snapshot.ts).
 *
 * `resolveToolPersona` below is the ONE place that turns those three columns
 * into a `ToolPersona`. It does NOT replace `Persona` (lib/kernel/types.ts —
 * the motivation_type-keyed BRAND-VOICE persona handle-inbound-email.ts
 * already reads) or `CampaignPersona` (lib/campaigns/contact-sources.ts — the
 * fourteen-value drip-campaign vocabulary): those answer "what tone/drip does
 * this person get", this file answers "which AI-agent TOOLS may this
 * conversation reach, and how much may it spend reaching them" — a different
 * question, deliberately a different name, so the three are never confused at
 * a call site (§6 — same vocabulary reused, not re-spelled; different
 * questions kept as different functions).
 *
 * ── THE PERSONA → TOOL POLICY TABLE ──────────────────────────────────────────
 * One table, ONE place a reader or a scorer can hold the whole ruling against
 * (CLAUDE.md §1/§2). Every persona's `batchDataToolNames` is a subset of the
 * tool names lib/ai-isa/batchdata-isa-tools.ts's registry can build (never a
 * new tool implementation here — this file only decides WHICH of the existing
 * ones a given persona may reach):
 *
 *   buyer      — RentCast (listing/valuation-shaped tools) only. ZERO BatchData
 *                (lane 75B — owner ruling: "random batchdata tools" are out of
 *                customer care; every need this persona had is now served by
 *                lib/ai-isa/capability-catalogue.ts).
 *   seller     — ZERO BatchData (lane 75B, same ruling) — lookup_property /
 *                comparable_property_* could surface a dollar figure
 *                mid-conversation, exactly the "value over the conversation"
 *                the owner ruled against; schedule_home_value_review (the
 *                catalogue) books a callback and never runs an AVM at all.
 *   investor   — UNCHANGED from wave 71/72 (lane 75B EXCEPTION, owner's own
 *                wording: "property-only search/comps preview since that IS
 *                its service"): search_properties_preview/count/page,
 *                comparable_property_preview/count, investor_buybox_
 *                preview/count — property fields ONLY, passed through
 *                `toInvestorFacingToolRow`'s redaction. No RentCast (BatchData
 *                is the off-market/quicklist provider that persona needs —
 *                wave 69).
 *   renter     — RentCast RENTAL-shaped tools only. Zero BatchData — a renter
 *                is not buying, so BatchData's per-record cost has nothing to
 *                buy for them.
 *   relocation — ZERO BatchData (lane 75B) — RentCast market/listing tools
 *                plus the catalogue's search_our_listings/send_matching_
 *                listings cover area visibility without a paid per-record call.
 *   sphere     — verify_phone / check_dnc_status / check_tcpa_status ONLY, and
 *                ONLY when the caller declares the conversation
 *                outbound-eligible (`ctx.outboundEligible`, default false —
 *                fail closed). A sphere-of-influence/referral contact is not
 *                being sold a property; the only BatchData need in that
 *                conversation is confirming a number is safe to call BEFORE
 *                the outbound gate runs (lib/communication/tcpa-gate.ts),
 *                never a substitute for it.
 *   vendor     — ZERO BatchData, ZERO RentCast (lane 76A). contacts.contact_type
 *                'vendor' is a LIVE CHECK value (contacts_contact_type_check —
 *                never invented here); a vendor who reaches a customer surface
 *                (calls the office line, is captured as a contact) asks about
 *                THEIR OWN placement/assignment, invoice/document and payout
 *                status — lib/ai-isa/capability-catalogue.ts::get_my_vendor_status
 *                — never about property data, so no paid tool has anything to
 *                buy for them.
 *
 * ── WHAT EACH PERSONA ACTUALLY ASKS (lane 76A research, sources in
 *    scratchpad lane76A-notes.md — Structurely/Aisa Holmes, Ylopo rAIya, Lofty
 *    Sales Agent qualification tags, CINC AI script goals, Alma/Noem/Hyperleap
 *    receptionist intake fields, TalkLuna vendor/leasing intake) ────────────
 * The PROMPT half of this table lives in lib/ai-isa/qualification-playbook.ts
 * ::PERSONA_QUESTION_GUIDE (one place, mounted on every surface); the TOOL
 * half is the free catalogue (lib/ai-isa/capability-catalogue.ts) — cheapest
 * first: own DB (search_our_listings / get_listing_details / send_matching_
 * listings) → RentCast (rentcast_* by persona pattern; send_matching_listings'
 * rental mode) → BatchData preview/count ONLY where nothing cheaper covers the
 * need (investor off-market/comps preview — the one explicit exception).
 *
 * `staff` (the in-app agent copilot, app/api/internal/ai-chat) is
 * DELIBERATELY NOT a `ToolPersona` value — wave 72B's own docs already record
 * "no persona split — staff get the whole toolkit" (the FULL, ungoverned
 * lib/external/batchdata-ai-tools.ts::batchDataMcpTools catalogue). The TIER
 * constriction below still applies to that surface (filterToolsByTier is
 * generic over any AI-SDK tool-name map), but the PERSONA allowlist in this
 * file governs customer-facing conversations only.
 *
 * ── COST-TIER CONSTRICTION (platform-level, independent of persona) ─────────
 * `BATCHDATA_TOOL_TIER` (env, default "lean") is the ceiling every persona's
 * allowlist is additionally filtered through:
 *   full — no restriction; the persona allowlist stands as computed above.
 *   lean — preview/count tools + lookup_property + the verify-prefixed and
 *          check_dnc_status/check_tcpa_status compliance tools survive (a persona whose
 *          policy never granted them gets nothing extra — the tier can only
 *          NARROW, never widen, a persona's own allowlist); `_page` pulls and
 *          any bulk/full-record tool are cut. This is the DEFAULT.
 *   off  — zero BatchData tools of any kind, for any persona or for staff;
 *          RentCast and the free internal tools are untouched.
 * `BATCHDATA_TOOL_MONTHLY_CAP_CENTS` (env, default $500.00) is the platform's
 * BatchData spend ceiling for the current calendar month (vendor_usage_
 * tracking, vendor_name='batchdata' — the SAME sum
 * app/api/admin/billing/batchdata-wallet/route.ts already reads for display,
 * read again here for a DECISION rather than a dashboard number).
 * `evaluateEffectiveBatchDataTier` is the PURE downgrade rule: crossing the
 * cap only ever moves DOWN one step (full → lean; lean stays lean; an
 * explicit "off" is never overridden upward by a healthy ledger — the operator
 * said off). It never widens a tier the operator configured tighter than the
 * spend alone would justify.
 */

export type ToolPersona = "buyer" | "seller" | "investor" | "renter" | "relocation" | "sphere" | "vendor"

export const TOOL_PERSONAS: readonly ToolPersona[] = ["buyer", "seller", "investor", "renter", "relocation", "sphere", "vendor"]

export interface ToolPersonaInput {
  /** contacts.contact_type / leads.lead_type-derived ('buyer'|'seller'|...) */
  contactType?: string | null
  /** contacts.contact_persona / leads.persona — m589 vocabulary */
  contactPersona?: string | null
  /** contacts.home_owner_status / leads.home_owner_status */
  homeOwnerStatus?: string | null
}

/**
 * PURE — the ONE place a contact/lead row's existing vocabulary columns
 * become a `ToolPersona`. Priority: contact_persona 'investor' (m589's own
 * ruling: this is a persona fact, checked first) > contact_persona
 * 'relocated' > home_owner_status 'renter' > contact_type 'seller' >
 * contact_type 'sphere'/'referral_partner'/'lifetime_customer' (past clients
 * and referral-network contacts are the sphere_of_influence manager's
 * territory — wave 47's own CLOSED→sphere_of_influence ruling) > contact_type
 * 'vendor' (lane 76A — a live contacts_contact_type_check value; a vendor is
 * never a property buyer, so it must not fall to the buyer default) > default
 * 'buyer'. The 'buyer' default mirrors lib/campaigns/contact-sources.ts's
 * own documented posture ("an unknown type is treated as a buyer rather than
 * dropped, so a capture never falls out of the funnel") — contact_type
 * 'both'/'lead'/'prospect'/'other'/unset all land here too. NOTE the default
 * is an UNKNOWN, not knowledge: a "buyer" may also be selling ("both" is a
 * live contact_type), which is why the free follow-up bundle never withholds
 * the seller tools from a buyer-defaulted thread — the playbook's per-persona
 * guide steers which one is OFFERED.
 */
export function resolveToolPersona(input: ToolPersonaInput): ToolPersona {
  const persona = (input.contactPersona ?? "").trim().toLowerCase()
  if (persona === "investor") return "investor"
  if (persona === "relocated") return "relocation"

  const owner = (input.homeOwnerStatus ?? "").trim().toLowerCase()
  if (owner === "renter") return "renter"

  const type = (input.contactType ?? "").trim().toLowerCase()
  if (type === "seller") return "seller"
  if (type === "sphere" || type === "referral_partner" || type === "lifetime_customer") return "sphere"
  if (type === "vendor") return "vendor"

  return "buyer"
}

export interface PersonaToolPolicy {
  /** Subset of lib/ai-isa/batchdata-isa-tools.ts's registry key names this
   *  persona may reach, BEFORE the platform tier filter narrows it further. */
  batchDataToolNames: readonly string[]
  /** May this persona reach ANY RentCast MCP tool at all? */
  rentCastEnabled: boolean
  /** When rentCastEnabled, further narrows the DISCOVERED `rentcast_<name>`
   *  tool keys to those matching this pattern (case-insensitive substring on
   *  the tool's own name) — null means "every discovered tool" (not used by
   *  any persona today; every enabled persona names a pattern deliberately). */
  rentCastNamePattern: RegExp | null
  /** Per-conversation BatchData spend cap in CENTS for this persona — the
   *  EFFECTIVE cap is min(this, resolveBatchDataIsaBudgetCents()), so an env
   *  override still acts as a ceiling no persona can exceed. */
  capCents: number
  /** 'identity' — the tool result passes through unchanged (this persona is
   *  looking at THEIR OWN property/context). 'property-only' — every row is
   *  redacted through the SAME allowlist shape the investor persona has
   *  always used (toInvestorFacingToolRow), because this persona is looking
   *  at someone ELSE's property and must never see owner/contact fields. */
  redaction: "identity" | "property-only"
}

export const PERSONA_TOOL_POLICY: Record<ToolPersona, PersonaToolPolicy> = {
  // Lane 75B — owner verbatim (wave 75): "if a brand wants to create a
  // specific tool that should be an option with all of the different
  // capabilities that we have built... I think those tools are better
  // suited than random batchdata tools... don't create tools that is not
  // useful for customer care in the real estate business." BatchData
  // property-VALUE tools (lookup_property, comparable_property_*,
  // verify_address) are REMOVED from buyer/seller/relocation: every need
  // they covered is now served by lib/ai-isa/capability-catalogue.ts's
  // customer-care capabilities (schedule_home_value_review books a callback
  // and NEVER runs an AVM; send_matching_listings/search_our_listings cover
  // area/inventory visibility) — and a comparable-property tool that could
  // surface a dollar figure mid-conversation is exactly the "value over the
  // conversation" the owner ruled against (wave 75, same ruling). investor
  // is the EXPLICIT exception (property-only search/comps IS its service,
  // per the owner's own wording) and sphere is UNCHANGED (verify_phone/
  // check_dnc_status/check_tcpa_status are an OUTBOUND COMPLIANCE gate, not
  // a customer-care capability — a need the catalogue does not cover).
  buyer: {
    batchDataToolNames: [],
    rentCastEnabled: true,
    rentCastNamePattern: /listing|sale|value|avm|market/i,
    capCents: 100,
    redaction: "property-only",
  },
  seller: {
    batchDataToolNames: [],
    rentCastEnabled: false,
    rentCastNamePattern: null,
    capCents: 200,
    redaction: "identity",
  },
  investor: {
    batchDataToolNames: [
      "search_properties_preview", "search_properties_count", "search_properties_page",
      "comparable_property_preview", "comparable_property_count",
      "investor_buybox_preview", "investor_buybox_count",
    ],
    rentCastEnabled: false,
    rentCastNamePattern: null,
    capCents: 200,
    redaction: "property-only",
  },
  renter: {
    batchDataToolNames: [],
    rentCastEnabled: true,
    rentCastNamePattern: /rent/i,
    capCents: 0,
    redaction: "property-only",
  },
  relocation: {
    batchDataToolNames: [],
    rentCastEnabled: true,
    rentCastNamePattern: /market|listing/i,
    capCents: 50,
    redaction: "property-only",
  },
  sphere: {
    // Gated a second way in batchdata-isa-tools.ts: only registered at all
    // when ctx.outboundEligible === true (default false — fail closed).
    batchDataToolNames: ["verify_phone", "check_dnc_status", "check_tcpa_status"],
    rentCastEnabled: false,
    rentCastNamePattern: null,
    capCents: 50,
    redaction: "identity",
  },
  vendor: {
    // Lane 76A — a vendor asks about THEIR OWN placement/document/payout
    // status (capability-catalogue.ts::get_my_vendor_status); there is no
    // property-data need, so no paid tool of either provider is ever offered.
    batchDataToolNames: [],
    rentCastEnabled: false,
    rentCastNamePattern: null,
    capCents: 0,
    redaction: "identity",
  },
}

/** PURE — is `toolName` allowed for `persona` BEFORE the platform tier filter? */
export function isToolAllowedForPersona(persona: ToolPersona, toolName: string): boolean {
  return PERSONA_TOOL_POLICY[persona].batchDataToolNames.includes(toolName)
}

/** PURE — which redaction a persona's tool ROWS go through. */
export function redactionModeForPersona(persona: ToolPersona): "identity" | "property-only" {
  return PERSONA_TOOL_POLICY[persona].redaction
}

// ─── COST TIER ───────────────────────────────────────────────────────────────

export type BatchDataToolTier = "full" | "lean" | "off"
const TIER_VALUES: readonly BatchDataToolTier[] = ["full", "lean", "off"]

/** PURE — env read, default "lean" (documented in .env.example). Any value
 *  other than "full"/"lean"/"off" (unset, typo, empty) falls back to "lean"
 *  rather than the most permissive tier — fail closed on cost. */
export function resolveConfiguredBatchDataToolTier(): BatchDataToolTier {
  const raw = (process.env.BATCHDATA_TOOL_TIER ?? "").trim().toLowerCase()
  return (TIER_VALUES as readonly string[]).includes(raw) ? (raw as BatchDataToolTier) : "lean"
}

const DEFAULT_MONTHLY_CAP_CENTS = 50_000 // $500.00/mo — documented default for BATCHDATA_TOOL_MONTHLY_CAP_CENTS

/** PURE — env read for the platform-wide monthly BatchData spend ceiling.
 *  Unset/non-positive/non-finite falls back to the documented default. */
export function resolveBatchDataToolMonthlyCapCents(): number {
  const raw = process.env.BATCHDATA_TOOL_MONTHLY_CAP_CENTS
  const n = raw !== undefined ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MONTHLY_CAP_CENTS
}

/**
 * PURE — the auto-downgrade decision. An explicit "off" is never overridden
 * (the operator already chose the cheapest tier). Otherwise, once the current
 * month's platform BatchData spend has reached the cap, "full" downgrades to
 * "lean"; "lean" stays "lean" (it is already the constricted floor short of
 * "off", which only an explicit env value or a future harder cap should set —
 * this function never auto-selects "off" on spend alone, so a spend spike
 * degrades the experience rather than silently amputating it).
 */
export function evaluateEffectiveBatchDataTier(
  configuredTier: BatchDataToolTier,
  spendCentsThisMonth: number,
  capCents: number,
): BatchDataToolTier {
  if (configuredTier === "off") return "off"
  if (spendCentsThisMonth >= capCents) {
    return configuredTier === "full" ? "lean" : configuredTier
  }
  return configuredTier
}

/**
 * I/O — platform-wide (no brokerage filter — CLAUDE.md §5 "batchdata is
 * platform spend") month-to-date BatchData spend, in cents. Mirrors the exact
 * query app/api/admin/billing/batchdata-wallet/route.ts already reads for
 * display. Fails OPEN (returns 0 → the configured tier stands unchanged) on
 * any read error: this is a COST-SAVING constriction, not a compliance gate,
 * so a transient ledger-read failure must never itself take a customer chat
 * down by assuming the platform is already over budget.
 */
export async function readPlatformBatchDataMonthlySpendCents(): Promise<number> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const now = new Date()
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const { data, error } = await svc
      .from("vendor_usage_tracking")
      .select("total_cost")
      .eq("vendor_name", "batchdata")
      .gte("created_at", startOfMonth)
    if (error) return 0
    const usd = (data ?? []).reduce((s: number, r: { total_cost: number | null }) => s + (Number(r.total_cost) || 0), 0)
    return Math.round(usd * 100)
  } catch {
    return 0
  }
}

let tierCache: { tier: BatchDataToolTier; at: number } | null = null
const TIER_CACHE_TTL_MS = 5 * 60 * 1000 // 5m — same posture as rentcast-ai-tools.ts's catalogue cache

/**
 * The composed, cached, production entry point: configured tier + live
 * platform spend → the effective tier every mounting surface filters its
 * tool registries through. `deps.readSpendCents` lets a proof inject a fake
 * ledger reader — when supplied, the module cache is bypassed so successive
 * calls in the same process see the injected value immediately (the cache
 * exists only to spare the PRODUCTION path a ledger read on every tool-registry
 * build, never to make a proof's assertions stale).
 */
export async function resolveEffectiveBatchDataToolTier(
  deps: { readSpendCents?: () => Promise<number> } = {},
): Promise<BatchDataToolTier> {
  const configured = resolveConfiguredBatchDataToolTier()
  if (configured === "off") return "off" // no need to read spend — already the floor
  const usingRealReader = !deps.readSpendCents
  if (usingRealReader && tierCache && Date.now() - tierCache.at < TIER_CACHE_TTL_MS) {
    return tierCache.tier
  }
  const reader = deps.readSpendCents ?? readPlatformBatchDataMonthlySpendCents
  const spendCents = await reader()
  const capCents = resolveBatchDataToolMonthlyCapCents()
  const tier = evaluateEffectiveBatchDataTier(configured, spendCents, capCents)
  if (usingRealReader) tierCache = { tier, at: Date.now() }
  return tier
}

/** PURE — is `toolName` still allowed once the tier's own constriction is
 *  applied? "full" imposes none. "off" allows nothing. "lean" keeps
 *  preview/count tools, `lookup_property`, and the verify-prefixed and
 *  check_dnc_status/check_tcpa_status compliance tools; a `_page` pull or any other bulk tool
 *  (including a FUTURE skip-trace tool added to the staff copilot's
 *  ungoverned catalogue — this predicate is generic over tool NAMES, not tied
 *  to batchdata-isa-tools.ts's registry) is cut. */
export function isToolAllowedForTier(toolName: string, tier: BatchDataToolTier): boolean {
  if (tier === "full") return true
  if (tier === "off") return false
  return (
    toolName.endsWith("_preview") ||
    toolName.endsWith("_count") ||
    toolName === "lookup_property" ||
    toolName.startsWith("verify_") ||
    toolName === "check_dnc_status" ||
    toolName === "check_tcpa_status"
  )
}

/**
 * Filters an AI-SDK tool-name map (any shape — the persona-scoped registry OR
 * the staff copilot's FULL ungoverned batchDataMcpTools catalogue) down to the
 * names `isToolAllowedForTier` admits. Generic on purpose: the tier is a
 * platform-wide constriction, not specific to one tool registry's shape.
 */
export function filterToolsByTier<T extends Record<string, unknown>>(registry: T, tier: BatchDataToolTier): Partial<T> {
  if (tier === "full") return registry
  if (tier === "off") return {}
  const out: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(registry)) {
    if (isToolAllowedForTier(name, tier)) out[name] = def
  }
  return out as Partial<T>
}

/**
 * Filters a DISCOVERED RentCast MCP tool map (keys are `rentcast_<toolName>`,
 * lib/external/rentcast-ai-tools.ts) down to what `persona`'s policy admits.
 * Returns `{}` outright when the persona's policy has RentCast disabled.
 */
export function filterRentCastToolsForPersona<T extends Record<string, unknown>>(
  registry: T,
  persona: ToolPersona,
): Partial<T> {
  const policy = PERSONA_TOOL_POLICY[persona]
  if (!policy.rentCastEnabled) return {}
  if (!policy.rentCastNamePattern) return registry
  const out: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(registry)) {
    if (policy.rentCastNamePattern.test(name)) out[name] = def
  }
  return out as Partial<T>
}

// ─── COST-RANKED TOOL ORDER (lane 74B) ──────────────────────────────────────
//
// Owner, wave 74 verbatim: "tools for the ai agents should not be using
// batchdata tools if there are less expensive tools to look up properties."
// `costRank` is the ONE cost ladder every mounting surface (chat AND voice)
// orders its tools by:
//   0 — internal/free (lib/ai-isa/customer-context-tools.ts's bundle +
//       record_qualification — no vendor spend, never metered).
//   1 — RentCast (`rentcast_<name>` — platform-key metered, materially
//       cheaper per call than BatchData's per-record pricing).
//   2 — BatchData preview/count/lookup/verify/compliance tools (cheap-tier
//       survivors under BATCHDATA_TOOL_TIER="lean" — see isToolAllowedForTier
//       above; the SAME predicate, reused rather than re-spelled, §6).
//   3 — BatchData bulk/page pulls and skip-trace (`_page`, `skip_trace_
//       property`, `reverse_skip_trace`) — the most expensive tier, offered
//       last and only when nothing cheaper covers the need.
export type ToolCostRank = 0 | 1 | 2 | 3

const BATCHDATA_BULK_PATTERN = /_page$|skip_trace_property|reverse_skip_trace/

/** PURE — every known FREE internal tool name (never a BatchData/RentCast
 *  spend). Kept as an explicit set (not a regex over "no known vendor
 *  prefix") so a future tool is rank-2-by-default (fail toward the pricier,
 *  auditable bucket) until it is deliberately added here. */
export const FREE_INTERNAL_TOOL_NAMES: readonly string[] = [
  "get_my_context",
  "search_our_listings",
  "request_showing",
  "schedule_callback",
  "send_matching_listings",
  "schedule_home_value_review",
  "find_listing_appointment_slots",
  "book_listing_appointment",
  "record_qualification",
  // Lane 75B — the customer-care capability catalogue (lib/ai-isa/
  // capability-catalogue.ts CAPABILITY_CATALOGUE). "book_agent_appointment"
  // is RETIRED (tombstone in lib/ai-isa/customer-context-tools.ts naming
  // book_listing_appointment as its survivor).
  "send_newsletter",
  "send_market_report",
  "send_explainer_video",
  // Lane 76A — persona-realistic free tools (lib/ai-isa/capability-catalogue.ts):
  // a specific listing's facts from OUR OWN table, a trusted-vendor / lender
  // intro from the brokerage's own bench, a sphere referral captured onto the
  // existing referrals rail, and a vendor's own placement/document/payout status.
  "get_listing_details",
  "request_vendor_referral",
  "capture_referral",
  "get_my_vendor_status",
]

/** PURE — the cost rank for one tool NAME. Generic over any registry's key
 *  shape (persona-scoped, voice-allowlisted, or the staff copilot's full
 *  catalogue) — never a second cost table per surface. */
export function costRankForTool(toolName: string): ToolCostRank {
  if (FREE_INTERNAL_TOOL_NAMES.includes(toolName)) return 0
  if (toolName.startsWith("rentcast_")) return 1
  if (BATCHDATA_BULK_PATTERN.test(toolName)) return 3
  return 2 // every other named tool (BatchData preview/count/lookup/verify/compliance, and any unrecognized future tool) — the auditable default, never the cheapest
}

/** Which NEED a rank-2/3 BatchData tool answers, when a cheaper tool covering
 *  the SAME need should make it redundant. Not every BatchData tool has a
 *  cheaper substitute in this codebase (valuation is answered by the AVM
 *  chain — lib/avm/provider-chain.ts — which is a SEPARATE call path, not a
 *  tool in this registry, so there is nothing to drop here for it; comps and
 *  property-lookup DO have a same-registry substitute when RentCast is on). */
const BATCHDATA_TOOL_NEED: Readonly<Record<string, string>> = {
  lookup_property: "property_lookup",
  comparable_property_preview: "comps",
  comparable_property_count: "comps",
}

/**
 * PURE — the cost-ranked, need-deduplicated tool selection every surface
 * (chat AND voice) should build its final `tools:` map through. Takes the
 * ALREADY persona+tier-filtered registry (BatchData persona/tier filters +
 * RentCast persona filter + the free bundle, merged) and:
 *   1. DROPS a rank-2/3 BatchData tool when a rank-1 RentCast tool ALREADY
 *      IN THIS SAME REGISTRY covers the same need (a RentCast tool is
 *      present at all → cheaper property lookup covered; a RentCast tool
 *      whose name matches /comp/i → cheaper comps covered). A persona whose
 *      policy has RentCast disabled (e.g. "seller") or whose RentCast name
 *      pattern excludes comps never gets ANY rentcast_ tool into the
 *      registry in the first place, so the BatchData tool that need only
 *      BatchData covers SURVIVES — the positive control this rule needs
 *      (CLAUDE.md §2): the rule can demonstrably keep a tool, not just drop
 *      one, proving it discriminates rather than stripping everything.
 *   2. Returns the SURVIVING tools sorted ascending by costRank, so a caller
 *      that reads `Object.keys(...)` in order (or logs it) sees the cheapest
 *      tools first.
 */
export function selectToolsForPersona<T extends Record<string, unknown>>(registry: T): Partial<T> {
  const names = Object.keys(registry)
  const rentcastNames = names.filter((n) => n.startsWith("rentcast_"))
  const coveredNeeds = new Set<string>()
  if (rentcastNames.length > 0) coveredNeeds.add("property_lookup")
  if (rentcastNames.some((n) => /comp/i.test(n))) coveredNeeds.add("comps")

  const survivors = names.filter((n) => {
    const need = BATCHDATA_TOOL_NEED[n]
    return !(need && coveredNeeds.has(need))
  })
  survivors.sort((a, b) => costRankForTool(a) - costRankForTool(b))

  const out: Record<string, unknown> = {}
  for (const n of survivors) out[n] = registry[n]
  return out as Partial<T>
}
