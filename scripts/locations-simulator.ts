#!/usr/bin/env tsx
/**
 * scripts/locations-simulator.ts  (npm run test:locations)
 *
 * Proves the multi-location (office) vertical: create offices, place agents in
 * them, reassign, and delete-with-unassign. Mirrors the createLocationAction /
 * assignAgentToLocationAction / deleteLocationAction DB contract against the LIVE
 * schema (agents.location_id FK → locations), fully self-cleaning.
 *
 *  - PURE (always): agent→office count rollups + unassigned accounting.
 *  - LIVE (creds-gated): seed a brokerage + 2 offices + 1 agent, assign → reassign
 *    → delete-the-office (agent falls back to Unassigned), asserting counts at each
 *    step, then delete all tagged rows.
 *
 * Live run:  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/locations-simulator.ts
 */
import { randomUUID } from "node:crypto"

/** PURE: roll agents up by location, counting nulls as Unassigned. */
function rollup(agents: Array<{ location_id: string | null }>): { byLoc: Record<string, number>; unassigned: number } {
  const byLoc: Record<string, number> = {}
  let unassigned = 0
  for (const a of agents) {
    if (a.location_id) byLoc[a.location_id] = (byLoc[a.location_id] ?? 0) + 1
    else unassigned += 1
  }
  return { byLoc, unassigned }
}

function selfTest(): void {
  let pass = 0, fail = 0
  const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

  console.log("\n[locations · pure]")
  const r = rollup([{ location_id: "A" }, { location_id: "A" }, { location_id: "B" }, { location_id: null }])
  check("agents roll up to their office", r.byLoc.A === 2 && r.byLoc.B === 1)
  check("null location counts as Unassigned", r.unassigned === 1)
  const empty = rollup([])
  check("no agents → empty rollup, zero unassigned", Object.keys(empty.byLoc).length === 0 && empty.unassigned === 0)

  if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
  console.log(` RESULT: ${pass} passed, 0 failed`)
}

async function main(): Promise<void> {
  selfTest()

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[live run] ⏭  Skipped — SUPABASE creds not set (or DB unreachable).")
    console.log("\n✅ LOCATIONS pure layer passed; live run is creds-gated.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const tag = `LOC-${Date.now()}`
  const brokerageId = randomUUID()
  const userId = randomUUID()
  const cleanup: Array<() => PromiseLike<unknown>> = []
  let agentRowId: string | null = null
  let officeA: string | null = null
  let ok = true
  const check = (n: string, c: boolean) => { if (!c) ok = false; console.log(`  ${c ? "✓" : "✗"} ${n}`) }

  console.log(`\n[live run] tag=${tag}`)
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} Brokerage`, city: "Austin", state: "TX" })
    cleanup.push(() => svc.from("brokerages").delete().eq("id", brokerageId))
    await svc.from("users").insert({ id: userId, brokerage_id: brokerageId, email: `agent+${tag}@demo.local`, first_name: "Demo", last_name: "Agent", user_type: "agent" })
    cleanup.push(() => svc.from("users").delete().eq("id", userId))
    const { data: agentRow } = await svc.from("agents").insert({ user_id: userId, brokerage_id: brokerageId }).select("id").single()
    agentRowId = (agentRow?.id as string) ?? null
    if (agentRowId) cleanup.push(() => svc.from("agents").delete().eq("id", agentRowId as string))

    const { data: a } = await svc.from("locations").insert({ brokerage_id: brokerageId, name: `${tag} Downtown`, city: "Austin", state: "TX" }).select("id").single()
    const { data: b } = await svc.from("locations").insert({ brokerage_id: brokerageId, name: `${tag} North`, city: "Round Rock", state: "TX" }).select("id").single()
    officeA = (a?.id as string) ?? null
    const officeB = (b?.id as string) ?? null
    cleanup.push(() => svc.from("locations").delete().eq("brokerage_id", brokerageId))
    check("two offices created", !!officeA && !!officeB)

    // assign → office A
    await svc.from("agents").update({ location_id: officeA }).eq("id", agentRowId as string).eq("brokerage_id", brokerageId)
    let { data: cur } = await svc.from("agents").select("location_id").eq("id", agentRowId as string).single()
    check("agent assigned to office A", cur?.location_id === officeA)

    // reassign → office B
    await svc.from("agents").update({ location_id: officeB }).eq("id", agentRowId as string).eq("brokerage_id", brokerageId)
    ;({ data: cur } = await svc.from("agents").select("location_id").eq("id", agentRowId as string).single())
    check("agent reassigned to office B", cur?.location_id === officeB)

    // delete office B → agent falls back to Unassigned (unassign-then-delete, as the action does)
    await svc.from("agents").update({ location_id: null }).eq("location_id", officeB).eq("brokerage_id", brokerageId)
    await svc.from("locations").delete().eq("id", officeB).eq("brokerage_id", brokerageId)
    ;({ data: cur } = await svc.from("agents").select("location_id").eq("id", agentRowId as string).single())
    check("deleting the office moves the agent to Unassigned (no dangling FK)", cur?.location_id === null)
    const { count: remaining } = await svc.from("locations").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("one office remains", (remaining ?? 0) === 1)

    if (!ok) throw new Error("one or more live assertions failed")
    console.log("\n✅ LOCATIONS — office CRUD + agent assignment ran end-to-end on the live DB.")
  } finally {
    for (const del of cleanup.reverse()) { try { await del() } catch { /* best-effort */ } }
    console.log(`  ✓ cleaned up all rows tagged ${tag}`)
  }
  if (!ok) process.exit(1)
}

main().catch((e) => { console.error("locations-simulator failed:", e); process.exit(1) })
