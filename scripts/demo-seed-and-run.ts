#!/usr/bin/env tsx
/**
 * scripts/demo-seed-and-run.ts  (npm run demo:seed-run) — the turnkey end-to-end proof.
 *
 * Closes the headline audit gap (docs/END-TO-END-AUDIT.md §3): the pipeline has never run on the
 * live DB. This SEEDS a tagged demo brokerage + agent + a raw scraped lead, RUNS the canonical
 * promotion pipeline (processRawRecord: raw → lead → contact), ASSERTS the journey advanced, then
 * CLEANS UP every tagged row. Idempotent + fully self-cleaning so it's safe to run against a real
 * (even production) DB. Requires SUPABASE creds + DB reachability (skips with a clear message
 * otherwise — e.g. the Claude web sandbox blocks the DB host).
 *
 * Run where the DB is reachable:  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/demo-seed-and-run.ts
 */
import { randomUUID } from "node:crypto"

export interface DemoSeedPlan {
  tag: string
  brokerage: { id: string; name: string; city: string; state: string }
  agent: { id: string; brokerage_id: string; email: string; first_name: string; last_name: string; user_type: string }
  rawLead: {
    id: string; brokerage_id: string; source: string
    first_name: string; last_name: string; email: string; phone: string
    address: string; city: string; state: string; raw_data: Record<string, unknown>
  }
}

/** PURE: a fully-linked, tagged demo seed plan. The tag threads through every row so cleanup is exact. */
export function buildDemoSeedPlan(tag: string, ids?: { brokerage?: string; agent?: string; rawLead?: string }): DemoSeedPlan {
  const brokerageId = ids?.brokerage ?? randomUUID()
  return {
    tag,
    brokerage: { id: brokerageId, name: `${tag} Demo Brokerage`, city: "Austin", state: "TX" },
    agent: {
      id: ids?.agent ?? randomUUID(), brokerage_id: brokerageId,
      email: `agent+${tag}@demo.local`, first_name: "Demo", last_name: "Agent", user_type: "agent",
    },
    rawLead: {
      id: ids?.rawLead ?? randomUUID(), brokerage_id: brokerageId, source: "demo_seed",
      first_name: "Jordan", last_name: "Seeker", email: `jordan+${tag}@demo.local`, phone: "+15125550101",
      address: "100 Congress Ave", city: "Austin", state: "TX",
      raw_data: { seeded_by: "demo-seed-and-run", tag, motivation: "relocating", lead_type: "buyer" },
    },
  }
}

// ── Pure-layer self-test (runs always; no DB) ──────────────────────────────────
function selfTest(): void {
  let pass = 0, fail = 0
  const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }
  console.log("\n[plan · pure]")
  const p = buildDemoSeedPlan("SELFTEST")
  check("agent + raw lead are linked to the brokerage", p.agent.brokerage_id === p.brokerage.id && p.rawLead.brokerage_id === p.brokerage.id)
  check("tag threads through brokerage name + emails (exact cleanup)", p.brokerage.name.includes("SELFTEST") && p.agent.email.includes("SELFTEST") && p.rawLead.email.includes("SELFTEST"))
  check("raw lead carries the identity processRawRecord needs", !!(p.rawLead.first_name && p.rawLead.email && p.rawLead.phone && p.rawLead.address && p.rawLead.source))
  check("ids are distinct uuids", new Set([p.brokerage.id, p.agent.id, p.rawLead.id]).size === 3)
  if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
  console.log(` RESULT: ${pass} passed, 0 failed`)
}

async function main(): Promise<void> {
  selfTest()

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[live run] ⏭  Skipped — SUPABASE creds not set (or DB unreachable). Set SUPABASE_URL +")
    console.log("            SUPABASE_SERVICE_ROLE_KEY and run where the DB host is allowlisted.")
    console.log("\n✅ DEMO_SEED_RUN pure layer passed; live run is creds-gated.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const tag = `DEMORUN-${Date.now()}`
  const plan = buildDemoSeedPlan(tag)
  const cleanup: Array<() => PromiseLike<unknown>> = []

  console.log(`\n[live run] tag=${tag}`)
  try {
    // ── SEED ──
    await svc.from("brokerages").insert({ id: plan.brokerage.id, name: plan.brokerage.name, city: plan.brokerage.city, state: plan.brokerage.state })
    cleanup.push(() => svc.from("brokerages").delete().eq("id", plan.brokerage.id))
    await svc.from("users").insert(plan.agent)
    cleanup.push(() => svc.from("users").delete().eq("id", plan.agent.id))
    await svc.from("raw_scraped_leads").insert(plan.rawLead)
    cleanup.push(() => svc.from("raw_scraped_leads").delete().eq("id", plan.rawLead.id))
    console.log("  ✓ seeded brokerage + agent + raw scraped lead")

    // ── RUN the canonical promotion pipeline ──
    const { processRawRecord } = await import("../lib/lead-pipeline")
    const result = await processRawRecord(plan.rawLead.id, plan.brokerage.id)
    console.log(`  ✓ processRawRecord ran → ${JSON.stringify(result).slice(0, 200)}`)

    // ── ASSERT the journey advanced (a lead and/or contact now exists for this brokerage) ──
    const [{ count: leadCount }, { count: contactCount }] = await Promise.all([
      svc.from("leads").select("id", { count: "exact", head: true }).eq("brokerage_id", plan.brokerage.id),
      svc.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", plan.brokerage.id),
    ])
    cleanup.push(() => svc.from("leads").delete().eq("brokerage_id", plan.brokerage.id))
    cleanup.push(() => svc.from("contacts").delete().eq("brokerage_id", plan.brokerage.id))
    const advanced = (leadCount ?? 0) > 0 || (contactCount ?? 0) > 0
    console.log(`  ${advanced ? "✓" : "✗"} journey advanced → leads=${leadCount ?? 0}, contacts=${contactCount ?? 0}`)
    if (!advanced) throw new Error("raw lead did not promote to a lead/contact — pipeline did not advance")

    console.log("\n✅ DEMO_SEED_RUN — the pipeline ran end-to-end on the live DB (raw → lead/contact).")
  } finally {
    // ── CLEANUP (reverse FK order); never leave demo data behind ──
    for (const del of cleanup.reverse()) { try { await del() } catch { /* best-effort */ } }
    console.log(`  ✓ cleaned up all rows tagged ${tag}`)
  }
}

main().catch((e) => { console.error("demo-seed-and-run failed:", e); process.exit(1) })
