#!/usr/bin/env tsx
/**
 * scripts/marketing-ops-consolidation-simulator.ts  (npm run test:marketing-ops-consolidation)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE MARKETING SURFACE, NOT TWO. The standalone "Ops Center" page
 * (/dashboard/marketing/ops) duplicated the Marketing Studio menu area. Its four
 * unique read-only functions — the health strip, needs-attention triage (incl.
 * stale-draft detection), the direct-mail pipeline, and connected-channel health
 * — moved INTO Studio as an "Ops" tab; the duplicate page + nav entries were
 * removed. This proves the merge KEPT the advanced functions and left no dangling
 * route/link (the owner's "keep, merge or remove — keep the more advanced").
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the Ops view is now a Studio tab (Studio is the kept, advanced surface) ──")
{
  const page = src("app/dashboard/marketing/studio/page.tsx")
  check("'ops' is a valid Studio tab", /VALID_TABS[\s\S]*?"ops"/.test(page))

  const client = src("app/dashboard/marketing/studio/marketing-studio-client.tsx")
  check("Studio client imports the MarketingOpsPanel", client.includes("./components/marketing-ops-panel"))
  check("an 'Ops' TabsTrigger exists", /TabsTrigger[\s\S]*?value="ops"/.test(client))
  check("the 'ops' TabsContent renders the panel", /TabsContent value="ops"[\s\S]*?<MarketingOpsPanel \/>/.test(client))
}

console.log("\n── the panel KEEPS all four Ops functions ──")
{
  const panel = src("app/dashboard/marketing/studio/components/marketing-ops-panel.tsx")
  check("loads via the getMarketingOpsSnapshot action", panel.includes("getMarketingOpsSnapshot"))
  check("[1] health strip (active / pending / failed / readiness pass-rate)",
    panel.includes("Active Campaigns") && panel.includes("Readiness Pass Rate"))
  check("[2] needs-attention triage incl. STALE DRAFTS", panel.includes("Stale Drafts") && panel.includes("Failed Social Publishes"))
  check("[3] direct-mail pipeline", panel.includes("Direct Mail Pipeline"))
  check("[4] connected-channel health", panel.includes("Connected Channels"))
}

console.log("\n── the action is gated + reads the right ledgers, stale-draft logic preserved ──")
{
  const act = src("app/actions/marketing-ops.ts")
  check("auth-gated (unauthorized without a user)", /getUser\(\)[\s\S]*?Unauthorized/.test(act))
  check("brokerage-scoped over all four reads", (act.match(/\.eq\("brokerage_id", brokerageId\)/g) ?? []).length >= 4)
  check("reads campaigns, social_posts, direct_mail_campaigns, brokerage_integrations",
    act.includes("marketing_campaigns") && act.includes("social_posts") && act.includes("direct_mail_campaigns") && act.includes("brokerage_integrations"))
  check("readiness pass-rate via fetchReadinessStatistics", act.includes("fetchReadinessStatistics"))
  check("stale-draft rule = draft older than 7 days", /7 \* 24 \* 60 \* 60 \* 1000/.test(act) && act.includes('"draft"'))
}

console.log("\n── the duplicate surface is fully removed (no dangling route/link) ──")
{
  check("the standalone Ops page file is deleted", !existsSync(join(process.cwd(), "app/dashboard/marketing/ops/page.tsx")))
  const nav = src("app/config/navigation-config.ts")
  check("no 'Ops Center' nav entries remain (all three removed)", !nav.includes("/dashboard/marketing/ops"))
  const adminDash = src("app/dashboard/admin/admin-dashboard-client.tsx")
  check("the admin 'Failed Publishes' tile repoints to the Studio ops tab",
    adminDash.includes("/dashboard/marketing/studio?tab=ops") && !adminDash.includes("/dashboard/marketing/ops'"))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ MARKETING_OPS_CONSOLIDATION_FAIL"); process.exit(1) }
console.log(" ✅ MARKETING_OPS_CONSOLIDATION_PASS — one marketing surface; the Ops functions kept as a Studio tab; no dangling route")
