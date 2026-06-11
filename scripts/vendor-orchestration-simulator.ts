#!/usr/bin/env tsx
/**
 * scripts/vendor-orchestration-simulator.ts — DEAL-STAGE VENDOR ORCHESTRATION proof.
 *
 * Layer 1 (PURE, always runs): the gap logic + preference-first ranking. Asserts that a
 * stage maps to the right vendor category, that the FIRST uncovered gap wins, that a
 * PREFERRED vendor outranks a higher-rated non-preferred vendor, and that a Stager gap is
 * SUPPRESSED when staging is disabled in settings (and surfaced only when enabled).
 *
 * Layer 2 (LIVE, creds-gated): seed a transaction at a stage with a gap + 2 bench vendors
 * (one preferred via higher rating, one not), run runVendorOrchestration, and assert the
 * PREFERRED vendor was proposed, a gated quote-request draft (agent_client_messages,
 * audience 'agent', status 'proposed') exists, staging is skipped while the setting is off,
 * and a second pass is idempotent. SELF-CLEANS by a unique TAG.
 */
import {
  vendorGapForStage, rankVendors, pickVendorForGap, composeQuoteRequestFallback,
  runVendorOrchestration, type BenchVendor, type DealCoverage,
} from "../lib/kernel/vendor-orchestration"

let passed = 0, failed = 0; const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { passed++; console.log(`  ✓ ${n}`) }
  else { failed++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}
const report = () => {
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) }
  console.log(" ✅ Vendor orchestration verified — preference-first, staging-optional, gated")
}

// A deterministic copy generator that never spends tokens (and proves the seam works).
const fakeCopy = async () => ({ subject: "TEST quote request", body: "TEST persona-aware quote request body." })

function layer1() {
  console.log("── Layer 1: pure gap logic + preference-first ranking ──")
  const covered: DealCoverage = { hasInspection: false, hasLender: false, hasTitle: false, hasStager: false, stagingEnabled: false }

  // Stage → category mapping.
  check("UNDER_CONTRACT with no inspection → Inspector gap",
    vendorGapForStage("UNDER_CONTRACT", covered)?.category === "Inspector")
  check("APPRAISAL with no lender → Lender gap",
    vendorGapForStage("APPRAISAL", { ...covered, hasInspection: true })?.category === "Lender")
  check("CLOSING_PREP with no title → Title Company gap",
    vendorGapForStage("CLOSING_PREP", { ...covered })?.category === "Title Company")
  check("CLOSED → no gap", vendorGapForStage("CLOSED", covered) === null)

  // FIRST uncovered gap: inspection covered at UNDER_CONTRACT, staging off → no gap.
  check("UNDER_CONTRACT, inspection covered, staging OFF → no gap",
    vendorGapForStage("UNDER_CONTRACT", { ...covered, hasInspection: true }) === null)

  // STAGING settings-gated.
  check("staging SUPPRESSED when disabled",
    vendorGapForStage("CLOSING_PREP", { ...covered, hasTitle: true, stagingEnabled: false }) === null)
  check("staging SURFACED when enabled + uncovered",
    vendorGapForStage("CLOSING_PREP", { ...covered, hasTitle: true, stagingEnabled: true })?.category === "Stager")
  check("staging NOT surfaced when already covered even if enabled",
    vendorGapForStage("CLOSING_PREP", { ...covered, hasTitle: true, hasStager: true, stagingEnabled: true }) === null)

  // PREFERENCE-FIRST ranking: preferred beats higher rating.
  const vendors: BenchVendor[] = [
    { id: "hi", name: "High Rated", category: "Inspector", email: "h@x.co", rating: 5 },
    { id: "pref", name: "Preferred Lower", category: "Inspector", email: "p@x.co", rating: 3, preferred: true },
    { id: "lo", name: "Low Rated", category: "Inspector", email: "l@x.co", rating: 1 },
  ]
  const ranked = rankVendors(vendors)
  check("preferred vendor outranks higher rating", ranked[0].id === "pref", ranked.map((v) => v.id).join(","))
  check("within non-preferred, higher rating wins", ranked[1].id === "hi")

  // preferredVendorIds set path.
  const rankedBySet = rankVendors(
    [{ id: "a", name: "A", category: "Inspector", email: null, rating: 5 }, { id: "b", name: "B", category: "Inspector", email: null, rating: 2 }],
    { preferredVendorIds: ["b"] },
  )
  check("preferredVendorIds set picks the preferred id first", rankedBySet[0].id === "b")

  // pickVendorForGap respects category + preference.
  const gap = vendorGapForStage("UNDER_CONTRACT", covered)!
  check("pickVendorForGap returns the preferred Inspector", pickVendorForGap(vendors, gap)?.id === "pref")
  check("pickVendorForGap returns null when bench lacks the category",
    pickVendorForGap([{ id: "t", name: "T", category: "Title Company", email: null, rating: 5 }], gap) === null)

  // fallback copy is real (never a stub).
  const fb = composeQuoteRequestFallback({ vendorName: "Acme", gap, propertyAddress: "1 St", dealName: "Deal X" })
  check("fallback quote copy mentions vendor + service", fb.body.includes("Acme") && fb.body.includes(gap.label))
}

async function layer2() {
  console.log("\n── Layer 2: live, creds-gated ──")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — no creds (live layer only)."); return }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `VendOrch${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  let restoreSettings: { table: "brokerage_settings"; id: string; settings: any } | null = null
  let createdSettingsId: string | null = null

  try {
    const { data: agent } = await svc.from("agents").select("id, brokerage_id")
      .not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { check("need an agent with a brokerage", false); return }
    const brokerageId = (agent as any).brokerage_id

    // STAGING OFF: ensure brokerage_settings has staging disabled.
    const { data: existingSettings } = await svc.from("brokerage_settings")
      .select("id, settings").eq("brokerage_id", brokerageId).maybeSingle()
    if (existingSettings) {
      restoreSettings = { table: "brokerage_settings", id: (existingSettings as any).id, settings: (existingSettings as any).settings }
      const next = { ...((existingSettings as any).settings ?? {}), staging_enabled: false }
      await svc.from("brokerage_settings").update({ settings: next }).eq("id", (existingSettings as any).id)
    } else {
      const { data: created } = await svc.from("brokerage_settings")
        .insert({ brokerage_id: brokerageId, settings: { staging_enabled: false } }).select("id").single()
      createdSettingsId = (created as any)?.id ?? null
    }

    // Two Inspector vendors on the bench: one higher-rated (the preference-first winner),
    // one lower. (vendors has no preferred flag — preference-first falls back to rating.)
    const { data: vTop } = await svc.from("vendors").insert({
      brokerage_id: brokerageId, name: `${TAG} TopInspector`, category: "Inspector",
      email: "top@x.co", rating: 5, access_level: "transaction_only",
    }).select("id").single()
    cleanup.push({ table: "vendors", id: (vTop as any).id })
    const { data: vLow } = await svc.from("vendors").insert({
      brokerage_id: brokerageId, name: `${TAG} LowInspector`, category: "Inspector",
      email: "low@x.co", rating: 2, access_level: "transaction_only",
    }).select("id").single()
    cleanup.push({ table: "vendors", id: (vLow as any).id })

    // A Stager on the bench too — to prove staging is SKIPPED while the setting is off.
    const { data: vStager } = await svc.from("vendors").insert({
      brokerage_id: brokerageId, name: `${TAG} Stager`, category: "Stager",
      email: "stage@x.co", rating: 5, access_level: "transaction_only",
    }).select("id").single()
    cleanup.push({ table: "vendors", id: (vStager as any).id })

    // Seed a transaction UNDER_CONTRACT with NO inspection booked → an Inspector gap.
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} Deal`, agent_id: (agent as any).id,
      property_address: `${TAG} 100 Main St`, stage: "UNDER_CONTRACT", status: "under_contract",
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })
    const txnId = (txn as any).id

    // RUN.
    const r1 = await runVendorOrchestration(brokerageId, { copyGenerator: fakeCopy }, svc)
    check("orchestration scanned the seeded transaction", r1.scanned >= 1, `scanned=${r1.scanned}`)
    check("orchestration proposed at least one vendor", r1.proposed >= 1, `proposed=${r1.proposed}`)

    // Fetch the proposal for our transaction.
    const { data: msgs } = await svc.from("agent_client_messages")
      .select("id, audience, status, rationale, subject, body, agent_kind")
      .eq("brokerage_id", brokerageId).eq("entity_type", "transaction").eq("entity_id", txnId)
    for (const m of (msgs ?? []) as any[]) cleanup.push({ table: "agent_client_messages", id: m.id })
    const inspectionMsg = (msgs ?? []).find((m: any) => (m.rationale ?? "").startsWith("VENDOR ORCH — inspection"))

    check("a gated inspection quote draft exists", !!inspectionMsg)
    check("draft is audience 'agent'", (inspectionMsg as any)?.audience === "agent")
    check("draft status is 'proposed' (gated, nothing auto-booked)", (inspectionMsg as any)?.status === "proposed")
    check("draft is from the deal_coordinator", (inspectionMsg as any)?.agent_kind === "deal_coordinator")
    check("PREFERRED (higher-rated) vendor was proposed, not the low one",
      (inspectionMsg as any)?.rationale?.includes(`${TAG} TopInspector`) &&
      !(inspectionMsg as any)?.rationale?.includes(`${TAG} LowInspector`))
    check("persona copy seam used (fake generator body)",
      (inspectionMsg as any)?.body === "TEST persona-aware quote request body.")

    // STAGING SKIPPED: no stager proposal while the setting is off.
    const stagerMsg = (msgs ?? []).find((m: any) => (m.rationale ?? "").startsWith("VENDOR ORCH — staging"))
    check("staging is SKIPPED when the setting is off (no stager draft)", !stagerMsg)

    // No vendor_booking was created (nothing auto-books).
    const { data: bookings } = await svc.from("vendor_bookings").select("id").eq("transaction_id", txnId)
    check("nothing auto-booked (no vendor_bookings rows)", ((bookings ?? []) as any[]).length === 0)

    // IDEMPOTENCY: second pass proposes nothing new for this gap.
    const before = (msgs ?? []).length
    const r2 = await runVendorOrchestration(brokerageId, { copyGenerator: fakeCopy }, svc)
    const { data: msgs2 } = await svc.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).eq("entity_type", "transaction").eq("entity_id", txnId)
    check("idempotent: second pass adds no new proposal for this gap", ((msgs2 ?? []).length) === before, `before=${before} after=${(msgs2 ?? []).length}`)
  } finally {
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch {} }
    // restore / remove settings we touched
    try {
      if (restoreSettings) await svc.from("brokerage_settings").update({ settings: restoreSettings.settings }).eq("id", restoreSettings.id)
      else if (createdSettingsId) await svc.from("brokerage_settings").delete().eq("id", createdSettingsId)
    } catch {}
    const { count } = await svc.from("vendors").select("id", { count: "exact", head: true }).like("name", `${TAG}%`)
    check("cleanup verified (no tagged vendors remain)", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══ Vendor orchestration simulator ══")
  layer1()
  await layer2()
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
