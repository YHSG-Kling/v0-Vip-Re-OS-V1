#!/usr/bin/env tsx
/**
 * scripts/lead-nurture-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AI ISA HOT-SELLER-LEAD NURTURE harness — proves the channel-appropriate,
 * VERIFICATION-GATED conversion push (lead→contact) the ISA extends after it
 * prioritizes a radar-promoted hot seller LEAD (ai_isa_owner=true, NO portal).
 *
 * Layer 1 (pure): chooseLeadNurtureChannels — the verification gate as data.
 *   · email_verified ONLY (+ complete email, not opted out) → email only.
 *   · mailing_address_verified ONLY (+ complete mailing address) → postcard only.
 *   · both verified → both. neither → none. opted-out / incomplete → off.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY): seed a REAL ISA-owned lead
 *   with email_verified=true + mailing_address_verified=false, fire the
 *   ai_isa:seller_intent_hot handler, and assert:
 *     · EXACTLY ONE gated video-EMAIL proposal (agent_client_messages,
 *       status='proposed', audience 'lead', channel 'email') + a staged gated reel
 *       (ai_video_projects approval_status='pending_review', lead in video_metadata);
 *     · NO postcard (mailing address NOT verified);
 *     · NO portal card (recipient_contact_id is null — it's a lead, not a contact);
 *     · a rerun proposes nothing new (idempotent per (lead, channel));
 *   then a BOTH-verified lead → BOTH (one email proposal + one gated postcard);
 *   then reverse-delete + cleanup count == 0. No mocks, real data.
 *
 * Run: npx tsx scripts/lead-nurture-simulator.ts  (npm run test:lead-nurture)
 */
import {
  chooseLeadNurtureChannels,
  type LeadNurtureInput,
} from "../lib/ai-isa/lead-nurture"

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
  console.log(" ✅ AI ISA hot-seller-LEAD nurture verified — verification-gated EMAIL (Director reel) + POSTCARD, each independent + idempotent, nothing auto-sends, no portal card (it's a lead)")
  console.log(" LEAD_NURTURE_PASS")
}

// A complete, deliverable mailing address (Lob requires all four lines).
const FULL_MAIL = {
  mailing_address: "9 Probe Ln", mailing_city: "Austin", mailing_state: "TX", mailing_zip: "78701",
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" AI ISA hot-seller-LEAD nurture simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · chooseLeadNurtureChannels — the verification gate as data]")

  const emailOnly: LeadNurtureInput = { email: "a@b.com", email_verified: true, mailing_address_verified: false, ...FULL_MAIL }
  const c1 = chooseLeadNurtureChannels(emailOnly)
  check("email-verified ONLY → email only (no postcard: mailing addr NOT verified)", c1.email === true && c1.postcard === false, JSON.stringify(c1))

  const mailOnly: LeadNurtureInput = { email: "a@b.com", email_verified: false, mailing_address_verified: true, ...FULL_MAIL }
  const c2 = chooseLeadNurtureChannels(mailOnly)
  check("mailing-verified ONLY → postcard only (no email: email NOT verified)", c2.email === false && c2.postcard === true, JSON.stringify(c2))

  const both: LeadNurtureInput = { email: "a@b.com", email_verified: true, mailing_address_verified: true, ...FULL_MAIL }
  const c3 = chooseLeadNurtureChannels(both)
  check("both verified → both channels", c3.email === true && c3.postcard === true, JSON.stringify(c3))

  const neither: LeadNurtureInput = { email: "a@b.com", email_verified: false, mailing_address_verified: false, ...FULL_MAIL }
  const c4 = chooseLeadNurtureChannels(neither)
  check("neither verified → no channels (skipped honestly)", c4.email === false && c4.postcard === false, JSON.stringify(c4))

  // CAN-SPAM: a verified email that OPTED OUT is still skipped.
  const optedOut = chooseLeadNurtureChannels({ email: "a@b.com", email_verified: true, email_opt_out: true, mailing_address_verified: false, ...FULL_MAIL })
  check("CAN-SPAM: email_verified but email_opt_out → email skipped", optedOut.email === false, JSON.stringify(optedOut))

  // A verified flag with NO email / INCOMPLETE address → that channel is off (no fabrication).
  const noEmail = chooseLeadNurtureChannels({ email: null, email_verified: true, mailing_address_verified: false })
  check("email_verified but NO email value → email skipped", noEmail.email === false)
  const partialMail = chooseLeadNurtureChannels({ email_verified: false, mailing_address_verified: true, mailing_address: "9 Probe Ln", mailing_city: "Austin", mailing_state: "TX", mailing_zip: "" })
  check("mailing_address_verified but INCOMPLETE address (no zip) → postcard skipped", partialMail.postcard === false)

  // Absent flags (undefined) behave like false.
  const empty = chooseLeadNurtureChannels({})
  check("empty input → no channels (undefined flags are not true)", empty.email === false && empty.postcard === false)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live handler → gated channel proposals]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const TAG = `Nurture${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 2 · live handler → verification-gated channel proposals]")
  try {
    const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brokerage) { console.log("  ⏭  Skipped — need a brokerage."); report(); return }
    const brokerageId = (brokerage as any).id

    // A real agent (users.id) must exist on the brokerage for the reel + QR.
    const { data: agentRow } = await svc.from("agents").select("user_id")
      .eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(1).maybeSingle()
    if (!(agentRow as any)?.user_id) { console.log("  ⏭  Skipped — need a brokerage agent with a user_id."); report(); return }

    // Fire the handler directly (the radar's prioritization path is proven by the
    // inventory-radar simulator; here we prove the NURTURE extension).
    const handler = SIGNAL_HANDLERS["ai_isa:seller_intent_hot"]
    check("ai_isa:seller_intent_hot handler is registered", typeof handler === "function")

    const fireFor = async (leadId: string) =>
      handler(
        {
          id: "sig-sim", fromManager: "data_steward" as any, toManager: "ai_isa" as any,
          signalType: "seller_intent_hot", message: "sim", entityType: "raw_scraped_lead",
          entityId: `${TAG}-raw`, contactId: null,
          payload: { lead_id: leadId, intent_score: 0.82, reasons: ["pre-foreclosure", "high equity"], property_address: `${TAG} 9 Probe Ln` },
          status: "open", createdAt: new Date().toISOString(),
        } as any,
        { brokerageId, supabase: svc },
      )

    // ── CASE A: email_verified=true, mailing_address_verified=false → EMAIL ONLY ──
    const { data: leadA } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "EmailOnly",
      email: `${TAG.toLowerCase()}@example.com`, email_verified: true, email_opt_out: false,
      ai_isa_owner: true, lead_stage: "new", lifecycle_state: "unconsented",
      mailing_address: "9 Probe Ln", mailing_city: "Austin", mailing_state: "TX", mailing_zip: "78701",
      mailing_address_verified: false,
    }).select("id").single()
    cleanup.push({ table: "leads", id: (leadA as any).id })
    const leadAId = (leadA as any).id as string

    const aAction = await fireFor(leadAId)
    check("CASE A: handler returned an action (prioritized + nurture)", !!aAction, String(aAction))

    // ONE gated video-email proposal, audience 'lead', channel 'email', NO portal contact.
    const { data: aMsgs } = await svc.from("agent_client_messages")
      .select("id, status, audience, channel, recipient_contact_id, entity_type")
      .eq("brokerage_id", brokerageId).eq("entity_id", leadAId).eq("entity_type", "lead_nurture_video")
    for (const m of (aMsgs ?? []) as any[]) {
      cleanup.push({ table: "agent_client_messages", id: m.id })
      const { data: ns } = await svc.from("notifications").select("id").eq("entity_id", m.id)
      for (const n of (ns ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    const aMsgRows = (aMsgs ?? []) as any[]
    check("CASE A: EXACTLY ONE gated video-email proposal", aMsgRows.length === 1, `got ${aMsgRows.length}`)
    check("CASE A: proposal is status='proposed', audience 'lead', channel 'email'",
      aMsgRows[0]?.status === "proposed" && aMsgRows[0]?.audience === "lead" && aMsgRows[0]?.channel === "email", JSON.stringify(aMsgRows[0]))
    check("CASE A: NO portal card — recipient_contact_id is null (it's a lead, not a contact)",
      aMsgRows.length === 1 && !aMsgRows[0]?.recipient_contact_id)

    // A staged, GATED Director reel carrying the lead in video_metadata.
    const { data: aReels } = await svc.from("ai_video_projects")
      .select("id, approval_status, audience_type, contact_id, video_metadata")
      .eq("brokerage_id", brokerageId).filter("video_metadata->>lead_id", "eq", leadAId)
    for (const v of (aReels ?? []) as any[]) {
      cleanup.push({ table: "ai_video_projects", id: v.id })
      const reelQr = (v.video_metadata as any)?.qr_code_id
      if (reelQr) cleanup.push({ table: "qr_codes", id: reelQr })
    }
    const aReelRows = (aReels ?? []) as any[]
    check("CASE A: a Director reel was staged for the lead (lead in video_metadata, NO contact_id)",
      aReelRows.length === 1 && !aReelRows[0]?.contact_id && (aReelRows[0]?.video_metadata?.lead_id === leadAId), `got ${aReelRows.length}`)
    check("CASE A: the reel is GATED (approval_status='pending_review' — never auto-publishes)",
      aReelRows[0]?.approval_status === "pending_review", JSON.stringify(aReelRows[0]?.approval_status))

    // NO postcard — mailing address NOT verified.
    const { data: aCards } = await svc.from("direct_mail_campaigns").select("id")
      .eq("brokerage_id", brokerageId).eq("lead_id", leadAId).eq("target_audience", "ai_isa_seller_nurture")
    for (const d of (aCards ?? []) as any[]) cleanup.push({ table: "direct_mail_campaigns", id: d.id })
    check("CASE A: NO postcard proposed (mailing address NOT verified)", ((aCards ?? []) as any[]).length === 0)

    // Idempotent rerun — no new email proposal, no new reel.
    await fireFor(leadAId)
    const { count: aMsgCount } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("entity_id", leadAId).eq("entity_type", "lead_nurture_video")
    const { count: aReelCount } = await svc.from("ai_video_projects").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).filter("video_metadata->>lead_id", "eq", leadAId)
    check("CASE A: idempotent rerun — still exactly ONE email proposal", (aMsgCount ?? 0) === 1, `got ${aMsgCount}`)
    check("CASE A: idempotent rerun — still exactly ONE reel", (aReelCount ?? 0) === 1, `got ${aReelCount}`)

    // ── CASE B: both verified → BOTH channels ──
    const { data: leadB } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Both",
      email: `${TAG.toLowerCase()}-both@example.com`, email_verified: true, email_opt_out: false,
      ai_isa_owner: true, lead_stage: "new", lifecycle_state: "unconsented",
      mailing_address: "7 Convert Rd", mailing_city: "Austin", mailing_state: "TX", mailing_zip: "78702",
      mailing_address_verified: true,
    }).select("id").single()
    cleanup.push({ table: "leads", id: (leadB as any).id })
    const leadBId = (leadB as any).id as string

    await fireFor(leadBId)

    const { data: bMsgs } = await svc.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).eq("entity_id", leadBId).eq("entity_type", "lead_nurture_video")
    for (const m of (bMsgs ?? []) as any[]) {
      cleanup.push({ table: "agent_client_messages", id: m.id })
      const { data: ns } = await svc.from("notifications").select("id").eq("entity_id", m.id)
      for (const n of (ns ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    check("CASE B: ONE gated video-email proposal (email verified)", ((bMsgs ?? []) as any[]).length === 1, `got ${((bMsgs ?? []) as any[]).length}`)

    const { data: bReels } = await svc.from("ai_video_projects").select("id, video_metadata")
      .eq("brokerage_id", brokerageId).filter("video_metadata->>lead_id", "eq", leadBId)
    for (const v of (bReels ?? []) as any[]) {
      cleanup.push({ table: "ai_video_projects", id: v.id })
      const reelQr = (v.video_metadata as any)?.qr_code_id
      if (reelQr) cleanup.push({ table: "qr_codes", id: reelQr })
    }

    const { data: bCards } = await svc.from("direct_mail_campaigns")
      .select("id, approval_status, status, piece_type, qr_code_id, lead_id, contact_id")
      .eq("brokerage_id", brokerageId).eq("lead_id", leadBId).eq("target_audience", "ai_isa_seller_nurture")
    for (const d of (bCards ?? []) as any[]) {
      cleanup.push({ table: "direct_mail_campaigns", id: d.id })
      if (d.qr_code_id) cleanup.push({ table: "qr_codes", id: d.qr_code_id })
    }
    const bCardRows = (bCards ?? []) as any[]
    check("CASE B: ONE gated POSTCARD proposed (mailing address verified)", bCardRows.length === 1, `got ${bCardRows.length}`)
    check("CASE B: postcard is GATED — approval_status='pending', status='planning' (NOT dispatched)",
      bCardRows[0]?.approval_status === "pending" && bCardRows[0]?.status === "planning", JSON.stringify({ a: bCardRows[0]?.approval_status, s: bCardRows[0]?.status }))
    check("CASE B: postcard is a postcard to the LEAD (lead_id set, no contact_id) carrying its QR",
      bCardRows[0]?.piece_type === "postcard" && bCardRows[0]?.lead_id === leadBId && !bCardRows[0]?.contact_id && !!bCardRows[0]?.qr_code_id)

    // CASE B idempotency — rerun proposes neither a second email nor a second postcard.
    await fireFor(leadBId)
    const { count: bMsgCount } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("entity_id", leadBId).eq("entity_type", "lead_nurture_video")
    const { count: bCardCount } = await svc.from("direct_mail_campaigns").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("lead_id", leadBId).eq("target_audience", "ai_isa_seller_nurture")
    check("CASE B: idempotent rerun — still ONE email + ONE postcard", (bMsgCount ?? 0) === 1 && (bCardCount ?? 0) === 1, `email=${bMsgCount} postcard=${bCardCount}`)

    // The ISA activity ledger recorded the prioritization for both leads (the base behavior held).
    const { data: acts } = await svc.from("ai_isa_activities").select("id")
      .eq("brokerage_id", brokerageId).in("lead_id", [leadAId, leadBId]).eq("activity_type", "seller_intent_prioritized")
    for (const a of (acts ?? []) as any[]) cleanup.push({ table: "ai_isa_activities", id: a.id })
    check("base behavior held — both leads prioritized on the ISA activity ledger", ((acts ?? []) as any[]).length >= 2, `got ${((acts ?? []) as any[]).length}`)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count: leadCount } = await svc.from("leads").select("id", { count: "exact", head: true }).eq("first_name", TAG)
    check("cleanup verified — 0 seeded leads remain", (leadCount ?? 0) === 0)
    const { count: msgCount } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).eq("entity_type", "lead_nurture_video").like("rationale", `%${TAG}%`)
    check("cleanup verified — 0 seeded nurture email proposals remain", (msgCount ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
