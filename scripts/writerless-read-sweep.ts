#!/usr/bin/env tsx
/**
 * scripts/writerless-read-sweep.ts  (PASS 16)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE "ALWAYS-EMPTY READ" SWEEP — the mirror image of the schema-drift guard.
 * Fifteen passes hardened WRONG queries; this finds RIGHT queries over data
 * that can never exist: tables the code READS but nothing in app/ or lib/
 * ever WRITES. Pre-launch, a writer-less read is a dead feature wearing a
 * working query (the skill-freshness 'completed' filter and the
 * neighborhood_guides read were both this class).
 *
 * Report-only with a committed baseline: NEW writer-less reads fail; the
 * existing list is a burn-down (each entry needs a verdict — build the writer,
 * repoint the read, or delete the dead surface). Seeded/reference tables
 * (populated by migration or superadmin, not runtime code) are exempt.
 *
 * Run: npx tsx scripts/writerless-read-sweep.ts  (npm run test:writerless-reads)
 * Tighten: GUARD_WRITE_BASELINE=1 npx tsx scripts/writerless-read-sweep.ts
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const BASELINE = join(process.cwd(), "scripts/writerless-read-baseline.json")

/** Reference tables seeded by migrations / platform admin — a runtime writer is
 *  not expected, so a read against them is legitimate. */
const SEEDED_REFERENCE = new Set([
  "subscription_tiers", "state_protected_classes", "state_appraiser_adjustment_rates",
  "tax_categories", "global_settings", "platform_settings", "achievements",
  "gamification_badges", "onboarding_steps", "milestone_template_items",
  "training_courses", "training_videos", "onboarding_quizzes", "brokerage_fee_types",
  "compliance_rules", "prohibited_phrases", "journey_blueprints",
  "offer_strategy_templates", "listing_task_templates", "transaction_milestone_templates",
  "email_templates", "newsletter_templates", "video_templates", "brand_templates",
  "content_templates", "document_templates", "chat_templates",
  "thank_you_note_templates", "remotion_compositions", "ai_prompt_templates",
  "ai_agent_templates", "template_marketplace", "vendor_plans", "journey_tools",
  "local_news_sources", "neighborhood_data_sources", "market_data_sources",
  "content_topic_sources",
  // Live-verified seeded config (rows exist, written by migration/superadmin):
  "plan_limits", "state_compliance_requirements",
  // Round-3 verdicts (investigated): behavioral_patterns is a pattern-definition
  // CATALOG (its own code comments say so); brokerage_forms is the per-state
  // form-template catalog (degrades to state_required_forms); document_
  // classifications is the routing RULE set (brokerage_id-null global default
  // rows); form_field_maps is per-form-template field mapping.
  "behavioral_patterns", "brokerage_forms", "document_classifications", "form_field_maps",
])

/** Database VIEWS — written through their base tables by definition; a read
 *  against a view is never writer-less. Live-verified relkind='v'. */
const DB_VIEWS = new Set([
  "contact_lead_history", "social_post_baselines_28d", "sphere_engagement_scores",
  "v_brokerage_ai_quota", "v_brokerage_onboarding_progress", "v_platform_margin",
])

/** Tables written through a VARIABLE table name the static scan can't see —
 *  each entry names its canonical writer so the exemption stays auditable. */
const VARIABLE_TABLE_WRITERS: Record<string, string> = {
  email_presets: "app/actions/campaign-presets.ts (CHANNEL_TABLE)",
  sms_presets: "app/actions/campaign-presets.ts (CHANNEL_TABLE)",
  voicedrop_presets: "app/actions/campaign-presets.ts (CHANNEL_TABLE)",
  social_post_presets: "app/actions/campaign-presets.ts (CHANNEL_TABLE)",
  portal_push_presets: "app/actions/campaign-presets.ts (CHANNEL_TABLE)",
  podcast_episode_presets: "app/actions/campaign-presets.ts (CHANNEL_TABLE)",
  ad_retarget_presets: "app/actions/campaign-presets.ts (CHANNEL_TABLE)",
}

function walk(dir: string, acc: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
}

function main() {
  const files: string[] = []
  for (const d of ["app", "lib"]) { try { walk(join(process.cwd(), d), files) } catch {} }

  const readers = new Map<string, Set<string>>()
  const writers = new Set<string>()
  // Tolerant windows: a write verb within 120 chars of the from() catches
  // multiline chains and interleaved option args.
  const FROM = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g
  for (const f of files) {
    const s = readFileSync(f, "utf8")
    let m: RegExpExecArray | null
    while ((m = FROM.exec(s))) {
      const table = m[1]
      const window = s.slice(m.index, m.index + m[0].length + 160)
      if (/\.(insert|upsert|update|delete)\s*\(/.test(window)) writers.add(table)
      if (/\.select\s*\(/.test(window)) {
        const set = readers.get(table) ?? new Set<string>()
        set.add(f.replace(process.cwd() + "/", ""))
        readers.set(table, set)
      }
    }
  }

  const offenders = [...readers.keys()]
    .filter((t) => !writers.has(t) && !SEEDED_REFERENCE.has(t) && !DB_VIEWS.has(t) && !(t in VARIABLE_TABLE_WRITERS))
    .sort()

  if (process.env.GUARD_WRITE_BASELINE === "1") {
    writeFileSync(BASELINE, JSON.stringify(offenders, null, 2) + "\n")
    console.log(`⚙ wrote baseline: ${offenders.length} writer-less reads (burn-down list)`)
  }
  const baseline = new Set<string>(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : [])
  const fresh = offenders.filter((t) => !baseline.has(t))
  const fixed = [...baseline].filter((t) => !offenders.includes(t))

  console.log("══════════════════════════════════════════════════")
  console.log(" PASS 16 — writer-less read sweep (dead features wearing working queries)")
  console.log("══════════════════════════════════════════════════")
  console.log(` reads over ${readers.size} tables · ${writers.size} tables have runtime writers`)
  console.log(` writer-less reads: ${offenders.length} (baseline ${baseline.size}, burn-down)`)
  for (const t of offenders.slice(0, 100)) {
    const mark = baseline.has(t) ? "·" : "✗ NEW"
    console.log(`  ${mark} ${t} ← ${[...(readers.get(t) ?? [])].slice(0, 2).join(", ")}`)
  }
  if (fixed.length > 0) console.log(` ↘ ${fixed.length} baseline entries now have writers — tighten with GUARD_WRITE_BASELINE=1`)
  if (fresh.length > 0) {
    console.log(` ✗ ${fresh.length} NEW writer-less read(s): ${fresh.join(", ")}`)
    console.log("   Give each a verdict: build the writer, repoint the read, or delete the dead surface.")
    process.exit(1)
  }
  console.log(" ✅ no NEW writer-less reads")
}

main()
