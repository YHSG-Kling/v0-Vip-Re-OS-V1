#!/usr/bin/env tsx
/**
 * scripts/back-on-market-promo-simulator.ts   (npm run test:back-on-market-promo)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves BACK-ON-MARKET is now a first-class multi-channel listing promo — the single
 * highest-intent re-marketing moment. Previously a re-list only fired a manager signal
 * (re-engage saved buyers); the listing itself was silently NOT re-marketed. Now the same
 * multi-channel path just_listed uses (video + social + mail) fires on back_on_market.
 *
 * PURE trigger: isBackOnMarket detects a contract-stage → on-market transition (never the
 * first go-live). SOURCE scan: back_on_market is wired in all three channel registries + the
 * core dispatches video + mail. (The policy/reactor modules are server-only, so we assert
 * their wiring by scanning source — the same way the egress/signal guards do.)
 */
import { isBackOnMarket } from "../lib/listings/back-on-market"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
/** Source with comments stripped — these files quote the poster they retired. */
const src = (p: string) =>
  stripComments(readFileSync(join(process.cwd(), p), "utf8"))
const exists = (p: string) => existsSync(join(process.cwd(), p))

function main() {
  console.log("\n[trigger — isBackOnMarket detects a fell-through re-list, never a normal launch]")
  check("UNDER_CONTRACT → MLS_ACTIVE → back on market", isBackOnMarket("UNDER_CONTRACT", "MLS_ACTIVE"))
  check("NEGOTIATION → SHOWINGS_ACTIVE → back on market", isBackOnMarket("NEGOTIATION", "SHOWINGS_ACTIVE"))
  check("FINANCING → OPEN_HOUSE_EVENT → back on market", isBackOnMarket("FINANCING", "OPEN_HOUSE_EVENT"))
  check("first go-live (COMING_SOON_ACTIVE → MLS_ACTIVE) is NOT back on market", !isBackOnMarket("COMING_SOON_ACTIVE", "MLS_ACTIVE"))
  check("normal launch (MLS_READY → MLS_ACTIVE) is NOT back on market", !isBackOnMarket("MLS_READY", "MLS_ACTIVE"))
  check("going UNDER contract (MLS_ACTIVE → UNDER_CONTRACT) is NOT back on market", !isBackOnMarket("MLS_ACTIVE", "UNDER_CONTRACT"))
  check("closed (UNDER_CONTRACT → CLOSED) is NOT back on market", !isBackOnMarket("UNDER_CONTRACT", "CLOSED"))
  check("missing stages → false", !isBackOnMarket(null, "MLS_ACTIVE") && !isBackOnMarket("UNDER_CONTRACT", null))

  console.log("\n[all THREE channel registries wire back_on_market]")
  const policy = src("lib/kernel/lifecycle-promo-policy.ts")
  check("policy: back_on_market in LifecycleEventType + PLATFORM_DEFAULTS (autoSpawn ON)", policy.includes('"back_on_market"') && /back_on_market:\s*{\s*autoSpawn:\s*true/.test(policy))
  const video = src("lib/video/listing-promo-reactor.ts")
  check("video: back_on_market TEMPLATE present (hook + CTA)", /back_on_market:\s*{[\s\S]*?hook:/.test(video))
  check("video: back_on_market template forbids distress/urgency phrasing (Fair Housing)", /back_on_market:[\s\S]*?motivated seller/.test(video))
  const mail = src("lib/direct-mail/listing-lifecycle-mail-reactor.ts")
  check("mail: back_on_market EVENT_DEFAULTS present", /back_on_market:\s*{[\s\S]*?statusBadge:/.test(mail))

  console.log("\n[the core dispatches the multi-channel promo, not just the manager signal]")
  const core = src("app/actions/listing-lifecycle-core.ts")
  check("core still hands off to the Shopping Agent (demand side)", core.includes("listing_back_on_market"))
  check("core NOW also dispatches the listing promo video (supply side)", /isBackOnMarket[\s\S]*?dispatchListingPromoVideo[\s\S]*?back_on_market/.test(core))
  check("core NOW also dispatches the lifecycle mail (supply side)", /isBackOnMarket[\s\S]*?dispatchLifecycleMail[\s\S]*?back_on_market/.test(core))

  // ── The catch-up sweep runs through the CANONICAL path, not a second poster ──
  //
  // lib/marketing/gbp-auto-posts.ts swept the same 24h window on its own hourly
  // cron and posted a hand-written template to Google Business Profile only —
  // outside lifecycle_promo_policy and outside the compliance gate, while
  // /api/cron/listing-promo-social-publish was already publishing google_business
  // alongside seven other platforms. Its own header deferred the collapse; this
  // pins the collapse in place.
  console.log("\n[catch-up — one sweep, through the canonical dispatcher]")
  check("the GBP-only poster is gone", !exists("lib/marketing/gbp-auto-posts.ts"))
  check("so is its cron route", !exists("app/api/cron/gbp-auto-posts/route.ts"))
  check("the registry no longer schedules it",
    !CRON_REGISTRY.some((e) => e.path === "/api/cron/gbp-auto-posts"))

  const catchup = src("lib/marketing/listing-promo-catchup.ts")
  check("the catch-up sweep dispatches through the canonical reactor",
    catchup.includes("dispatchListingPromoVideo") &&
    catchup.includes('from "@/lib/video/listing-promo-reactor"'))
  check("it never calls the social rail directly (no bespoke second poster)",
    !catchup.includes("createSocialPost") && !/platforms:\s*\[/.test(catchup))
  // The GBP tick swept lifecycle_stage='active' and status='closed'. Neither
  // string is in this schema's CHECK vocabularies, so both halves matched zero
  // rows every run — verified live. These are the values that actually exist.
  check("just_listed sweeps the LIVE on-market vocabulary (MLS_ACTIVE / status active)",
    catchup.includes("lifecycle_stage.eq.MLS_ACTIVE,status.eq.active"))
  check("just_sold sweeps the LIVE sold vocabulary (CLOSED / status sold)",
    catchup.includes("lifecycle_stage.eq.CLOSED,status.eq.sold"))
  check("neither impossible literal survives",
    !catchup.includes("lifecycle_stage.eq.active") && !catchup.includes("status.eq.closed") &&
    !/\.eq\("lifecycle_stage",\s*"active"\)/.test(catchup) && !/\.eq\("status",\s*"closed"\)/.test(catchup))
  check("one dispatch per (listing, event) even when both columns qualify",
    catchup.includes("const seen = new Set<string>()"))
  check("it keeps the 24h look-back that made it a catch-up",
    /24 \* 60 \* 60 \* 1000/.test(catchup))
  check("a listing the event path already handled comes back already_queued, not a second promo",
    catchup.includes("already_queued") && catchup.includes("alreadyHandled"))
  check("a listing with no brokerage or agent is skipped and counted, never dispatched blind",
    /if \(!row\.brokerage_id \|\| !row\.agent_id\)/.test(catchup))
  check("the replacement cron is registered",
    CRON_REGISTRY.some((e) => e.path === "/api/cron/listing-promo-catchup"))
  check("its route exists and is cron-auth gated",
    exists("app/api/cron/listing-promo-catchup/route.ts") &&
    src("app/api/cron/listing-promo-catchup/route.ts").includes("verifyCronAuth"))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ BACK_ON_MARKET_PROMO_FAIL"); process.exit(1) }
  console.log(" ✅ BACK_ON_MARKET_PROMO_PASS — a re-list now auto-re-markets across video + social + mail, both demand + supply sides")
}
main()
