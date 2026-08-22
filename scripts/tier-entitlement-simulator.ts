#!/usr/bin/env tsx
/**
 * scripts/tier-entitlement-simulator.ts   (npm run test:tier-entitlement)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves tier feature-gating works. subscription_tiers.features is a JSONB OBJECT
 * ({ accounting_sync: true, team_features: false, ... }); resolveFeatureEntitlement used to call
 * .includes() on it, which threw / returned undefined so EVERY tier feature resolved to DISABLED —
 * a paying brokerage was denied accounting_sync/compliance it paid for. isTierFeatureIncluded now
 * reads the key's boolean (and still honors a legacy array shape). Pure; the real per-tier matrix is
 * asserted from the actual production feature objects.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isTierFeatureIncluded } from "../lib/kernel/billing"
import { TIER_SEAT_LIMITS, seatDecision } from "../lib/kernel/tier-role-matrix"
import { resolveEntitlement } from "../lib/entitlements/resolve"
import { readPlanTier } from "../lib/billing/plan-tier"
import { mapUserTypeToTier } from "../lib/kernel/0.1-feature-access"
import { isNeighborhoodReportAllowed } from "../lib/property/neighborhood-scoring"
import { TOKEN_SELF_SERVE_TIERS } from "../lib/platform/tenant-webhooks-core"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** Source with comments removed by the ONE correct scanner (CLAUDE.md §2) — a
 *  prose mention of a gate must never satisfy an assertion about live code. */
const code = (p: string) => stripComments(src(p))

// The REAL production tier feature objects (subscription_tiers.features), AFTER the "all tools to
// every tier" packaging (m251): every tier carries the full TOOL capability set; tiers differ only by
// SCALE (max_agents/max_brokerages) and the multi-location-only scale flags.
const TOOLS = { portal: true, basic_ai: true, core_crm: true, team_features: true, accounting_sync: true, compliance: true }
const TIERS: Record<string, Record<string, boolean>> = {
  solo_agent:    { ...TOOLS },
  team:          { ...TOOLS },
  brokerage:     { ...TOOLS },
  multi_location:{ ...TOOLS, usage_metering: true, multi_brokerage: true },
}
// Max seats per tier — the REAL differentiator now (subscription_tiers.max_agents).
// THESE ARE THE OWNER'S NUMBERS, not the ones the live catalogue carried: it said
// solo=1 / team=10 while the seat gate enforced 2 / 5, and max_agents is what the
// tenant's billing page and the platform voice receptionist QUOTE. m523 moves the
// catalogue onto these; lib/kernel/tier-role-matrix.ts is the code-side fallback
// and scripts/seat-cap-simulator.ts (npm run test:seat-cap) is the enforcement proof.
const MAX_AGENTS: Record<string, number | null> = { solo_agent: 2, team: 5, brokerage: null, multi_location: null }

async function main() {
  console.log("\n[isTierFeatureIncluded · pure — object shape]")
  check("true-valued key ⇒ included", isTierFeatureIncluded({ accounting_sync: true }, "accounting_sync") === true)
  check("false-valued key ⇒ NOT included", isTierFeatureIncluded({ accounting_sync: false }, "accounting_sync") === false)
  check("absent key ⇒ NOT included", isTierFeatureIncluded({ portal: true }, "accounting_sync") === false)
  check("non-boolean truthy value ⇒ NOT included (must be strictly true)", isTierFeatureIncluded({ x: 1 }, "x") === false)

  console.log("\n[legacy array shape still honored]")
  check("array containing the key ⇒ included", isTierFeatureIncluded(["accounting_sync", "portal"], "accounting_sync") === true)
  check("array without the key ⇒ NOT included", isTierFeatureIncluded(["portal"], "accounting_sync") === false)

  console.log("\n[garbage ⇒ safe deny]")
  check("null ⇒ not included", isTierFeatureIncluded(null, "x") === false)
  check("string ⇒ not included", isTierFeatureIncluded("accounting_sync", "accounting_sync") === false)

  console.log("\n[ALL TOOLS to EVERY tier — differentiation is SCALE, not feature locks (m251 packaging)]")
  const ALL_TOOLS = ["portal", "basic_ai", "core_crm", "team_features", "accounting_sync", "compliance"]
  check("solo_agent NOW GETS accounting_sync (all tools)", isTierFeatureIncluded(TIERS.solo_agent, "accounting_sync") === true)
  check("solo_agent NOW GETS team_features + compliance", isTierFeatureIncluded(TIERS.solo_agent, "team_features") === true && isTierFeatureIncluded(TIERS.solo_agent, "compliance") === true)
  check("team GETS accounting_sync (previously locked)", isTierFeatureIncluded(TIERS.team, "accounting_sync") === true)
  check("EVERY tier gets EVERY tool capability", Object.values(TIERS).every((t) => ALL_TOOLS.every((k) => isTierFeatureIncluded(t, k) === true)))
  check("multi_location still owns the SCALE flags (usage_metering + multi_brokerage)", isTierFeatureIncluded(TIERS.multi_location, "usage_metering") === true && isTierFeatureIncluded(TIERS.multi_location, "multi_brokerage") === true)
  check("non-multi tiers do NOT get multi_brokerage (scale-gated)", !isTierFeatureIncluded(TIERS.solo_agent, "multi_brokerage") && !isTierFeatureIncluded(TIERS.team, "multi_brokerage") && !isTierFeatureIncluded(TIERS.brokerage, "multi_brokerage"))
  check("SCALE is the differentiator — seats step 2 → 5 → unlimited (owner's ruling)", MAX_AGENTS.solo_agent === 2 && MAX_AGENTS.team === 5 && MAX_AGENTS.brokerage === null)
  check("…and these agree with the seat matrix the gate enforces, so catalogue and code cannot drift",
    MAX_AGENTS.solo_agent === TIER_SEAT_LIMITS.solo_agent
    && MAX_AGENTS.team === TIER_SEAT_LIMITS.team
    && MAX_AGENTS.brokerage === TIER_SEAT_LIMITS.brokerage)

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER PARITY — the owner ruling, and the two things it must NOT flatten.
  //
  //   "brokerages can have teams and agents but that is the brokerage tier.
  //    when we have the team and solo agent subscription tiers, those
  //    subscriptions get the same level of features as brokerages."
  //
  // read with the seat ruling from the same thread ("team tier only has 5 seats
  // … agent tier subscription only has 2 seats … but these lower plans need to
  // be treated like mini brokerages"): TIERS DIFFER BY SEAT COUNT, NOT BY
  // FEATURE SET. So every assertion below has a twin — the capability must be
  // OPEN, and the seat cap must STILL BITE — and every absence assertion has a
  // POSITIVE CONTROL proving it can go red (CLAUDE.md §2).
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n[PARITY · entitlement resolution — solo and team reach a brokerage-level capability]")
  const OPEN_FLAG = {
    enabled: true, deprecated: false, sunsetDate: null, superadminOnly: false,
    tierHasAccess: true, tierLimit: null as number | null, rolloutPercentage: null,
  }
  const PAID_TIERS = ["solo_agent", "team", "brokerage", "multi_location"]
  check("every tier is ALLOWED a capability whose tier column is open (the m527 post-state)",
    PAID_TIERS.every((tier) => resolveEntitlement({ flag: { ...OPEN_FLAG }, tier }).allowed === true))
  // POSITIVE CONTROL — the same assertion against a brokerage-only row. If this
  // does not go red the check above is blind and its green is worthless.
  check("POSITIVE CONTROL — a brokerage-only row still DENIES solo (the pre-m527 shape is detectable)",
    resolveEntitlement({ flag: { ...OPEN_FLAG, tierHasAccess: false }, tier: "solo_agent" }).allowed === false)

  console.log("\n[PARITY · a granted capability with a quota of ZERO is a denial in disguise (m527 §2)]")
  check("tierLimit 0 + usage 0 ⇒ REFUSED — this is what listing_marketing_tiers did to solo",
    resolveEntitlement({ flag: { ...OPEN_FLAG, tierLimit: 0 }, usageCurrent: 0, tier: "solo_agent" }).allowed === false)
  check("POSITIVE CONTROL — the same row at the lowest real rung (5) is ALLOWED, so 0 is the defect, not the check",
    resolveEntitlement({ flag: { ...OPEN_FLAG, tierLimit: 5 }, usageCurrent: 0, tier: "solo_agent" }).allowed === true)
  check("…and a quota that is genuinely spent still refuses (capacity is untouched by the ruling)",
    resolveEntitlement({ flag: { ...OPEN_FLAG, tierLimit: 5 }, usageCurrent: 5, tier: "solo_agent" }).allowed === false)

  console.log("\n[PARITY · SEATS STILL DIFFER — the ruling is the seat count, so flattening it would break it]")
  check("solo is capped at 2 · team at 5 · brokerage unlimited",
    TIER_SEAT_LIMITS.solo_agent === 2 && TIER_SEAT_LIMITS.team === 5 && TIER_SEAT_LIMITS.brokerage === null)
  check("a 3rd seat on solo is REFUSED and names the upgrade",
    seatDecision("solo_agent", 2, null, 1).withinLimit === false
    && seatDecision("solo_agent", 2, null, 1).upgradeTo === "team")
  check("a 6th seat on team is REFUSED and names the upgrade",
    seatDecision("team", 5, null, 1).withinLimit === false
    && seatDecision("team", 5, null, 1).upgradeTo === "brokerage")
  check("brokerage keeps hiring", seatDecision("brokerage", 5000, null, 1).withinLimit === true)
  // POSITIVE CONTROL — the seat gate is not simply refusing everything.
  check("POSITIVE CONTROL — a 2nd seat on solo is ALLOWED, so the refusals above are the cap, not a stuck gate",
    seatDecision("solo_agent", 1, null, 1).withinLimit === true)

  console.log("\n[PARITY · the code-side tier gates that never went through feature_flags]")
  check("neighborhood intelligence: allowed on EVERY tier (was brokerage/multi only)",
    PAID_TIERS.every((t) => isNeighborhoodReportAllowed(t) === true))
  check("…and an unreadable/NULL tier no longer denies it either",
    isNeighborhoodReportAllowed(null) === true && isNeighborhoodReportAllowed(undefined) === true)
  check("self-serve API tokens: mintable on EVERY tier (was brokerage/multi only)",
    PAID_TIERS.every((t) => TOKEN_SELF_SERVE_TIERS.has(t)))
  // POSITIVE CONTROL — the set is still a real membership test, not a rubber stamp.
  check("POSITIVE CONTROL — TOKEN_SELF_SERVE_TIERS still rejects a name that is not a tier",
    !TOKEN_SELF_SERVE_TIERS.has("not_a_tier"))

  const sso = code("app/actions/tenant-sso.ts")
  const domains = code("app/actions/custom-domains.ts")
  const portfolio = code("lib/intelligence/portfolio-intelligence.ts")
  check("POSITIVE CONTROL — the comment-stripped sources are still the files we think they are",
    /tierAllowsSso/.test(sso) && /tierAllowsCustomDomains/.test(domains) && /runPortfolioAdvisorAll/.test(portfolio))
  check("SSO/SAML: no brokerage floor left in live code", !/TIER_ORDER\.indexOf\(\s*["']brokerage["']\s*\)/.test(sso))
  check("custom domains: no brokerage floor left in live code", !/TIER_ORDER\.indexOf\(\s*["']brokerage["']\s*\)/.test(domains))
  check("…and both gates are still CALLED, so parity was granted rather than the gate deleted",
    /tierAllowsSso\(/.test(sso) && /tierAllowsCustomDomains\(/.test(domains))
  check("portfolio advisor: the monthly cohort is no longer filtered to brokerage/multi tenants",
    !/\.in\(\s*["']plan_tier["']\s*,\s*\[\s*["']brokerage["']/.test(portfolio))

  console.log("\n[PARITY · the tier is read from the SUBSCRIPTION, and an unreadable one FAILS CLOSED]")
  // A structural stub: every chained builder method returns the chain, and
  // maybeSingle() resolves the canned { data, error } for that table. This is
  // how a refused read reaches readPlanTier in production — supabase-js RESOLVES
  // refusals (CLAUDE.md §3), it does not throw.
  const stub = (rows: Record<string, { data: unknown; error: unknown }>) => ({
    from(table: string) {
      const res = rows[table] ?? { data: null, error: null }
      const chain: any = new Proxy({}, {
        get: (_t, prop) => (prop === "maybeSingle" ? async () => res : () => chain),
      })
      return chain
    },
  })
  const brokerageRow = (plan_tier: string | null) => ({ brokerages: { data: { plan_tier }, error: null } })

  const readTeam = await readPlanTier(stub(brokerageRow("team")), "b1")
  check("a tenant billed on TEAM resolves as team, whatever the caller's user_type",
    readTeam.ok === true && readTeam.tier === "team")
  const readSolo = await readPlanTier(stub(brokerageRow("solo_agent")), "b1")
  check("a tenant billed on SOLO resolves as solo_agent — no promotion to brokerage",
    readSolo.ok === true && readSolo.tier === "solo_agent")
  const readRefused = await readPlanTier(
    stub({ brokerages: { data: null, error: { message: "permission denied" } } }), "b1")
  check("a REFUSED read fails CLOSED — ok:false with a caller-safe reason (CLAUDE.md §4)",
    readRefused.ok === false && typeof (readRefused as any).reason === "string" && (readRefused as any).reason.length > 0)
  const readMissing = await readPlanTier(stub({ brokerages: { data: null, error: null } }), "b1")
  check("no such tenant row also fails CLOSED", readMissing.ok === false)
  const readLegacy = await readPlanTier(
    { ...stub({ brokerages: { data: { plan_tier: null }, error: null }, subscriptions: { data: null, error: null } }) },
    "b1")
  check("a row that ANSWERS with a NULL/legacy tier is NOT a failure — it floors honestly",
    readLegacy.ok === true && (readLegacy as any).tier === "solo_agent" && (readLegacy as any).fromCache === false)

  const kernel = code("lib/kernel/0.1-feature-access.ts")
  check("canAccessFeature reads the billed tier through readPlanTier", /readPlanTier\(/.test(kernel))
  check("…and REFUSES on an unreadable tier rather than guessing",
    /if \(!read\.ok\) return \{ allowed: false, reason: read\.reason \}/.test(kernel))
  check("mapUserTypeToTier no longer promotes a solo caller to the brokerage tier",
    mapUserTypeToTier("solo_agent", "brokerage-id") === "solo_agent"
    && mapUserTypeToTier("agent", "brokerage-id") === "solo_agent")
  check("…nor demotes a brokerage tenant's team member to the team tier",
    mapUserTypeToTier("broker", "brokerage-id", "team-id") === "brokerage")
  // POSITIVE CONTROL — the map still maps; it has not been flattened to one answer.
  check("POSITIVE CONTROL — mapUserTypeToTier still distinguishes user types",
    mapUserTypeToTier("team_lead") === "team" && mapUserTypeToTier("broker") === "brokerage")

  console.log("\n[the resolver no longer calls .includes() on the object (the bug)]")
  const billing = src("lib/kernel/billing.ts")
  check("resolveFeatureEntitlement uses isTierFeatureIncluded", /resolveFeatureEntitlement[\s\S]*?isTierFeatureIncluded/.test(billing))
  check("no `tier.features?.includes(` remains", !/tier\.features\?\.includes\(/.test(billing))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ TIER_ENTITLEMENT_FAIL"); process.exit(1) }
  console.log(" ✅ TIER_ENTITLEMENT_PASS — tier feature-gating reads the JSONB object correctly; paying tiers get what they pay for")
}
main()
