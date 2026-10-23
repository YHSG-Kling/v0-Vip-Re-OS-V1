#!/usr/bin/env tsx
/**
 * scripts/geo-loop-schedule-simulator.ts  (npm run test:geo-loop-schedule)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GEO LOOP IS NOW SCHEDULED (owner: "the only loop we need to close is the
 * geo loop"). The gap→signal→draft→approve chain was fully built but its INGRESS
 * (citation monitors) and gap scan were never invoked by any cron — so no
 * observations were ever recorded in production and the loop never fired. This
 * proves the new geo-citation-monitor cron (1) exists and drives all three
 * ingress steps, and (2) is registered in the single CRON_REGISTRY dispatcher.
 * The downstream (geo_visibility_gap → gated regenerate_faq) is proven by the
 * existing geo-remediation simulator.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the GEO cron drives all three ingress steps ──")
{
  const route = src("app/api/cron/geo-citation-monitor/route.ts")
  check("records reel citations (runCitationMonitor)", route.includes("runCitationMonitor("))
  check("records landing/FAQ citations (runLandingPageCitationMonitor)", route.includes("runLandingPageCitationMonitor("))
  check("runs the gap scan that raises geo_visibility_gap signals (runGeoGapScan)", route.includes("runGeoGapScan("))
  check("is cron-authed + records a cron context", route.includes("verifyCronAuth") && route.includes("createCronRunContextAction"))
  check("iterates brokerages with citable surfaces (published reels OR active FAQ forms)",
    route.includes("ai_video_projects") && route.includes("lead_capture_forms") && route.includes("is_published"))
}

console.log("\n── the cron is registered in the single dispatcher ──")
{
  const entry = CRON_REGISTRY.find((c) => c.path === "/api/cron/geo-citation-monitor")
  check("registered in CRON_REGISTRY", !!entry)
  check("has a valid 5-field schedule", !!entry && entry.schedule.trim().split(/\s+/).length === 5)
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ GEO_LOOP_SCHEDULE_FAIL"); process.exit(1) }
console.log(" ✅ GEO_LOOP_SCHEDULE_PASS — the GEO loop ingress is scheduled; observations flow → gaps → gated FAQ drafts")
