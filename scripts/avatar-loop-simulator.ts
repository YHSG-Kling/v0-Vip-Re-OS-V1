#!/usr/bin/env tsx
/**
 * scripts/avatar-loop-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — avatar/explainer loop handoff harness. Proves the D-ID → Remotion
 * link that was broken: a completed D-ID talking-head video must flow into a
 * Remotion composition render's input_props.avatarVideoUrl (so
 * AgentTalkingHeadReel / AgentExplainerReel render the real avatar instead of a
 * static photo).
 *
 *   Layer 1 — pure buildAvatarRenderRow: avatar (+ voiceover) URL merged into
 *     input_props, used_did_avatar/used_voiceover flags, queued status, agent
 *     scope.
 *   Layer 2 — live handoff (gated): seed a completed ai_video_projects with a
 *     target_composition_id, run enqueueAvatarCompositionForProject, and assert
 *     a queued remotion_composition_renders row exists carrying the avatar URL
 *     in input_props. Also asserts a project WITHOUT a target is skipped.
 *     Self-cleans.
 *
 * Run:  npx tsx scripts/avatar-loop-simulator.ts   (npm run test:avatar-loop)
 */
import { buildAvatarRenderRow } from "../lib/video/avatar-render-orchestrator"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testBuildRow() {
  console.log("\n[Layer 1 · buildAvatarRenderRow]")
  const row = buildAvatarRenderRow({
    brokerageId: "brk", agentId: "agt", compositionId: "AgentTalkingHeadReel",
    avatarVideoUrl: "https://cdn/clean.mp4", voiceoverUrl: "https://cdn/vo.mp3",
    extraInputProps: { headline: "Just Listed" },
  })
  const props = row.input_props as Record<string, unknown>
  check("avatar URL wired into input_props", props.avatarVideoUrl === "https://cdn/clean.mp4")
  check("voiceover URL wired into input_props", props.voiceoverUrl === "https://cdn/vo.mp3")
  check("caller's extra props preserved", props.headline === "Just Listed")
  check("used_did_avatar flag set", row.used_did_avatar === true)
  check("used_voiceover reflects voiceover presence", row.used_voiceover === true)
  check("enqueued as 'queued'", row.render_status === "queued")
  check("agent scope set", row.scope_type === "agent" && row.scope_id === "agt")
  check("requested_via is a valid allowlist value (cron)", row.requested_via === "cron")
  check("not published on creation", row.is_published === false)

  const noVo = buildAvatarRenderRow({ brokerageId: "b", agentId: "a", compositionId: "X", avatarVideoUrl: "u" })
  check("no voiceover → used_voiceover false + null in props", noVo.used_voiceover === false && (noVo.input_props as any).voiceoverUrl === null)
}

async function testLiveHandoff() {
  console.log("\n[Layer 2 · live D-ID → Remotion handoff]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer still ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { enqueueAvatarCompositionForProject } = await import("../lib/video/avatar-render-orchestrator")
  const svc = createServiceClient()
  const TAG = `__avatarsim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    // ai_video_projects.agent_id FK-references users(id) (the agent-as-user).
    const { data: agent } = await svc.from("users").select("id").limit(1).single()
    const { data: comp } = await svc.from("remotion_compositions").select("composition_id").limit(1).single()
    if (!brk || !agent || !comp) { console.log("  ⏭  Skipped — need a brokerage + user + composition."); return }
    const brokerageId = (brk as any).id
    const agentId = (agent as any).id
    const compositionId = (comp as any).composition_id

    // Seed a completed D-ID project that targets a composition.
    const cleanUrl = `https://example.test/${TAG}clean.mp4`
    const { data: project, error: pErr } = await svc.from("ai_video_projects").insert({
      agent_id: agentId, brokerage_id: brokerageId, title: `${TAG}project`, status: "completed",
      video_url: cleanUrl,
      provider_metadata: { provider: "did", target_composition_id: compositionId, clean_video_url: cleanUrl, voiceover_url: `https://example.test/${TAG}vo.mp3` },
    }).select("id").single()
    check("seed completed D-ID project", !pErr && !!project, pErr?.message)
    if (!project) throw new Error("project seed failed")
    cleanup.push({ table: "ai_video_projects", id: (project as any).id })

    // Run the handoff.
    const res = await enqueueAvatarCompositionForProject((project as any).id, svc)
    check("handoff enqueues a render", res.ok === true, res.ok ? "" : res.skipped)
    if (!res.ok) throw new Error(res.skipped)
    cleanup.push({ table: "remotion_composition_renders", id: res.renderId })

    // Verify the render row carries the avatar URL.
    const { data: render } = await svc.from("remotion_composition_renders")
      .select("composition_id, render_status, used_did_avatar, input_props").eq("id", res.renderId).single()
    const props = (render as any)?.input_props ?? {}
    check("render targets the requested composition", (render as any)?.composition_id === compositionId)
    check("render is queued for the drain cron", (render as any)?.render_status === "queued")
    check("render flagged used_did_avatar", (render as any)?.used_did_avatar === true)
    check("avatar URL landed in input_props (the broken link is fixed)", props.avatarVideoUrl === cleanUrl)
    check("voiceover URL landed in input_props", typeof props.voiceoverUrl === "string")

    // Negative: a project with no target_composition_id is skipped (backward compatible).
    const { data: bare } = await svc.from("ai_video_projects").insert({
      agent_id: agentId, brokerage_id: brokerageId, title: `${TAG}bare`, status: "completed",
      video_url: cleanUrl, provider_metadata: { provider: "did" },
    }).select("id").single()
    if (bare) {
      cleanup.push({ table: "ai_video_projects", id: (bare as any).id })
      const skip = await enqueueAvatarCompositionForProject((bare as any).id, svc)
      check("project without target_composition_id is skipped (no spurious render)", skip.ok === false)
    }
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("ai_video_projects").select("id", { count: "exact", head: true }).like("title", `${TAG}%`)
    check("cleanup verified — 0 seeded projects remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Avatar loop simulator (D-ID → Remotion handoff)")
  console.log("══════════════════════════════════════════════════")
  testBuildRow()
  await testLiveHandoff()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Avatar loop handoff verified (D-ID URL reaches Remotion input_props)")
}
main().catch((e) => { console.error(e); process.exit(1) })
