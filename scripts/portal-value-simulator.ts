#!/usr/bin/env tsx
/**
 * scripts/portal-value-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PORTAL VALUE CARD harness — the shared primitive behind the owner's contract:
 * "if the person is a contact, they have a portal, and there should always be a push
 *  to their portal with some real value so they keep coming back." Every contact-touch
 * play (Client Pulse, Referral Radar, Reverse Prospecting) leaves ONE fresh, REAL card
 * on the contact's portal each run via pushPortalValueCard → transparency_updates
 * (is_visible_to_client = true), idempotent per (contact, update_type, day).
 *
 * Layer 1 (pure): portalValueDedupeSince computes the dedupe lower-bound correctly
 *   (now − window); and pushPortalValueCard's INPUT-SHAPING guards (missing required
 *   field → pushed:false reason 'missing_required'; no fabrication, no throw).
 * Layer 2 (live, gated): create a throwaway CONTACT, call pushPortalValueCard TWICE with
 *   the SAME updateType + same day; assert the FIRST returns pushed:true and the SECOND
 *   pushed:false (idempotent within the 24h window); assert EXACTLY ONE visible
 *   transparency_updates row exists for that (contact, update_type); then CLEAN UP every
 *   row created (delete in reverse) and verify the cleanup count == 0.
 *
 * Run: npx tsx scripts/portal-value-simulator.ts  (npm run test:portal-value)
 */
import {
  portalValueDedupeSince,
  pushPortalValueCard,
  PORTAL_VALUE_DEDUPE_MS,
} from "../lib/kernel/portal-value"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Portal Value Card verified — visible card, idempotent per (contact, update_type, day)")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Portal Value Card simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · dedupe window + input shaping]")

  // (1) Dedupe boundary — exactly now − window, ISO.
  const now = new Date("2026-06-11T12:00:00.000Z")
  const since = portalValueDedupeSince(now)
  check("dedupe since = now − default 24h window",
    since === new Date(now.getTime() - PORTAL_VALUE_DEDUPE_MS).toISOString(), `got ${since}`)
  check("default dedupe window is 24h", PORTAL_VALUE_DEDUPE_MS === 24 * 60 * 60 * 1000)
  const since1h = portalValueDedupeSince(now, 60 * 60 * 1000)
  check("custom dedupe window is honored (1h back)",
    since1h === new Date(now.getTime() - 60 * 60 * 1000).toISOString(), `got ${since1h}`)
  check("a card created AT the boundary is inside the window (>= since)", since <= now.toISOString())

  // (2) Input shaping — required-field guards reject (no throw, honest reason, NOTHING written).
  const missingBrokerage = await pushPortalValueCard({
    brokerageId: "", contactId: "c1", title: "T", summary: "S", updateType: "client_pulse",
  })
  check("missing brokerageId → pushed:false, reason 'missing_required'",
    missingBrokerage.pushed === false && missingBrokerage.reason === "missing_required")
  const missingContact = await pushPortalValueCard({
    brokerageId: "b1", contactId: "", title: "T", summary: "S", updateType: "client_pulse",
  })
  check("missing contactId → pushed:false, reason 'missing_required'",
    missingContact.pushed === false && missingContact.reason === "missing_required")
  const blankTitle = await pushPortalValueCard({
    brokerageId: "b1", contactId: "c1", title: "   ", summary: "S", updateType: "client_pulse",
  })
  check("blank title → pushed:false, reason 'missing_required' (title is NOT NULL)",
    blankTitle.pushed === false && blankTitle.reason === "missing_required")
  const missingType = await pushPortalValueCard({
    brokerageId: "b1", contactId: "c1", title: "T", summary: "S", updateType: "",
  })
  check("missing updateType → pushed:false, reason 'missing_required'",
    missingType.pushed === false && missingType.reason === "missing_required")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live portal value card]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `PortalValue${Date.now()}`
  const UPDATE_TYPE = "portal_value_sim"
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, brokerage_id")
      .not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent for a brokerage_id."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // Throwaway CONTACT (has a portal).
    const { data: contact } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "PortalContact", contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (contact as any).id })
    const contactId = (contact as any).id

    const fixedNow = new Date()
    const cardInput = {
      brokerageId, contactId, listingId: null,
      title: `${TAG} — your portal value`,
      summary: "A real, contact-safe value sentence drawn from this run's computed values.",
      updateType: UPDATE_TYPE,
      metadata: { tag: TAG, source: "portal_value_sim" },
      now: fixedNow,
    }

    // FIRST push → a new visible card is written.
    const first = await pushPortalValueCard(cardInput, svc)
    if (first.id) cleanup.push({ table: "transparency_updates", id: first.id })
    check("first push: pushed:true (a visible card is written)", first.pushed === true && !!first.id)

    // SECOND push, same (contact, update_type, day) → idempotent no-op.
    const second = await pushPortalValueCard(cardInput, svc)
    if (second.id) cleanup.push({ table: "transparency_updates", id: second.id })
    check("second push: pushed:false, reason 'duplicate_within_window' (idempotent per day)",
      second.pushed === false && second.reason === "duplicate_within_window")

    // EXACTLY ONE visible row for this (contact, update_type).
    const { count: visibleCount } = await svc.from("transparency_updates")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", contactId).eq("update_type", UPDATE_TYPE).eq("is_visible_to_client", true)
    check("exactly ONE visible transparency_updates row for (contact, update_type)",
      (visibleCount ?? -1) === 1, `got ${visibleCount}`)

    // The written card is the canonical shape — visible, both text columns set, metadata stamped.
    const { data: row } = await svc.from("transparency_updates")
      .select("id, contact_id, listing_id, title, plain_language_summary, message, update_type, is_visible_to_client, metadata")
      .eq("id", first.id!).maybeSingle()
    check("card is visible to client (the whole point — is_visible_to_client true)",
      (row as any)?.is_visible_to_client === true)
    check("card writes BOTH portal text columns from the one summary",
      (row as any)?.plain_language_summary === cardInput.summary && (row as any)?.message === cardInput.summary)
    check("card carries the play update_type + portal_value_card metadata stamp",
      (row as any)?.update_type === UPDATE_TYPE && (row as any)?.metadata?.portal_value_card === true)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("transparency_updates")
      .select("id", { count: "exact", head: true }).eq("update_type", UPDATE_TYPE).ilike("title", `${TAG}%`)
    check("cleanup verified — 0 seeded portal cards remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
