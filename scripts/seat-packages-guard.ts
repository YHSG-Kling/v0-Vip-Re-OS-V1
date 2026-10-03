#!/usr/bin/env tsx
/**
 * scripts/seat-packages-guard.ts   (npm run test:seat-packages)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 79A — owner verbatim (2026-09-23):
 *
 *   "not charging for staff/admin (non producing) and charging producing
 *    seats. solo tier is 2 seats; team tier is 10 seats; brokerage tier is 30
 *    seats; multi location tier is custom pricing for seats. the fee is setup
 *    fee. there will be an opportunity for buying more seat packages and if
 *    the tenant hits a limit they will be able to either upgrade to a higher
 *    tier (or lower tier if their business changes) or buy more seats.
 *    subscriptions will be setup in stripe so they sync."
 *
 * Proves, with production functions against fixtures / injected clients and
 * STRIPPED source for every code-token scan (scripts/strip-comments.ts,
 * CLAUDE.md §2), a positive control beside every absence claim. Every
 * number is DERIVED from TIER_SEAT_BANDS — never a pinned adjacency.
 *
 *   1 · THE BANDS      2 / 10 / 30 / custom; identity with the gate's fallback;
 *                      the fit; the enterprise floor derived from the bands.
 *   2 · THE DOOR       effective limit = band + extra seats (override / custom
 *                      count); over the limit the paths are upgrade / downgrade
 *                      (when today's producers fit) / buy_seats (only when the
 *                      package is SELLABLE) / contact; the message quotes the
 *                      catalogue price and nothing else.
 *   3 · STRIPE → ROW   items → tier + packages (by price, by metadata, unmatched
 *                      reported); the ONE normalizer; a patch that never zeroes
 *                      seats it did not read; prices → catalogue patches.
 *   4 · RECONCILE      the daily pass against an injected client: counted
 *                      writes, tier re-sync, errors and skips reported.
 *   5 · WIRING         webhook, cron, seat door actions, billing.ts:868, staff
 *                      door `produces`, the /login activated rail, no second
 *                      Stripe importer, the retired $25 literal gone.
 *   6 · MIGRATION      m660's SET / CASE numbers derived from the bands; the
 *                      seat columns present.
 *   7 · registration.
 *
 * No DB, no network. Run: npx tsx --conditions=react-server scripts/seat-packages-guard.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { walkTs } from "./runtime-roots"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
/** POSITIVE CONTROL: the same finder, fed the defect, MUST report it. */
function control(name: string, defectSeen: boolean) {
  if (defectSeen) { passed++; console.log(`  ↺ control: ${name}`) }
  else { failed++; failures.push(`CONTROL DID NOT GO RED: ${name}`); console.log(`  ✗ CONTROL DID NOT GO RED: ${name}`) }
}
const root = process.cwd()
const raw = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "")
const code = (p: string) => stripComments(raw(p))

const CATALOG = "lib/billing/plan-catalog.ts"
const MATRIX = "lib/kernel/tier-role-matrix.ts"
const USAGE = "lib/kernel/seat-usage.ts"
const PACKAGES_MODULE = "lib/billing/seat-packages.ts"
const SYNC = "lib/billing/seat-sync.ts"
const OPS = "lib/billing/stripe-subscription-ops.ts"
const ACTIVATION = "lib/billing/subscription-activation.ts"
const WEBHOOK = "app/api/billing/webhook/route.ts"
const CRON = "app/api/cron/billing-dunning/route.ts"
const BILLING_ACTIONS = "app/actions/billing.ts"
const CATALOG_ACTIONS = "app/actions/superadmin/plan-catalog.ts"
const KERNEL_BILLING = "lib/kernel/billing.ts"
const CORE = "lib/kernel/tenant-creation.ts"
const LOGIN = "app/login/page.tsx"
const DOOR = "lib/platform/subscriber-door.ts"
const TENANT_USERS = "app/actions/superadmin/tenant-users.ts"
const INVITE = "app/actions/admin/invite-user.ts"
const MIGRATION = "supabase/migrations/m660-seat-bands-2-10-30-custom-and-seat-packages.sql"

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1 · THE BANDS — 2 / 10 / 30 / custom, one object, the fit, the derived floor]")
const { TIER_SEAT_BANDS, CANONICAL_TIERS, tierForSeatCount, seatCountAboveEveryBand, seatPackageSellable, seatPackagesNeeded, validatePlanTierInput } = await import("../lib/billing/plan-catalog")
const { TIER_SEAT_LIMITS, TIER_ORDER, seatDecision, seatDecisionMessage, effectiveSeatLimit, seatCheck } = await import("../lib/kernel/tier-role-matrix")
const { ENTERPRISE_SEAT_FLOOR, tierForProspect } = await import("../lib/platform/prospect-conversion")

check("the bands are the owner's: solo_agent 2 · team 10 · brokerage 30 · multi_location custom (null)",
  TIER_SEAT_BANDS.solo_agent === 2 && TIER_SEAT_BANDS.team === 10 && TIER_SEAT_BANDS.brokerage === 30 && TIER_SEAT_BANDS.multi_location === null)
check("TIER_SEAT_LIMITS IS TIER_SEAT_BANDS (identity)", (TIER_SEAT_LIMITS as unknown) === (TIER_SEAT_BANDS as unknown))
const capped = CANONICAL_TIERS.filter((t) => TIER_SEAT_BANDS[t] !== null)
const custom = CANONICAL_TIERS.filter((t) => TIER_SEAT_BANDS[t] === null)
check("the capped bands ascend and the custom tier is last", capped.every((t, i) => i === 0 || (TIER_SEAT_BANDS[t] as number) > (TIER_SEAT_BANDS[capped[i - 1]!] as number)) && custom.length === 1 && custom[0] === CANONICAL_TIERS[CANONICAL_TIERS.length - 1])
// THE FIT, derived: for every capped tier, its band fits on it and band+1 moves up.
check("tierForSeatCount: each capped band fits its tier, band+1 moves to the next tier, and above every band lands on the custom tier",
  capped.every((t, i) => tierForSeatCount(TIER_SEAT_BANDS[t] as number) === t && tierForSeatCount((TIER_SEAT_BANDS[t] as number) + 1) === CANONICAL_TIERS[CANONICAL_TIERS.indexOf(t) + 1] && (i > 0 ? tierForSeatCount((TIER_SEAT_BANDS[capped[i - 1]!] as number) + 1) === t : true))
  && tierForSeatCount(seatCountAboveEveryBand()) === custom[0] && tierForSeatCount(null) === CANONICAL_TIERS[0] && tierForSeatCount(0) === CANONICAL_TIERS[0])
check("seatCountAboveEveryBand = the largest band + 1, and ENTERPRISE_SEAT_FLOOR IS it (derived, not retyped)",
  seatCountAboveEveryBand() === Math.max(...capped.map((t) => TIER_SEAT_BANDS[t] as number)) + 1 && ENTERPRISE_SEAT_FLOOR === seatCountAboveEveryBand())
check("tierForProspect follows: a declared tier wins, else the count's band", tierForProspect("team", 1) === "team" && tierForProspect(null, TIER_SEAT_BANDS.team as number) === "team" && tierForProspect(null, (TIER_SEAT_BANDS.team as number) + 1) === "brokerage")
check("the catalogue validator carries the seat-package columns (size ≥ 1, cents ≥ 0; 0 cents stores as unpriced, never free)",
  (() => {
    const ok = validatePlanTierInput({ tierName: "team", displayName: "T", monthlyPriceCents: 1, seatPackageSize: 5, seatPackagePriceCents: 4900, stripeSeatPriceId: " price_seat " })
    const zero = validatePlanTierInput({ tierName: "team", displayName: "T", monthlyPriceCents: 1, seatPackageSize: 5, seatPackagePriceCents: 0 })
    return ok.ok && ok.value.seatPackageSize === 5 && ok.value.seatPackagePriceCents === 4900 && ok.value.stripeSeatPriceId === "price_seat"
      && zero.ok && zero.value.seatPackagePriceCents === null
      && !validatePlanTierInput({ tierName: "team", displayName: "T", monthlyPriceCents: 1, seatPackageSize: 0 }).ok
      && !validatePlanTierInput({ tierName: "team", displayName: "T", monthlyPriceCents: 1, seatPackagePriceCents: -1 }).ok
  })())

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2 · THE DOOR — band + extra seats; upgrade / downgrade / buy / contact; the price from the catalogue]")
const TEAM = TIER_SEAT_BANDS.team as number
const BRK = TIER_SEAT_BANDS.brokerage as number
const SOLO = TIER_SEAT_BANDS.solo_agent as number
const PACK = { size: 5, priceCents: 4900, stripePriceId: "price_seat_team" }
const PACKAGES = { team: PACK, brokerage: { ...PACK, stripePriceId: "price_seat_brk" }, solo_agent: { size: 1, priceCents: 2500, stripePriceId: "price_seat_solo" } }

check("sellable needs size, price AND a Stripe price; packages needed = ceil(over / size)",
  seatPackageSellable(PACK) && !seatPackageSellable({ ...PACK, priceCents: null }) && !seatPackageSellable({ ...PACK, stripePriceId: null }) && !seatPackageSellable({ ...PACK, size: 0 }) && !seatPackageSellable(null)
  && seatPackagesNeeded(1, 5) === 1 && seatPackagesNeeded(5, 5) === 1 && seatPackagesNeeded(6, 5) === 2 && seatPackagesNeeded(0, 5) === 0)
{
  const e = effectiveSeatLimit("team", null, null, { extraSeats: 5 })
  check(`effective limit = band + extra seats (team ${TEAM} + 5 = ${TEAM + 5}); bandLimit stays the band`, e.limit === TEAM + 5 && e.bandLimit === TEAM && e.extraSeats === 5 && !e.overridden && !e.custom)
  check("a staff override WINS over the band and still gains extra seats", effectiveSeatLimit("team", 3, null, { extraSeats: 5 }).limit === 8 && effectiveSeatLimit("team", 3, null, { extraSeats: 5 }).overridden)
  check("the custom tier: no negotiated count ⇒ unlimited; a negotiated count ⇒ that count + extra seats", effectiveSeatLimit("multi_location", null).limit === null && effectiveSeatLimit("multi_location", null, null, { customSeatLimit: 40, extraSeats: 5 }).limit === 45 && effectiveSeatLimit("multi_location", null, null, { customSeatLimit: 40 }).custom)
  control("without the terms the band alone answers (the extra seats are not imagined)", effectiveSeatLimit("team", null).limit === TEAM)
}
{
  // Team, full to the band, one more producer → the door.
  const d = seatDecision("team", TEAM, null, 1, null, { packages: PACKAGES })
  const kinds = d.paths.map((p) => p.kind)
  check(`team at ${TEAM}/${TEAM} + 1: over by 1, UPGRADE to brokerage (${BRK}) and BUY 1 package of 5 at $49 — no downgrade (today's ${TEAM} do not fit on solo)`,
    !d.withinLimit && d.outcome === "over_limit" && d.seatsOver === 1 && d.upgradeTo === "brokerage" && d.upgradeSeats === BRK
    && kinds.includes("upgrade") && kinds.includes("buy_seats") && !kinds.includes("downgrade") && !kinds.includes("contact")
    && d.paths.some((p) => p.kind === "buy_seats" && p.packages === 1 && p.size === 5 && p.priceCents === 4900 && p.seatsAdded === 5), JSON.stringify(d.paths))
  const msg = seatDecisionMessage(d) ?? ""
  check("the message names the upgrade AND the package, quoting $49/month from the catalogue and no other dollar figure",
    /upgrade to Brokerage for 30 seats/.test(msg) && /buy 1 seat package \(5 seats each, \$49\/month per package\)/.test(msg) && (msg.match(/\$\d/g) ?? []).length === 1, msg)
  control("the finder sees a second dollar figure", ((msg + " or $25/month per seat").match(/\$\d/g) ?? []).length === 2)
  const withExtra = seatDecision("team", TEAM + 5, null, 1, null, { terms: { extraSeats: 5 }, packages: PACKAGES })
  check(`purchased seats RAISE the limit: team + 5 extra seats admits ${TEAM + 5} and refuses the next, saying "plus 5 purchased"`,
    seatDecision("team", TEAM + 4, null, 1, null, { terms: { extraSeats: 5 } }).withinLimit && !withExtra.withinLimit && /plus 5 purchased/.test(seatDecisionMessage(withExtra) ?? ""))
  const six = seatDecision("team", TEAM, null, 6, null, { packages: PACKAGES })
  check("6 seats over on a 5-seat package needs 2 packages", six.paths.some((p) => p.kind === "buy_seats" && p.packages === 2 && p.seatsAdded === 10))
  const unsellable = seatDecision("team", TEAM, null, 1, null, { packages: { team: { ...PACK, priceCents: null } } })
  check("an UNPRICED package is never offered — the door says contact (package_not_sellable) beside the upgrade",
    unsellable.paths.some((p) => p.kind === "contact" && p.reason === "package_not_sellable") && !unsellable.paths.some((p) => p.kind === "buy_seats") && /not on sale yet/.test(seatDecisionMessage(unsellable) ?? ""))
  control("the same door with a priced package DOES offer buy_seats", d.paths.some((p) => p.kind === "buy_seats"))
  const noCatalog = seatDecision("team", TEAM)
  check("no package facts at all (no catalogue) ⇒ contact, never an invented price", noCatalog.paths.some((p) => p.kind === "contact") && !/\$/.test(seatDecisionMessage(noCatalog) ?? ""))
}
{
  const down = seatDecision("team", SOLO, null, 0)
  check(`DOWNGRADE is carried on every decision: a team tenant with ${SOLO} producers may move down to solo (${SOLO}); with ${SOLO + 1} it may not`,
    down.withinLimit && down.downgradeTo === "solo_agent" && down.downgradeSeats === SOLO && seatDecision("team", SOLO + 1, null, 0).downgradeTo === null)
  const brkDown = seatDecision("brokerage", TEAM, null, 0)
  check(`a brokerage tenant with ${TEAM} producers is offered team (the HIGHEST lower tier that fits), not solo`, brkDown.downgradeTo === "team")
  // A downgrade joins the door only when it fits — build a catalogue where a
  // lower band is wider than the effective limit (a staff-free, catalogue-driven case).
  const oddCatalog = { solo_agent: 2, team: 3, brokerage: 30, multi_location: null }
  const withDown = seatDecision("team", 3, null, 1, oddCatalog, { packages: PACKAGES })
  check("at the door the downgrade path appears exactly when today's producers fit it (catalogue-driven)", withDown.paths.some((p) => p.kind === "downgrade" && p.tier === "solo_agent") === (3 <= 2) && seatDecision("team", 2, null, 2, oddCatalog).paths.some((p) => p.kind === "downgrade" && p.tier === "solo_agent"))
}
{
  const brk = seatDecision("brokerage", BRK, null, 1, null, { packages: PACKAGES })
  check(`brokerage at ${BRK}/${BRK} + 1 is REFUSED (no longer unlimited): upgrade to Multi-Location with custom seats, or buy a package`,
    !brk.withinLimit && brk.upgradeTo === "multi_location" && brk.upgradeSeats === null && brk.paths.some((p) => p.kind === "buy_seats") && /custom seats/.test(seatDecisionMessage(brk) ?? ""))
  control(`brokerage at ${BRK - 1} + 1 is admitted (the refusal is the band, not a stuck gate)`, seatDecision("brokerage", BRK - 1, null, 1).withinLimit)
  check("multi_location with nothing negotiated is unlimited", seatDecision("multi_location", 5000).withinLimit && seatDecision("multi_location", 5000).limit === null)
  const negotiated = seatDecision("multi_location", 40, null, 1, null, { terms: { customSeatLimit: 40 }, packages: PACKAGES })
  check("a NEGOTIATED custom count refuses past it with contact (custom_pricing) — no upgrade, no package",
    !negotiated.withinLimit && negotiated.paths.length === 1 && negotiated.paths[0]!.kind === "contact" && (negotiated.paths[0] as any).reason === "custom_pricing" && negotiated.upgradeTo === null)
  const capped = seatDecision("team", 3, 3, 1, null, { packages: { team: { ...PACK, priceCents: null } } })
  check("a staff override is a deliberate cap: no upgrade, and with no sellable package the answer is contact (staff_cap)",
    !capped.withinLimit && capped.overridden && capped.upgradeTo === null && capped.paths.some((p) => p.kind === "contact" && p.reason === "staff_cap"))
  check("…but a sellable package is still offered on an override (the cap can be bought past, not climbed past)", seatDecision("team", 3, 3, 1, null, { packages: PACKAGES }).paths.some((p) => p.kind === "buy_seats") && !seatDecision("team", 3, 3, 1, null, { packages: PACKAGES }).paths.some((p) => p.kind === "upgrade"))
  check("seatCheck (the display projection) takes the terms and agrees with the decision", seatCheck("team", TEAM + 4, null, null, { extraSeats: 5 }).allowed && !seatCheck("team", TEAM + 5, null, null, { extraSeats: 5 }).allowed)
}
// The gate reads the tenant's terms and FAILS CLOSED when it cannot.
{
  type Fixture = { data: unknown; error: { message: string } | null }
  function fakeSvc(fx: Record<string, Fixture>) {
    return {
      from(table: string) {
        const f = fx[table] ?? { data: [], error: null }
        const chain: any = {
          eq() { return chain }, in() { return chain }, not() { return chain }, limit() { return chain }, order() { return chain },
          maybeSingle: async () => ({ data: Array.isArray(f.data) ? (f.data[0] ?? null) : f.data, error: f.error }),
          then(res: (v: unknown) => unknown) { return Promise.resolve({ data: f.data, error: f.error }).then(res) },
        }
        return { select() { return chain } }
      },
    } as any
  }
  const { seatGate, resolveCatalogSeatLimits, resolveTenantSeatTerms } = await import("../lib/kernel/seat-usage")
  const catalogRows = CANONICAL_TIERS.map((t) => ({ tier_name: t, max_agents: TIER_SEAT_BANDS[t], seat_package_size: t === "multi_location" ? null : 5, seat_package_price_cents: t === "team" ? 4900 : null, stripe_seat_price_id: t === "team" ? "price_seat_team" : null }))
  const users = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, user_type: "agent", status: "active" })), error: null })
  const base = (extra: Record<string, Fixture>) => fakeSvc({ brokerages: { data: [{ plan_tier: "team", billing_metadata: {} }], error: null }, users: users(TEAM), agents: { data: [], error: null }, user_role_assignments: { data: [], error: null }, subscription_tiers: { data: catalogRows, error: null }, ...extra })
  const read = await resolveCatalogSeatLimits(fakeSvc({ subscription_tiers: { data: catalogRows, error: null } }))
  check("the catalogue reader returns limits AND packages off the same rows (team sellable, brokerage unpriced, multi none)",
    read.ok && read.limits.team === TEAM && read.packages.team?.priceCents === 4900 && read.packages.brokerage?.priceCents === null && read.packages.multi_location === null)
  const terms = await resolveTenantSeatTerms(fakeSvc({ subscriptions: { data: [{ id: "s1", extra_seats: 10, seat_packages: 2, custom_seat_limit: null, status: "active" }], error: null } }), "b1")
  check("the terms reader returns extra seats / packages / custom count and the row id; no row is an honest zero", terms.ok && terms.terms.extraSeats === 10 && terms.terms.seatPackages === 2 && terms.subscriptionId === "s1"
    && (await resolveTenantSeatTerms(fakeSvc({}), "b1")).terms.extraSeats === 0)
  const full = await seatGate(base({}), "b1", "agent")
  check(`the gate: team full at ${TEAM} refuses the next producer with the door (upgrade + buy_seats from the catalogue row)`, !full.allowed && full.reason === "over_limit" && full.decision?.paths.some((p) => p.kind === "buy_seats" && p.priceCents === 4900) === true && full.decision?.upgradeTo === "brokerage")
  const bought = await seatGate(base({ subscriptions: { data: [{ id: "s1", extra_seats: 5, seat_packages: 1, status: "active" }], error: null } }), "b1", "agent")
  check("…and the SAME tenant with a bought package is admitted (the gate reads subscriptions.extra_seats)", bought.allowed && bought.reason === "within_limit" && bought.decision?.limit === TEAM + 5)
  const refused = await seatGate(base({ subscriptions: { data: null, error: { message: "permission denied" } } }), "b1", "agent")
  check("a refused terms read FAILS CLOSED by name (seat_terms_unreadable)", !refused.allowed && refused.reason === "seat_terms_unreadable" && /purchased seats could not be read/.test(refused.message ?? ""))
  const staffAdmin = await seatGate(base({}), "b1", "admin", { produces: false })
  check("the staff door: a NON-producing admin on a full team is free (produces:false → not_a_seat)", staffAdmin.allowed && staffAdmin.reason === "not_a_seat")
  control("…while the same admin without the statement produces on a team tenant and is refused", !(await seatGate(base({}), "b1", "admin")).allowed)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3 · STRIPE → ROW — items → tier + packages; the ONE normalizer; prices → catalogue]")
const { itemFactsOf, deriveSubscriptionSeatState, normalizeStripeSubscription, catalogFromStripePrices, priceFactsOf, seatRowPatch } = await import("../lib/billing/seat-packages")
const { buildSubscriptionPatch } = await import("../lib/billing/subscription-activation")
const TIERS = [
  { id: "t-solo", tier_name: "solo_agent", stripe_price_id: "price_solo", stripe_seat_price_id: null, seat_package_size: 5 },
  { id: "t-team", tier_name: "team", stripe_price_id: "price_team", stripe_seat_price_id: "price_seat_team", seat_package_size: 5 },
  { id: "t-brk", tier_name: "brokerage", stripe_price_id: "price_brk", stripe_seat_price_id: "price_seat_brk", seat_package_size: 5 },
  { id: "t-multi", tier_name: "multi_location", stripe_price_id: null, stripe_seat_price_id: null, seat_package_size: null },
]
function sub(items: any[], extra: Record<string, unknown> = {}): any {
  return { id: "sub_1", customer: "cus_1", status: "active", metadata: { brokerage_id: "b1", tier_id: "t-meta" }, current_period_start: 1, current_period_end: 2, trial_end: null, cancel_at: null, items: { data: items }, ...extra }
}
{
  const s = sub([{ id: "si_plan", price: { id: "price_team", metadata: { tier_name: "team" } }, quantity: 1 }, { id: "si_seat", price: { id: "price_seat_team", metadata: { kind: "seat_package" } }, quantity: 2 }])
  const d = deriveSubscriptionSeatState(itemFactsOf(s), TIERS)
  check("plan item by price → tier; seat item quantity 2 × size 5 → 10 extra seats; nothing unmatched", d.tierId === "t-team" && d.tierName === "team" && d.tierSource === "plan_item" && d.seatItemId === "si_seat" && d.seatPackages === 2 && d.extraSeats === 10 && d.unmatchedPriceIds.length === 0, JSON.stringify(d))
  const n = normalizeStripeSubscription(s, d)
  check("the normalizer: tier from the ITEMS (not metadata.tier_id), seat facts on the object, status through the stored vocabulary", n.tierId === "t-team" && n.seatPackages === 2 && n.extraSeats === 10 && n.stripeSeatItemId === "si_seat" && n.stripePriceId === "price_team" && n.status === "active"
    && normalizeStripeSubscription({ ...s, status: "canceled" }, d).status === "cancelled" && normalizeStripeSubscription({ ...s, status: "unpaid" }, d).status === "past_due")
  const patch = buildSubscriptionPatch(n)
  check("buildSubscriptionPatch writes the seat columns when derived", patch.seat_packages === 2 && patch.extra_seats === 10 && patch.stripe_seat_item_id === "si_seat" && patch.stripe_price_id === "price_team" && patch.tier_id === "t-team")
  const blind = buildSubscriptionPatch(normalizeStripeSubscription(s, null))
  check("…and OMITS them when the items were not read — a blind write never zeroes what a tenant bought; the tier falls back to metadata", !("seat_packages" in blind) && !("extra_seats" in blind) && blind.tier_id === "t-meta")
  control("the finder sees seat columns in a derived patch", "extra_seats" in patch)
  const byMeta = deriveSubscriptionSeatState(itemFactsOf(sub([{ id: "si_x", price: { id: "price_custom_deal", metadata: { tier_name: "multi_location" } }, quantity: 1 }])), TIERS)
  check("a tenant-specific price with tier_name metadata (custom multi_location deal) resolves by metadata", byMeta.tierId === "t-multi" && byMeta.tierSource === "price_metadata" && byMeta.basePriceId === "price_custom_deal")
  const foreign = deriveSubscriptionSeatState(itemFactsOf(sub([{ id: "si_plan", price: { id: "price_team" }, quantity: 1 }, { id: "si_seat", price: { id: "price_seat_brk" }, quantity: 3 }, { id: "si_other", price: { id: "price_unknown" }, quantity: 1 }])), TIERS)
  check("a seat pack from ANOTHER tier and an unknown price are reported unmatched, never counted", foreign.tierId === "t-team" && foreign.seatPackages === 0 && foreign.extraSeats === 0 && [...foreign.unmatchedPriceIds].sort().join() === "price_seat_brk,price_unknown")
  const none = deriveSubscriptionSeatState(itemFactsOf(sub([{ id: "si_other", price: "price_unknown", quantity: 1 }])), TIERS)
  check("no matching item ⇒ tierSource none, and seatRowPatch never NULLS the row's tier for it", none.tierId === null && none.tierSource === "none" && seatRowPatch({ tier_id: "t-team", seat_packages: 0, extra_seats: 0, stripe_seat_item_id: null, stripe_price_id: "price_team" }, none) === null)
  const rowPatch = seatRowPatch({ tier_id: "t-solo", seat_packages: 0, extra_seats: 0, stripe_seat_item_id: null, stripe_price_id: null }, d)
  check("seatRowPatch is the DIFFERENCE only (tier, packages, seats, item, price) and null when equal", !!rowPatch && rowPatch.tier_id === "t-team" && rowPatch.extra_seats === 10 && seatRowPatch({ tier_id: "t-team", seat_packages: 2, extra_seats: 10, stripe_seat_item_id: "si_seat", stripe_price_id: "price_team" }, d) === null)
}
{
  const prices = [
    { id: "price_team_new", active: true, unit_amount: 29900, currency: "usd", recurring: { interval: "month", usage_type: "licensed" }, metadata: { tier_name: "team" }, product: { name: "Team", metadata: {} } },
    { id: "price_team_old", active: true, unit_amount: 24900, currency: "usd", recurring: { interval: "month", usage_type: "licensed" }, metadata: { tier_name: "team" }, product: { name: "Team", metadata: {} } },
    { id: "price_team_year", active: true, unit_amount: 299000, currency: "usd", recurring: { interval: "year", usage_type: "licensed" }, metadata: { tier_name: "team" }, product: { name: "Team", metadata: {} } },
    { id: "price_seat_team", active: true, unit_amount: 4900, currency: "usd", recurring: { interval: "month", usage_type: "licensed" }, metadata: { tier_name: "team", kind: "seat_package", seat_package_size: "5" }, product: { name: "Team seats", metadata: {} } },
    { id: "price_seat_brk", active: true, unit_amount: 3900, currency: "usd", recurring: { interval: "month", usage_type: "licensed" }, transform_quantity: { divide_by: 10, round: "up" }, metadata: { kind: "seat_package" }, product: { name: "Brokerage seats", metadata: { tier_name: "brokerage" } } },
    { id: "price_nometa", active: true, unit_amount: 100, currency: "usd", recurring: { interval: "month", usage_type: "licensed" }, metadata: {}, product: { name: "?", metadata: {} } },
    { id: "price_metered", active: true, unit_amount: 1, currency: "usd", recurring: { interval: "month", usage_type: "metered" }, metadata: { tier_name: "brokerage" }, product: { metadata: {} } },
    { id: "price_inactive", active: false, unit_amount: 1, currency: "usd", recurring: { interval: "month", usage_type: "licensed" }, metadata: { tier_name: "solo_agent" }, product: { metadata: {} } },
  ]
  const c = catalogFromStripePrices(prices.map(priceFactsOf))
  const team = c.patches.find((p) => p.tierName === "team")?.patch
  const brk = c.patches.find((p) => p.tierName === "brokerage")?.patch
  check("prices → catalogue: team monthly (newest wins) + annual + seat package (size from metadata); brokerage seat package size from transform_quantity via PRODUCT metadata",
    team?.stripe_price_id === "price_team_new" && team?.monthly_price_cents === 29900 && team?.annual_price_cents === 299000 && team?.stripe_seat_price_id === "price_seat_team" && team?.seat_package_price_cents === 4900 && team?.seat_package_size === 5
    && brk?.stripe_seat_price_id === "price_seat_brk" && brk?.seat_package_size === 10 && brk?.stripe_price_id === undefined, JSON.stringify(c))
  check("unplaceable prices are RETURNED with reasons (no tier_name, metered, older duplicate) and inactive ones ignored; tiers without a plan price are NAMED",
    c.unmatched.some((u) => u.priceId === "price_nometa") && c.unmatched.some((u) => u.priceId === "price_metered") && c.unmatched.some((u) => u.priceId === "price_team_old")
    && !c.unmatched.some((u) => u.priceId === "price_inactive") && [...c.tiersWithoutPlanPrice].sort().join() === "brokerage,multi_location,solo_agent")
  control("a clean list names no unmatched", catalogFromStripePrices([priceFactsOf(prices[0])]).unmatched.length === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4 · RECONCILE — the daily pass, against an injected client]")
{
  const { reconcileSubscriptionsFromStripe } = await import("../lib/billing/seat-sync")
  const writes: Array<{ table: string; payload: Record<string, unknown> }> = []
  function svc(rows: any[], tiersErr: { message: string } | null = null) {
    return {
      from(table: string) {
        let payload: Record<string, unknown> | null = null
        const api: any = {
          select() { return api }, in() { return api }, not() { return api }, eq() { return api },
          update(p: Record<string, unknown>) { payload = p; return api },
          then(res: (v: unknown) => unknown) {
            if (table === "subscription_tiers") return Promise.resolve(res({ data: tiersErr ? null : TIERS, error: tiersErr }))
            if (table === "subscriptions" && payload) { writes.push({ table, payload }); return Promise.resolve(res({ data: [{ id: "x" }], error: null })) }
            return Promise.resolve(res({ data: rows, error: null }))
          },
        }
        return api
      },
    }
  }
  const rows = [
    { id: "r1", brokerage_id: "b1", stripe_subscription_id: "sub_1", tier_id: "t-solo", seat_packages: 0, extra_seats: 0, stripe_seat_item_id: null, stripe_price_id: null },
    { id: "r2", brokerage_id: "b2", stripe_subscription_id: "sub_2", tier_id: "t-team", seat_packages: 2, extra_seats: 10, stripe_seat_item_id: "si_seat", stripe_price_id: "price_team" },
    { id: "r3", brokerage_id: "b3", stripe_subscription_id: "sub_3", tier_id: "t-team", seat_packages: 0, extra_seats: 0, stripe_seat_item_id: null, stripe_price_id: null },
  ]
  const stripeSubs: Record<string, any> = {
    sub_1: sub([{ id: "si_plan", price: { id: "price_team" }, quantity: 1 }, { id: "si_seat", price: { id: "price_seat_team" }, quantity: 2 }]),
    sub_2: sub([{ id: "si_plan", price: { id: "price_team" }, quantity: 1 }, { id: "si_seat", price: { id: "price_seat_team" }, quantity: 2 }]),
  }
  const synced: string[] = []
  const summary = await reconcileSubscriptionsFromStripe(svc(rows), {
    retrieve: async (id) => (stripeSubs[id] ? { ok: true, sub: stripeSubs[id] } : { ok: false, skipped: false, error: "No such subscription" }),
    syncPlanTier: async (b) => { synced.push(b) },
  })
  check("3 candidates, 2 retrieved, 1 patched (r1: solo→team + 10 seats), r2 already equal, r3 errored by name; plan_tier re-synced for the tier change only",
    summary.candidates === 3 && summary.retrieved === 2 && summary.patched === 1 && summary.tierChanged === 1 && synced.join() === "b1" && summary.errors.length === 1 && /No such subscription/.test(summary.errors[0]!.error)
    && writes.length === 1 && writes[0]!.payload.tier_id === "t-team" && writes[0]!.payload.extra_seats === 10 && !summary.skipped, JSON.stringify(summary))
  control("an r2 that drifted WOULD be patched", !!seatRowPatch({ ...rows[1]!, extra_seats: 5 }, deriveSubscriptionSeatState(itemFactsOf(stripeSubs.sub_2), TIERS)))
  const skipped = await reconcileSubscriptionsFromStripe(svc(rows), { retrieve: async () => ({ ok: false, skipped: true }), syncPlanTier: async () => {} })
  check("Stripe unconfigured ⇒ skipped:true and NO writes (reported, not passed)", skipped.skipped && skipped.patched === 0)
  const refused = await reconcileSubscriptionsFromStripe(svc(rows, { message: "permission denied" }), { retrieve: async () => ({ ok: true, sub: stripeSubs.sub_1 }), syncPlanTier: async () => {} })
  check("a refused catalogue read stops the pass with the error named (never a walk with no tiers to match)", refused.errors.length === 1 && /catalogue read refused/.test(refused.errors[0]!.error) && refused.retrieved === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5 · WIRING — webhook, cron, the door actions, billing.ts, staff door, login, no second Stripe importer]")
{
  const wh = code(WEBHOOK)
  check("the webhook handles customer.subscription.created AND updated through the ONE normalizer + item derivation (no private normalizeSub returning metadata.tier_id)",
    /case "customer\.subscription\.created":\s*case "customer\.subscription\.updated":/.test(wh) && /deriveSubscriptionSeatState\(itemFactsOf\(/.test(wh) && /normalizeStripeSubscription\(s, seat\)/.test(wh)
    && !/tierId: s\.metadata\?\.tier_id \?\? null/.test(wh) && /TOMBSTONE: the private `normalizeSub`/.test(raw(WEBHOOK)))
  check("…checkout.session.completed goes through the same normalizer", /buildSubscriptionPatch\(await normalizeSub\(supabase, sub\)\)/.test(wh))
  check("a refused catalogue read in the webhook leaves the seat columns alone (normalizeStripeSubscription(s, null))", /normalizeStripeSubscription\(s, null\)/.test(wh))
  const cron = code(CRON)
  check("the daily billing cron runs the reconcile as step 2 and records it under its own key", /reconcileSubscriptionsFromStripe\(svc\)/.test(cron) && /seatSync/.test(cron))
  const { CRON_REGISTRY } = await import("../lib/kernel/cron-dispatch")
  check("…and that cron is registered in cron-dispatch (reachability, §1)", CRON_REGISTRY.some((j: { path: string }) => j.path === "/api/cron/billing-dunning"))
  const acts = code(BILLING_ACTIONS)
  check("the seat door actions exist, tenant from the SESSION under the COMMERCE roster, and Stripe is written BEFORE the row (stripeSetSeatPackages precedes the subscriptions update)",
    /export async function getSeatDoorAction/.test(acts) && /export async function buySeatPackagesAction/.test(acts) && /export async function changePlanTierAction/.test(acts)
    && /TENANT_COMMERCE_ADMIN_USER_TYPES\.has/.test(acts) && !/brokerageId: string\) \{[\s\S]{0,200}buySeatPackages/.test(acts)
    && acts.indexOf("stripeSetSeatPackages(stripeSubId") < acts.indexOf("seat_packages: qty") && /stripeSwapPrice\(stripeSubId, priceId\)/.test(acts))
  check("a downgrade is allowed only when producers fit; a Stripe-linked tenant is refused a tier with no published price; a decrease under seated producers is refused",
    /direction === "downgrade"[\s\S]{0,400}usage\.seatCount > limit/.test(acts) && /if \(!priceId\) return \{ ok: false/.test(acts) && /usage\.seatCount > newLimit/.test(acts))
  const ops = code(OPS)
  check("stripeSetSeatPackages: a licensed item on the seat price, quantity, create_prorations; 0 removes; fails closed on a missing price", /export async function stripeSetSeatPackages/.test(ops) && (ops.match(/proration_behavior: "create_prorations"/g) ?? []).length >= 4 && /deleted: true/.test(ops) && /no Stripe seat-package price linked/.test(ops))
  check("the superadmin sync action lists Stripe prices through the ops survivor and maps through catalogFromStripePrices; unmatched + tiersWithoutPlanPrice returned",
    /export async function syncCatalogFromStripeAction/.test(code(CATALOG_ACTIONS)) && /stripeListActivePrices\(\)/.test(code(CATALOG_ACTIONS)) && /catalogFromStripePrices\(listed\.prices\.map\(priceFactsOf\)\)/.test(code(CATALOG_ACTIONS)) && /tiersWithoutPlanPrice/.test(code(CATALOG_ACTIONS)))
  // No NEW importer of the platform Stripe client: the seat modules never touch it.
  check("lib/billing/seat-packages.ts and seat-sync.ts import no Stripe client (pure / injectable)", !/@\/lib\/stripe["']/.test(code(PACKAGES_MODULE)) && !/from "stripe"/.test(code(PACKAGES_MODULE)) && !/@\/lib\/stripe["']/.test(code(SYNC)))
  control("the finder sees a Stripe import", /@\/lib\/stripe["']/.test(code(OPS)))
  const kb = code(KERNEL_BILLING)
  check("billing.ts: NULL max_agents is unlimited (normalizeCatalogSeatLimit → no cap) plus extra seats, never `?? 0`", /normalizeCatalogSeatLimit\(tier\.max_agents\)/.test(kb) && /Number\.POSITIVE_INFINITY : seatCap \+ extraSeats/.test(kb) && !/max_agents \?\? 0/.test(kb))
  control("the finder sees the old `?? 0` shape", /max_agents \?\? 0/.test("active_agents: tier.max_agents ?? 0,"))
  check("the staff door and the tenant invite take `produces` and pass it to the ONE gate", /seatGate\(svc, params\.brokerageId, params\.userType, \{ produces: params\.produces \}\)/.test(code(TENANT_USERS)) && /seatGate\(service, resolvedBrokerageId, requestedRole, \{ produces: params\.produces \}\)/.test(code(INVITE)))
  check("the activation checkout returns to /login (the real sign-in page), not /auth/login (the demo page), and /login reads activated=1 / activation=cancelled with fixed copy",
    /successUrl: `\$\{appUrl\}\$\{SUBSCRIBER_ACTIVATED_PATH\}`/.test(code(CORE)) && /cancelUrl: `\$\{appUrl\}\$\{SUBSCRIBER_ACTIVATION_CANCELLED_PATH\}`/.test(code(CORE)) && !/auth\/login\?activated/.test(code(CORE))
    && /SUBSCRIBER_ACTIVATED_PATH = "\/login\?activated=1"/.test(code(DOOR)) && /SUBSCRIBER_ACTIVATION_CANCELLED_PATH = "\/login\?activation=cancelled"/.test(code(DOOR))
    && /searchParams\.get\('activated'\) === '1'/.test(code(LOGIN)) && /ACTIVATION_COPY\.activated/.test(code(LOGIN)) && /ACTIVATION_COPY\.cancelled/.test(code(LOGIN)))
  // The retired $25 literal and the retired outcomes are gone from RUNTIME code (tombstones stay in prose).
  const files = [...walkTs(join(root, "lib")), ...walkTs(join(root, "app"))]
  // Strings blanked too: the manager registry's prose NAMES the retired
  // identifier inside a `what:` string (its own tombstone), and prose is not code.
  const hits = files.filter((f) => /\bADDITIONAL_SEAT_MONTHLY_USD\b|"paid_seat_only"|"upgrade_offered"/.test(blankStrings(stripComments(readFileSync(f, "utf8"))))).map((f) => f.replace(root + "/", ""))
  console.log(`    denominator: ${files.length} .ts/.tsx files under lib/ + app/`)
  check(`the retired ADDITIONAL_SEAT_MONTHLY_USD / paid_seat_only / upgrade_offered are gone from runtime code (found in: ${hits.join(", ") || "none"})`, hits.length === 0)
  control("the finder sees the retired identifier in code and ignores it in a comment", /\bADDITIONAL_SEAT_MONTHLY_USD\b/.test(stripComments("export const ADDITIONAL_SEAT_MONTHLY_USD = 25")) && !/\bADDITIONAL_SEAT_MONTHLY_USD\b/.test(stripComments("// ADDITIONAL_SEAT_MONTHLY_USD retired")))
  check("the tombstone for the $25 literal names its survivor", /TOMBSTONE — `ADDITIONAL_SEAT_MONTHLY_USD`[\s\S]{0,400}SeatPackageFacts/.test(raw(MATRIX)))
  check("the matrix, the usage reader and the catalogue agree on the reader (resolveCatalogSeatLimits selects the package columns off the same row)", /seat_package_size, seat_package_price_cents, stripe_seat_price_id/.test(code(USAGE)) && /packages\[name as CanonicalTier\]/.test(code(USAGE)) && /export function seatPackageSellable/.test(code(CATALOG)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6 · MIGRATION m660 — numbers derived from the bands; the seat columns]")
{
  const m = raw(MIGRATION)
  check("m660 exists", m.length > 0)
  for (const t of CANONICAL_TIERS) {
    const band = TIER_SEAT_BANDS[t]
    const tierSpell = band === null ? "NULL" : String(band)
    const planSpell = band === null ? "-1" : String(band)
    check(`  ${t}: subscription_tiers.max_agents = ${tierSpell}, plan_limits.active_users = ${planSpell}, and the CASE postcondition says the same`,
      new RegExp(`SET max_agents = ${tierSpell}\\s+WHERE tier_name = '${t}'`).test(m)
      && new RegExp(`SET limit_value = ${planSpell},[^;]*WHERE plan_tier = '${t}'`).test(m)
      && (band === null ? !new RegExp(`WHEN '${t}'\\s+THEN \\d`).test(m) && /ELSE NULL/.test(m) && /ELSE -1/.test(m) : new RegExp(`WHEN '${t}'\\s+THEN ${band}\\b`).test(m)))
  }
  control("the migration finder would catch a retyped team number", /WHEN 'team'\s+THEN \d/.test("WHEN 'team' THEN 5") && !/WHEN 'team'\s+THEN 10\b/.test("WHEN 'team' THEN 5"))
  check("m660 adds the seat-package columns on subscription_tiers and the seat-term columns on subscriptions, with CHECKs",
    ["seat_package_size", "seat_package_price_cents", "stripe_seat_price_id"].every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS ${c}`).test(m))
    && ["seat_packages", "extra_seats", "stripe_seat_item_id", "stripe_price_id", "custom_seat_limit", "custom_stripe_price_id"].every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS ${c}`).test(m))
    && /CHECK \(seat_packages >= 0\)/.test(m) && /CHECK \(extra_seats >= 0\)/.test(m))
  check("m660 leaves the package PRICE unset (a commercial decision) and refuses when a tenant already exceeds its new band", !/SET seat_package_price_cents = \d/.test(m) && /producers > x\.band/.test(m) && /RAISE EXCEPTION 'm660: % tenant/.test(m))
  check("m660 states the producer rule in the max_agents column comment", /COMMENT ON COLUMN public\.subscription_tiers\.max_agents IS[\s\S]{0,400}PRODUCERS/.test(m))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[7 · registration]")
{
  const pkg = raw("package.json")
  check(`"test:seat-packages" is registered`, /"test:seat-packages":\s*"tsx --conditions=react-server scripts\/seat-packages-guard\.ts"/.test(pkg))
  const guardLine = /"guard":\s*"([^"]+)"/.exec(pkg)?.[1] ?? ""
  check("the guard chain runs it AFTER test:scrapers (ordering only — never an adjacency pin)", guardLine.indexOf("npm run test:scrapers") >= 0 && guardLine.indexOf("npm run test:seat-packages") > guardLine.indexOf("npm run test:scrapers"))
  const reg = code("lib/kernel/manager-registry.ts")
  check("MAINTENANCE_DOMAINS carries seat_packages_and_stripe_sync with proof test:seat-packages", /seat_packages_and_stripe_sync:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:seat-packages"/.test(reg))
  check("MANAGER_COLLABORATIONS declares seat_commerce_sync between finance_manager and data_steward", /seat_commerce_sync:\s*\{[\s\S]{0,300}managers:\s*\["finance_manager",\s*"data_steward"\]/.test(reg))
}

console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ SEAT_PACKAGES — see failures above")
  process.exit(1)
}
console.log(`\n✅ SEAT_PACKAGES — bands ${CANONICAL_TIERS.map((t) => TIER_SEAT_BANDS[t] ?? "custom").join("/")}, the limit is a door (upgrade / downgrade / buy / contact), Stripe is the source and the row follows it`)
