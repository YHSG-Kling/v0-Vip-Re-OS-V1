#!/usr/bin/env tsx
/**
 * scripts/portal-milestone-visibility-simulator.ts   (npm run test:portal-milestone-visibility)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the KERNEL is the decision-maker for which transaction milestones a CLIENT
 * sees on their journey portal, with two concerns deliberately SEPARATED:
 *   • VISIBILITY = the agent-controlled is_client_visible flag (+ per-contact
 *     overrides). The flag — never milestone_type — decides what the client sees, so
 *     the agent's explicit show/hide choice is always respected.
 *   • IDENTITY = the canonical milestone_type (resolveMilestoneIdentity), used to key
 *     overrides stably across tier name variants and to drive education/reporting.
 *
 * lib/kernel/portal.ts owns the rule; the journey page + portal home pages call it.
 *
 * Layer 1 (pure, no I/O) — isClientVisibleMilestone / selectClientMilestones:
 *   - flag=true shows, flag=false hides, default (undefined) shows.
 *   - a canonical milestone_type NEVER force-shows or force-hides against the flag.
 *   - overrides hide (false) or force-show (true), keyed by canonical identity
 *     (resolved from type OR human name), with raw name as the fallback key.
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
  console.log("\n[Layer 1 · isClientVisibleMilestone — agent-controlled is_client_visible flag decides]")

  // The flag rules. milestone_type (identity) NEVER overrides the agent's flag.
  check("flag=true ⇒ SHOWS", isClientVisibleMilestone(row({ is_client_visible: true })) === true)
  check("flag=false ⇒ HIDES", isClientVisibleMilestone(row({ is_client_visible: false })) === false)
  check("flag undefined (default) ⇒ SHOWS", isClientVisibleMilestone({ milestone_name: "X" } as any) === true)

  // A canonical milestone_type does NOT change visibility — the flag is respected.
  check("canonical client-visible type + flag=false ⇒ HIDES (flag wins, type never force-shows)",
    isClientVisibleMilestone(row({ milestone_type: "inspection_completed", is_client_visible: false })) === false)
  check("canonical internal type + flag=true ⇒ SHOWS (flag wins, type never force-hides)",
    isClientVisibleMilestone(row({ milestone_type: "cda_delivered", is_client_visible: true })) === true)

  console.log("\n[Layer 1 · overrides — agent's per-contact show/hide list]")
  // override hides a flag-true row; keyed by canonical identity (resolved from type or name).
  check("override=false by canonical identity hides a visible milestone",
    isClientVisibleMilestone(row({ milestone_type: "inspection_completed", is_client_visible: true }), { inspection_completed: false }) === false)
  // identity resolves from the human name too — override keyed on the canonical id hides it.
  check("override=false by identity resolved from a human name hides it",
    isClientVisibleMilestone(row({ milestone_type: null, milestone_name: "Home Inspection", is_client_visible: true }), { inspection_deadline: false }) === false)
  // override=true force-shows a flag-false row (agent re-enabled it).
  check("override=true force-shows a flag-false milestone",
    isClientVisibleMilestone(row({ milestone_type: "cda_delivered", is_client_visible: false }), { cda_delivered: true }) === true)
  // override by raw name still works when no canonical identity resolves.
  check("override=false by milestone_name works for an unmappable row",
    isClientVisibleMilestone(row({ milestone_name: "Quarterly Newsletter", is_client_visible: true }), { "Quarterly Newsletter": false }) === false)

  console.log("\n[Layer 1 · selectClientMilestones — list filter]")
  const list = [
    row({ milestone_type: "inspection_completed", milestone_name: "Home Inspection", is_client_visible: true }), // show (flag)
    row({ milestone_type: "cda_delivered", milestone_name: "CDA Delivered", is_client_visible: false }),         // hide (flag)
    row({ milestone_type: "closing_date", milestone_name: "Closing Day", is_client_visible: true }),             // show (flag)
    row({ milestone_type: null, milestone_name: "Internal Note", is_client_visible: false }),                     // hide (flag)
  ]
  const visible = selectClientMilestones(list as any)
  check("filters to exactly the flag-visible rows",
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
      { transaction_id: txnId, milestone_name: "Home Inspection", milestone_type: "inspection_completed", status: "completed", is_client_visible: true  }, // flag → show
      { transaction_id: txnId, milestone_name: "CDA Delivered",   milestone_type: "cda_delivered",        status: "pending",   is_client_visible: false }, // flag → hide
      { transaction_id: txnId, milestone_name: "Closing Day",     milestone_type: "closing_date",         status: "pending",   is_client_visible: true  }, // flag → show
      { transaction_id: txnId, milestone_name: "Internal Audit",  milestone_type: null,                   status: "pending",   is_client_visible: false }, // flag → hide
    ]
    await svc.from("transaction_milestones").insert(seedRows)

    // Kernel read by contactId (resolves the transaction itself). The agent-controlled
    // is_client_visible flag decides — milestone_type never overrides it.
    const visible = await getPortalJourneyMilestones(svc, { contactId })
    const names = visible.map((m) => m.milestone_name).sort()
    check("kernel surfaces exactly the flag-visible rows (Closing Day + Home Inspection)",
      JSON.stringify(names) === JSON.stringify(["Closing Day", "Home Inspection"]))
    check("a flag-false milestone (CDA Delivered) never surfaces — even with a canonical type",
      !names.includes("CDA Delivered"))

    // Agent override hides a flag-visible milestone, keyed on its canonical identity.
    await svc.from("contact_portal_preferences").insert({ contact_id: contactId, milestone_overrides: { inspection_completed: false } })
    const afterOverride = await getPortalJourneyMilestones(svc, { contactId })
    check("portal-preferences override hides Home Inspection by canonical identity",
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
  console.log(" ✅ PORTAL_MILESTONE_VISIBILITY_PASS — the agent-controlled flag decides; identity keys overrides")
}

main().catch((e) => { console.error(e); process.exit(1) })
