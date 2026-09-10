#!/usr/bin/env tsx
/**
 * scripts/stale-listing-sphere-sweep-simulator.ts (npm run test:stale-listing-sphere-sweep — see report)
 *
 * PURE branch coverage for lib/transactions/stale-listing-sphere-sweep.ts, the
 * safety net for a CLOSED listing whose linked transaction never reaches its
 * own terminal stage (carried note, lane FB, wave 47 → wave 48; see that
 * file's header for the full account of the two existing "deal_closed"
 * producers and the gap between them). No DB — every table is a fake client
 * over canned fixtures, exercising each branch the sweep can take.
 */
import { sweepStaleClosedListingSphereHandoffs } from "../lib/transactions/stale-listing-sphere-sweep"

type Fixture = { data: unknown[] | null; error: { message: string } | null }

function fakeSvc(fx: { listings: Fixture; transactions: Fixture; manager_signals: Fixture; inserted?: unknown[] }) {
  const inserted = fx.inserted ?? []
  return {
    from(table: string) {
      if (table === "listings") {
        const f = fx.listings
        const thenable: any = {
          eq() { return thenable },
          not() { return thenable },
          then(res: (v: any) => unknown) { return Promise.resolve({ data: f.data, error: f.error }).then(res) },
        }
        return { select: () => thenable }
      }
      if (table === "transactions") {
        const f = fx.transactions
        const thenable: any = {
          in() { return thenable },
          then(res: (v: any) => unknown) { return Promise.resolve({ data: f.data, error: f.error }).then(res) },
        }
        return { select: () => thenable }
      }
      if (table === "manager_signals") {
        const f = fx.manager_signals
        const thenable: any = {
          eq() { return thenable },
          in() { return thenable },
          limit() { return thenable },
          maybeSingle: async () => ({ data: Array.isArray(f.data) ? (f.data[0] ?? null) : f.data, error: f.error }),
        }
        return {
          select: () => thenable,
          insert(row: unknown) {
            inserted.push(row)
            return {
              select: () => ({
                single: async () => (f.error ? { data: null, error: f.error } : { data: { id: "sig-new" }, error: null }),
              }),
            }
          },
        }
      }
      throw new Error(`fakeSvc: unexpected table "${table}"`)
    },
  } as any
}

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}`) }
}

const CLOSED_LISTING = { id: "listing-1", brokerage_id: "b1", seller_contact_id: "contact-1", address: "1 Main St", city: "Springfield", state: "IL" }
const EMPTY = { data: [], error: null } as Fixture
const NO_EXISTING_SIGNAL = { data: null, error: null } as Fixture

async function main() {
  console.log("\n[1 · no linked transaction — producer 1's own gap (a refused lookup at close time)]")
  {
    const svc = fakeSvc({
      listings: { data: [CLOSED_LISTING], error: null },
      transactions: EMPTY,
      manager_signals: NO_EXISTING_SIGNAL,
    })
    const r = await sweepStaleClosedListingSphereHandoffs(svc)
    check("published (no transaction linked, nothing signaled yet)", r.published === 1)
    check("scanned counts the one listing", r.scanned === 1)
    check("no errors", r.errors === 0)
  }

  console.log("\n[2 · linked transaction stuck at a non-terminal status — the primary gap]")
  {
    const svc = fakeSvc({
      listings: { data: [CLOSED_LISTING], error: null },
      transactions: { data: [{ id: "txn-1", listing_id: "listing-1", brokerage_id: "b1", status: "pending" }], error: null },
      manager_signals: NO_EXISTING_SIGNAL,
    })
    const r = await sweepStaleClosedListingSphereHandoffs(svc)
    check("published (transaction linked but never reached a terminal status)", r.published === 1)
  }

  console.log("\n[3 · linked transaction already TERMINAL — producer 2 owns it, sweep steps aside]")
  {
    const svc = fakeSvc({
      listings: { data: [CLOSED_LISTING], error: null },
      transactions: { data: [{ id: "txn-1", listing_id: "listing-1", brokerage_id: "b1", status: "closed" }], error: null },
      manager_signals: NO_EXISTING_SIGNAL,
    })
    const r = await sweepStaleClosedListingSphereHandoffs(svc)
    check("handledByTransaction, NOT published — producer 2's own dedupe owns this one", r.handledByTransaction === 1 && r.published === 0)
  }
  {
    const svc = fakeSvc({
      listings: { data: [CLOSED_LISTING], error: null },
      transactions: { data: [{ id: "txn-1", listing_id: "listing-1", brokerage_id: "b1", status: "funded" }], error: null },
      manager_signals: NO_EXISTING_SIGNAL,
    })
    const r = await sweepStaleClosedListingSphereHandoffs(svc)
    check("`funded` also counts as terminal (TRANSACTION_STATUSES_TERMINAL, not a hand-typed list)", r.handledByTransaction === 1)
  }

  console.log("\n[4 · a deal_closed signal already exists for this deal — never a double welcome]")
  {
    const svc = fakeSvc({
      listings: { data: [CLOSED_LISTING], error: null },
      transactions: { data: [{ id: "txn-1", listing_id: "listing-1", brokerage_id: "b1", status: "pending" }], error: null },
      manager_signals: { data: [{ id: "sig-existing" }], error: null },
    })
    const r = await sweepStaleClosedListingSphereHandoffs(svc)
    check("alreadySignaled, NOT re-published", r.alreadySignaled === 1 && r.published === 0)
  }

  console.log("\n[5 · fail-closed on a refused read — never treated as \"nothing to do\"]")
  {
    const svc = fakeSvc({
      listings: { data: null, error: { message: "refused" } },
      transactions: EMPTY,
      manager_signals: NO_EXISTING_SIGNAL,
    })
    const r = await sweepStaleClosedListingSphereHandoffs(svc)
    check("a refused listings read counts as an error, not a clean zero", r.errors === 1 && r.published === 0 && r.scanned === 0)
  }

  console.log("\n[6 · a listing with no seller contact is not scanned at all]")
  {
    const svc = fakeSvc({
      listings: EMPTY, // .not("seller_contact_id", "is", null) — the fake honors the fixture, not the filter itself; this models the filtered-out case directly
      transactions: EMPTY,
      manager_signals: NO_EXISTING_SIGNAL,
    })
    const r = await sweepStaleClosedListingSphereHandoffs(svc)
    check("nothing scanned, nothing published", r.scanned === 0 && r.published === 0)
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log(" ❌ STALE_LISTING_SPHERE_SWEEP_FAIL")
    process.exit(1)
  }
  console.log(" ✅ STALE_LISTING_SPHERE_SWEEP_PASS")
}

main()
