// lib/relocation/pcs-planner.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PCS / RELOCATION TRANSITION PLANNER (wave 150, lane 150KLMO — directive 150K; directive §"Relocation Corridor Observatory").
//
// SURVIVOR VERDICT (CLAUDE.md §1): MISSING. The repo held PCS only as PERSONA COPY — lib/portal/persona-config.ts (a "BAH
// Calculator" / "PCS Timeline" card with no engine behind it), lib/contacts/persona-layers.ts (angles), the portal assistant's
// military prompt. Nothing planned a move, nothing named an official source, nothing compared selling with renting out. This is
// the smallest complete planner, built ON the survivors: the C37 reporting windows (lib/intent/moving-moments.ts
// decisionWindowForDays — stated dates beat inferred ranges), the verified market facts of THE market twin
// (lib/market-reports/market-twin.ts — listing asking median, asking rent), the capability names the managers already own
// (appointment_schedule, lender_preapproval_handoff — lib/kernel/strategy-library.ts) and THE valuation door named by LAW 3
// (requestPropertyValuation — the caller passes its answer in; this module never calls a vendor).
//
// HARD BOUNDARIES (owner directive): official DoD BAH and installation information is cited BY NAME AND URL — never scraped,
// never fetched here; a BAH figure is the person's OWN (their LES / the DTMO lookup they ran) or a DTMO rate file staff imported.
// Individual PCS orders, private employee data, pseudonymous social identities and unconsented service histories are OUT of scope:
// the person mode REFUSES without a stated consent basis for the destination/timeline the person volunteered. The sell-vs-rent
// comparison is an ILLUSTRATION over stated inputs with every assumption labelled — not tax, legal or lending advice; the tax
// question (IRC §121's military suspension of the 5-year test) and the loan belong to a CPA and a lender (the handoffs).
//
// Consumer: lib/market-reports/topics.ts (territory_guide mode — the relocation guide evidence over verified twin facts). The
// person mode is the door the AI ISA / portal assistant call once wired (lane 150KLMO notes, Registry entries needed). Pure,
// never throws.

import { decisionWindowForDays, type DecisionWindow } from "@/lib/intent/moving-moments"

/** Official sources, cited by NAME and URL. Read by people; never scraped or fetched by the OS. */
export const PCS_OFFICIAL_SOURCES = Object.freeze([
  { key: "dtmo_bah_lookup", name: "Defense Travel Management Office — BAH Rate Lookup", url: "https://www.travel.dod.mil/Allowances/Basic-Allowance-for-Housing/BAH-Rate-Lookup/", use: "the service member's own BAH for the new duty station (pay grade + dependency status + ZIP) — entered by them, never fetched" },
  { key: "military_installations", name: "Military OneSource — MilitaryINSTALLATIONS", url: "https://installations.militaryonesource.mil/", use: "installation-level housing office, relocation assistance and area information for the destination base" },
  { key: "plan_my_move", name: "Military OneSource — Plan My Move", url: "https://planmymove.militaryonesource.mil/", use: "the official PCS move checklist and timeline the person keeps" },
  { key: "va_home_loans", name: "U.S. Department of Veterans Affairs — VA Home Loans", url: "https://www.va.gov/housing-assistance/home-loans/", use: "VA loan eligibility and entitlement — confirmed by the lender, never by the OS" },
] as const)

type SourceKey = (typeof PCS_OFFICIAL_SOURCES)[number]["key"]

/** Labelled assumptions of the illustration — each replaceable by the person's own number. */
const ASSUMPTIONS = Object.freeze({
  sellingCostPct: { value: 0.07, label: "selling and closing costs, assumed 7 % of the price — replace with the actual net sheet" },
  managementPct: { value: 0.1, label: "property management, assumed 10 % of rent (a long-distance landlord usually hires one)" },
  vacancyPct: { value: 0.08, label: "vacancy, assumed 8 % of rent (about one month a year)" },
  maintenancePct: { value: 0.08, label: "maintenance and repairs reserve, assumed 8 % of rent" },
})

interface StatedConsent { basis: string; ref?: string | null; capturedAt?: string | null }

interface SellVsRent {
  sell: { netProceeds: number | null; why: string }
  rentOut: { monthlyNet: number | null; why: string }
  assumptions: string[]
  boundary: string
}

type RelocationInput =
  | {
      mode: "territory_guide"
      territoryLabel: string
      /** Verified twin facts for the territory (listing asking median + asking rent), with their date and source. */
      facts: { medianAskingPrice: number | null; medianRent: number | null; asOf: string | null; source: string }
    }
  | {
      mode: "person"
      /** The basis the person's volunteered destination/timeline is held on — required (consented destination/timeline). */
      consent: StatedConsent | null
      destination: { label: string; installationName?: string | null; state?: string | null }
      /** The report / move date the PERSON stated (ISO day) — a stated date beats any inferred range. */
      statedMoveDate?: string | null
      now?: Date
      currentHome?: { value?: number | null; valueSource?: string | null; mortgageBalance?: number | null; monthlyPayment?: number | null; expectedRent?: number | null; rentSource?: string | null } | null
      bahMonthly?: { amount: number; source: "self_stated" | "dtmo_rate_file" } | null
      vaInterestStated?: boolean
      spouseLicensedOccupation?: string | null
      /** States the presenting agent is licensed in (agent_licenses) — a destination outside them is a REFERRAL, not a service. */
      agentLicensedStates?: string[]
    }

interface PlanStep { key: string; owner: string; what: string; sources: SourceKey[] }

type RelocationPlan =
  | { ok: true; mode: "territory_guide"; summary: string; priceToRent: number | null; grossRentYieldPct: number | null; sources: typeof PCS_OFFICIAL_SOURCES; boundary: string }
  | { ok: true; mode: "person"; window: DecisionWindow; windowBasis: "stated_date" | "unknown"; steps: PlanStep[]; sellVsRent: SellVsRent | null; sources: typeof PCS_OFFICIAL_SOURCES; boundary: string }
  | { ok: false; reason: string }

const BOUNDARY = "Official military housing information is cited by name and link and read by the person; the OS never fetches, scrapes or infers orders, allowances or service history. Figures are illustrations over stated inputs and verified market data — not tax, legal or lending advice."

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`
const pos = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }

/** PURE — selling now vs renting the home out, over the person's stated numbers; null where an input is missing (said). */
function sellVsRent(h: NonNullable<Extract<RelocationInput, { mode: "person" }>["currentHome"]>): SellVsRent {
  const value = pos(h.value), balance = Number.isFinite(Number(h.mortgageBalance)) && Number(h.mortgageBalance) >= 0 ? Number(h.mortgageBalance) : null
  const rent = pos(h.expectedRent), payment = pos(h.monthlyPayment)
  const a = ASSUMPTIONS
  const sell = value != null && balance != null
    ? { netProceeds: Math.round(value * (1 - a.sellingCostPct.value) - balance), why: `${usd(value)} value${h.valueSource ? ` (${h.valueSource})` : ""} less ${a.sellingCostPct.value * 100}% selling costs less the ${usd(balance)} loan balance` }
    : { netProceeds: null, why: value == null ? "no home value on record — the valuation door (requestPropertyValuation) answers it" : "no loan balance stated" }
  const keep = 1 - a.managementPct.value - a.vacancyPct.value - a.maintenancePct.value
  const rentOut = rent != null && payment != null
    ? { monthlyNet: Math.round(rent * keep - payment), why: `${usd(rent)} rent${h.rentSource ? ` (${h.rentSource})` : ""} less management, vacancy and maintenance less the ${usd(payment)} monthly payment` }
    : { monthlyNet: null, why: rent == null ? "no expected rent — the market twin's asking rent for the ZIP is the verified starting point" : "no monthly payment (principal, interest, taxes, insurance) stated" }
  return { sell, rentOut, assumptions: Object.values(a).map((x) => x.label), boundary: "Tax treatment (IRC §121 — a service member on qualified official extended duty may suspend the 5-year test) and any refinance belong to a CPA and a lender." }
}

/** The planner — territory_guide (market-level, no person) or person (consented, volunteered facts only). */
export function planRelocation(input: RelocationInput): RelocationPlan {
  if (input.mode === "territory_guide") {
    const p = pos(input.facts.medianAskingPrice), r = pos(input.facts.medianRent)
    const priceToRent = p != null && r != null ? Math.round((p / (r * 12)) * 10) / 10 : null
    const grossRentYieldPct = p != null && r != null ? Math.round(((r * 12) / p) * 1000) / 10 : null
    const summary = priceToRent != null
      ? `${input.territoryLabel}: listed homes ask ${usd(p!)} at the median and rental listings ask ${usd(r!)} a month (${input.facts.source}, ${input.facts.asOf ?? "date unknown"}) — a price-to-rent ratio of ${priceToRent} (gross ${grossRentYieldPct}% a year), the starting point for a keep-and-rent or sell decision on a move`
      : `${input.territoryLabel}: no verified listing and rental medians together — the own-or-rent illustration is not stated`
    return { ok: true, mode: "territory_guide", summary, priceToRent, grossRentYieldPct, sources: PCS_OFFICIAL_SOURCES, boundary: BOUNDARY }
  }

  // PERSON MODE — only what the person volunteered, on a stated basis.
  if (!input.consent || typeof input.consent.basis !== "string" || !input.consent.basis.trim()) {
    return { ok: false, reason: "no stated consent basis for the destination and timeline — the planner works only from what the person volunteered (never orders, never service history)" }
  }
  const now = input.now ?? new Date()
  const stated = input.statedMoveDate && /^\d{4}-\d{2}-\d{2}/.test(input.statedMoveDate) ? Date.parse(`${input.statedMoveDate.slice(0, 10)}T00:00:00Z`) : NaN
  const window = Number.isFinite(stated) ? decisionWindowForDays((stated - now.getTime()) / 86_400_000) : "unknown"
  const steps: PlanStep[] = [
    { key: "official_checklist", owner: "the person (Military OneSource)", what: "keep the official PCS checklist and timeline; we work to the dates you give us", sources: ["plan_my_move", "military_installations"] },
    { key: "housing_budget", owner: "shopping_agent", what: input.bahMonthly ? `search within your stated housing budget (BAH ${usd(input.bahMonthly.amount)}/month, ${input.bahMonthly.source === "self_stated" ? "as you told us" : "from the DTMO rate file"})` : "tell us your BAH from your LES or the DTMO lookup if you want the search held to it", sources: ["dtmo_bah_lookup"] },
    { key: "remote_tours", owner: "shopping_agent · appointment_schedule", what: `live video tours of shortlisted homes in ${input.destination.label} with a local agent, plus any 3-D tour the listing's own MLS feed provides — decide before you arrive`, sources: [] },
  ]
  if (input.vaInterestStated) steps.push({ key: "finance_handoff", owner: "shopping_agent · lender_preapproval_handoff", what: "a pre-approval conversation with a bench lender who confirms VA eligibility and entitlement", sources: ["va_home_loans"] })
  const destState = (input.destination.state ?? "").trim().toUpperCase()
  const licensed = (input.agentLicensedStates ?? []).map((s) => s.trim().toUpperCase())
  if (destState && licensed.length > 0 && !licensed.includes(destState)) steps.push({ key: "licence_handoff", owner: "referral", what: `${destState} is outside the states your agent is licensed in — a referral to a licensed agent there, with your consent`, sources: [] })
  if (input.spouseLicensedOccupation) steps.push({ key: "spouse_licence", owner: "the person", what: `license transfer questions for a ${input.spouseLicensedOccupation} go to the destination state's licensing board and the installation's relocation office`, sources: ["military_installations"] })
  const sv = input.currentHome ? sellVsRent(input.currentHome) : null
  if (sv) steps.push({ key: "sell_vs_rent", owner: "listing_concierge · finance handoff", what: "compare selling with renting out the current home (illustration below; tax and lending questions go to a CPA and a lender)", sources: [] })
  return { ok: true, mode: "person", window, windowBasis: Number.isFinite(stated) ? "stated_date" : "unknown", steps, sellVsRent: sv, sources: PCS_OFFICIAL_SOURCES, boundary: BOUNDARY }
}
