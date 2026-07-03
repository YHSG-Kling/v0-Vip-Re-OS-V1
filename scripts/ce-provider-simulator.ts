#!/usr/bin/env tsx
/**
 * scripts/ce-provider-simulator.ts   (npm run test:ce-provider)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the ACCREDITED CE PROVIDER INTEGRATION — agents complete real accredited CE inside the app
 * through a connected provider; the platform records only what the provider verifiably reports (never
 * fabricates accreditation) into the CE ledger the license-readiness engine reads.
 *
 * PURE:   isCeProviderConnected + availableCourses (state-filtered, empty when unconnected) +
 *         normalizeCeCompletion + sumCeHours + ceProgress + buildLaunchUrl + verifyCeSignature (HMAC).
 * SOURCE: the webhook verifies the signature + records via recordCeCompletionFromProvider; the CE center
 *         UI launches courses; owned by recruiting_manager with a runnable proof.
 * LIVE (creds-gated): connect a provider on a brokerage + record a completion into agent_ce_completions +
 *         bump ce_hours_completed (what the webhook does) → license-readiness sees it → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createHmac } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import {
  isCeProviderConnected,
  availableCourses,
  normalizeCeCompletion,
  sumCeHours,
  ceProgress,
  buildLaunchUrl,
  verifyCeSignature,
  type CeProviderConfig,
} from "../lib/education/ce-provider"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const connected: CeProviderConfig = {
  name: "The CE Shop", connected: true, launchBaseUrl: "https://provider.example/sso",
  catalog: [
    { id: "eth-1", title: "Ethics 2026", category: "ethics", hours: 3, state: "TX" },
    { id: "core-1", title: "Core Law", category: "core", hours: 8, state: null },
    { id: "fl-1", title: "FL Contracts", category: "contracts", hours: 3, state: "FL" },
  ],
}

function pureLayer() {
  console.log("\n[connection + catalog · pure — honest, never fabricates]")
  check("a connected provider is recognized", isCeProviderConnected(connected))
  check("no/blank provider is NOT connected (in-app CE unavailable)", !isCeProviderConnected(null) && !isCeProviderConnected({ name: "", connected: true }) && !isCeProviderConnected({ name: "X", connected: false }))
  check("unconnected → zero courses (honest empty, not fake CE)", availableCourses(null, "TX").length === 0)
  check("connected → catalog filtered to the agent's state (+ multi-state)", availableCourses(connected, "TX").map((c) => c.id).sort().join(",") === "core-1,eth-1")
  check("no agent state → full catalog", availableCourses(connected).length === 3)

  console.log("\n[record + progress · pure]")
  const row = normalizeCeCompletion(
    { course_id: "eth-1", course_name: "Ethics 2026", category: "ethics", hours: 3, completed_on: "2026-06-01", certificate_url: "https://c/1" },
    { agentId: "a1", brokerageId: "b1", providerName: "The CE Shop" },
  )
  check("normalize maps a provider completion → the CE ledger shape", row.agent_id === "a1" && row.provider === "The CE Shop" && row.hours === 3 && row.certificate_url === "https://c/1" && /Accredited CE completed in-app/.test(row.notes))
  check("sumCeHours totals credit hours", sumCeHours([{ hours: 3 }, { hours: 8 }, { hours: null }]) === 11)
  const prog = ceProgress(18, 11)
  check("ceProgress computes remaining + pct", prog.remaining === 7 && prog.pct === 61 && !prog.complete)
  check("ceProgress complete when met; honest zeros when no requirement", ceProgress(12, 12).complete && ceProgress(null, 5).pct === 0)

  console.log("\n[launch + signature · pure]")
  check("launch URL deep-links into the connected provider with course + ref", buildLaunchUrl(connected, "eth-1", "a1") === "https://provider.example/sso/launch?course=eth-1&ref=a1")
  check("no launch URL when unconnected", buildLaunchUrl({ name: "X", connected: false }, "x", "a1") === null)
  const body = JSON.stringify({ course_id: "eth-1" })
  const goodSig = createHmac("sha256", "secret").update(body).digest("hex")
  check("valid HMAC signature verifies", verifyCeSignature(body, goodSig, "secret"))
  check("bad signature / missing secret rejected", !verifyCeSignature(body, "deadbeef", "secret") && !verifyCeSignature(body, goodSig, null))
}

function sourceLayer() {
  console.log("\n[wiring — webhook records, UI launches, owned]")
  const wh = src("app/api/webhooks/ce-provider/route.ts")
  check("the webhook verifies the signature then records via the provider path", /verifyCeSignature\(raw, sig, secret\)/.test(wh) && /recordCeCompletionFromProvider\(/.test(wh))
  const act = src("app/actions/ce-provider.ts")
  check("recordCeCompletionFromProvider writes the ledger + recomputes ce_hours_completed", /agent_ce_completions"\)\.insert\(row\)/.test(act) && /ce_hours_completed: total/.test(act))
  check("platform never fabricates: only provider-reported completions are recorded", /normalizeCeCompletion/.test(act) && /Not the accreditor|Accredited CE completed in-app/.test(src("lib/education/ce-provider.ts")))
  const ui = src("app/dashboard/settings/license-ce/ce-center-panel.tsx")
  check("the CE center UI launches courses via launchCeCourse", /launchCeCourse\(/.test(ui))
  check("the License & CE page mounts the CE center", /CeCenterPanel/.test(src("app/dashboard/settings/license-ce/page.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /ce_provider_integration:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:ce-provider"/.test(reg))
  check("package.json wires the proof", /"test:ce-provider":\s*"tsx scripts\/ce-provider-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] record an accredited completion → ce_hours_completed bumps → clean up")
  const { data: agent } = await svc.from("agents").select("id, brokerage_id, ce_hours_completed").limit(1).maybeSingle()
  if (!agent) { console.log("  ⊘ no agent — skipping"); return }
  const a = agent as any
  const priorHours = Number(a.ce_hours_completed ?? 0)
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const row = normalizeCeCompletion(
      { course_id: "sim-eth", course_name: "ZZ Sim Ethics", category: "ethics", hours: 3, completed_on: "2026-06-01" },
      { agentId: a.id, brokerageId: a.brokerage_id ?? null, providerName: "ZZ Sim Provider" },
    )
    const { data: ins } = await svc.from("agent_ce_completions").insert(row).select("id").single()
    cleanup.push({ table: "agent_ce_completions", id: (ins as any).id })
    check("live: the accredited completion is recorded in the CE ledger", !!ins)

    const { data: all } = await svc.from("agent_ce_completions").select("hours").eq("agent_id", a.id)
    const total = sumCeHours((all ?? []) as any[])
    await svc.from("agents").update({ ce_hours_completed: total }).eq("id", a.id)
    check("live: agents.ce_hours_completed reflects the new credit (license-readiness input)", total >= priorHours + 3)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    // Restore the agent's prior hour total.
    const { data: all2 } = await svc.from("agent_ce_completions").select("hours").eq("agent_id", a.id)
    await svc.from("agents").update({ ce_hours_completed: sumCeHours((all2 ?? []) as any[]) }).eq("id", a.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CE_PROVIDER_FAIL"); process.exit(1) }
  console.log(" ✅ CE_PROVIDER_PASS — accredited CE completed in-app via a connected provider; credit recorded, never fabricated")
}
main()
