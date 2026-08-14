#!/usr/bin/env tsx
/**
 * scripts/child-tenant-scope-simulator.ts   (npm run test:child-tenant-scope)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CHILD-TABLE TENANT BOUNDARY, checked against the LIVE database.
 *
 * The app-layer guard (test:tenant-scope) lints ~20 named tenant tables in the
 * TypeScript. It cannot see the class this simulator exists for: a CHILD table
 * that carries tenant rows, has no brokerage_id of its own, and is protected only
 * by an RLS policy — so no amount of reading app/ or lib/ reveals whether the
 * boundary holds. The only source of truth is pg_policies.
 *
 * HOW THE HOLE GOT THERE. Migration 063 fixed a real outage: ~44 tables had RLS
 * ENABLED with ZERO policies, which denies everything, so those features were
 * silently dead. It unblocked them with `USING (TRUE)`. Correct for platform
 * reference data; wrong for children of tenant tables, where it meant any
 * authenticated user could read — and on several, UPDATE — every other
 * brokerage's rows. m288 scoped the ten that had a tenant anchor.
 *
 * THE INVARIANT. A table is TENANT-ANCHORED if it has its own brokerage_id, or a
 * foreign key to a table that has one. A tenant-anchored table may not carry a
 * permissive (`USING (true)`) SELECT or UPDATE policy for public/authenticated.
 * Anything else must be on ALLOWED below, WITH A REASON — the list is the argument,
 * not a rubber stamp.
 *
 * Requires DB credentials; skips cleanly (exit 0) without them so the pure guard
 * chain still runs offline.
 */
import { createClient } from "@supabase/supabase-js"

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.log("── CHILD-TENANT-SCOPE ──")
  console.log("  ⊘ SKIPPED — no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env")
  process.exit(0)
}

/**
 * Permissive-by-design. Two kinds, and the distinction matters:
 *
 *  (a) GLOBAL REFERENCE DATA — every tenant reads the same rows. Scoping these by
 *      brokerage would be wrong, not safer: a state's protected classes and a
 *      plan's limits are the same for everyone.
 *  (b) NO TENANT ANCHOR — the table has neither brokerage_id nor an FK to anything
 *      that has one, so there is nothing to scope BY. A policy here would be
 *      invented rather than derived. These are the honest remainder: listed so they
 *      stay visible, not because they are proven safe.
 */
const ALLOWED: Record<string, string> = {
  // (a) global reference data
  achievements: "gamification catalogue — same for every tenant",
  ai_prompt_templates: "platform prompt library",
  compliance_rules: "regulatory rules, identical per state for all tenants",
  document_templates: "platform-supplied document templates",
  feature_flags: "platform flags — read by every tenant",
  journey_blueprints: "canonical journey definitions",
  journey_tools: "canonical journey tool catalogue",
  keywords: "SEO keyword reference set",
  lead_scraping_motivated_params: "scraper parameter vocabulary",
  lead_scraping_property_params: "scraper parameter vocabulary",
  market_rate_snapshots: "public market rates",
  onboarding_quizzes: "platform onboarding content",
  plan_limits: "subscription plan limits — public by nature",
  platform_settings: "platform-level settings",
  playbooks: "canonical playbook library",
  prohibited_phrases: "Fair-Housing phrase list — must be readable by every tenant",
  required_disclosures: "state disclosure requirements",
  // `scripts` was here as (a) global reference data — "canonical call/objection
  // script library", i.e. every tenant reads the same rows. m429 makes that
  // description false. The owner ruled that agents author into this table
  // ("agent authored scripts should save to scripts"), so it now carries a
  // brokerage_id, a private/brokerage/platform visibility, and a SELECT policy
  // that is no longer `USING (true)`. It therefore drops out of `permissive`
  // (tenant_scope_facts() selects on qual='true') and needs no cover.
  //
  // Removing the entry is the point, not housekeeping: `scripts` was already
  // ANCHORED — scripts.created_by FKs users(id), and users carries brokerage_id
  // — and already permissive, so this line was the only thing keeping this guard
  // green over a table that was about to start holding one agent's private work
  // readable by every brokerage on the platform.
  state_appraiser_adjustment_rates: "state appraisal reference rates",
  state_compliance_requirements: "state compliance reference",
  state_protected_classes: "Fair-Housing protected classes per state",
  subscription_tiers: "tier catalogue",
  user_roles: "role vocabulary",

  // (b) no tenant anchor — tracked, not blessed
  long_form_videos: "DEAD SCHEMA: 0 rows, no writer, and its only reader (a cross-tenant service-client select) was deleted — nothing to scope",
  marketing_stats: "DEAD SCHEMA: 0 rows, no writer, and its only reader (a cross-tenant service-client select) was deleted — nothing to scope",
  transparency_videos: "DEAD SCHEMA: 0 rows, no writer, and its only reader (a cross-tenant service-client select) was deleted — nothing to scope",
  demo_persona_contacts: "platform demo fixture; writes already restricted to is_platform_admin()",
}

const db = createClient(url, key, { auth: { persistSession: false } })

interface ScopeFacts {
  anchored: string[]
  permissive: Array<{ tablename: string; cmds: string }>
  oha_select: Array<{ policyname: string; qual: string }>
}

/** public.tenant_scope_facts() — SECURITY DEFINER, service_role only (m288). */
async function loadFacts(): Promise<ScopeFacts> {
  const { data, error } = await db.rpc("tenant_scope_facts")
  if (error) throw new Error(`tenant_scope_facts() — ${error.message}`)
  return data as ScopeFacts
}

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Child-table tenant scope (live pg_policies)")
  console.log("══════════════════════════════════════════════════\n")

  // Tenant-anchored = own brokerage_id, OR an FK to a table that has one.
  const facts = await loadFacts()
  const anchoredSet = new Set(facts.anchored)
  const permissive = facts.permissive
  console.log(`  · ${anchoredSet.size} tenant-anchored tables (own brokerage_id or an FK to one)`)
  console.log(`  · ${permissive.length} tables carry a permissive SELECT/UPDATE policy\n`)

  const offenders = permissive
    .filter((r) => anchoredSet.has(r.tablename))
    .filter((r) => !ALLOWED[r.tablename])

  check(
    "no tenant-anchored table is world-readable/writable via USING(true)",
    offenders.length === 0,
    offenders.map((o) => `${o.tablename} (${o.cmds})`).join(", "),
  )

  // The ten m288 closed must STAY closed — named individually so a regression
  // says which one, instead of a bare count.
  const M288 = [
    "open_house_analytics", "cma_comparables", "cma_price_adjustments",
    "campaign_sequence_steps", "objection_training_turns", "newsletter_seo_scores",
    "tool_shares", "ai_suggestions", "newsletter_scheduled_sends", "newsletter_sections",
  ]
  const stillPermissive = new Set(permissive.map((r) => r.tablename))
  for (const t of M288) {
    check(`m288 holds: ${t} is not permissive`, !stillPermissive.has(t))
  }

  // open_house_analytics is the one that was BOTH readable and writable — assert it
  // is scoped through its parent, not merely non-permissive.
  const oha = facts.oha_select
  check(
    "open_house_analytics SELECT scopes through open_house_events.brokerage_id",
    oha.length > 0 && oha.every((p) => (p.qual ?? "").includes("open_house_events") && (p.qual ?? "").includes("has_brokerage_access")),
    oha.map((p) => p.policyname).join(",") || "no SELECT policy",
  )

  // Every allowlist entry must still exist and still be permissive — otherwise the
  // list is stale and quietly granting cover it no longer needs to.
  const stale = Object.keys(ALLOWED).filter((t) => !stillPermissive.has(t))
  if (stale.length > 0) {
    console.log(`  ↘  ${stale.length} allowlist entr${stale.length === 1 ? "y is" : "ies are"} no longer permissive — prune: ${stale.join(", ")}`)
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    console.log(" ❌ CHILD_TENANT_SCOPE_FAIL — a child table with tenant rows is world-readable/writable")
    process.exit(1)
  }
  console.log(" ✅ CHILD_TENANT_SCOPE_PASS — every tenant-anchored table scopes by brokerage or its parent")
}

main().catch((e) => { console.error(e); process.exit(1) })
