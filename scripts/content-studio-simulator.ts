#!/usr/bin/env tsx
/**
 * scripts/content-studio-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONTENT STUDIO harness — proves the Asset Manager's command surface over
 * the AI creative team. The Video Director stamps the WHOLE creative decision onto
 * each staged ai_video_projects row (composition, channels/aspect, music mood,
 * format_source + WHY, the hook A/B, the outro QR, the sourced B-roll); the studio
 * aggregator surfaces those reels grouped (pending_review / approved) with the right
 * badges, rolls up the hook A/B with its crowned winner, and one-click approves
 * through the REAL existing ai_video_projects gate. Built on the
 * campaign-center-simulator pure+live template; reuses the just-shipped Director +
 * format-learning; NO mocks, NO demo data, real rows, reverse-delete cleanup.
 *
 * Layer 1 (pure, always runs):
 *   · captionStateOf / hasQrOf / brollCountOf — the per-reel badge derivations.
 *   · shapeStudioItem — one raw row → the typed studio item with all badges.
 *   · groupStudioItems — fold into groups + counts + by-composition.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *   · seed a few Director-staged ai_video_projects rows (one plain reel with QR +
 *     B-roll + format-learned WHY; a 2-variant hook A/B experiment with QR scans so
 *     a winner is crowned), loadContentStudio surfaces them grouped with the right
 *     badges + the experiment winner.
 *   · approveContentItem flips ONE through the real gate (pending_review → approved);
 *     re-approve is idempotent (no-op success).
 *   · reverse-delete EVERY seeded row + verify cleanup count == 0.
 *
 * Run: npx tsx scripts/content-studio-simulator.ts  (npm run test:content-studio)
 */
import {
  captionStateOf,
  hasQrOf,
  brollCountOf,
  shapeStudioItem,
  groupStudioItems,
  loadContentStudio,
  approveContentItem,
  type ContentStudioItem,
} from "../lib/kernel/content-studio"
import { MIN_FORMAT_SAMPLE } from "../lib/video/format-learning"

let passed = 0, failed = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { passed++; console.log(`  ✓ ${n}`) }
  else { failed++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}
const report = () => {
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) }
  console.log(" ✅ Content Studio verified")
}

async function main() {
  console.log("══ Content Studio simulator ══\n[Layer 1 · pure shaping + badges]")

  // captionStateOf — gated script → captioned; ungated script → script_only; none.
  check("captionStateOf: gated script → captioned", captionStateOf("Just Listed", "passed") === "captioned")
  check("captionStateOf: ungated script → script_only", captionStateOf("Just Listed", "pending") === "script_only")
  check("captionStateOf: no script → none", captionStateOf("", "passed") === "none" && captionStateOf(null, null) === "none")

  // hasQrOf — present qr_code_id → true; absent/empty → false.
  check("hasQrOf: qr_code_id present → true", hasQrOf({ qr_code_id: "qr-123" }) === true)
  check("hasQrOf: absent/empty → false", hasQrOf({ qr_code_id: null }) === false && hasQrOf({}) === false && hasQrOf(null) === false)

  // brollCountOf — reads the Director's stamp; falls back to clip array length.
  check("brollCountOf: reads broll_sourced_count", brollCountOf({ broll_sourced_count: 3 }) === 3)
  check("brollCountOf: falls back to clip array", brollCountOf({ broll_clips: [{}, {}] }) === 2)
  check("brollCountOf: none → 0", brollCountOf({}) === 0 && brollCountOf(null) === 0)

  // shapeStudioItem — one raw Director row → the typed studio item.
  const raw = {
    id: "v1", title: "Just Listed — JustListedReelSquare",
    video_type: "just_listed", script_content: "Just Listed", compliance_status: "passed",
    created_at: "2026-06-12T00:00:00Z",
    video_metadata: {
      composition_id: "JustListedReelSquare", aspect: "vertical", target_channels: ["tiktok", "instagram"],
      music_mood: "sophisticated", format_source: "learned", format_why: "Learned: square+B-roll won here.",
      qr_code_id: "qr-1", broll_sourced_count: 2, requested_via: "asset_manager",
    },
  }
  const item = shapeStudioItem(raw, "pending_review")
  check("shapeStudioItem: composition + aspect + channels", item.composition === "JustListedReelSquare" && item.aspect === "vertical" && item.targetChannels.length === 2)
  check("shapeStudioItem: mood + format source + WHY", item.musicMood === "sophisticated" && item.formatSource === "learned" && !!item.formatWhy)
  check("shapeStudioItem: caption + QR + B-roll flags", item.captionState === "captioned" && item.hasQr && item.hasBroll && item.brollCount === 2)

  // groupStudioItems — groups + counts + by-composition.
  const items: ContentStudioItem[] = [
    item,
    { ...item, id: "v2", group: "pending_review" },
    { ...item, id: "v3", group: "approved" },
  ]
  const grouped = groupStudioItems(items)
  check("groupStudioItems: 2 pending / 1 approved", grouped.pendingCount === 2 && grouped.approvedCount === 1 && grouped.total === 3)
  check("groupStudioItems: by-composition counts pending only", grouped.byComposition["JustListedReelSquare"] === 2)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n[Layer 2] ⏭ no creds"); report(); return }

  console.log("\n[Layer 2 · live: real Director-staged rows, real gate]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `CS${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭ need an agent"); report(); return }
    const brokerageId = (agent as any).brokerage_id as string
    const agentUserId = (agent as any).user_id as string // ai_video_projects.agent_id FK → users.id
    const agentRowId = (agent as any).id as string       // qr_codes.agent_id FK → agents.id

    // ── Seed 1: a plain Director-staged reel — QR + B-roll + a learned WHY. ──────
    const { data: plain } = await svc.from("ai_video_projects").insert({
      brokerage_id: brokerageId, agent_id: agentUserId,
      title: `${TAG} Just Listed`, script_content: "Just Listed", status: "queued",
      video_type: "just_listed", format: "9:16", audience_type: "customer_facing",
      is_ai_generated: true, approval_status: "pending_review",
      compliance_status: "passed",
      video_metadata: {
        director_key: `${TAG}:plain`,
        composition_id: "JustListedReelSquare", aspect: "vertical", target_channels: ["tiktok", "instagram"],
        music_mood: "sophisticated", format_source: "learned",
        format_why: "Learned: square + B-roll outperformed horizontal here.",
        qr_code_id: `${TAG}-qr`, broll_sourced_count: 2, requested_via: "asset_manager",
      },
    }).select("id").single()
    cleanup.push({ table: "ai_video_projects", id: (plain as any).id })

    // ── Seed 2: a 2-variant hook A/B experiment sharing an experiment_id. One QR
    //    per variant; the winner's QR gets enough real scans to clear the gate. ──
    const experimentId = `${TAG}:hookexp`
    const mkQr = async (label: string) => {
      const { data } = await svc.from("qr_codes").insert({
        brokerage_id: brokerageId, agent_id: agentRowId, label,
        slug: label.toLowerCase(), target_url: "https://app.example.com/x",
        purpose: "general", destination_type: "listing_detail", is_active: true, scan_count: 0, lead_count: 0,
      }).select("id").single()
      cleanup.push({ table: "qr_codes", id: (data as any).id })
      return (data as any).id as string
    }
    const qrV0 = await mkQr(`${TAG}-v0`)
    const qrV1 = await mkQr(`${TAG}-v1`)

    const mkVariant = async (variantIndex: number, angle: string, qrId: string) => {
      const { data } = await svc.from("ai_video_projects").insert({
        brokerage_id: brokerageId, agent_id: agentUserId,
        title: `${TAG} hook v${variantIndex} (${angle})`, script_content: "Buyers Are Already Asking",
        status: "queued", video_type: "just_listed", format: "9:16",
        audience_type: "customer_facing", is_ai_generated: true, approval_status: "pending_review",
        compliance_status: "passed",
        video_metadata: {
          director_key: `${experimentId}:v${variantIndex}`, experiment_id: experimentId,
          variant_index: variantIndex, hook_angle: angle, hook_variant: "Buyers Are Already Asking",
          hook_source: "default", hook_why: "Default angle order (curiosity-first).",
          composition_id: "JustListedReelSquare", aspect: "vertical", target_channels: ["tiktok"],
          music_mood: "sophisticated", qr_code_id: qrId, requested_via: "asset_manager",
        },
      }).select("id").single()
      cleanup.push({ table: "ai_video_projects", id: (data as any).id })
      return (data as any).id as string
    }
    await mkVariant(0, "curiosity", qrV0)
    await mkVariant(1, "social_proof", qrV1)

    // Real scans: v0 gets 1, v1 gets many → v1 crosses the sample+margin gate.
    await svc.from("qr_scan_events").insert({ qr_code_id: qrV0, brokerage_id: brokerageId, is_first_scan: true })
    const winnerScans = MIN_FORMAT_SAMPLE + 30
    for (let i = 0; i < winnerScans; i++) {
      const { data: sc } = await svc.from("qr_scan_events").insert({
        qr_code_id: qrV1, brokerage_id: brokerageId, is_first_scan: i === 0,
      }).select("id").single()
      cleanup.push({ table: "qr_scan_events", id: (sc as any).id })
    }

    // ── loadContentStudio surfaces the seeded reels grouped + badged. ───────────
    const data = await loadContentStudio(brokerageId, svc)
    const mine = data.items.filter((i) => i.title.startsWith(TAG))
    check("loadContentStudio: surfaced all 3 Director-staged reels", mine.length === 3)
    check("all surfaced reels are PENDING (gated, never auto-approved)", mine.every((i) => i.group === "pending_review"))

    const plainItem = mine.find((i) => i.id === (plain as any).id)!
    check("plain reel: composition + aspect + channels badged", plainItem.composition === "JustListedReelSquare" && plainItem.aspect === "vertical" && plainItem.targetChannels.includes("tiktok"))
    check("plain reel: mood + learned format source + WHY", plainItem.musicMood === "sophisticated" && plainItem.formatSource === "learned" && !!plainItem.formatWhy)
    check("plain reel: captioned ✓ / QR ✓ / B-roll ✓", plainItem.captionState === "captioned" && plainItem.hasQr && plainItem.hasBroll && plainItem.brollCount === 2)
    check("by-composition surfaced the pending composition", (data.byComposition["JustListedReelSquare"] ?? 0) >= 3)

    // The hook A/B experiment rolled up with the crowned winner (real gated data).
    const exp = data.experiments.find((e) => e.experimentId === experimentId)
    check("experiment surfaced with both variants", !!exp && exp.variants.length === 2)
    check("experiment crowned variant 1 (social_proof) as the winner — real scans cleared the gate",
      !!exp && exp.winnerVariantIndex === 1 && exp.variants.find((v) => v.variantIndex === 1)?.isWinner === true,
      `winner=${exp?.winnerVariantIndex} why=${exp?.why}`)

    // ── approveContentItem flips ONE reel through the REAL gate. ────────────────
    const r1 = await approveContentItem(brokerageId, (plain as any).id, agentUserId, svc)
    const { data: after } = await svc.from("ai_video_projects").select("approval_status, approved_by").eq("id", (plain as any).id).single()
    check("approve: plain reel flipped pending_review → approved through the real gate",
      r1.ok && (after as any).approval_status === "approved" && (after as any).approved_by === agentUserId)

    // Idempotent: re-approving is a no-op success (state already approved).
    const r2 = await approveContentItem(brokerageId, (plain as any).id, agentUserId, svc)
    check("approve idempotent: re-approve is a no-op success", r2.ok === true)

    // Cross-tenant fence: a bogus brokerage can't flip the reel.
    const r3 = await approveContentItem("00000000-0000-0000-0000-000000000000", (plain as any).id, agentUserId, svc)
    check("approve fenced: another brokerage cannot approve this reel", r3.ok === false)

    // After approval, the reel moves to the 'approved' group on reload.
    const data2 = await loadContentStudio(brokerageId, svc)
    const plainAfter = data2.items.find((i) => i.id === (plain as any).id)
    check("reload: approved reel now in the approved group", !!plainAfter && plainAfter.group === "approved")
  } finally {
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch {} }
    const { count } = await svc.from("ai_video_projects").select("id", { count: "exact", head: true }).like("title", `${TAG}%`)
    check("cleanup verified — no seeded reels remain (count == 0)", (count ?? 0) === 0, `count=${count}`)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
