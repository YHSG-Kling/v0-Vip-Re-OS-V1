#!/usr/bin/env tsx
/**
 * scripts/assignment-method-simulator.ts (npm run test:assignment-method)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BROKER CHOSE AN ASSIGNMENT METHOD AND ONLY ONE OF THEM DID ANYTHING.
 *
 * assignment_rules.rule_type admits round_robin | load_balance | geo_based |
 * specialization | manual. Both routers branched on ONE of them:
 *
 *     rule.rule_type === "round_robin" ? rotate(pool) : pool[0]
 *
 * So a broker who created "Load balance my buyer leads" sent every matching
 * lead to the first agent in the list, forever — and the same for a Geographic
 * or a Specialization rule. The picker promised four behaviours and delivered
 * two. Sharpest of all: a real capacity-aware balancer (selectAgentByCapacity,
 * shared with the Capacity Guardian) already existed on the FALLBACK path, and
 * the rule type of the same name never called it.
 *
 * 'manual' was worse than wrong — it was admitted by the column, offered by no
 * picker, and would have silently behaved as pool[0] if anyone had set it in the
 * database. A broker could not choose to hold leads for a person at all.
 *
 * ── THE THIRD IMPLEMENTATION ────────────────────────────────────────────────
 * lib/lead-governance/agent-selector.ts picked agents for the whole governance
 * rail and never queried assignment_rules. It sorted by id.localeCompare, took
 * the first, and wrote an activities row claiming selectionMethod
 * 'load_balanced' — a false entry in an audit record, which its own comment
 * conceded ("In production, you'd query leads table for counts"). Deleted; its
 * one real idea (prefer a specialist) is now a method the broker can choose.
 *
 * What this proves: each method DECIDES DIFFERENTLY, the pure layer never
 * invents a second load metric, a manual rule assigns nobody and says so, and
 * the picker offers exactly what the column admits.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import {
  pickAgentForRule,
  previewRuleRouting,
  RULE_TYPES,
  RULE_TYPE_LABELS,
  RULE_TYPE_HELP,
  isRuleType,
  toRoutingProfiles,
  type MatchableRule,
} from "../lib/lead-assignment/rule-matcher"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
/** The dropped brokerages column, SINGULAR — never the subscription_tiers table. */
const TWIN_READ = /subscription_tier(?!s)/

const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")

console.log("══════════════════════════════════════════════════")
console.log(" Assignment method — the broker's choice actually routes")
console.log("══════════════════════════════════════════════════")

const rule = (over: Partial<MatchableRule> = {}): MatchableRule => ({
  id: "r1", name: "Rule", rule_type: "round_robin", conditions: {},
  agent_ids: ["a", "b", "c"], priority: 10, is_active: true, times_triggered: 0,
  ...over,
})
const POOL = ["a", "b", "c"]
const PROFILES = toRoutingProfiles([
  { id: "a", specializations: ["Luxury"], location_id: "L1", zip_codes: ["78704"] },
  { id: "b", specializations: ["First-Time Buyers"], location_id: "L2", zip_codes: ["78745"] },
  { id: "c", specializations: null, location_id: null, zip_codes: null },
])

console.log("\n[the vocabulary the broker picks from IS the column's]")
{
  const live = CHECK_VOCABULARIES.assignment_rules?.rule_type ?? []
  check(`the column admits ${live.length} methods`, live.length > 0)
  check("the module offers exactly those",
    RULE_TYPES.length === live.length && RULE_TYPES.every((t) => live.includes(t)))
  check("'manual' is one of them — it was admitted and offered nowhere",
    live.includes("manual") && RULE_TYPES.includes("manual"))
  check("every method has a label and a plain-words explanation",
    RULE_TYPES.every((t) => !!RULE_TYPE_LABELS[t] && !!RULE_TYPE_HELP[t]))
  check("the owner's word for it is what a broker reads",
    RULE_TYPE_LABELS.specialization === "Expertise")
  check("isRuleType rejects a value the column would refuse", !isRuleType("whatever"))
}

console.log("\n[each method decides DIFFERENTLY — this is the whole bug]")
{
  // round_robin: rotation, deterministic on times_triggered.
  const r0 = pickAgentForRule(rule({ times_triggered: 0 }), POOL, {}, PROFILES)
  const r1 = pickAgentForRule(rule({ times_triggered: 1 }), POOL, {}, PROFILES)
  const r2 = pickAgentForRule(rule({ times_triggered: 4 }), POOL, {}, PROFILES)
  check("round robin rotates through the pool",
    r0.kind === "agent" && r0.agentId === "a" &&
    r1.kind === "agent" && r1.agentId === "b" &&
    r2.kind === "agent" && r2.agentId === "b")

  // load_balance: defers to the DB picker over the WHOLE pool — it does not
  // name pool[0], and it does not invent a second load metric here.
  const lb = pickAgentForRule(rule({ rule_type: "load_balance" }), POOL, {}, PROFILES)
  check("load balance defers to the capacity picker over the whole pool",
    lb.kind === "capacity" && lb.candidates.length === 3 && lb.method === "load_balance")
  check("…and does NOT silently name the first agent",
    lb.kind !== "agent")

  // specialization: narrows to the matching agent, then capacity.
  const sp = pickAgentForRule(
    rule({ rule_type: "specialization" }), POOL,
    { motivation_type: "first_time_buyers" }, PROFILES)
  check("expertise narrows to the agent whose specialization matches",
    sp.kind === "capacity" && sp.candidates.length === 1 && sp.candidates[0] === "b")
  check("…matching is spelling-tolerant ('First-Time Buyers' ≈ 'first_time_buyers')",
    sp.kind === "capacity" && sp.candidates[0] === "b")

  // A specialization rule that matches nobody must still route.
  const spNone = pickAgentForRule(
    rule({ rule_type: "specialization" }), POOL,
    { motivation_type: "divorce" }, PROFILES)
  check("an expertise rule matching nobody falls back to the pool, honestly labelled",
    spNone.kind === "capacity" && spNone.candidates.length === 3 &&
    spNone.method === "specialization_no_match")

  // geo_based: narrows by ZIP farm.
  const geo = pickAgentForRule(
    rule({ rule_type: "geo_based" }), POOL, { property_zip_code: "78704" }, PROFILES)
  check("geographic narrows to the agent who farms that ZIP",
    geo.kind === "capacity" && geo.candidates.length === 1 && geo.candidates[0] === "a")
  const geoNone = pickAgentForRule(
    rule({ rule_type: "geo_based" }), POOL, { property_zip_code: "99999" }, PROFILES)
  check("…and an unfarmed ZIP falls back to the pool, honestly labelled",
    geoNone.kind === "capacity" && geoNone.method === "geo_based_no_match")

  // manual: assign NOBODY, and never fall through.
  const man = pickAgentForRule(rule({ rule_type: "manual" }), POOL, {}, PROFILES)
  check("manual assigns nobody — a deliberate hold, not a pick", man.kind === "manual")

  // The four non-manual methods must not all collapse to the same answer.
  const answers = new Set(
    (["round_robin", "load_balance", "geo_based", "specialization"] as const).map((t) => {
      const p = pickAgentForRule(rule({ rule_type: t }), POOL, { property_zip_code: "78704", motivation_type: "luxury" }, PROFILES)
      if (p.kind === "agent") return `agent:${p.agentId}`
      if (p.kind === "manual") return "manual"
      return `capacity:${p.candidates.join("+")}`
    }),
  )
  check("the four automatic methods do not all produce the same answer", answers.size >= 3,
    [...answers].join(" | "))
}

console.log("\n[the preview tells the truth about what it cannot know]")
{
  // It used to report pool[0] as "the agent this rule would pick" for three of
  // the four methods — a confident answer that was simply wrong.
  const rules = [rule({ rule_type: "load_balance" })]
  const p = previewRuleRouting(rules, {}, { profiles: PROFILES })
  check("a capacity-decided rule previews the SHORTLIST, not a fabricated winner",
    p.rule?.id === "r1" && p.agentId === null && (p.candidates ?? []).length === 3)
  check("…and names the strategy so the broker can see which one ran",
    p.strategy === "load_balance")

  const pr = previewRuleRouting([rule({ rule_type: "round_robin", times_triggered: 1 })], {}, { profiles: PROFILES })
  check("a round-robin rule still previews the exact agent (it is knowable)",
    pr.agentId === "b" && pr.strategy === "round_robin")

  const pm = previewRuleRouting([rule({ rule_type: "manual" })], {}, { profiles: PROFILES })
  check("a manual rule previews as matched-but-unassigned",
    pm.rule?.id === "r1" && pm.agentId === null && pm.strategy === "manual")

  const pn = previewRuleRouting([], {})
  check("no rule at all still falls through to load balance", pn.method === "load_balance")
}

console.log("\n[one resolver — the third implementation is gone]")
{
  check("lib/lead-governance/agent-selector.ts is deleted",
    !existsSync(join(process.cwd(), "lib/lead-governance/agent-selector.ts")))
  const barrel = src("lib/lead-governance/index.ts")
  check("…and the barrel no longer exports selectAgentForLead",
    !/export \{ selectAgentForLead \}/.test(barrel))

  const gov = src("app/actions/lead-governance/govern-lead.ts")
  check("governance routes through the canonical rule resolver",
    /resolveAgentByRules/.test(gov))
  check("…so the broker's rules apply on the governance path at last",
    !/selectAgentForLead/.test(gov))
  check("…and its fallback is the SHARED capacity picker, not a private heuristic",
    /selectAgentByCapacity/.test(gov) && /resolveBrokerageMaxLoad/.test(gov))
  check("a manual hold is RECORDED, never a silent non-assignment",
    /Held for Manual Assignment/.test(gov))

  const engine = src("lib/lead-assignment/assignment-engine.ts")
  check("the resolver is exported from the assignment spine",
    /export async function resolveAgentByRules/.test(engine))

  // The literal shape of the bug, in both routers.
  for (const f of [
    "lib/lead-assignment/assignment-engine.ts",
    "lib/lead-assignment/contact-assignment.ts",
    "lib/lead-assignment/rule-matcher.ts",
  ]) {
    const s = src(f)
    check(`${f}: no "round_robin ? rotate : pool[0]" left`,
      !/rule_type === ["']round_robin["'][\s\S]{0,160}?:\s*(pool\[0\]|0\b)/.test(s))
  }
}

console.log("\n[a SOLO tenant gets everything — every ingress path, ahead of everything]")
{
  // Owner's rule: on a solo_agent subscription every lead and contact belongs to
  // that one agent, whether it arrives from their own site, another real-estate
  // site, a lead magnet or form they built, a CSV import, a QR scan or a call.
  //
  // The CONTACT side honoured it. The LEAD side did not: evaluateAndAssignLead
  // went straight to assignment_rules and then the brokerage default. Wrong three
  // ways for a solo tenant, and the third arrived with m305: an admin choosing
  // the 'manual' default would have their OWN leads held for a person to place,
  // and they are the only person there is.
  const solo = src("lib/lead-assignment/solo-agent.ts")
  check("there is ONE solo resolver", solo.length > 0)
  const stripComments = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
  check("…and it decides the tier through the canonical accessor, not a raw column read",
    /resolvePlanTier/.test(solo) && !TWIN_READ.test(stripComments(solo)))
  check("…returns null for a non-solo brokerage rather than guessing",
    /if \(tier !== "solo_agent"\) return null/.test(solo))
  check("…and picks the oldest active agent, so ownership never silently migrates",
    /order\("created_at", \{ ascending: true \}\)/.test(solo))

  const engine = src("lib/lead-assignment/assignment-engine.ts")
  const contact = src("lib/lead-assignment/contact-assignment.ts")
  check("Engine 2 (leads) now honours the solo guarantee", /resolveSoloAgentOwner/.test(engine))
  check("…BEFORE it loads any assignment rule",
    engine.indexOf("resolveSoloAgentOwner") < engine.indexOf("resolveAgentByRules"))
  check("…and still ledgers the assignment through the canonical handler",
    /resolveSoloAgentOwner[\s\S]{0,600}?handleLeadAssigned/.test(engine))
  check("the contact resolver uses the SAME resolver, so the two cannot disagree",
    /resolveSoloAgentOwner/.test(contact))
  check("…and no longer keeps its own inline plan_tier solo query",
    !/plan_tier === "solo_agent"/.test(contact))

  // Every ingress path routes through one of the two engines — that is what makes
  // the guarantee hold for imports, QR scans, forms and scraped territory alike.
  for (const f of [
    "lib/contact-pipeline/contact-capture.ts",
    "lib/platform/tenant-import.ts",
    "lib/application/lead-application-service.ts",
    "app/actions/lead-import/import-actions.ts",
    "app/api/qr/submit/route.ts",
  ]) {
    check(`${f} routes through the canonical contact resolver`,
      /resolveAgentForContact/.test(src(f)))
  }
}

console.log("\n[ONE tier per tenant — the unwritten twin is gone (m306)]")
{
  // brokerages carried plan_tier AND subscription_tier. Only plan_tier had
  // writers (lib/billing/sync-plan-tier.ts syncs it from Stripe and calls itself
  // "the runtime cache"); nothing wrote subscription_tier except a test fixture,
  // which set it INSTEAD of plan_tier. Seven production readers preferred the
  // unwritten one. Live, VIP Premier Realty was plan_tier=solo_agent with
  // subscription_tier=brokerage — a SOLO tenant to the lead router and a
  // BROKERAGE tenant to the asset manager, the Remotion catalog, its own billing
  // save-offer and the coupon check, simultaneously.
  const cols = (SCHEMA_SNAPSHOT as Record<string, string[]>).brokerages ?? []
  check("plan_tier is the surviving tier column", cols.includes("plan_tier"))
  check("…and the subscription_tier twin is dropped", !cols.includes("subscription_tier"))

  const mod = src("lib/billing/plan-tier.ts")
  check("there is one accessor, and it reads plan_tier only",
    /\.select\("plan_tier"\)/.test(mod) && !/subscription_tier/.test(mod.replace(/\/\/[^\n]*/g, "")))
  check("…falling to the TIGHTEST tier, so a mis-tagged tenant gets no free upgrade",
    /FALLBACK_TIER: PlanTier = "solo_agent"/.test(mod))

  // Every former reader repointed. A missed one is a stale tier decision.
  for (const f of [
    "lib/agents/brokerage-context.ts",
    "lib/agents/asset-manager.ts",
    "app/actions/composition-library.ts",
    "app/actions/billing.ts",
    "app/actions/superadmin/coupons.ts",
    "app/api/internal/remotion/render-composition/route.ts",
  ]) {
    const s = src(f)
    // TWIN_READ is the SINGULAR column. `subscription_tiers` (plural) is the plan
    // catalog TABLE and joining to it is correct — billing legitimately reads
    // subscription_tiers:tier_id(monthly_price_cents) for the save-offer price.
    check(`${f}: no longer reads brokerages.subscription_tier`,
      !TWIN_READ.test(s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")))
    check(`${f}: resolves the tier through lib/billing/plan-tier`,
      /from "@\/lib\/billing\/plan-tier"/.test(s))
  }
  check("the test fixture writes the column with writers, not the twin",
    /plan_tier: "solo_agent"/.test(src("scripts/studio-session-simulator.ts")))
}

console.log("\n[the DEFAULT method is the admin's decision, not a hardcoded one (m305)]")
{
  // The per-rule methods only apply when a rule MATCHES. The ordinary case is a
  // new contact — especially a newly converted lead — that no rule covers, and
  // for that lead both routers did the same hardcoded thing: capacity-based load
  // balancing, with no way to change it. A brokerage running a strict
  // round-robin floor rotation, the most common convention in the business,
  // could not have one. The method deciding MOST assignments was the only one
  // the admin could not set.
  const live = CHECK_VOCABULARIES.brokerages?.default_assignment_method ?? []
  check("brokerages.default_assignment_method exists as a CHECK-constrained column",
    live.length > 0)
  check("…and shares assignment_rules.rule_type's vocabulary exactly",
    live.length === RULE_TYPES.length && RULE_TYPES.every((t) => live.includes(t)))

  const mig = src("supabase/migrations/m305-brokerage-default-assignment-method.sql")
  check("the migration declares the column and the CHECK",
    /ADD COLUMN IF NOT EXISTS default_assignment_method/.test(mig) &&
    /brokerages_default_assignment_method_check/.test(mig))
  check("…and defaults to load_balance, preserving the pre-m305 behaviour",
    /DEFAULT 'load_balance'/.test(mig))

  const def = src("lib/lead-assignment/default-assignment.ts")
  check("the default runs through the SAME pickByMethod the per-rule path uses",
    /pickByMethod\(/.test(def))
  check("…so 'round robin' cannot mean two different things by code path",
    !/round_robin.*rotate|localeCompare/.test(def))
  check("an unset or unrecognised value falls back to load_balance, not to something new",
    /isRuleType\(m\) \? m : "load_balance"/.test(def))
  check("a default round-robin has a real rotation source (assignment history)",
    /from\("contacts"\)[\s\S]{0,220}?count: "exact"/.test(def))
  check("expertise/geo only pay for the profile query when they are the method",
    /method === "specialization" \|\| method === "geo_based"/.test(def))
  check("the capacity pick still uses the shared picker + tier ceiling",
    /selectAgentByCapacity/.test(def) && /resolveBrokerageMaxLoad/.test(def))
  check("the method is reported prefixed 'default_' so a ledger says WHERE it came from",
    /default_\$\{pick\.method\}/.test(def))

  // Both fallbacks must now read the setting rather than hardcode the method.
  const contact = src("lib/lead-assignment/contact-assignment.ts")
  const engine = src("lib/lead-assignment/assignment-engine.ts")
  check("the contact resolver's fallback reads the configured default",
    /assignByDefaultMethod\(/.test(contact))
  check("Engine 2's fallback reads it too", /assignByDefaultMethod\(/.test(engine))
  check("…and the engine's private loadBalanceFallback is gone",
    !/async function loadBalanceFallback/.test(engine))
  check("a team-affinity contact gets the default method applied WITHIN the team",
    /assignByDefaultMethod\([\s\S]{0,200}?teamAgents\.map/.test(contact))
  check("choosing manual is reported as a HOLD, never as a routing failure",
    /method: "manual_hold"/.test(contact) && /held for a person/.test(engine))
}

console.log("\n[the admin can actually set it — broker/admin gated, in Settings]")
{
  const action = src("app/actions/admin/lead-routing-settings.ts")
  check("the action exists and validates against the routing module",
    /isRuleType\(method\)/.test(action))
  check("…and is gated to broker + admin, the same gate the Settings page uses",
    /\["broker", "admin"\]\.includes\(type\)/.test(action))
  check("…and READS the write error rather than discarding it",
    /if \(error\) return \{ success: false, error: error\.message \}/.test(action))

  const panel = src("app/dashboard/settings/components/lead-routing-panel.tsx")
  check("the Settings panel exists and derives its options from the module",
    /RULE_TYPES\.map/.test(panel) && /RULE_TYPE_LABELS\[t\]/.test(panel))
  check("…shows what the chosen method does, in the module's own words",
    /RULE_TYPE_HELP\[method\]/.test(panel))
  check("…warns that Manual leaves a contact unassigned",
    /unassigned/.test(panel))
  check("…and points at per-rule routing instead of duplicating it",
    /dashboard\/admin\/assignment-rules/.test(panel))
  const settings = src("app/dashboard/settings/settings-control-os-client.tsx")
  check("the panel is mounted on the Settings control center", /<LeadRoutingPanel \/>/.test(settings))
}

console.log("\n[the picker offers every method the column admits]")
{
  const page = src("app/dashboard/admin/assignment-rules/page.tsx")
  check("the picker DERIVES its options from the routing module",
    /RULE_TYPES\.map/.test(page))
  check("…and no longer restates them as hardcoded <SelectItem>s",
    !/<SelectItem value="round_robin">/.test(page))
  check("…and shows what the chosen method actually does",
    /RULE_TYPE_HELP\[form\.rule_type\]/.test(page))
  check("the labels come from the module too, so list and table cannot disagree",
    /RULE_TYPE_LABELS/.test(page) && !/const RULE_TYPE_LABELS: Record<RuleType, string> = \{/.test(page))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ ASSIGNMENT_METHOD_FAIL"); process.exit(1) }
console.log(" ✅ ASSIGNMENT_METHOD_PASS — every method the broker can pick changes where the lead goes")
