#!/usr/bin/env tsx
/**
 * scripts/rejected-write-simulator.ts   (npm run test:rejected-write) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * NINETEEN WRITES THAT WERE SILENTLY REJECTED.
 *
 * Triaging the remaining CHECK-vocabulary baseline by OPERATION rather than by
 * table split it cleanly: 19 entries were not filters at all, they were
 * INSERT/UPDATE payloads. A filter on an impossible value returns no rows; a
 * WRITE of one loses the row. Every one of these was a record the product
 * believed it had made — a referral, a dedupe audit, a price prediction, a Zoom
 * meeting's call row, a commission adjustment.
 *
 * Only FOUR needed schema (m299). The rest were the code using a word the column
 * already had under another name, or writing "unknown" into a NULLABLE column
 * that already says that with NULL.
 *
 * ── WIDENED (m299) — a genuinely missing state ──────────────────────────────
 *   calendar_sync_logs.direction   += both     a two-way sync is neither push
 *                                              nor pull, and the two-way syncer
 *                                              is what writes this row
 *   voice_calls.call_type          += zoom_meeting
 *                                              the Zoom lane is built; a
 *                                              convened meeting is none of the
 *                                              four types, and this row anchors
 *                                              the transcript + recap
 *   ad_insights.source_type        += competitor_analysis
 *                                              the AI's DERIVED insight, not a
 *                                              single observed ad/post; NOT NULL
 *                                              so there was no fallback
 *   listing_packet_jobs.job_type   += full_packet
 *                                              "all five at once" is its own
 *                                              job; NOT NULL
 *
 * ── REPOINTED — the column already had the word ─────────────────────────────
 *   qr_codes.purpose                 open_house_signin → open_house
 *   message_provider_logs.channel    social_dm         → ai_social_dm
 *   commission_adjustments.applies_to listing          → gross
 *   commission_adjustments.direction  reduction        → credit
 *   agents.onboarding_status          pending          → not_started
 *   marketing_campaigns.campaign_type nurture          → omni
 *   predictive_listing_actions.status approved         → queued
 *   buyer_financial_profiles.lender_referral_status requested → referred
 *   lead_deduplication_log.action_taken merged_into_existing → merged
 *   lead_deduplication_log.stage       contact          → lead_creation
 *   referrals.status                   new              → received
 *   pricing_history.price_type         ai_prediction    → prediction
 *   chat_sessions.session_type         portal_ai        → portal_widget
 *   price_trend_alerts.alert_type      price_gap        → price_too_high when
 *     the prediction is BELOW list (the listing is priced too high) and
 *     market_shift when it is ABOVE (there is no "underpriced" value, and the
 *     alert's own message already distinguishes the two).
 *
 * ── DROPPED — the column is NULLABLE and the value meant "unknown" ──────────
 *   open_house_attendees.interest_level 'unknown' — at sign-in nobody has
 *     assessed them; NULL already says that, and a stored 'unknown' would be a
 *     second spelling of it.
 *   ai_video_projects.video_type 'upload' — video_type says what a video IS
 *     (listing_tour, just_sold, …). For a file the user uploaded we do not know,
 *     and the adjacent video_provider already records that it arrived by upload.
 *   voice_commands.source 'voice_assistant' — source is the CLIENT SURFACE
 *     (web|mobile|pwa|voice_call). The internal route cannot know which, and
 *     'voice_assistant' is the feature, not the surface. It says nothing rather
 *     than guessing.
 *
 * VERIFIED LIVE: all four widened values store; and for the repoints sampled
 * end-to-end (referrals, lead_deduplication_log on BOTH its columns,
 * pricing_history) the old literal was rejected — referrals by the named
 * referrals_status_check — and the new one stored. Probes deleted, every touched
 * table back to 0.
 */
import { readFileSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
const vocab = (t: string, c: string): readonly string[] =>
  ((CHECK_VOCABULARIES as any)[t]?.[c] ?? []) as string[]

console.log("══════════════════════════════════════════════════")
console.log(" Rejected writes (the record the product believed it made)")
console.log("══════════════════════════════════════════════════")

console.log("\n── m299 widened four columns, and only four ──")
{
  const widened: Array<[string, string, string, number]> = [
    ["calendar_sync_logs", "direction", "both", 3],
    ["voice_calls", "call_type", "zoom_meeting", 5],
    ["ad_insights", "source_type", "competitor_analysis", 3],
    ["listing_packet_jobs", "job_type", "full_packet", 6],
  ]
  for (const [t, c, v, size] of widened) {
    const live = vocab(t, c)
    check(`${t}.${c} admits '${v}' (m299)`, live.includes(v))
    check(`${t}.${c} is exactly ${size} values — additive, nothing dropped`, live.length === size)
  }
  check("the pre-existing directions survive",
    ["push", "pull"].every((v) => vocab("calendar_sync_logs", "direction").includes(v)))
  check("the pre-existing call types survive",
    ["agent_call", "ai_isa_call", "vapi_inbound", "warm_transfer"].every((v) => vocab("voice_calls", "call_type").includes(v)))
}

console.log("\n── every repointed write names a value its column admits ──")
{
  const repoints: Array<[string, string, string, string, string]> = [
    // file, table, column, oldValue (must be impossible), newValue (must be admitted)
    ["app/actions/seller-open-house.ts", "qr_codes", "purpose", "open_house_signin", "open_house"],
    ["app/actions/social-dm.ts", "message_provider_logs", "channel", "social_dm", "ai_social_dm"],
    ["app/actions/seller-listing/execution-engine.ts", "commission_adjustments", "applies_to", "listing", "gross"],
    ["app/actions/seller-listing/execution-engine.ts", "commission_adjustments", "direction", "reduction", "credit"],
    ["app/api/recruiting/provision-agent/route.ts", "agents", "onboarding_status", "pending", "not_started"],
    ["app/crm/page.tsx", "marketing_campaigns", "campaign_type", "nurture", "omni"],
    ["app/dashboard/sphere/actions.ts", "predictive_listing_actions", "status", "approved", "queued"],
    ["lib/ai-isa/convert-buyer-lead-on-intent.ts", "buyer_financial_profiles", "lender_referral_status", "requested", "referred"],
    ["lib/kernel/crm.ts", "lead_deduplication_log", "action_taken", "merged_into_existing", "merged"],
    ["lib/kernel/crm.ts", "lead_deduplication_log", "stage", "contact", "lead_creation"],
    ["lib/kernel/reputation.ts", "referrals", "status", "new", "received"],
    ["lib/pricing/predictive-pricing.ts", "pricing_history", "price_type", "ai_prediction", "prediction"],
    ["app/api/portal/ai-chat/route.ts", "chat_sessions", "session_type", "portal_ai", "portal_widget"],
  ]
  for (const [file, table, col, oldV, newV] of repoints) {
    const live = vocab(table, col)
    check(`${table}.${col}: '${oldV}' is impossible, '${newV}' is admitted`,
      live.length > 0 && !live.includes(oldV) && live.includes(newV))
    const t = src(file)
    check(`${file}: writes ${col} '${newV}', not '${oldV}'`,
      new RegExp(`${col}:\\s*["']${newV}["']`).test(t) &&
      !new RegExp(`${col}:\\s*["']${oldV}["']`).test(t))
  }
}

console.log("\n── the price alert picks a REAL type from the direction it computed ──")
{
  const live = vocab("price_trend_alerts", "alert_type")
  check("'price_gap' is not an alert type", !live.includes("price_gap"))
  check("both branch values are admitted",
    live.includes("price_too_high") && live.includes("market_shift"))
  const p = src("lib/pricing/predictive-pricing.ts")
  check("the write branches on the direction it already computed",
    /alert_type: direction === "below" \? "price_too_high" : "market_shift"/.test(p))
  check("no 'price_gap' literal remains", !/"price_gap"/.test(p))
}

console.log("\n── the three 'unknown' writes became NULL, not a second spelling ──")
{
  check("open_house_attendees.interest_level has no 'unknown'",
    !vocab("open_house_attendees", "interest_level").includes("unknown"))
  check("…and the sign-in no longer writes one",
    !/interest_level:\s*"unknown"/.test(src("app/actions/seller-open-house.ts")))
  check("ai_video_projects.video_type has no 'upload'",
    !vocab("ai_video_projects", "video_type").includes("upload"))
  check("…and the uploader no longer writes one, but still records the provider",
    !/video_type:\s*"upload"/.test(src("app/content-studio/content-studio-client.tsx")) &&
    /video_provider:\s*"upload"/.test(src("app/content-studio/content-studio-client.tsx")))
  check("voice_commands.source has no 'voice_assistant'",
    !vocab("voice_commands", "source").includes("voice_assistant"))
  check("…and the route no longer guesses a surface",
    !/source:\s*"voice_assistant"/.test(src("app/api/internal/voice-command/route.ts")))
}

console.log("\n── the last eleven: seven DEAD QUERIES, three riders, one false positive ──")
{
  // An .eq() on an impossible value returns ZERO rows — a dead query, not a
  // harmless rider. Seven of the final eleven were exactly that.
  const dead: Array<[string, string, string, string, string]> = [
    ["app/actions/assistant.ts", "video_scripts_library", "approval_status", "pending", "pending_review"],
    ["app/actions/financials.ts", "agent_earnings", "period_type", "annual", "ytd"],
    ["app/api/internal/remotion/render-just-listed/route.ts", "listing_media", "media_type", "image", "photo"],
    ["app/dashboard/financials/brokerage/page.tsx", "team_earnings", "period_type", "monthly", "mtd"],
    ["lib/intelligence/manager-standup.ts", "remotion_composition_renders", "render_status", "completed", "succeeded"],
    ["lib/onboarding/certification-engine.ts", "onboarding_steps", "category", "platform_tour", "system_setup"],
  ]
  for (const [file, table, col, oldV, newV] of dead) {
    const live = vocab(table, col)
    check(`${table}.${col}: '${oldV}' matched nothing, '${newV}' is admitted`,
      live.length > 0 && !live.includes(oldV) && live.includes(newV))
    check(`${file}: filters ${col} on '${newV}'`,
      new RegExp(`["']${col}["'],\\s*["']${newV}["']`).test(src(file)))
  }

  // vendor_invoices.billed_to — the code was AHEAD of the schema, not drifted:
  // its own comment cited a migration that never landed. m300 finished it.
  check("vendor_invoices.billed_to admits 'vendor' (m300)",
    vocab("vendor_invoices", "billed_to").includes("vendor"))
  check("…alongside the two it always had",
    ["brokerage", "contact"].every((v) => vocab("vendor_invoices", "billed_to").includes(v)))

  // The three riders: an impossible value sitting next to a real one in an .in().
  check("lifetime_customer_touchpoints has no 'anniversary' (it says home_anniversary)",
    !vocab("lifetime_customer_touchpoints", "touchpoint_type").includes("anniversary") &&
    vocab("lifetime_customer_touchpoints", "touchpoint_type").includes("home_anniversary"))
  check("open_house_events has no 'confirmed'",
    !vocab("open_house_events", "status").includes("confirmed"))
  check("users has no 'team_manager'",
    !vocab("users", "user_type").includes("team_manager") &&
    vocab("users", "user_type").includes("team_lead"))
  for (const [f, gone] of [
    ["app/actions/portal-lifetime.ts", "anniversary"],
    ["app/api/cron/open-house-reminder/route.ts", "confirmed"],
    ["app/dashboard/team/page.tsx", "team_manager"],
  ] as Array<[string, string]>) {
    check(`${f}: the rider '${gone}' is gone`, !new RegExp(`["']${gone}["']`).test(src(f)))
  }

  // brokerage_earnings and training_videos were CORRECT all along — a blanket
  // replace-all briefly broke them and the guard caught it. Pinned so a future
  // sweep does not "fix" them onto a sibling table's vocabulary.
  check("brokerage_earnings.period_type keeps its OWN vocabulary",
    ["monthly", "quarterly", "annual"].every((v) => vocab("brokerage_earnings", "period_type").includes(v)))
  check("…which is NOT agent_earnings' vocabulary",
    !vocab("brokerage_earnings", "period_type").includes("mtd") &&
    vocab("agent_earnings", "period_type").includes("mtd"))
  check("training_videos.category really does admit 'platform_tour'",
    vocab("training_videos", "category").includes("platform_tour") &&
    !vocab("onboarding_steps", "category").includes("platform_tour"))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ REJECTED_WRITE_FAIL"); process.exit(1) }
console.log(" ✅ REJECTED_WRITE_PASS — every record the product claims to make can be made")
