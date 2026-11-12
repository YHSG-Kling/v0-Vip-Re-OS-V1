// lib/investor/rei-playbook.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PROPERTYRADAR REI PLAYBOOK v5.5 METHOD — INVESTOR PLAYS ONLY, AS LABELLED HISTORICAL HEURISTICS (wave 150, lane 150KLMO —
// directive 150M; directive §"PropertyRadar v5.5 reference method — targeted plays, not universal rules").
//
// SOURCE (read, never called): the owner-installed playbook skills — rei-list-builder/SKILL.md + references/rei_playbook.md
// (the Buy Box ★5, the overlay plays with their exact criteria, Hunting vs Farming, the wholesaler exit plays, the channel
// benchmarks) and propertyradar-api/SKILL.md + references/endpoints.md (the CONFIRMED criterion names and value formats,
// `Purchase=0` preview vs `Purchase=1` purchase, `totalResultCount`, the 500-record cap). No live PropertyRadar call is made from
// this repo by this module, no token is read, and nothing here can submit a purchase parameter: every criteria set it builds is a
// PREVIEW spec (`purchase: 0`) for a human-approved count first.
//
// SURVIVOR VERDICT (CLAUDE.md §1): PARTIAL → completed here, not beside it. lib/lead-pipeline/source-discovery-planner.ts already
// carried the method in two inline literals (`{ equityPercentMin: 30 }` on investor lines, FARMING_DISTRESS_FLOOR = 25); there was
// no play catalogue, no overlay, no exit play and no confirmed criterion vocabulary anywhere. The planner now reads THIS module
// (one place for the method — LAW 2), keeping its own plan contract.
//
// RULES THE OWNER SET (each enforced by investorPlayCriteria, proven by scripts/market-twin-guard.ts §M):
//   · INVESTOR ONLY — a retail seller needs no 30 % equity floor and is never qualified by a Buy Box; asking for a play for a
//     retail audience is refused.
//   · ONE overlay at a time on the Buy Box (the playbook: "overlay additional distress indicators … for even higher motivation").
//   · COUNT / PREVIEW FIRST — purchase is always 0 here; a purchase is a separate, approved act outside this module.
//   · Vendor units stay vendor units — DistressScore is PropertyRadar's 0–100 rank ("rank, don't filter"), never a probability.
//   · Channel benchmarks and cycle lengths are HISTORICAL PLAYBOOK PLANNING HEURISTICS — never fixed automation, never a
//     guaranteed rate; the Channel Arbiter (lib/ai-isa/followup-arbiter.ts) makes the real timing / channel choice.
//   · Criteria the endpoints reference does NOT confirm (divorce, deceased, bankruptcy, purchase-date encodings) are carried as
//     the playbook's display labels with `verify: true` — never improvised as API names.
//
// Pure. Never throws.

/** A confirmed PropertyRadar criterion (propertyradar-api/references/endpoints.md — names verbatim). */
type PrCriterion = { name: string; value: unknown[] }

interface PlayDef {
  label: string
  stars: number
  mode: "hunting" | "farming" | "exit"
  /** Confirmed API criteria (endpoints.md). */
  criteria: PrCriterion[]
  /** Playbook display criteria the API reference does not confirm — verify against the live criteria reference before use. */
  unconfirmed: string[]
  channels: { recommended: string[]; supporting: string[] }
  cycle: string
}

const OFF_MARKET: PrCriterion = { name: "isListedForSale", value: [0] }
const EQUITY_30: PrCriterion = { name: "EquityPercent", value: [[30, 100]] }
const SFR: PrCriterion = { name: "PropertyType", value: [{ name: "PType", value: ["SFR"] }] }

/** The Buy Box (★★★★★) — the universe; the value band is set from the area median (ARV), never an arbitrary range. */
const BUY_BOX: PlayDef = {
  label: "Buy Box", stars: 5, mode: "farming",
  criteria: [SFR, OFF_MARKET, EQUITY_30, { name: "YearBuilt", value: [[1980, null]] }],
  unconfirmed: [],
  channels: { recommended: ["direct_mail", "phone"], supporting: ["online_ads", "email"] },
  cycle: "ongoing farm — judged on consistent deal flow year over year",
}

/** The overlay plays — ONE added to the Buy Box for motivation (rei_playbook.md "Overlay plays", exact criteria). */
const OVERLAYS = {
  tax_delinquent: { label: "Tax Delinquent", stars: 4, mode: "hunting", criteria: [OFF_MARKET, { name: "inTaxDelinquency", value: [1] }, EQUITY_30], unconfirmed: ["Tax Delinquent Yrs: <variable>"], channels: { recommended: ["direct_mail", "phone"], supporting: ["email", "online_ads"] }, cycle: "hunting" },
  vacant: { label: "Vacant", stars: 4, mode: "hunting", criteria: [{ name: "isSiteVacant", value: [1] }, { name: "isNotSameMailingOrExempt", value: [1] }, EQUITY_30, OFF_MARKET], unconfirmed: [], channels: { recommended: ["direct_mail", "phone"], supporting: ["email", "online_ads"] }, cycle: "hunting" },
  absentee_owner: { label: "Absentee Owner", stars: 2, mode: "farming", criteria: [{ name: "isNotSameMailingOrExempt", value: [1] }, EQUITY_30], unconfirmed: ["Purchase Date: to 2020", "Type: Single Family, Condominium"], channels: { recommended: ["direct_mail", "phone"], supporting: ["online_ads", "email"] }, cycle: "farming" },
  preforeclosure: { label: "Preforeclosure", stars: 4, mode: "hunting", criteria: [{ name: "ForeclosureStage", value: ["Preforeclosure"] }, EQUITY_30], unconfirmed: ["Type: Single Family, Condominium"], channels: { recommended: ["phone", "direct_mail"], supporting: ["email"] }, cycle: "longer cycle, higher payoff" },
  foreclosure_pre_auction: { label: "Foreclosure – Pre-Auction", stars: 4, mode: "hunting", criteria: [{ name: "ForeclosureStage", value: ["Auction"] }, EQUITY_30], unconfirmed: [], channels: { recommended: ["phone"], supporting: ["email"] }, cycle: "urgent 30–60 day window; SMS not permitted for cold outreach" },
  divorce: { label: "Divorce", stars: 3, mode: "hunting", criteria: [OFF_MARKET, EQUITY_30], unconfirmed: ["Divorce?: Yes", "Divorce Rec Date: Last 365 Days"], channels: { recommended: ["direct_mail"], supporting: ["phone"] }, cycle: "discreet — never call out divorce directly" },
  deceased_owner: { label: "Deceased Owner", stars: 4, mode: "hunting", criteria: [OFF_MARKET, EQUITY_30], unconfirmed: ["Deceased?: Yes"], channels: { recommended: ["direct_mail"], supporting: ["phone"] }, cycle: "empathetic, discreet; mail to the estate" },
  death_of_joint_tenant: { label: "Death of Joint Tenant", stars: 3, mode: "hunting", criteria: [OFF_MARKET, EQUITY_30], unconfirmed: ["Txfr Type: Date of Joint Tenant", "Txfr Rec Date: Last 365 Days"], channels: { recommended: ["direct_mail"], supporting: ["phone"] }, cycle: "empathetic, discreet" },
  bankruptcy: { label: "Bankruptcy", stars: 4, mode: "hunting", criteria: [OFF_MARKET, EQUITY_30], unconfirmed: ["Bankruptcy?: Yes", "BK Status: Open"], channels: { recommended: ["direct_mail"], supporting: ["phone"] }, cycle: "discreet" },
} satisfies Record<string, PlayDef>

/** The wholesaler's EXIT plays — the buyer side, investor-only (rei_playbook.md "Wholesaler exit"). */
const EXITS = {
  cash_buyers: { label: "Cash Buyers", stars: 0, mode: "exit", criteria: [], unconfirmed: ["Purchase Down %: 100+", "Purchase Date: Last 365 Days"], channels: { recommended: ["direct_mail", "phone"], supporting: ["email"] }, cycle: "line up the end-buyer before assigning" },
  flippers: { label: "Flippers", stars: 0, mode: "exit", criteria: [], unconfirmed: ["Purchase Type: Market Flip, Short Sale Flip, REO Flip", "bought and resold in 6–24 months"], channels: { recommended: ["direct_mail", "phone"], supporting: ["email"] }, cycle: "line up the end-buyer before assigning" },
  trustee_sale_investors: { label: "Trustee Sale Investors", stars: 0, mode: "exit", criteria: [{ name: "ForeclosureStage", value: ["3rd Owned"] }], unconfirmed: ["Purchase Date: Last 365 Days"], channels: { recommended: ["phone"], supporting: ["email"] }, cycle: "line up the end-buyer before assigning" },
} satisfies Record<string, PlayDef>

type OverlayKey = keyof typeof OVERLAYS
type ExitKey = keyof typeof EXITS

/** The playbook's channel benchmarks — HISTORICAL PLANNING HEURISTICS (never fixed automation, never a guaranteed rate). */
const CHANNEL_BENCHMARKS = Object.freeze({
  label: "PropertyRadar REI Playbook v5.5 channel benchmarks — historical planning heuristics, not a forecast; the Channel Arbiter decides timing and channel",
  direct_mail: "response 0.5%–2%", phone: "about 70% right-party contact; response 5%–15% live-connect; honour DNC",
  email: "open 20%–40%, click 2%–8%, reply 1%–5%", online_ads: "5–10 impressions per property; minimum audience 500 properties", door_knocking: "conversation 5%–25%",
})

/** Distress preview count below which a market reads as FARMING (rei-list-builder step 4: "if the distress counts are near zero … it's a farming market"). The number is this repo's planning threshold, not the playbook's. */
const FARMING_DISTRESS_FLOOR = 25

type InvestorPlayRequest =
  | { audience: "investor"; play: "buy_box"; overlay?: OverlayKey | null; arvTarget?: number | null; zip?: string | null }
  | { audience: "investor"; play: "exit"; exit: ExitKey; zip?: string | null }
  | { audience: "retail_seller" | "retail_buyer"; play: string }
  | { audience: "market_mode"; distressPreviewCount: number | null }

type InvestorPlayAnswer =
  | { ok: true; kind: "play"; label: string; mode: PlayDef["mode"]; stars: number; preview: { purchase: 0; limit: 1; criteria: PrCriterion[] }; equityPercentMin: number | null; unconfirmed: string[]; channels: PlayDef["channels"]; cycle: string; benchmarks: typeof CHANNEL_BENCHMARKS; heuristic: true; rank: string }
  | { ok: true; kind: "market_mode"; marketMode: "hunting" | "farming" | "unknown"; why: string }
  | { ok: false; reason: string }

/** The one door into the method. */
export function investorPlay(req: InvestorPlayRequest): InvestorPlayAnswer {
  if (req.audience === "market_mode") {
    const n = req.distressPreviewCount
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return { ok: true, kind: "market_mode", marketMode: "unknown", why: "no distress preview count — hunting vs farming is not known" }
    return n < FARMING_DISTRESS_FLOOR
      ? { ok: true, kind: "market_mode", marketMode: "farming", why: `${n} distress candidates in the preview — thin: a FARMING market (lead with the Buy Box farm and first-party plays)` }
      : { ok: true, kind: "market_mode", marketMode: "hunting", why: `${n} distress candidates in the preview — a HUNTING market (motivated-seller overlays earn their cost)` }
  }
  if (req.audience !== "investor") {
    return { ok: false, reason: "the REI Playbook plays are INVESTOR plays — a retail seller needs no 30% equity floor and is never qualified by a buy box or a distress overlay" }
  }
  const rank = "rank pulled records by PropertyRadar DistressScore (0–100, vendor-defined) — rank, never filter; never a probability"
  if (req.play === "exit") {
    const e: PlayDef = EXITS[req.exit]
    if (!e) return { ok: false, reason: `unknown exit play "${String(req.exit)}"` }
    const criteria = [...e.criteria, ...(req.zip && /^\d{5}$/.test(req.zip) ? [{ name: "ZipFive", value: [Number(req.zip)] }] : [])]
    return { ok: true, kind: "play", label: e.label, mode: e.mode, stars: e.stars, preview: { purchase: 0, limit: 1, criteria }, equityPercentMin: null, unconfirmed: [...e.unconfirmed], channels: e.channels, cycle: e.cycle, benchmarks: CHANNEL_BENCHMARKS, heuristic: true, rank }
  }
  const overlay: PlayDef | null = req.overlay ? OVERLAYS[req.overlay] ?? null : null
  if (req.overlay && !overlay) return { ok: false, reason: `unknown overlay "${String(req.overlay)}" — one of ${Object.keys(OVERLAYS).join(", ")}` }
  // Merge: the Buy Box universe + ONE overlay; a criterion the overlay repeats (off-market, equity) is kept once.
  const byName = new Map<string, PrCriterion>()
  for (const c of [...BUY_BOX.criteria, ...(overlay?.criteria ?? [])]) if (!byName.has(c.name)) byName.set(c.name, c)
  const arv = typeof req.arvTarget === "number" && req.arvTarget > 0 ? req.arvTarget : null
  // The value ceiling is ~80% of the ARV target (the area median SFR price) — only when the ARV is KNOWN (never an arbitrary range).
  if (arv) byName.set("AVM", { name: "AVM", value: [[0, Math.round(arv * 0.8)]] })
  if (req.zip && /^\d{5}$/.test(req.zip)) byName.set("ZipFive", { name: "ZipFive", value: [Number(req.zip)] })
  const unconfirmed = [...(overlay?.unconfirmed ?? []), ...(arv ? [] : ["value band: set from the area's median single-family sale price (ARV) — not stated, so no AVM ceiling"])]
  return {
    ok: true, kind: "play", label: overlay ? `Buy Box + ${overlay.label}` : BUY_BOX.label, mode: overlay ? overlay.mode : BUY_BOX.mode,
    stars: overlay ? overlay.stars : BUY_BOX.stars, preview: { purchase: 0, limit: 1, criteria: [...byName.values()] }, equityPercentMin: 30,
    unconfirmed, channels: overlay ? overlay.channels : BUY_BOX.channels, cycle: overlay ? overlay.cycle : BUY_BOX.cycle, benchmarks: CHANNEL_BENCHMARKS, heuristic: true, rank,
  }
}
