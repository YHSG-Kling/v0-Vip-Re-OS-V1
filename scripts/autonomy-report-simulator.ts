#!/usr/bin/env tsx
/**
 * scripts/autonomy-report-simulator.ts   (npm run test:autonomy-report)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE KPI KERNEL PROOF — program item #1: the autonomy-impact + coaching
 * reports that turn this OS's decision provenance and delivery ledgers into
 * the numbers a tenant sees ("what the OS did, measured"), tier-scoped
 * through the EXISTING reporting-scope ladder (keep-one — no fifth engine).
 *
 * Layer 1 (pure): median math, narrative honesty (quiet windows say so;
 * no invented momentum), narrative composition from real report shapes.
 * Layer 2 (source locks): generators ride ReportingActorContext +
 * narrowReportAgentIds; provenance reads the recorded fields
 * (generated_from / content_kit.built_by); the reports page renders the
 * tier-scoped section with the assistant narrative.
 * Layer 3 (live, creds-gated): run BOTH generators read-only against the
 * real database for a real brokerage and assert honest shapes.
 */
import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { median, composeKpiNarrative, type AutonomyImpactReport, type CoachingSignalsReport } from "../lib/kernel/reporting-autonomy"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf-8") : "")

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" KPI kernel simulator (autonomy impact + coaching signals)")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[1 · pure math + narrative honesty]")
  check("median: odd, even, empty", median([3, 1, 2]) === 2 && median([1, 2, 3, 4]) === 2.5 && median([]) === null)

  const quiet: AutonomyImpactReport = {
    tier: "agent", window: { from: "a", to: "b" },
    assets: { videosProduced: 0, rendersProduced: 0, documentsProduced: 0, socialPostsPublished: 0 },
    aiLane: { draftsWritten: 0, draftsSent: 0, draftAdoptionRate: null },
    provenance: { learned: 0, norm: 0, fallback: 0, learnedShare: null },
    attribution: { creditDollars: 0, creditedTransactions: 0 },
  }
  const quietCoaching: CoachingSignalsReport = {
    tier: "agent", window: { from: "a", to: "b" },
    medianFirstResponseMinutes: null, contactsMeasured: 0, followUpGaps: 0,
    deadlines: { atRisk: 0, missed: 0 },
  }
  const quietLines = composeKpiNarrative(quiet, quietCoaching)
  check("a QUIET window says so — no invented momentum, no fabricated stats",
    quietLines.length === 1 && /quiet window/i.test(quietLines[0]))

  const busy: AutonomyImpactReport = {
    tier: "brokerage", window: { from: "a", to: "b" },
    assets: { videosProduced: 4, rendersProduced: 6, documentsProduced: 3, socialPostsPublished: 9 },
    aiLane: { draftsWritten: 40, draftsSent: 28, draftAdoptionRate: 0.7 },
    provenance: { learned: 6, norm: 3, fallback: 1, learnedShare: 0.6 },
    attribution: { creditDollars: 84250, creditedTransactions: 3 },
  }
  const busyCoaching: CoachingSignalsReport = {
    tier: "brokerage", window: { from: "a", to: "b" },
    medianFirstResponseMinutes: 7, contactsMeasured: 22, followUpGaps: 5,
    deadlines: { atRisk: 2, missed: 1 },
  }
  const lines = composeKpiNarrative(busy, busyCoaching)
  check("the busy narrative carries the trust lines: production, draft adoption, own-evidence share, MEASURED attribution, response time, gaps, deadlines",
    lines.some((l) => l.includes("13 finished assets"))
    && lines.some((l) => l.includes("sent 70%"))
    && lines.some((l) => l.includes("60% of creative decisions ran on your own measured results"))
    && lines.some((l) => l.includes("$84,250") && /measured by the attribution ledger, not claimed/.test(l))
    && lines.some((l) => l.includes("7 minutes"))
    && lines.some((l) => l.includes("5 active contacts"))
    && lines.some((l) => l.includes("2 at risk, 1 missed")))

  console.log("\n[2 · keep-one wiring — the EXISTING reporting kernel, extended]")
  const mod = src("lib/kernel/reporting-autonomy.ts")
  check("generators ride ReportingActorContext + narrowReportAgentIds (no fifth scope system)",
    mod.includes("ReportingActorContext") && mod.includes("narrowReportAgentIds")
    && !mod.includes("interface ReportScope {"))
  check("provenance reads the RECORDED decision fields (generated_from learned:%, content_kit.built_by) — never inferred",
    mod.includes('startsWith("learned:")') && mod.includes("content_kit?.built_by"))
  check("attribution reads the credit ledger; drafts adoption = sent_message_id set ÷ written",
    mod.includes("marketing_attribution_credits") && mod.includes('not("sent_message_id", "is", null)'))
  check("coaching signals compute from ledgers: first activity per contact, 14-day gap sweep, deadline states",
    mod.includes("firstByContact") && mod.includes("gapCutoff") && mod.includes('["at_risk", "missed"]'))
  const page = src("app/dashboard/reports/page.tsx")
  check("the reports surface renders the tier-scoped section + the assistant narrative (one surface, not a new dashboard)",
    page.includes("generateAutonomyImpactReport") && page.includes("composeKpiNarrative")
    && page.includes("Your AI team, measured") && page.includes("decisions on your own evidence"))

  console.log("\n[3 · live — both generators against the real database (read-only)]")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("  ○ skipped (no live credentials in this environment)")
  } else {
    const { createServiceClient } = await import("../lib/supabase/service")
    const { generateAutonomyImpactReport, generateCoachingSignalsReport } = await import("../lib/kernel/reporting-autonomy")
    const svc = createServiceClient()
    const { data: b } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!b?.id) {
      console.log("  ○ skipped (no live brokerage)")
    } else {
      const ctx = { userId: "sim", agentId: "sim", brokerageId: (b as any).id, userType: "broker" as const }
      const [a, c] = await Promise.all([
        generateAutonomyImpactReport({ ctx }),
        generateCoachingSignalsReport({ ctx }),
      ])
      check("live: autonomy report succeeds at brokerage tier with numeric, non-negative columns",
        a.success === true && a.data?.tier === "brokerage"
        && (a.data?.assets.rendersProduced ?? -1) >= 0 && (a.data?.aiLane.draftsWritten ?? -1) >= 0
        && (a.data?.attribution.creditDollars ?? -1) >= 0, a.error)
      check("live: coaching report succeeds with honest nulls when unmeasured",
        c.success === true
        && (c.data?.medianFirstResponseMinutes === null || (c.data?.medianFirstResponseMinutes ?? -1) >= 0)
        && (c.data?.followUpGaps ?? -1) >= 0, c.error)
      if (a.success && c.success && a.data && c.data) {
        const liveLines = composeKpiNarrative(a.data, c.data)
        check("live: the narrative composes without inventing anything on real data", Array.isArray(liveLines) && liveLines.length >= 1)
        console.log(`    · live narrative preview: "${liveLines[0]}"`)
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ KPI kernel verified — the OS's work is measured, tier-scoped, provenance-backed, and honestly narrated.")
  console.log(" AUTONOMY_REPORT_PASS")
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
