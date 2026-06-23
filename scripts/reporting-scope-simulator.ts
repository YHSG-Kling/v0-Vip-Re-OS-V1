#!/usr/bin/env tsx
/**
 * scripts/reporting-scope-simulator.ts  (npm run test:reporting-scope)
 *
 * Proves the reporting kernel now honors the multi-location / team / agent tiers instead of leaking
 * the whole brokerage to every actor:
 *
 *  - PURE (always): narrowReportAgentIds — brokerage ⇒ no narrowing (null); agent ⇒ own id; a
 *    location/team ⇒ exactly its member agents; an empty scope ⇒ [] (a real empty report, NOT
 *    brokerage-wide).
 *  - LIVE (creds-gated): seed a brokerage + 2 offices + 1 agent each + a transaction per agent, then
 *    run generateTransactionPipelineReport as (a) a LOCATION ADMIN of office A — sees only office A's
 *    pipeline — and (b) a BROKER — sees both offices. Self-cleaning (reverse-delete, count == 0).
 */
import { randomUUID } from "node:crypto"
import { narrowReportAgentIds } from "../lib/kernel/reporting-scope"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log("\n[reporting scope · pure — narrowReportAgentIds]")
  check("brokerage ⇒ null (no agent narrowing — whole brokerage)", narrowReportAgentIds("brokerage", "self", ["x", "y"]) === null)
  const own = narrowReportAgentIds("agent", "self", [])
  check("agent ⇒ own id only", Array.isArray(own) && own.length === 1 && own[0] === "self")
  const loc = narrowReportAgentIds("location", "self", ["a1", "a2"])
  check("location ⇒ its member agents", Array.isArray(loc) && loc.length === 2 && loc.includes("a1") && loc.includes("a2"))
  const team = narrowReportAgentIds("team", "self", ["t1"])
  check("team ⇒ its member agents", Array.isArray(team) && team.length === 1 && team[0] === "t1")
  const emptyLoc = narrowReportAgentIds("location", "self", [])
  check("empty location ⇒ [] (real empty report, NOT brokerage-wide)", Array.isArray(emptyLoc) && emptyLoc.length === 0)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[reporting scope · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the narrowing")
    return
  }
  console.log("\n[reporting scope · live — location admin sees ONE office, broker sees ALL → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { generateTransactionPipelineReport } = await import("../lib/kernel/reporting")
  const svc = createServiceClient()
  const tag = `RPTSCOPE-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const cleanup: Array<() => PromiseLike<unknown>> = []
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} Brokerage`, city: "Austin", state: "TX" })
    cleanup.push(() => svc.from("brokerages").delete().eq("id", brokerageId))

    const { data: ofA } = await svc.from("locations").insert({ brokerage_id: brokerageId, name: `${tag} A`, city: "Austin", state: "TX" }).select("id").single()
    const { data: ofB } = await svc.from("locations").insert({ brokerage_id: brokerageId, name: `${tag} B`, city: "Dallas", state: "TX" }).select("id").single()
    const officeA = ofA!.id as string, officeB = ofB!.id as string
    cleanup.push(() => svc.from("locations").delete().eq("brokerage_id", brokerageId))

    // One agent per office.
    const mkAgent = async (loc: string, label: string) => {
      const uid = randomUUID()
      await svc.from("users").insert({ id: uid, brokerage_id: brokerageId, email: `a-${label}-${tag}@demo.local`, first_name: label, last_name: "Agent", user_type: "agent" })
      cleanup.push(() => svc.from("users").delete().eq("id", uid))
      const { data: ar } = await svc.from("agents").insert({ user_id: uid, brokerage_id: brokerageId, location_id: loc }).select("id").single()
      const aid = ar!.id as string
      cleanup.push(() => svc.from("agents").delete().eq("id", aid))
      return aid
    }
    const agentA = await mkAgent(officeA, "A")
    const agentB = await mkAgent(officeB, "B")

    // A transaction per agent with deterministic pipeline value.
    const mkTxn = async (agentId: string, price: number) => {
      const { data: t } = await svc.from("transactions").insert({
        brokerage_id: brokerageId, agent_id: agentId, status: "active", stage: "active", purchase_price: price, created_at: new Date().toISOString(),
      }).select("id").single()
      const tid = t!.id as string
      cleanup.push(() => svc.from("transactions").delete().eq("id", tid))
    }
    await mkTxn(agentA, 400000)
    await mkTxn(agentB, 600000)

    // (a) LOCATION ADMIN of office A — should see ONLY office A's $400k pipeline.
    const adminCtx = { userId: randomUUID(), agentId: randomUUID(), brokerageId, userType: "admin" as const, locationId: officeA, teamId: null }
    const locReport = await generateTransactionPipelineReport({ ctx: adminCtx })
    const locValue = locReport.success ? locReport.data!.totalPipelineValue : -1
    check("location admin sees ONLY their office ($400k, not $1M)", locValue === 400000)

    // (b) BROKER — no location → sees BOTH offices ($1M).
    const brokerCtx = { userId: randomUUID(), agentId: randomUUID(), brokerageId, userType: "broker" as const, locationId: null, teamId: null }
    const allReport = await generateTransactionPipelineReport({ ctx: brokerCtx })
    const allValue = allReport.success ? allReport.data!.totalPipelineValue : -1
    check("broker sees ALL offices ($1M)", allValue === 1000000)

    // (c) out-of-scope guard: location-A admin cannot pull office-B's agent explicitly.
    const guarded = await generateTransactionPipelineReport({ ctx: adminCtx, agentId: agentB })
    check("location admin blocked from another office's agent", guarded.success === false && (guarded as { error?: string }).error === "agent_out_of_scope")
  } finally {
    for (const del of cleanup.reverse()) { try { await del() } catch { /* best-effort */ } }
    const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("cleanup complete", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ REPORTING_SCOPE_FAIL"); process.exit(1) }
  console.log(" ✅ REPORTING_SCOPE_PASS — reports honor the location / team / agent tiers")
}

main().catch((e) => { console.error(e); process.exit(1) })
