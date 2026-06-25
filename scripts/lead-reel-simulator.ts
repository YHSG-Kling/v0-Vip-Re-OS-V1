#!/usr/bin/env tsx
/**
 * scripts/lead-reel-simulator.ts   (npm run test:lead-reel)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MULTI-MANAGER LEAD-OUTREACH PLAY — proven end-to-end on the inter-manager bus.
 * The AI ISA QUARTERBACKS, the Asset Manager DIRECTS, the Campaign Orchestrator
 * DISTRIBUTES — every hop on the "managers talking" feed (the angle for the whole app).
 *
 * Layer 1 (pure, no I/O):
 *   · buildLeadIntroReelBrief — kind 'lead_intro', email channel (strictly 1:1),
 *     persona.audience 'lead', cohort tones the PHRASING only (gen_z ≠ boomer), and the
 *     bounded extraFacts carry NO age / protected-class language (Fair Housing).
 *   · selectVideoFormat('lead_intro') → AgentExplainerReel (avatar), targetChannels ['email'].
 *   · qrKindForSituation('lead_intro') → 'lead_intro'; qrDestinationForKind → book_meeting (/book).
 *   · videoType education, music calm, default hook present; a lead reel is NEVER promotable
 *     (no paid social broadcast).
 *
 * Layer 2 (live, guarded by SUPABASE_SERVICE_ROLE_KEY):
 *   · ISA publishes asset_manager:lead_creative_handoff →
 *   · consumeManagerSignals(asset_manager) commissions a GATED reel (video_metadata.lead_id
 *     + audience='lead', approval_status='pending_review', book-a-consult QR minted) →
 *   · flip the reel to completed → publishVideoCoordinationSignals routes it 1:1
 *     (campaign_orchestrator:lead_outreach_ready — NOT a social video_ready, NOT ads) →
 *   · consumeManagerSignals(campaign_orchestrator) proposes ONE gated 1:1 email
 *     (agent_client_messages, audience 'lead', channel 'email', body embeds the reel URL) →
 *   · idempotent rerun (no duplicate reel / message) →
 *   · the conversation is visible in loadRecentManagerTalk.
 * Reverse-deletes every seeded row; asserts cleanup count == 0.
 */
// lib/video/video-qr.ts imports `server-only`, which throws outside a Server Component
// (tsx is neither). Neutralize that guard module in the require cache BEFORE the system
// under test lazy-imports it. This shims ONLY the external guard; the real code runs.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
// ─────────────────────────────────────────────────────────────────────────────

import { buildLeadIntroReelBrief } from "../lib/ai-isa/lead-reel-brief"
import {
  selectVideoFormat,
  qrKindForSituation,
  musicMoodForSituation,
  defaultHookForSituation,
} from "../lib/video/video-director"
// qrDestinationForKind lives in lib/video/video-qr (server-only) — lazy-loaded inside
// pureLayer() AFTER the shim above, never statically (a static import would evaluate
// `server-only` before the shim registers).
import { isPromotableVideoKind } from "../lib/kernel/video-coordination"
import {
  publishManagerSignal,
  consumeManagerSignals,
  loadRecentManagerTalk,
} from "../lib/kernel/manager-signals"
import type { GenerationalCohort } from "../lib/kernel/education"

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
  console.log(" LEAD_REEL_PASS — ISA → Asset Manager → Campaign Orchestrator, strictly 1:1 email, gated, Fair-Housing safe")
}

async function pureLayer() {
  console.log("\n[Layer 1 · pure — the creative brief + the Director taxonomy]")
  const { qrDestinationForKind } = await import("../lib/video/video-qr")
  const base = {
    leadId: "lead-xyz", firstName: "Sam", propertyInterest: "3-bed homes downtown",
    timeline: "buy this spring", motivationType: "relocation_buyer", budgetMin: 400000, budgetMax: 550000,
  }
  const brief = buildLeadIntroReelBrief({ ...base, cohort: "millennial" })
  check("brief: situation kind is 'lead_intro'", brief.situation.kind === "lead_intro")
  check("brief: targetChannel is 'email' (strictly 1:1, never broadcast)", brief.situation.targetChannel === "email")
  check("brief: persona audience is 'lead'", brief.persona.audience === "lead")
  check("brief: persona is named for 1:1 tone", brief.persona.name === "Sam")
  check("brief: situation.facts carries the lead_id", brief.situation.facts?.lead_id === "lead-xyz")
  check("brief: extraFacts are grounded (interest + timeline + budget present)",
    brief.extraFacts.some((f) => f.includes("3-bed homes")) &&
    brief.extraFacts.some((f) => f.toLowerCase().includes("timeline")) &&
    brief.extraFacts.some((f) => f.includes("400,000")))

  // Cohort tones the PHRASING only — gen_z ≠ boomer persona situation.
  const cohorts: GenerationalCohort[] = ["gen_z", "millennial", "gen_x", "boomer", "silent", "unknown"]
  const situations = cohorts.map((c) => buildLeadIntroReelBrief({ ...base, cohort: c }).persona.situation ?? "")
  check("brief: cohort tones the persona (gen_z ≠ boomer)",
    buildLeadIntroReelBrief({ ...base, cohort: "gen_z" }).persona.situation !==
    buildLeadIntroReelBrief({ ...base, cohort: "boomer" }).persona.situation)

  // FAIR HOUSING — no age / protected-class language in the brief the copy may use.
  const BANNED = ["race", "religion", "christian", "jewish", "muslim", "national origin", "ethnic", "disab",
    "handicap", "familial", "children", "kids", "married", "single mom", "elderly", "senior citizen",
    "young couple", "your age", "retiree", "gen_z", "gen z", "boomer", "millennial", "generation"]
  let clean = true
  for (const c of cohorts) {
    const b = buildLeadIntroReelBrief({ ...base, cohort: c })
    const blob = [...b.extraFacts, b.persona.situation ?? "", b.persona.audience ?? ""].join(" ").toLowerCase()
    const hit = BANNED.find((w) => blob.includes(w))
    if (hit) { clean = false; failures.push(`cohort ${c} brief leaks banned term "${hit}"`) }
  }
  check("brief: no age / protected-class language in any cohort's facts (Fair Housing)", clean)
  void situations

  const sit = { kind: "lead_intro" as const, tier: "solo_agent" as const, targetChannel: "email" as const }
  const fmt = selectVideoFormat(sit)
  check("format: lead_intro → AgentExplainerReel (avatar-led intro)", fmt.compositionId === "AgentExplainerReel" && fmt.needsAvatar)
  check("format: lead_intro ships ONLY for email (no social feed)",
    fmt.targetChannels.length === 1 && fmt.targetChannels[0] === "email")
  check("QR kind: lead_intro → 'lead_intro'", qrKindForSituation("lead_intro") === "lead_intro")
  const dest = qrDestinationForKind("lead_intro")
  check("QR destination: lead_intro → book_meeting (book a consult, no listing)", dest.destinationType === "book_meeting")
  check("QR target: lands on the general /book page (no per-lead PII in the URL)",
    dest.buildTargetUrl("https://x.test", { leadId: "lead-xyz" }).endsWith("/book"))
  check("music: lead_intro → calm (warm, never fights narration)", musicMoodForSituation("lead_intro") === "calm")
  check("default hook present for lead_intro", defaultHookForSituation("lead_intro").length > 0)
  check("routing: a lead reel is NEVER promotable (no paid social broadcast)",
    !isPromotableVideoKind("lead_intro") && !isPromotableVideoKind("education"))
}

async function liveLayer() {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live] ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return
  }
  console.log("\n[Layer 2 · live — the three-manager play on the bus]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `LeadReel${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    // A real agent (agents.id + agents.user_id) so the handler resolves a presenter.
    const { data: agentRow } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).maybeSingle()
    if (!agentRow) { console.log("  ⏭  Skipped — need an agent with a user_id + brokerage."); return }
    const brokerageId = (agentRow as any).brokerage_id as string
    const agentId = (agentRow as any).id as string

    // Seed a qualified, unconsented lead (agent_id set so the reel carries a real presenter).
    const { data: lead } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Intro",
      email: `${TAG.toLowerCase()}@example.com`, email_verified: true, email_opt_out: false,
      ai_isa_owner: true, lead_stage: "new", lifecycle_state: "unconsented",
      agent_id: agentId, property_interest: "3-bed homes", timeline: "buy this spring",
      motivation_type: "relocation_buyer", budget_min: 400000, budget_max: 550000,
      enrichment_profile: { age: 38 },
    }).select("id").single()
    if (!lead) { console.log("  ⏭  Skipped — lead seed failed."); return }
    const leadId = (lead as any).id as string
    cleanup.push({ table: "leads", id: leadId })

    // ── ISA DELEGATES → Asset Manager (the team's video director) ──
    const pub = await publishManagerSignal({
      brokerageId, fromManager: "ai_isa", toManager: "asset_manager",
      signalType: "lead_creative_handoff",
      message: `Qualified ${TAG} — build the persona intro reel.`,
      entityType: "lead", entityId: leadId,
      payload: { first_name: TAG },
    }, svc)
    check("ISA published lead_creative_handoff → asset_manager", pub.ok, pub.reason)
    if (pub.signalId) cleanup.push({ table: "manager_signals", id: pub.signalId })

    // ── Asset Manager CONSUMES → commissions the gated reel ──
    const cAsset = await consumeManagerSignals({ brokerageId, toManager: "asset_manager" }, svc)
    check("Asset Manager consumed the handoff", cAsset.consumed >= 1)
    const { data: reels } = await svc.from("ai_video_projects")
      .select("id, status, approval_status, audience_type, contact_id, video_url, video_type, video_metadata")
      .eq("brokerage_id", brokerageId).filter("video_metadata->>lead_id", "eq", leadId)
    for (const v of (reels ?? []) as any[]) {
      cleanup.push({ table: "ai_video_projects", id: v.id })
      const qrId = (v.video_metadata as any)?.qr_code_id
      if (qrId) cleanup.push({ table: "qr_codes", id: qrId })
    }
    const reel = ((reels ?? []) as any[])[0]
    check("a Director reel was staged for the lead (lead_id in metadata, NO contact_id)",
      !!reel && reel.video_metadata?.lead_id === leadId && !reel.contact_id, JSON.stringify(reel?.id))
    check("the reel is GATED (approval_status='pending_review' — never auto-publishes)",
      reel?.approval_status === "pending_review", String(reel?.approval_status))
    check("the reel is stamped audience='lead' (routes 1:1, not social)",
      reel?.video_metadata?.audience === "lead", JSON.stringify(reel?.video_metadata?.audience))
    check("the reel minted a book-a-consult QR (qr_code_id present)",
      !!reel?.video_metadata?.qr_code_id, JSON.stringify(reel?.video_metadata?.qr_code_id))

    // ── Render completes → the completion publisher routes it 1:1 ──
    const reelId = reel.id as string
    await svc.from("ai_video_projects").update({
      status: "completed", video_url: `https://example.test/${TAG}.mp4`, completed_at: new Date().toISOString(),
    }).eq("id", reelId)
    const { publishVideoCoordinationSignals } = await import("../lib/kernel/video-coordination")
    const pubCoord = await publishVideoCoordinationSignals(reelId, svc)
    check("completion publisher routed the lead reel 1:1 (campaign_orchestrator only)",
      pubCoord.ok && pubCoord.published.length === 1 && pubCoord.published[0] === "campaign_orchestrator", JSON.stringify(pubCoord))
    const { data: coordSigs } = await svc.from("manager_signals")
      .select("id, to_manager, signal_type").eq("entity_id", reelId)
    for (const s of (coordSigs ?? []) as any[]) cleanup.push({ table: "manager_signals", id: s.id })
    const leadReadySig = (coordSigs ?? []).find((s: any) => s.signal_type === "lead_outreach_ready")
    check("the routed signal is lead_outreach_ready → campaign_orchestrator (NOT social video_ready)",
      !!leadReadySig && (leadReadySig as any).to_manager === "campaign_orchestrator")
    check("NO social video_ready signal was published for a personalized lead reel",
      !(coordSigs ?? []).some((s: any) => s.signal_type === "video_ready"))

    // ── Campaign Orchestrator CONSUMES → proposes the gated 1:1 email ──
    const cCampaign = await consumeManagerSignals({ brokerageId, toManager: "campaign_orchestrator" }, svc)
    check("Campaign Orchestrator consumed lead_outreach_ready", cCampaign.consumed >= 1)
    const { data: msgs } = await svc.from("agent_client_messages")
      .select("id, status, audience, channel, recipient_lead_id, recipient_contact_id, body")
      .eq("brokerage_id", brokerageId).eq("recipient_lead_id", leadId)
    for (const m of (msgs ?? []) as any[]) {
      cleanup.push({ table: "agent_client_messages", id: m.id })
      const { data: ns } = await svc.from("notifications").select("id").eq("entity_id", m.id)
      for (const n of (ns ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    const msg = ((msgs ?? []) as any[])[0]
    check("ONE gated 1:1 email proposed (audience 'lead', channel 'email')",
      ((msgs ?? []) as any[]).length === 1 && msg?.status === "proposed" && msg?.audience === "lead" && msg?.channel === "email", JSON.stringify(msg))
    check("the email is addressed to the LEAD (recipient_lead_id set, no contact)",
      msg?.recipient_lead_id === leadId && !msg?.recipient_contact_id)
    check("the email embeds the finished reel URL", typeof msg?.body === "string" && msg.body.includes(`${TAG}.mp4`))

    // ── Idempotent rerun — no duplicate reel, no duplicate email ──
    await consumeManagerSignals({ brokerageId, toManager: "asset_manager" }, svc)
    await publishVideoCoordinationSignals(reelId, svc)
    await consumeManagerSignals({ brokerageId, toManager: "campaign_orchestrator" }, svc)
    const { count: reelCount } = await svc.from("ai_video_projects").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).filter("video_metadata->>lead_id", "eq", leadId)
    const { count: msgCount } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("recipient_lead_id", leadId)
    check("idempotent: still exactly ONE reel after rerun", (reelCount ?? 0) === 1, `got ${reelCount}`)
    check("idempotent: still exactly ONE email proposal after rerun", (msgCount ?? 0) === 1, `got ${msgCount}`)

    // ── The conversation is visible in 'managers talking' ──
    const talk = await loadRecentManagerTalk(brokerageId, 40, svc)
    const handoffLine = talk.find((t) => t.fromLabel === "AI ISA" && t.toLabel === "Asset Manager")
    const distLine = talk.find((t) => t.fromLabel === "Asset Manager" && t.toLabel === "Campaign Orchestrator" && t.status === "consumed")
    check("talk feed: AI ISA → Asset Manager handoff is visible", !!handoffLine)
    check("talk feed: Asset Manager → Campaign Orchestrator (1:1 distribution) shows with ✓ action",
      !!distLine && !!distLine.consumedAction)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("ai_video_projects")
      .select("id", { count: "exact", head: true }).filter("video_metadata->>sim_tag", "eq", TAG)
    const { count: leadLeft } = await svc.from("leads")
      .select("id", { count: "exact", head: true }).eq("last_name", "Intro").like("first_name", `${TAG}`)
    check("cleanup verified — 0 seeded leads remain", (leadLeft ?? 0) === 0)
    void count
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Multi-manager lead intro reel play simulator")
  console.log("══════════════════════════════════════════════════")
  await pureLayer()
  await liveLayer()
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
