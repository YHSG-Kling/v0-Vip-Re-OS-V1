#!/usr/bin/env tsx
/**
 * scripts/lifetime-audience-simulator.ts   (npm run test:lifetime-audience)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LIFETIME → FB AUDIENCE PROMOTION — a past client (deal closed, contact_type='lifetime')
 * is the highest-ROI real-estate audience (referrals + repeat + lookalike seed), yet the
 * lifetime transition had NO audience hook. onContactBecameLifetimeForAudience now stages the
 * past client into the brokerage retargeting audience, consent-gated + idempotent.
 *
 * Live (gated by SUPABASE_SERVICE_ROLE_KEY): seed a brokerage FB audience + a consented
 * lifetime contact → promote → assert an audience_members row (pending) is staged; a DNC
 * contact is skipped; a re-run is idempotent (no duplicate). Reverse-delete; cleanup == 0.
 */
export {} // module scope (avoid global-script symbol collisions under tsc)

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
function report() {
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LIFETIME_AUDIENCE_FAIL"); process.exit(1) }
  console.log(" ✅ LIFETIME_AUDIENCE_PASS — past clients are promoted into the FB retargeting audience, consent-gated + idempotent")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lifetime → FB audience promotion simulator")
  console.log("══════════════════════════════════════════════════")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set (live-only simulator)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { onContactBecameLifetimeForAudience } = await import("../lib/audiences/audience-sync")
  const svc = createServiceClient()
  const TAG = `LifeAud${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!brokerage) { console.log("  ⏭  Skipped — need a brokerage."); return report() }
    const brokerageId = (brokerage as any).id as string

    // Seed an ACTIVE brokerage-scope FB audience (the promotion target).
    const { data: aud, error: audErr } = await svc.from("facebook_custom_audiences").insert({
      brokerage_id: brokerageId, audience_name: `${TAG} Retargeting`, audience_type: "retargeting",
      scope_type: "brokerage", status: "active",
    }).select("id").single()
    if (audErr || !aud) { console.log(`  ⏭  Skipped — audience seed failed: ${audErr?.message}`); return report() }
    const audienceId = (aud as any).id as string
    cleanup.push({ table: "facebook_custom_audiences", id: audienceId })

    // A consented lifetime contact (a real past client) + a DNC one (must be skipped).
    const { data: good } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Lifetime", contact_type: "lifetime",
      tcpa_consent: true, dnc_status: false,
    }).select("id").single()
    const goodId = (good as any).id as string
    cleanup.push({ table: "contacts", id: goodId })
    const { data: dnc } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "DNC", contact_type: "lifetime",
      tcpa_consent: true, dnc_status: true,
    }).select("id").single()
    const dncId = (dnc as any).id as string
    cleanup.push({ table: "contacts", id: dncId })

    // ── PROMOTE the consented past client ──
    const r1 = await onContactBecameLifetimeForAudience({ contactId: goodId, brokerageId })
    check("promotion ok + a member was inserted", r1.ok && r1.membersInserted >= 1, JSON.stringify(r1))
    const { data: m1 } = await svc.from("audience_members").select("id, sync_status, consent_snapshot")
      .eq("audience_id", audienceId).eq("contact_id", goodId)
    for (const m of (m1 ?? []) as any[]) cleanup.push({ table: "audience_members", id: m.id })
    const mem = ((m1 ?? []) as any[])[0]
    check("the past client is staged in the brokerage audience (sync_status=pending)", !!mem && mem.sync_status === "pending")
    check("the membership carries a lifetime consent snapshot", !!mem && (mem.consent_snapshot as any)?.lifetime === true)

    // ── DNC past client is NEVER promoted ──
    const r2 = await onContactBecameLifetimeForAudience({ contactId: dncId, brokerageId })
    check("DNC past client is skipped (dnc_status_blocked)", r2.skippedReasons.includes("dnc_status_blocked"))
    const { count: dncCount } = await svc.from("audience_members").select("id", { count: "exact", head: true })
      .eq("audience_id", audienceId).eq("contact_id", dncId)
    check("no audience row for the DNC past client", (dncCount ?? 0) === 0)

    // ── Idempotent rerun — no duplicate membership ──
    await onContactBecameLifetimeForAudience({ contactId: goodId, brokerageId })
    const { count: goodCount } = await svc.from("audience_members").select("id", { count: "exact", head: true })
      .eq("audience_id", audienceId).eq("contact_id", goodId)
    check("idempotent: still exactly ONE membership after rerun (no duplicate)", (goodCount ?? 0) === 1, `got ${goodCount}`)
  } finally {
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ } }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("first_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0, `got ${count}`)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
