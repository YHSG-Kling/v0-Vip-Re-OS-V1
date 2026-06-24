#!/usr/bin/env tsx
/**
 * scripts/portal-milestone-visibility-simulator.ts   (npm run test:portal-milestone-visibility)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the KERNEL is the decision-maker for which transaction milestones a CLIENT
 * sees on their journey portal — and that the decision is keyed on the STABLE
 * canonical milestone_type, NOT the free-text milestone_name.
 *
 * The architecture (agreed): reporting/supporting the portal on free-text milestone
 * names across thousands of subscription tiers is unmanageable, so portal visibility,
 * completions, and reporting all key off the SAME small canonical vocabulary
 * (MILESTONE_NAMES). lib/kernel/portal.ts owns the rule; the journey page calls it.
 *
 * Layer 1 (pure, no I/O) — isClientVisibleMilestone / selectClientMilestones:
 *   - a canonical client-visible milestone_type SHOWS even when the stale
 *     is_client_visible flag says false (the kernel decision supersedes the flag).
 *   - a canonical INTERNAL milestone_type (not in CLIENT_VISIBLE) HIDES even when the
 *     flag says true.
 *   - an un-backfilled row (milestone_type null / coarse category) falls back to the
 *     per-row is_client_visible flag, so live data renders unchanged during migration.
 *   - agent overrides hide — keyed by canonical milestone_type first, name as fallback.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY) — getPortalJourneyMilestones:
 *   - seed a real brokerage/contact/transaction with a spread of milestone rows,
 *     read back through the kernel, assert exactly the kernel-visible set surfaces,
 *     assert a portal-preferences override hides one, then reverse-delete; cleanup==0.
 */
import { randomUUID } from "node:crypto"

// portal.ts transitively pulls modules that may `import "server-only"` (throws under
// tsx). Neutralize that guard in the require cache BEFORE the lazy import below. This
// shims an external guard module ONLY; the kernel rule under test runs for real.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }

type PortalModule = typeof import("../lib/kernel/portal")
let isClientVisibleMilestone: PortalModule["isClientVisibleMilestone"]
let selectClientMilestones: PortalModule["selectClientMilestones"]
let getPortalJourneyMilestones: PortalModule["getPortalJourneyMilestones"]
async function loadKernel() {
  const m = await import("../lib/kernel/portal")
  isClientVisibleMilestone = m.isClientVisibleMilestone
  selectClientMilestones = m.selectClientMilestones
  getPortalJourneyMilestones = m.getPortalJourneyMilestones
}

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// A minimal row factory — only the fields the kernel rule reads.
function row(over: Partial<{ milestone_type: string | null; milestone_name: string; is_client_visible: boolean | null }>) {
  return {
    milestone_type: over.milestone_type ?? null,
    milestone_name: over.milestone_name ?? "Some Milestone",
    is_client_visible: over.is_client_visible ?? true,
  }
}

function pureLayer(): void {
  console.log("\n[Layer 1 · isClientVisibleMilestone — kernel decides by canonical milestone_type]")

  // canonical client-visible type SHOWS even with a stale is_client_visible=false flag.
  check("canonical client-visible type SHOWS despite stale flag=false",
    isClientVisibleMilestone(row({ milestone_type: "inspection_completed", is_client_visible: false })) === true)

  // canonical INTERNAL type HIDES even with flag=true (cda_delivered is canonical but internal).
  check("canonical internal type HIDES despite flag=true",
    isClientVisibleMilestone(row({ milestone_type: "cda_delivered", is_client_visible: true })) === false)

  // un-backfilled (null type) → fall back to the flag.
  check("null milestone_type + flag=true ⇒ SHOWS (transition fallback)",
    isClientVisibleMilestone(row({ milestone_type: null, is_client_visible: true })) === true)
  check("null milestone_type + flag=false ⇒ HIDES (transition fallback)",
    isClientVisibleMilestone(row({ milestone_type: null, is_client_visible: false })) === false)

  // coarse category (non-canonical) → fall back to the flag, never treated as canonical.
  check("coarse category 'financial' + flag=true ⇒ SHOWS (fallback, not canonical)",
    isClientVisibleMilestone(row({ milestone_type: "financial", is_client_visible: true })) === true)
  check("coarse category 'financial' + flag=false ⇒ HIDES (fallback)",
    isClientVisibleMilestone(row({ milestone_type: "financial", is_client_visible: false })) === false)

  console.log("\n[Layer 1 · overrides — agent's per-contact hide list]")
  // override keyed by canonical milestone_type wins.
  check("override by canonical type hides a would-be-visible milestone",
    isClientVisibleMilestone(row({ milestone_type: "inspection_completed", is_client_visible: true }), { inspection_completed: false }) === false)
  // override keyed by milestone_name (transition) hides an un-backfilled row.
  check("override by milestone_name hides an un-backfilled row",
    isClientVisibleMilestone(row({ milestone_type: null, milestone_name: "Home Inspection", is_client_visible: true }), { "Home Inspection": false }) === false)
  // override === true never force-shows an internal canonical type (overrides only hide).
  check("override=true does NOT un-hide a canonical internal type",
    isClientVisibleMilestone(row({ milestone_type: "cda_delivered", is_client_visible: true }), { cda_delivered: true }) === false)

  console.log("\n[Layer 1 · selectClientMilestones — list filter]")
  const list = [
    row({ milestone_type: "inspection_completed", milestone_name: "Home Inspection", is_client_visible: false }), // show (canonical)
    row({ milestone_type: "cda_delivered", milestone_name: "CDA Delivered", is_client_visible: true }),            // hide (canonical internal)
    row({ milestone_type: null, milestone_name: "Closing Day", is_client_visible: true }),                          // show (fallback)
    row({ milestone_type: null, milestone_name: "Internal Note", is_client_visible: false }),                       // hide (fallback)
  ]
  const visible = selectClientMilestones(list as any)
  check("filters to exactly the kernel-visible rows",
    visible.length === 2 &&
    visible.some((m) => m.milestone_name === "Home Inspection") &&
    visible.some((m) => m.milestone_name === "Closing Day"))
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the kernel rule")
    return
  }
  console.log("\n[Layer 2 · live — seed → read through kernel → assert → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const tag = `pmv-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const contactId = randomUUID()
  const txnId = randomUUID()
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (portal milestone test)` })
    await svc.from("contacts").insert({ id: contactId, brokerage_id: brokerageId, first_name: tag, last_name: "Tester", contact_type: "buyer" })
    await svc.from("transactions").insert({ id: txnId, brokerage_id: brokerageId, deal_name: `${tag} deal`, status: "active", buyer_contact_id: contactId })

    const seedRows = [
      { transaction_id: txnId, milestone_name: "Home Inspection", milestone_type: "inspection_completed", status: "completed", is_client_visible: false }, // canonical visible (flag stale)
      { transaction_id: txnId, milestone_name: "CDA Delivered",   milestone_type: "cda_delivered",        status: "pending",   is_client_visible: true  }, // canonical internal
      { transaction_id: txnId, milestone_name: "Closing Day",     milestone_type: null,                   status: "pending",   is_client_visible: true  }, // fallback show
      { transaction_id: txnId, milestone_name: "Internal Audit",  milestone_type: null,                   status: "pending",   is_client_visible: false }, // fallback hide
    ]
    await svc.from("transaction_milestones").insert(seedRows)

    // Kernel read by contactId (resolves the transaction itself).
    const visible = await getPortalJourneyMilestones(svc, { contactId })
    const names = visible.map((m) => m.milestone_name).sort()
    check("kernel surfaces only client-visible-by-type rows (Closing Day + Home Inspection)",
      JSON.stringify(names) === JSON.stringify(["Closing Day", "Home Inspection"]))
    check("the canonical INTERNAL milestone (CDA Delivered) never surfaces",
      !names.includes("CDA Delivered"))

    // Agent override hides a would-be-visible milestone by canonical type.
    await svc.from("contact_portal_preferences").insert({ contact_id: contactId, milestone_overrides: { inspection_completed: false } })
    const afterOverride = await getPortalJourneyMilestones(svc, { contactId })
    check("portal-preferences override hides Home Inspection by canonical type",
      !afterOverride.some((m) => m.milestone_name === "Home Inspection") &&
      afterOverride.some((m) => m.milestone_name === "Closing Day"))
  } finally {
    await svc.from("contact_portal_preferences").delete().eq("contact_id", contactId)
    await svc.from("transaction_milestones").delete().eq("transaction_id", txnId)
    await svc.from("transactions").delete().eq("id", txnId)
    await svc.from("contacts").delete().eq("id", contactId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("transaction_milestones").select("id", { count: "exact", head: true }).eq("transaction_id", txnId)
    check("cleanup complete (no test rows remain)", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  await loadKernel()
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ PORTAL_MILESTONE_VISIBILITY_FAIL"); process.exit(1) }
  console.log(" ✅ PORTAL_MILESTONE_VISIBILITY_PASS — the kernel decides portal milestones by canonical milestone_type")
}

main().catch((e) => { console.error(e); process.exit(1) })
