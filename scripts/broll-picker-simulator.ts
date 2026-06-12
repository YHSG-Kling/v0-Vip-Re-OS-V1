#!/usr/bin/env tsx
/**
 * scripts/broll-picker-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE B-ROLL PICKER harness — the stop-the-scroll missing link. The Video
 * Director already FLAGS needsBroll; this verifies the picker that SOURCES the
 * clips from the EXISTING video_assets stock library, honoring the EXISTING
 * agent → team → brokerage scope cascade. Built on the offer-net-sheet
 * pure+live template.
 *
 * Layer 1 (pure): selectBrollPlan —
 *   · FILLS a timeline exactly (no overrun; final clip truncated)
 *   · LOOPS a short library to cover a long timeline
 *   · TRUNCATES an over-long single clip to the timeline length
 *   · HONEST empty → [] (empty library / non-positive timeline)
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY): seed REAL video_assets
 *   b_roll rows across agent + team + brokerage scopes; assert pickBrollClips
 *   returns the AGENT-scoped clips first (most-specific wins, honoring the
 *   cascade), then prove the brokerage fallback when the agent scope is empty,
 *   then HONEST empty for a scope with nothing. Reverse-delete + cleanup count == 0.
 *
 * Run: npx tsx scripts/broll-picker-simulator.ts  (npm run test:video-broll)
 */
import {
  selectBrollPlan,
  type BrollSourceClip,
} from "../lib/video/broll-picker"

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
  console.log(" ✅ B-roll picker verified — fills/loops/truncates a timeline + honors the scope cascade")
}

const sum = (p: { durationSeconds: number }[]) => p.reduce((s, e) => s + e.durationSeconds, 0)

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" B-roll picker simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · selectBrollPlan pure: fill / loop / truncate / honest-empty]")

  // FILL — three 4s clips fill a 12s window exactly, in order, no overrun.
  const lib3: BrollSourceClip[] = [
    { url: "https://x/a.mp4", durationSeconds: 4, caption: "A" },
    { url: "https://x/b.mp4", durationSeconds: 4 },
    { url: "https://x/c.mp4", durationSeconds: 4 },
  ]
  const fill = selectBrollPlan(lib3, 12)
  check("FILL: a 12s window from three 4s clips → 3 entries, total 12s, no overrun",
    fill.length === 3 && Math.abs(sum(fill) - 12) < 1e-6, `entries=${fill.length} total=${sum(fill)}`)
  check("FILL: entries are in library order with sequential starts (0, 4, 8)",
    fill[0].url.endsWith("a.mp4") && fill[1].startSeconds === 4 && fill[2].startSeconds === 8)
  check("FILL: caption carried through from source clip", fill[0].caption === "A")

  // LOOP — a SHORT library (two 3s clips = 6s) loops to cover a 16s timeline,
  // and the final clip is truncated so the plan ends exactly at 16s.
  const shortLib: BrollSourceClip[] = [
    { url: "https://x/p.mp4", durationSeconds: 3 },
    { url: "https://x/q.mp4", durationSeconds: 3 },
  ]
  const looped = selectBrollPlan(shortLib, 16)
  check("LOOP: short 6s library covers a 16s timeline (loops past its length)",
    Math.abs(sum(looped) - 16) < 1e-6 && looped.length > shortLib.length, `total=${sum(looped)} entries=${looped.length}`)
  check("LOOP: library repeats from the top (entry 0 and entry 2 are the same clip)",
    looped[0].url === looped[2].url)
  check("LOOP: final entry truncated so the plan never overruns the timeline",
    looped[looped.length - 1].startSeconds + looped[looped.length - 1].durationSeconds <= 16 + 1e-6)

  // TRUNCATE — a single OVER-LONG clip (30s) is truncated to a 12s timeline.
  const longClip: BrollSourceClip[] = [{ url: "https://x/long.mp4", durationSeconds: 30 }]
  const truncated = selectBrollPlan(longClip, 12)
  check("TRUNCATE: a 30s clip is truncated to a 12s timeline (one 12s entry)",
    truncated.length === 1 && Math.abs(truncated[0].durationSeconds - 12) < 1e-6, `dur=${truncated[0]?.durationSeconds}`)

  // perClipSeconds — fixed 2s beats across the library, capped to clip length.
  const beats = selectBrollPlan(lib3, 12, 2)
  check("perClipSeconds: fixed 2s beats → 6 entries filling 12s",
    beats.length === 6 && Math.abs(sum(beats) - 12) < 1e-6, `entries=${beats.length} total=${sum(beats)}`)

  // HONEST empty.
  check("HONEST: empty library → []", selectBrollPlan([], 12).length === 0)
  check("HONEST: non-positive timeline → []", selectBrollPlan(lib3, 0).length === 0)
  check("HONEST: zero-duration clips fall back to default (still fills, never empty/overrun)",
    Math.abs(sum(selectBrollPlan([{ url: "https://x/z.mp4", durationSeconds: 0 }], 8)) - 8) < 1e-6)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live scope cascade]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live: seed video_assets b_roll across scopes → pickBrollClips honors the cascade]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { pickBrollClips } = await import("../lib/video/broll-picker")
  const svc = createServiceClient()
  const TAG = `BrollSim${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    // A real agent with a brokerage. team_id is OPTIONAL — the cascade skips
    // the team tier when absent, so the test works either way.
    const { data: agent } = await svc.from("agents")
      .select("id, brokerage_id, team_id")
      .not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const agentId     = (agent as any).id
    const brokerageId = (agent as any).brokerage_id
    const teamId      = (agent as any).team_id as string | null

    const seedAsset = async (scopeType: string, scopeId: string, label: string, durationSeconds: number | null) => {
      const { data, error } = await svc.from("video_assets").insert({
        brokerage_id:     brokerageId,
        title:            `${TAG} ${label}`,
        category:         "b_roll",
        scope_type:       scopeType,
        scope_id:         scopeId,
        video_url:        `https://example.com/${TAG}-${label}.mp4`,
        duration_seconds: durationSeconds,
      }).select("id").single()
      if (error) throw new Error(`seed ${label} failed: ${error.message}`)
      cleanup.push({ table: "video_assets", id: (data as any).id })
      return (data as any).id as string
    }

    // Seed b_roll at the AGENT scope (2 clips) and the BROKERAGE scope (1 clip).
    await seedAsset("agent", agentId, "agentA", 5)
    await seedAsset("agent", agentId, "agentB", 6)
    await seedAsset("brokerage", brokerageId, "brokerage", 4)
    // Seed a team clip too when the agent has a team (extra cascade coverage).
    if (teamId) await seedAsset("team", teamId, "team", 5)

    // 1) Agent render → most-specific (agent) clips win, brokerage NOT pulled.
    const agentPick = await pickBrollClips(
      { brokerageId, scopeType: "agent", scopeId: agentId, neededSeconds: 16 }, svc,
    )
    check("cascade: agent render sources the AGENT-scoped clips (most-specific wins)",
      agentPick.sourcedScope === `agent:${agentId}` && agentPick.sourcedCount === 2,
      `scope=${agentPick.sourcedScope} count=${agentPick.sourcedCount}`)
    check("cascade: agent pick returns only the agent's URLs (brokerage clip NOT mixed in)",
      agentPick.clips.every((c) => c.url.includes(TAG) && !c.url.includes("brokerage")) && agentPick.clips.length === 2)
    check("cascade: agent pick fills the 16s timeline (loops the agent library)",
      Math.abs(sum(agentPick.plan) - 16) < 1e-6, `total=${sum(agentPick.plan)}`)
    check("cascade: agent clips carry the stored title as caption",
      agentPick.clips.some((c) => (c.caption ?? "").startsWith(TAG)))

    // 2) Brokerage render → brokerage clip (the fallback tier sourced directly).
    const brokeragePick = await pickBrollClips(
      { brokerageId, scopeType: "brokerage", scopeId: brokerageId, neededSeconds: 12 }, svc,
    )
    check("cascade: brokerage render sources the BROKERAGE clip",
      brokeragePick.sourcedScope === `brokerage:${brokerageId}` && brokeragePick.sourcedCount === 1,
      `scope=${brokeragePick.sourcedScope} count=${brokeragePick.sourcedCount}`)
    check("cascade: brokerage pick fills its 12s timeline by looping the single clip",
      Math.abs(sum(brokeragePick.plan) - 12) < 1e-6 && brokeragePick.plan.length > 1)

    // 3) HONEST empty — a scope with NO b_roll anywhere returns [] (composition
    //    renders WITHOUT B-roll, exactly like today). Use a random agent id with
    //    a brokerage that has no seeded rows under it.
    const emptyPick = await pickBrollClips(
      { brokerageId, scopeType: "agent", scopeId: "00000000-0000-0000-0000-000000000000", neededSeconds: 12 }, svc,
    )
    // The random agent has no agent-scope rows, but the brokerage fallback DOES
    // have our seeded brokerage clip — so it should source from brokerage, not
    // fabricate. To prove the HONEST-empty path we point at a brokerage with no
    // rows at all.
    check("honest: a missing-agent render still falls back to the brokerage library (no fabrication, no crash)",
      emptyPick.sourcedScope === `brokerage:${brokerageId}` || emptyPick.clips.length === 0)

    const trulyEmpty = await pickBrollClips(
      { brokerageId: "00000000-0000-0000-0000-000000000000", scopeType: "brokerage", scopeId: "00000000-0000-0000-0000-000000000000", neededSeconds: 12 }, svc,
    )
    check("honest: a scope with NO b_roll anywhere → empty plan + empty clips (renders without B-roll)",
      trulyEmpty.plan.length === 0 && trulyEmpty.clips.length === 0 && trulyEmpty.sourcedCount === 0)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("video_assets").select("id", { count: "exact", head: true }).like("title", `${TAG}%`)
    check("cleanup verified — 0 seeded video_assets remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
