// lib/kernel/lookalike-research.ts
//
// THE PURE HALF OF THE LOOK-ALIKE CAPABILITY (wave 143, lane 143D). lib/kernel/lookalike-audience.ts is the SURVIVOR and
// the only entry point (the weekly cron, the action ledger, the tenant-scoped reads and writes); this module is what it
// reasons WITH: the ad-policy verdict as data, the attribute registry (what the research may read and what each fact may
// drive), the seed profile, the research itself (the whole picture), the content briefs and the lead-acquisition inputs
// derived from it. No database, no client, no network, no server-only import — so a proof (scripts/versium-capability-
// matrix-guard.ts) can drive every rule on fixtures, and the I/O half cannot grow a rule the pure half does not hold.
// The split is pure-vs-I/O inside ONE capability (the repo's own idiom: deal-vocabulary / deal-suppression), not a second
// system: nothing here is reachable except through lookalike-audience.ts.

import { realEstateIndicatorsFromProfile } from "@/lib/enrichment/online-presence-store"
import type { VersiumAudienceFilters } from "@/lib/external/versium-client"

// ─── WAVE 142 (lane 142D) + WAVE 143 (lane 143D): THE AD-POLICY VERDICT, AS DATA — AND LOOK-ALIKE RESEARCH ─────────────
// Wave 142 owner, verbatim: "Look-alike audiences (recent buyers / new listings / just-sold) for compliant marketing
// research — never assume look-alike targeting is lawful; respect consent, fair housing, protected characteristics and
// platform ad policies; where restricted, use for compliant content planning."
// Wave 143 owner ruling (2026-10-23): look-alike RESEARCH is NOT restricted on the tenant's own consented customers —
// "research what customers have in common, then create content to attract look-alikes and feed lead acquisition
// (research ≠ ad targeting; targeting / outbound keep their legal / privacy / platform checks)". "Remove any research
// restriction that hides the picture; keep protected-class attributes out of targeting."
//
// Housing is a Special Ad Category on Meta and a restricted vertical on Google: the platforms offer NO look-alike /
// similar-audience model for housing ads, and the Fair Housing Act (42 U.S.C. §3604(c)) forbids advertising that
// indicates a preference or limitation on a protected characteristic. So:
//   (1) the AD seed stays a LOCATION seed — a radius-limited, allowed housing input the human still approves on the DRAFT;
//       it is never sent to a platform as a look-alike model, and the draft's targeting_config carries NO people-traits
//       (143D: the 142D `targeting_config.research` block moved out — a research picture inside a targeting spec is one
//       copy-paste from becoming a segment);
//   (2) the RESEARCH reads the facts the tenant already holds on its own closed customers — place, property, deal, online
//       behaviour, lead channel, and person traits — and answers "what do the people who said yes have in common";
//   (3) what the research may DRIVE is narrower than what it may SHOW: content briefs and acquisition inputs describe the
//       HOME and the MOMENT (place, property, price band, tenure, financing, intent), never the PERSON (occupation, income,
//       family, age). Protected-class characteristics are not read at all (LOOKALIKE_PROTECTED_CATEGORIES) — the OS may hold
//       some of them on a contact (gender, age range), but the research registry has no key for them, so no code path here can
//       read, show or drive from one. Showing them in the picture only is an owner + counsel decision, not a default.
// Versium's own prompt library names this use ("Based on these 10 best-performing customer profiles, use Versium to find
// the common demographic denominators" — versium.com/versium-reach-mcp, 2026-10-23); the REACH MCP excludes only its
// look-alike LIST generation (lib/external/versium-client.ts VERSIUM_REACH_MCP).
export const LOOKALIKE_AD_POLICY = Object.freeze({
  housing_special_ad_category: true,
  lookalike_model_available_for_housing: false,
  allowed_targeting_inputs: ["location"] as const,
  research_use: "content_briefs_and_lead_acquisition_inputs" as const,
  summary: "housing ads: no platform look-alike model and no protected-characteristic targeting — the seed is a location input the human approves; the research feeds content briefs and staged lead-acquisition inputs, never the ad targeting",
})

/**
 * Characteristics this OS never reads for look-alike research (they are protected, or a proxy for a protected class, or a firewalled estimate).
 * @proofSeam kept exported for scripts/versium-capability-matrix-guard.ts, which asserts every research result publishes it
 */
export const LOOKALIKE_PROTECTED_CATEGORIES = Object.freeze([
  "age / date of birth", "gender / sex", "race / ethnicity", "religion", "national origin / language", "familial status / children",
  "disability / health", "marital status", "veteran / military status", "political affiliation / donations", "modeled credit band (firewalled estimate)",
] as const)

/**
 * What a seed needs to describe a pattern without describing a person: below this a "common denominator" IS an individual.
 * @proofSeam kept exported for scripts/versium-capability-matrix-guard.ts, which derives its seed sizes from the floor
 */
export const RESEARCH_MIN_SEED = 3

// ─── THE ATTRIBUTE REGISTRY — what the research may read, and what each fact may drive ───────────────────────────────
type AttributeKind = "place" | "property" | "deal" | "behaviour" | "channel" | "person"
interface ResearchAttributeSpec { key: string; label: string; kind: AttributeKind; /** may this attribute shape a content brief / acquisition input? (the HOME and the MOMENT, never the PERSON) */ brief: boolean }
const RESEARCH_ATTRIBUTE_SPECS: readonly ResearchAttributeSpec[] = Object.freeze([
  { key: "city", label: "city", kind: "place", brief: true },
  { key: "zip", label: "ZIP code", kind: "place", brief: true },
  { key: "property_type", label: "property type", kind: "property", brief: true },
  { key: "price_band", label: "price band", kind: "deal", brief: true },
  { key: "side", label: "side of the deal", kind: "deal", brief: true },
  { key: "financing_type", label: "financing", kind: "deal", brief: true },
  { key: "home_owner_status", label: "home tenure", kind: "property", brief: true },
  { key: "length_of_residence", label: "length of residence", kind: "property", brief: true },
  { key: "online_presence_real_estate", label: "online real-estate activity", kind: "behaviour", brief: true },
  { key: "investing_real_estate", label: "real-estate investing", kind: "behaviour", brief: true },
  { key: "home_improvement_interest", label: "home-improvement interest", kind: "behaviour", brief: true },
  { key: "online_purchasing", label: "online purchasing", kind: "behaviour", brief: false },
  { key: "lead_source", label: "lead source", kind: "channel", brief: false },
  { key: "household_income", label: "household income", kind: "person", brief: false },
  { key: "occupation", label: "occupation", kind: "person", brief: false },
  { key: "business_owner", label: "business owner", kind: "person", brief: false },
])
/** The attributes a look-alike RESEARCH may read (the 142D name, widened). Every one is a property / deal / behaviour / channel / non-protected person fact. */
export const LOOKALIKE_RESEARCH_ATTRIBUTES = RESEARCH_ATTRIBUTE_SPECS.map((s) => s.key) as readonly string[]
export type LookalikeResearchAttribute = string
/** A profile key naming a protected characteristic (or an age band) — never read, even if the caller passes it. */
const PROTECTED_RESEARCH_KEY = /age|dob|birth|gender|sex|ethnic|race|religio|language|national|familial|children|marital|disab|veteran|party|politic/i
/** A free-text VALUE of a person / behaviour / channel attribute that names a protected class or a proxy for one ("Religious", "Military", "Retired"…). */
const PROTECTED_RESEARCH_VALUE = /relig|church|christian|muslim|islam|jewish|hindu|buddh|clergy|pastor|military|veteran|retired|homemaker|disab|wheelchair|pregnan|single parent|widow|divorc|children|kids|senior|elderly|young adult|\bfamil(y|ies)\b/i
/** Brief-level exclusion: a value that is a PRODUCT but doubles as a proxy for a protected class never shapes a brief ("VA" loans — veteran status). */
const BRIEF_VALUE_EXCLUDE = /\bva\b|veteran|military/i

export interface LookalikeResearchDenominator { attribute: LookalikeResearchAttribute; value: string; share: number; count: number }
export interface LookalikeResearchDistribution {
  attribute: LookalikeResearchAttribute
  /** Share of the WHOLE seed that carries a value for this attribute — the denominator's blind spot, published beside it. */
  coverage: number
  top: Array<{ value: string; count: number; share: number; shareOfKnown: number }>
}
export interface LookalikeResearch {
  seedCount: number
  /** The whole picture: for every readable attribute its coverage and its top values — nothing hidden behind a threshold. */
  distribution: LookalikeResearchDistribution[]
  /** The common denominators — attribute values at or above `minShare` of the seed (and carried by at least two customers), strongest first. */
  denominators: LookalikeResearchDenominator[]
  use: typeof LOOKALIKE_AD_POLICY.research_use
  /** Always null: a research result is not a targeting spec. */
  targeting: null
  policy: string
  /** What was never read, and how many free-text values were dropped for naming one. */
  withheld: { categories: readonly string[]; valuesDropped: number }
}

// ─── PURE: a seed profile from the rows we hold ──────────────────────────────────────────────────────────────────────
const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "")
const num = (v: unknown): number | null => { const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null }

/** PURE — a purchase price as a band (no figure leaves). */
function priceBand(v: unknown): string | null {
  const n = num(v)
  if (n === null) return null
  return n < 200_000 ? "< $200k" : n < 300_000 ? "$200k–$300k" : n < 400_000 ? "$300k–$400k" : n < 500_000 ? "$400k–$500k" : n < 750_000 ? "$500k–$750k" : n < 1_000_000 ? "$750k–$1M" : "$1M+"
}
/** PURE — household income as a band (the 142D bands; a figure never leaves). */
function incomeBand(v: unknown): string | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.]/g, ""))
  if (!Number.isFinite(n) || n <= 0) return typeof v === "string" && /\$|-/.test(v) ? v.trim() : null
  return n < 50_000 ? "< $50k" : n < 100_000 ? "$50k–$100k" : n < 150_000 ? "$100k–$150k" : n < 250_000 ? "$150k–$250k" : "$250k+"
}
/** PURE — length of residence: a number of years becomes a band, the vendor's own band ("15+ Years") passes through. */
function residenceBand(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v < 2 ? "< 2 yrs" : v < 5 ? "2–5 yrs" : v < 10 ? "5–10 yrs" : v < 15 ? "10–15 yrs" : "15+ yrs"
  const s = asText(v)
  if (!s) return null
  return /^\d+(\.\d+)?$/.test(s) ? residenceBand(Number(s)) : s
}

/**
 * PURE — ONE closed customer as a research profile, from the contact row, their closed deal and the stored Versium
 * indicators. Only the registry's attributes are ever produced; a protected characteristic has no key to land in.
 * @proofSeam kept exported for scripts/versium-capability-matrix-guard.ts (the seed-profile mapping is proved row by row)
 */
export function lookalikeSeedProfile(input: { contact: Record<string, unknown>; deal?: Record<string, unknown> | null; side?: "buyer" | "seller" | null }): Record<string, unknown> {
  const c = input.contact ?? {}
  const d = input.deal ?? {}
  const ind = realEstateIndicatorsFromProfile((c.enrichment_profile as Record<string, unknown> | null) ?? null)
  const zip = asText(d.property_zip).match(/^\d{5}/)?.[0] ?? null
  const p: Record<string, unknown> = {
    city: asText(d.property_city) || asText(c.city) || null,
    zip,
    property_type: asText(c.property_type).toLowerCase().replace(/_/g, " ") || null,
    price_band: priceBand(d.purchase_price),
    side: input.side ?? null,
    financing_type: asText(d.financing_type).toLowerCase().replace(/_/g, " ") || null,
    home_owner_status: asText(c.home_owner_status).toLowerCase() || (ind?.homeOwnRent ?? null),
    length_of_residence: residenceBand(ind?.lengthOfResidence ?? c.length_of_residence),
    online_presence_real_estate: ind?.onlinePresenceRealEstate ?? null,
    investing_real_estate: ind?.investingRealEstate ?? null,
    home_improvement_interest: ind?.homeImprovementInterest ?? null,
    online_purchasing: ind?.onlinePurchasing ?? null,
    lead_source: asText(c.source).toLowerCase().replace(/_/g, " ") || null,
    household_income: incomeBand(c.household_income),
    occupation: asText(c.occupation) || null,
    business_owner: ind?.businessOwner ?? null,
  }
  return p
}

/**
 * PURE — what a seed of customer profiles has in common, over the registry's attributes. Null below `minSeed`
 * (RESEARCH_MIN_SEED — below it a "denominator" is a person). The whole distribution is returned, not only the values over
 * the threshold, so a thin pattern is visible as thin instead of absent.
 */
export function researchLookalikeDenominators(
  seedProfiles: ReadonlyArray<Record<string, unknown>>,
  opts: { minSeed?: number; minShare?: number } = {},
): LookalikeResearch | null {
  const minSeed = opts.minSeed ?? RESEARCH_MIN_SEED
  const minShare = opts.minShare ?? 0.4
  const seedCount = seedProfiles.length
  if (seedCount < minSeed) return null
  let valuesDropped = 0
  const tally = new Map<string, { attribute: string; value: string; count: number }>()
  const known = new Map<string, number>()
  for (const spec of RESEARCH_ATTRIBUTE_SPECS) {
    if (PROTECTED_RESEARCH_KEY.test(spec.key)) continue // belt and braces: a registry key can never be a protected one
    for (const p of seedProfiles) {
      const raw = p[spec.key]
      if (raw === undefined || raw === null || raw === "") continue
      const value = typeof raw === "boolean" ? (raw ? "yes" : "no") : String(raw).trim()
      if (!value) continue
      if ((spec.kind === "person" || spec.kind === "behaviour" || spec.kind === "channel") && PROTECTED_RESEARCH_VALUE.test(value)) { valuesDropped += 1; continue }
      known.set(spec.key, (known.get(spec.key) ?? 0) + 1)
      const key = `${spec.key}=${value.toLowerCase()}`
      const t = tally.get(key) ?? { attribute: spec.key, value, count: 0 }
      t.count += 1
      tally.set(key, t)
    }
  }
  const round2 = (n: number) => Math.round(n * 100) / 100
  const distribution: LookalikeResearchDistribution[] = []
  for (const spec of RESEARCH_ATTRIBUTE_SPECS) {
    const k = known.get(spec.key) ?? 0
    if (k === 0) continue
    const top = [...tally.values()].filter((t) => t.attribute === spec.key)
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, 5)
      .map((t) => ({ value: t.value, count: t.count, share: round2(t.count / seedCount), shareOfKnown: round2(t.count / k) }))
    distribution.push({ attribute: spec.key, coverage: round2(k / seedCount), top })
  }
  const denominators = [...tally.values()]
    .map((t) => ({ ...t, share: round2(t.count / seedCount) }))
    .filter((t) => t.share >= minShare && t.count >= 2)
    .sort((a, b) => b.share - a.share || a.attribute.localeCompare(b.attribute))
  return {
    seedCount, distribution, denominators, use: LOOKALIKE_AD_POLICY.research_use, targeting: null, policy: LOOKALIKE_AD_POLICY.summary,
    withheld: { categories: LOOKALIKE_PROTECTED_CATEGORIES, valuesDropped },
  }
}

// ─── PURE: from the picture to CONTENT BRIEFS ────────────────────────────────────────────────────────────────────────
export interface ResearchBrief {
  /** Stable key — the idempotency sentinel on content_topic_bank.raw_data. Same pattern, same key. */
  key: string
  title: string
  /** The EVIDENCE (what the tenant's own closings show), not marketing copy — the content generator writes the copy and the Fair Housing gate still runs on it. */
  valueAngle: string
  attributes: string[]
  /** 0-100, the weakest supporting share. */
  engagement: number
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const titleCase = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase())
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

/**
 * PURE — content briefs from a research picture: each describes the HOME and the MOMENT (place, property, price band,
 * tenure, financing, intent) and is derived ONLY from attributes the registry marks `brief` — never occupation, income, or
 * any person trait. A title is a SUBJECT for the generator, not copy; a value naming a protected-class proxy never shapes one.
 * @proofSeam kept exported for scripts/versium-capability-matrix-guard.ts (the brief rules are proved on fixtures, incl. positive controls)
 */
export function composeResearchBriefs(research: LookalikeResearch, opts: { max?: number } = {}): ResearchBrief[] {
  const briefable = new Set(RESEARCH_ATTRIBUTE_SPECS.filter((s) => s.brief).map((s) => s.key))
  const top = (attr: string): LookalikeResearchDenominator | null =>
    research.denominators.find((d) => d.attribute === attr && briefable.has(attr) && !BRIEF_VALUE_EXCLUDE.test(d.value)) ?? null
  const yes = (attr: string): LookalikeResearchDenominator | null => { const d = top(attr); return d && d.value.toLowerCase() === "yes" ? d : null }
  const city = top("city"), ptype = top("property_type"), band = top("price_band"), lor = top("length_of_residence"), fin = top("financing_type")
  const sideD = research.denominators.find((d) => d.attribute === "side" && (d.value === "buyer" || d.value === "seller")) ?? null
  const place = city?.value ?? null
  const ev = (...ds: Array<LookalikeResearchDenominator | null>) => {
    const used = ds.filter((d): d is LookalikeResearchDenominator => !!d)
    return `${research.seedCount} of the tenant's own closed clients: ` + used.map((d) => `${pct(d.share)} ${RESEARCH_ATTRIBUTE_SPECS.find((s) => s.key === d.attribute)?.label ?? d.attribute} "${d.value}"`).join("; ")
  }
  const mk = (kind: string, title: string, ds: Array<LookalikeResearchDenominator | null>): ResearchBrief => {
    const used = ds.filter((d): d is LookalikeResearchDenominator => !!d)
    return {
      key: `lookalike:${kind}:${used.map((d) => `${d.attribute}=${slug(d.value)}`).join("|")}`,
      title: title.slice(0, 120), valueAngle: ev(...ds), attributes: used.map((d) => `${d.attribute}=${d.value}`),
      engagement: Math.max(1, Math.round(Math.min(...used.map((d) => d.share)) * 100)),
    }
  }
  const out: ResearchBrief[] = []
  if (city && (ptype || band)) out.push(mk("place", `${ptype ? `${titleCase(ptype.value)} homes` : "Homes"} in ${city.value}${band ? ` around ${band.value}` : ""}: what to know before you move`, [city, ptype, band]))
  if (lor) out.push(mk("tenure", `Thinking about selling after ${lor.value} in ${place ? `your ${place}` : "your"} home? What to know before you list`, [lor, city]))
  if (sideD?.value === "seller") out.push(mk("sell", `Selling in ${place ?? "your market"}: pricing, timing and what buyers are paying`, [sideD, city]))
  if (sideD?.value === "buyer") out.push(mk("buy", `Buying in ${place ?? "your market"}: how offers win and what actually closes`, [sideD, city]))
  if (fin) out.push(mk("financing", `How ${fin.value} purchases close in ${place ?? "your market"}`, [fin, city]))
  const inv = yes("investing_real_estate")
  if (inv) out.push(mk("investing", `Investing in ${place ?? "local"} real estate: rents, returns and what to watch`, [inv, city]))
  const reno = yes("home_improvement_interest")
  if (reno) out.push(mk("renovation", `Renovations that pay off before you sell${place ? ` in ${place}` : ""}`, [reno, city]))
  const online = yes("online_presence_real_estate")
  if (online) out.push(mk("online-research", `Researching homes online${place ? ` in ${place}` : ""}? A local agent's checklist`, [online, city]))
  return out.slice(0, opts.max ?? 6)
}

// ─── PURE: from the picture to LEAD-ACQUISITION INPUTS ───────────────────────────────────────────────────────────────
export interface LookalikeAcquisitionInputs {
  /** Where the customers cluster (ZIPs and cities) — the territory the research suggests; a human adds a territory, this never does. */
  territories: Array<{ kind: "zip" | "city"; value: string; count: number; share: number }>
  /** Which populations the closings came from. */
  intents: Array<{ intent: "buyer" | "seller" | "investor"; share: number }>
  /** STAGED keyword rows (inactive until a human enables them): public-intent search terms for the sources that read keywords. */
  keywords: Array<{ keyword: string; keyword_type: "buyer" | "motivated_seller" | "investor"; weight: number; basis: string }>
  /** The free Versium audience-size read for the territory, or null when the picture has no ZIPs. */
  estimateFilters: VersiumAudienceFilters | null
  /** Which of the tenant's lead sources produced these customers (informational — the source-conversion loop owns channel allocation). */
  sourceMix: Array<{ source: string; share: number }>
}

/**
 * PURE — lead-acquisition inputs from a research picture. Geography + intent only; no person trait is read.
 * @proofSeam kept exported for scripts/versium-capability-matrix-guard.ts (the acquisition-input rules are proved on fixtures)
 */
export function composeAcquisitionInputs(research: LookalikeResearch): LookalikeAcquisitionInputs {
  const dist = (attr: string) => research.distribution.find((d) => d.attribute === attr)
  const territories: LookalikeAcquisitionInputs["territories"] = []
  for (const t of dist("zip")?.top ?? []) if (t.count >= 2) territories.push({ kind: "zip", value: t.value, count: t.count, share: t.share })
  for (const t of dist("city")?.top ?? []) if (t.count >= 2) territories.push({ kind: "city", value: t.value, count: t.count, share: t.share })
  const sideShare = (v: string) => dist("side")?.top.find((t) => t.value === v)?.share ?? 0
  const investShare = dist("investing_real_estate")?.top.find((t) => t.value === "yes")?.share ?? 0
  const intents: LookalikeAcquisitionInputs["intents"] = []
  if (sideShare("buyer") > 0) intents.push({ intent: "buyer", share: sideShare("buyer") })
  if (sideShare("seller") > 0) intents.push({ intent: "seller", share: sideShare("seller") })
  if (investShare > 0) intents.push({ intent: "investor", share: investShare })
  const ptype = research.denominators.find((d) => d.attribute === "property_type" && !BRIEF_VALUE_EXCLUDE.test(d.value))?.value ?? null
  const home = ptype ? (/\b(home|house|condo|townhome|townhouse|villa|apartment)s?$/i.test(ptype) ? ptype : `${ptype} home`) : "home"
  const keywords: LookalikeAcquisitionInputs["keywords"] = []
  const weight = (share: number) => Math.max(1, Math.round(share * 10))
  for (const i of intents) {
    if (i.share < 0.25) continue
    const basis = `${pct(i.share)} of ${research.seedCount} closed clients were ${i.intent}s`
    if (i.intent === "buyer") keywords.push({ keyword: `looking to buy a ${home} in {city}`, keyword_type: "buyer", weight: weight(i.share), basis })
    if (i.intent === "seller") keywords.push({ keyword: `thinking about selling my ${home} in {city}`, keyword_type: "motivated_seller", weight: weight(i.share), basis })
    if (i.intent === "investor") keywords.push({ keyword: `{city} investment property`, keyword_type: "investor", weight: weight(i.share), basis })
  }
  // The free size read: ZIPs where the customers cluster (max 10), tenure and length of residence when the picture is clear.
  const zips = territories.filter((t) => t.kind === "zip").slice(0, 10).map((t) => t.value)
  let estimateFilters: VersiumAudienceFilters | null = null
  if (zips.length > 0) {
    estimateFilters = { zips, requiredFields: ["address"] }
    const tenure = dist("home_owner_status")?.top[0]
    if (tenure && tenure.shareOfKnown >= 0.5 && /own/i.test(tenure.value)) estimateFilters.ownRent = ["H"]
    const lor = dist("length_of_residence")?.top[0]?.value ?? ""
    const plus = lor.match(/^(\d+)\+/), range = lor.match(/^(\d+)\s*[–-]\s*(\d+)/)
    if (plus) estimateFilters.lengthOfResidenceYears = { min: Number(plus[1]), max: 99 }
    else if (range) estimateFilters.lengthOfResidenceYears = { min: Number(range[1]), max: Number(range[2]) }
  }
  const sourceMix = (dist("lead_source")?.top ?? []).map((t) => ({ source: t.value, share: t.share }))
  return { territories, intents, keywords, estimateFilters, sourceMix }
}
