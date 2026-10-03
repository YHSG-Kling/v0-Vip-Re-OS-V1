#!/usr/bin/env tsx
/**
 * scripts/identity-orphan-sweep-simulator.ts   (npm run test:identity-orphan-sweep)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the BATCH identity-orphan reconciliation is actually wired end to end.
 *
 * SOURCE: hidden-wire census (d) wave 57 found public.reconcile_orphaned_users()
 *         (m266) defined in a migration with ZERO callers anywhere in app/, lib/
 *         or scripts/ — the per-request path (lib/kernel/users.ts::mergeOrphan)
 *         only catches a collision it happens to see at invite time; a
 *         historical orphan never crosses that path. BUILT: lib/identity/
 *         orphan-reconciliation.ts::reconcileOrphanedIdentities calls the RPC,
 *         destructures { data, error } and separates a REFUSAL from a clean
 *         "found nothing"; app/api/cron/identity-orphan-sweep/route.ts is the
 *         autonomous caller, registered in CRON_REGISTRY + CRON_MANAGER.
 *
 * PURE LAYER (no creds needed): a fake service client with an injectable
 * .rpc() response proves refused / empty / reconciled are told apart.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { reconcileOrphanedIdentities } from "../lib/identity/orphan-reconciliation"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function fakeClient(response: { data: any; error: any }) {
  return { rpc: async (_name: string) => response } as any
}

async function pureLayer() {
  console.log("\n[pure — refused vs empty vs reconciled are told apart]")

  const refused = await reconcileOrphanedIdentities(fakeClient({ data: null, error: { message: "permission denied" } }))
  check("a refused RPC call is reported as refused, not as reconciled:0", refused.outcome === "refused" && refused.error === "permission denied")

  const empty = await reconcileOrphanedIdentities(fakeClient({ data: { reconciled: 0, detail: [] }, error: null }))
  check("a clean 'found nothing' reports reconciled:0 with outcome=reconciled", empty.outcome === "reconciled" && empty.outcome === "reconciled" && (empty as any).reconciled === 0)

  const found = await reconcileOrphanedIdentities(fakeClient({
    data: { reconciled: 2, detail: [{ email: "a@x.com", from: "id1", to: "id2", children_moved: 3 }] },
    error: null,
  }))
  check("a real reconciliation carries the count + per-email detail through", found.outcome === "reconciled" && (found as any).reconciled === 2 && (found as any).detail[0].children_moved === 3)
}

function sourceLayer() {
  console.log("\n[source — the migration RPC, the caller, the cron, and governance]")

  const mig = src("supabase/migrations/m266-reconcile-user-identity.sql")
  check("m266 defines the batch RPC this wires", /function public\.reconcile_orphaned_users/.test(mig))

  const lib = src("lib/identity/orphan-reconciliation.ts")
  check("the lib caller invokes the RPC by name and reads { data, error }", /\.rpc\(\s*["']reconcile_orphaned_users["']\s*\)/.test(lib) && /const\s*\{\s*data,\s*error\s*\}/.test(lib))

  const route = src("app/api/cron/identity-orphan-sweep/route.ts")
  check("the cron route calls the lib caller (not a second implementation)", /reconcileOrphanedIdentities\(/.test(route))
  check("the route verifies cron auth before doing anything", /verifyCronAuth\(req\)/.test(route))
  check("a refusal is recorded as a cron FAILURE, not swallowed", /outcome === "refused"[\s\S]{0,200}recordCronFailureAction/.test(route))

  const dispatch = src("lib/kernel/cron-dispatch.ts")
  check("the route is registered in CRON_REGISTRY", /\{\s*path:\s*"\/api\/cron\/identity-orphan-sweep"/.test(dispatch))

  const reg = src("lib/kernel/manager-registry.ts")
  check("CRON_MANAGER assigns the sweep to data_steward (owns tenancy/identity, CLAUDE.md §4)", /"\/api\/cron\/identity-orphan-sweep":\s*"data_steward"/.test(reg))

  check("package.json wires this proof", /"test:identity-orphan-sweep":\s*"tsx scripts\/identity-orphan-sweep-simulator\.ts"/.test(src("package.json")))
}

async function main() {
  await pureLayer()
  sourceLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ IDENTITY_ORPHAN_SWEEP_FAIL"); process.exit(1) }
  console.log(" ✅ IDENTITY_ORPHAN_SWEEP_PASS — the batch identity-orphan RPC (m266) now has a real, autonomous, refusal-honest caller")
}
main()
