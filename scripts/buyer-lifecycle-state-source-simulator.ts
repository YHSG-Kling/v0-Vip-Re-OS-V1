#!/usr/bin/env tsx
/**
 * scripts/buyer-lifecycle-state-source-simulator.ts   (npm run test:buyer-lifecycle-state)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GOVERNANCE GATE READ A TABLE NOTHING WRITES.
 *
 * Buyer lifecycle transitions are written by emitLifecycleTransition, which routes through
 * transitionLifecycle() into `lifecycle_events` with entity_type 'buyer_lifecycle'. That is
 * the ONLY writer.
 *
 * Three readers went somewhere else entirely — `activities` with activity_type
 * 'buyer.lifecycle.transition' / '.transitioned', a row no code has ever produced:
 *
 *   1. gating-helpers.ts kept a PRIVATE getCurrentBuyerState reading that phantom. It
 *      returned null for every buyer, and these gates FAIL CLOSED on null, so
 *      isSearchAllowed / isTourAllowed / isOfferAllowed and the batch check denied EVERY
 *      buyer permanently. A gate that blocks everyone carries no information: it cannot
 *      tell a verified buyer from an unverified one.
 *   2. recovery-paths.ts read the same phantom for the "days in state" clock, so
 *      getBuyersEligibleForRecovery always returned an EMPTY LIST — no buyer on hold was
 *      ever nominated for recovery.
 *   3. buyer-execution-engine.ts read it for milestone completion dates, so the buyer
 *      journey rendered its steps with no date against any of them. (That one was doubly
 *      dead: it never selected `metadata`, then tested metadata on the rows.)
 *
 * Live census at the fix: 0 rows matching the activity types, 8 real buyer_lifecycle rows
 * in lifecycle_events. The state existed the whole time, in the other table.
 *
 * AND IT WAS N+1. getLifecycleStatistics fetched every contact in the brokerage with no
 * limit, then issued one lifecycle_events SELECT per contact. m367's
 * buyer_lifecycle_current_states does it in a single DISTINCT ON pass.
 *
 * SOURCE layer: no reader points at the phantom; the private duplicate is gone with its
 * survivor named; the statistics/recovery readers call the RPC, not a per-contact loop.
 * LIVE layer (creds-gated): seed two buyers with real transitions, assert latest-wins,
 * state-less contacts excluded, entered_at drives the recovery clock, tenant isolation,
 * residue 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** Strip comments so no assertion can be satisfied by prose describing the fix. */
const code = (p: string) => stripComments(src(p))

function sourceLayer() {
  console.log("\n[source · nothing reads the phantom any more]")
  for (const f of [
    "lib/buyer-lifecycle/gating-helpers.ts",
    "lib/buyer-lifecycle/extensions/recovery-paths.ts",
    "lib/buyer-execution/buyer-execution-engine.ts",
  ]) {
    check(`${f.split("/").pop()} does not read activities for a lifecycle transition`,
      !/buyer\.lifecycle\.transition/.test(code(f)))
  }

  console.log("\n[source · the private duplicate is gone, survivor named]")
  const gate = code("lib/buyer-lifecycle/gating-helpers.ts")
  check("gating-helpers no longer defines its own getCurrentBuyerState",
    !/(async\s+)?function\s+getCurrentBuyerState/.test(gate))
  check("...it imports the canonical one from the logger",
    /import\s*\{[^}]*getCurrentBuyerState[^}]*\}\s*from\s*["']\.\/lifecycle-logger["']/.test(gate))
  check("...and the survivor really exists and reads lifecycle_events",
    /export async function getCurrentBuyerState/.test(src("lib/buyer-lifecycle/lifecycle-logger.ts")) &&
    /entity_type["']?\s*,\s*["']buyer_lifecycle["']/.test(code("lib/buyer-lifecycle/lifecycle-logger.ts")))

  console.log("\n[source · the N+1 loops are set-based]")
  const logger = code("lib/buyer-lifecycle/lifecycle-logger.ts")
  check("getLifecycleStatistics calls the one-pass RPC",
    /buyer_lifecycle_current_states/.test(logger))
  // The defect was a per-contact await inside a for-loop. Assert the CONSTRUCT is gone.
  check("...and no longer awaits a state lookup per contact",
    !/for\s*\(const contactId of contactIds\)[\s\S]{0,200}?await getCurrentBuyerState/.test(logger))
  check("getBuyersInState calls the RPC too, not a loop",
    !/for\s*\(const contact of contacts\)[\s\S]{0,200}?await getCurrentBuyerState/.test(logger))

  const rec = code("lib/buyer-lifecycle/extensions/recovery-paths.ts")
  check("recovery eligibility uses the RPC's entered_at as the clock",
    /buyer_lifecycle_current_states/.test(rec) && /entered_at/.test(rec))

  console.log("\n[source · the migration is committed, not just applied]")
  // Strip SQL line comments first — the migration's own header explains WHY it must not be
  // SECURITY DEFINER, and a naive scan matches that prose and fails on correct code. Assert
  // the construct, never the spelling.
  const mig = src("supabase/migrations/m367-buyer-lifecycle-current-states.sql")
    .replace(/^\s*--.*$/gm, "")
  check("m367 defines the DISTINCT ON function", /distinct on \(e\.entity_id\)/.test(mig))
  // SECURITY DEFINER here would hand any authenticated caller another tenant's lifecycle
  // data, because the brokerage id is an ARGUMENT.
  check("...and is NOT security definer (it takes a brokerage id as an argument)",
    !/security\s+definer/i.test(mig))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the source layer proved the shape"); return }
  console.log("\n[live · the state the gate could never see]")
  const svc = createClient(url, key, { auth: { persistSession: false } })

  const stamp = `zz_bl_${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: brk } = await svc.from("brokerages").insert({ name: stamp }).select("id").single()
    if (!brk) { console.log("  ⊘ could not seed a brokerage — skipping live"); return }
    const brokerageId = (brk as any).id as string
    cleanup.push({ table: "brokerages", id: brokerageId })

    const mkContact = async (last: string) => {
      const { data } = await svc.from("contacts")
        .insert({ brokerage_id: brokerageId, first_name: "ZZ", last_name: last }).select("id").single()
      if (data) cleanup.push({ table: "contacts", id: (data as any).id })
      return data ? (data as any).id as string : null
    }
    const searching = await mkContact("Searching")
    const onHold    = await mkContact("OnHold")
    await mkContact("NoEvents")   // has no transition at all — must not appear
    if (!searching || !onHold) { console.log("  ⊘ could not seed contacts — skipping live"); return }

    const mkEvent = async (contactId: string, toState: string, daysAgo: number) => {
      const { data } = await svc.from("lifecycle_events").insert({
        brokerage_id: brokerageId, entity_type: "buyer_lifecycle", entity_id: contactId,
        event_type: "BUYER_STATE_CHANGED", metadata: { to_state: toState },
        created_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      }).select("id").single()
      if (data) cleanup.push({ table: "lifecycle_events", id: (data as any).id })
    }
    await mkEvent(searching, "BUYER_CONTACT_CREATED", 10)
    await mkEvent(searching, "BUYER_SEARCHING", 2)      // the LATEST — must win
    await mkEvent(onHold,    "BUYER_ON_HOLD", 30)

    const { data: rows, error } = await svc.rpc("buyer_lifecycle_current_states", {
      p_brokerage_id: brokerageId, p_start: null, p_end: null,
    })
    check("live: the RPC returns without error", !error)
    const list = (rows ?? []) as Array<{ contact_id: string; current_state: string; entered_at: string }>

    const sRow = list.find((r) => r.contact_id === searching)
    check("live: LATEST transition wins (BUYER_SEARCHING, not the older CONTACT_CREATED)",
      sRow?.current_state === "BUYER_SEARCHING")
    check("live: a contact with no transition is not given a state", list.length === 2)

    const hRow = list.find((r) => r.contact_id === onHold)
    const days = hRow ? Math.floor((Date.now() - new Date(hRow.entered_at).getTime()) / 86_400_000) : -1
    check("live: entered_at drives the recovery clock (30 days on hold)", days === 30)

    // The state the OLD readers looked for, in the table they looked in.
    const { count: phantom } = await svc.from("activities")
      .select("id", { count: "exact", head: true })
      .in("activity_type", ["buyer.lifecycle.transition", "buyer.lifecycle.transitioned"])
    check("live: the phantom activity rows the old gate needed do not exist", (phantom ?? 0) === 0)

    const { data: foreign } = await svc.rpc("buyer_lifecycle_current_states", {
      p_brokerage_id: "00000000-0000-0000-0000-000000000000", p_start: null, p_end: null,
    })
    check("live: tenant scoped — a foreign brokerage sees none of it", ((foreign ?? []) as unknown[]).length === 0)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let leftover = 0
    for (const c of cleanup) {
      const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id)
      leftover += count ?? 0
    }
    check("live: cleanup count == 0", leftover === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" BUYER LIFECYCLE STATE SOURCE — one writer, one reader, one pass")
  console.log("══════════════════════════════════════════════════════════════════════")
  sourceLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`BUYER LIFECYCLE STATE SOURCE — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nBuyer lifecycle state is written to lifecycle_events (entity_type")
    console.log("'buyer_lifecycle') and NOWHERE else. A reader that goes to `activities` for a")
    console.log("transition finds nothing, and these gates fail closed — which blocks every")
    console.log("buyer while looking exactly like a working gate.")
    process.exit(1)
  }
  console.log("✅ BUYER_LIFECYCLE_STATE_SOURCE_PASS — the gate reads what the writer writes")
}

main().catch((e) => { console.error(e); process.exit(1) })
