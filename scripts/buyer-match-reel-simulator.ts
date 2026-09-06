#!/usr/bin/env tsx
/**
 * scripts/buyer-match-reel-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 59 — proves the buyer property-match REEL AUTO-handoff is DELIVERABLE-gated:
 * when a buyer gets fresh high-score matches, the system enqueues a personalized
 * "homes matching your search" reel (reusing AffordabilitySnapshotReel) into the
 * canonical render queue — zero agent effort, idempotent per buyer/week.
 *
 *   Layer 1 — pure: buildBuyerMatchReelProps (3 cards, formatted price, sanitized,
 *     Fair-Housing clean labels).
 *   Layer 2 — live (gated): seed a buyer + listing + property_match → produceBuyerMatchReel
 *     enqueues a 'queued' remotion_composition_renders row with the right composition +
 *     inputProps + scope; idempotent within the cooldown; cleanup.
 *
 * Run: npx tsx scripts/buyer-match-reel-simulator.ts  (npm run test:buyer-match-reel)
 */
import { randomUUID } from "node:crypto"
import { buildBuyerMatchReelProps } from "../lib/agents/buyer-match-reel-producer"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · buildBuyerMatchReelProps — resolved facts from EITHER source]")
  const props = buildBuyerMatchReelProps(
    [
      { id: "1", address: "12 Oak St", city: "Maple Grove", state: "MN", price: 485000, bedrooms: 3, bathrooms: 2, photoUrl: "https://cdn/x.jpg", source: "listing", status: "active", listingId: null, propertyId: "MLS-1", mlsNumber: "MLS-1", listingUrl: null, statusSource: "unknown" as const },
      { id: "2", address: "9 Elm Ave", city: "Maple Grove", state: "MN", price: 525000, bedrooms: 4, bathrooms: 3, photoUrl: null, source: "idx", status: "active", listingId: null, propertyId: "MLS-1", mlsNumber: "MLS-1", listingUrl: null, statusSource: "unknown" as const },
    ],
    { agentName: "Dana Kling", agentPhone: "(555) 555-1212", brokerageName: "Kling Realty" },
  ) as any
  check("builds props with one card per resolved property", Array.isArray(props?.examples) && props.examples.length === 2)
  check("formats price as currency", props.examples[0].price === "$485,000")
  check("carries the photo when present (external MLS snapshot)", props.examples[0].photoUrl === "https://cdn/x.jpg")
  check("weaves the area from the property city", props.areaName === "Maple Grove")
  check("buyer-match framing headline (not a generic affordability band)", /matching your search/i.test(props.monthlyHeadline))
  check("carries agent + brokerage for the footer", props.agentName === "Dana Kling" && props.brand.brokerageName === "Kling Realty")
  check("Fair-Housing clean labels", !/famil|kids|perfect for|safe neighborhood/i.test(JSON.stringify(props)))
  const none = buildBuyerMatchReelProps([{ id: "x", address: null, city: null, state: null, price: null, bedrooms: null, bathrooms: null, photoUrl: null, source: "saved", status: "active", listingId: null, propertyId: "MLS-1", mlsNumber: "MLS-1", listingUrl: null, statusSource: "unknown" as const }], { agentName: "X", agentPhone: "", brokerageName: "Y" })
  check("no renderable facts → null (no empty reel)", none === null)
}

async function testLive() {
  console.log("\n[Layer 2 · live render-queue enqueue]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { produceBuyerMatchReel } = await import("../lib/agents/buyer-match-reel-producer")
  const svc = createServiceClient()
  const TAG = `__bmr_${Date.now()}__`
  let buyerId: string | null = null, listingId: string | null = null, savedId: string | null = null
  // ── THE SEED HAD NO AGENT, AND THAT IS NOW A REFUSAL, NOT A REEL ───────────
  // AffordabilitySnapshotReel REQUIRES agentPhone (lib/remotion/content-contract),
  // and the producer resolves it from `users.phone` via `contacts.agent_id`.
  // This seed used to create a buyer with NO agent at all, so agentPhone was ""
  // — which the contract reads as unsupplied, so render-composition CANCELLED
  // the reel after the queue row and the tracked QR had already been created.
  // The producer now refuses before either, which is correct and which this
  // seed could not express: a buyer with no agent tests the refusal, not the
  // happy path the assertion below is about. So the happy path gets a real
  // agent with a real phone, and the refusal gets its own buyer and its own
  // assertion — a documented behaviour is worth pinning.
  let agentUserId: string | null = null, agentRecordId: string | null = null
  let poorBuyerId: string | null = null, poorAgentUserId: string | null = null, poorAgentId: string | null = null
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    // The agent behind the happy path: a users row WITH a phone (the fact the
    // composition prints), crossed to an agents row (contacts.agent_id is the
    // AGENTS class — agents.id and users.id are DISJOINT, CLAUDE.md §3).
    agentUserId = randomUUID()
    const { error: uErr } = await svc.from("users").insert({
      id: agentUserId, brokerage_id: brokerageId, email: `${TAG}agent@example.com`,
      first_name: `${TAG}Dana`, last_name: "Kling", user_type: "agent", phone: "(555) 555-1212",
    })
    if (uErr) { console.log(`  ⏭  Skipped — could not seed the agent user: ${uErr.message}`); return }
    const { data: ag, error: agErr } = await svc.from("agents")
      .insert({ user_id: agentUserId, brokerage_id: brokerageId }).select("id").single()
    if (agErr || !ag) { console.log(`  ⏭  Skipped — could not seed the agents row: ${agErr?.message}`); return }
    agentRecordId = (ag as { id: string }).id

    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}Buyer`, last_name: "Test", email: `${TAG}b@example.com`, contact_type: "buyer",
      agent_id: agentRecordId,
    }).select("id").maybeSingle()
    buyerId = (c as { id: string } | null)?.id ?? null
    const { data: l } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 12 Oak St`, city: "Maple Grove", state: "MN",
      list_price: 485000, bedrooms: 3, bathrooms: 2, status: "active", lifecycle_stage: "MLS_ACTIVE",
    }).select("id").maybeSingle()
    listingId = (l as { id: string } | null)?.id ?? null
    if (!buyerId || !listingId) { console.log("  ⏭  seed failed — skipped"); return }

    await svc.from("property_matches").insert({
      brokerage_id: brokerageId, contact_id: buyerId, property_id: listingId, match_score: 95, ai_generated: true,
    })
    // An EXTERNAL MLS (RentCast/IDX) match — cached in saved_properties, referenced by its uuid.
    const { data: anyUser } = await svc.from("users").select("id").limit(1).maybeSingle()
    const userId = (anyUser as { id: string } | null)?.id ?? null
    const { data: sp } = userId ? await svc.from("saved_properties").insert({
      brokerage_id: brokerageId, contact_id: buyerId, user_id: userId, source: "idx", external_property_id: `${TAG}MLS1`,
      property_address: `${TAG} 9 Elm Ave`, city: "Maple Grove", state: "MN", list_price: 525000,
      bedrooms: 4, bathrooms: 3, primary_photo_url: "https://cdn.example/elm.jpg",
    }).select("id").maybeSingle() : { data: null }
    savedId = (sp as { id: string } | null)?.id ?? null
    if (savedId) {
      await svc.from("property_matches").insert({
        brokerage_id: brokerageId, contact_id: buyerId, property_id: savedId, match_score: 92, ai_generated: true,
      })
    }

    const r = await produceBuyerMatchReel(brokerageId, buyerId, svc)
    check("fresh matches → enqueues a reel render", r.queued === true && !!r.renderId, r.reason)

    const { data: render } = await svc.from("remotion_composition_renders")
      .select("composition_id, render_status, entity_type, entity_id, input_props")
      .eq("id", r.renderId!).maybeSingle()
    const rr = render as any
    check("queued render uses AffordabilitySnapshotReel, scoped to the contact", rr?.composition_id === "AffordabilitySnapshotReel" && rr?.render_status === "queued" && rr?.entity_type === "contact" && rr?.entity_id === buyerId)
    // The prop whose absence used to cancel this render at the backstop. Pinned
    // because the seed above is the only thing that makes it non-empty, so a
    // future seed that drops the agent would otherwise silently test nothing.
    check("the queued reel actually carries the agent phone the composition prints",
      typeof rr?.input_props?.agentPhone === "string" && rr.input_props.agentPhone.trim().length > 0,
      JSON.stringify(rr?.input_props?.agentPhone))
    const examplesJson = JSON.stringify(rr?.input_props?.examples ?? [])
    check("inputProps carry the OUR-LISTING match card", /Oak St/.test(examplesJson))
    if (savedId) {
      check("inputProps ALSO carry the EXTERNAL MLS match (resolved from saved_properties)", /Elm Ave/.test(examplesJson))
      check("external MLS card carries its photo", /elm\.jpg/.test(examplesJson))
    }

    const r2 = await produceBuyerMatchReel(brokerageId, buyerId, svc)
    check("idempotent within the weekly cooldown (no duplicate reel)", r2.queued === false, r2.reason)

    // ── THE REFUSAL, PINNED ────────────────────────────────────────────────
    // Same buyer setup, but the agent's users row has NO phone — the live shape
    // that used to queue a render and mint a QR for a reel the backstop then
    // cancelled, after which the cooldown probe suppressed every retry for a
    // week and the buyer silently never got one. The producer must now refuse
    // BY NAME and write NOTHING.
    poorAgentUserId = randomUUID()
    const { error: pu } = await svc.from("users").insert({
      id: poorAgentUserId, brokerage_id: brokerageId, email: `${TAG}nophone@example.com`,
      first_name: `${TAG}NoPhone`, last_name: "Agent", user_type: "agent",
    })
    const { data: pa } = pu ? { data: null } : await svc.from("agents")
      .insert({ user_id: poorAgentUserId, brokerage_id: brokerageId }).select("id").single()
    poorAgentId = (pa as { id: string } | null)?.id ?? null
    if (poorAgentId) {
      const { data: pc } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, first_name: `${TAG}PoorBuyer`, last_name: "Test",
        email: `${TAG}pb@example.com`, contact_type: "buyer", agent_id: poorAgentId,
      }).select("id").maybeSingle()
      poorBuyerId = (pc as { id: string } | null)?.id ?? null
      if (poorBuyerId && listingId) {
        await svc.from("property_matches").insert({
          brokerage_id: brokerageId, contact_id: poorBuyerId, property_id: listingId, match_score: 95, ai_generated: true,
        })
        const r3 = await produceBuyerMatchReel(brokerageId, poorBuyerId, svc)
        check("an agent with NO phone → the reel is REFUSED, naming agentPhone",
          r3.queued === false && /agentPhone/.test(r3.reason ?? ""), r3.reason)
        // The refusal must leave no trace, or the cooldown probe re-arms itself
        // on a reel that never existed — the exact way the retry was suppressed.
        const { count: rowsAfterRefusal } = await svc.from("remotion_composition_renders")
          .select("id", { count: "exact", head: true })
          .eq("entity_type", "contact").eq("entity_id", poorBuyerId)
        check("...and writes NO render row, so the weekly cooldown is not armed by a refusal",
          (rowsAfterRefusal ?? 0) === 0, `rows=${rowsAfterRefusal}`)
      }
    }
  } finally {
    for (const cid of [buyerId, poorBuyerId]) {
      if (!cid) continue
      try { await svc.from("remotion_composition_renders").delete().eq("entity_id", cid).eq("composition_id", "AffordabilitySnapshotReel") } catch {}
      try { await svc.from("property_matches").delete().eq("contact_id", cid) } catch {}
      try { await svc.from("saved_properties").delete().eq("contact_id", cid) } catch {}
      try { await svc.from("contacts").delete().eq("id", cid) } catch {}
    }
    if (listingId) { try { await svc.from("listings").delete().eq("id", listingId) } catch {} }
    // The happy path MINTS A TRACKED QR (qr_codes.agent_id is the USERS id —
    // mintTrackedQr is handed agentUserId). The old seed left these behind
    // because it never got far enough to mint one; this one does.
    for (const uid of [agentUserId, poorAgentUserId]) {
      if (!uid) continue
      try { await svc.from("qr_codes").delete().eq("agent_id", uid) } catch {}
    }
    for (const aid of [agentRecordId, poorAgentId]) {
      if (!aid) continue
      try { await svc.from("agents").delete().eq("id", aid) } catch {}
    }
    for (const uid of [agentUserId, poorAgentUserId]) {
      if (!uid) continue
      try { await svc.from("users").delete().eq("id", uid) } catch {}
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
    const { count: userCount } = await svc.from("users").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test agent users remain", (userCount ?? 0) === 0, `users=${userCount}`)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer property-match REEL AUTO-handoff simulator (deliverable-gated)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Buyer match reel: zero agent effort; render is deliverable-gated in the queue")
}
main().catch((e) => { console.error(e); process.exit(1) })
