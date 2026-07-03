#!/usr/bin/env tsx
/**
 * scripts/regulatory-curriculum-simulator.ts   (npm run test:regulatory-curriculum)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the REGULATORY → CURRICULUM AUTOPILOT + the VIDEO VOICE-BY-AUDIENCE render wire.
 *
 * Regulatory: the watcher detects a real, sourced reg change → the autopilot authors a gated training
 *   module (agent+broker audience, regulation gap-tag, required-when-binding) on the canonical rail, so
 *   the learning-router pushes it to the team. Grounded in the real change; idempotent per signature.
 * Video voice: resolveVideoVoiceId honors video_metadata.voice — agent-facing → the brokerage assistant
 *   voice; contact-facing → the agent's own cloned voice.
 *
 * PURE:   regulationTag namespacing + resolveVideoVoiceId branch logic (via a stub svc for the DB read).
 * SOURCE: the watcher calls the autopilot on a new escalation; the render worker uses resolveVideoVoiceId.
 * LIVE (creds-gated): persist a regulatory module → lands agent+broker + required; assistant-voice
 *   resolution reads default_isa_voice_id; clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { regulationTag } from "../lib/education/regulatory-curriculum"
import { resolveVideoVoiceId } from "../lib/video/module-voice"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

async function pureLayer() {
  console.log("\n[pure — reg tag + voice-by-audience resolution]")
  check("regulationTag namespaces by signature", regulationTag("abc123") === "regulation:abc123")
  // agent_own → keeps the presenter (agent) voice, no DB read needed.
  check("contact-facing (agent_own) → the agent's own presenter voice", await resolveVideoVoiceId({ voiceKind: "agent_own", presenterVoiceId: "agent-voice-1", brokerageId: "b" }, {} as any) === "agent-voice-1")
  // assistant → reads default_isa_voice_id via a stub svc.
  const stub = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { default_isa_voice_id: "assistant-voice-9" } }) }) }) }) }
  check("agent-facing (assistant) → the brokerage assistant voice", await resolveVideoVoiceId({ voiceKind: "assistant", presenterVoiceId: "agent-voice-1", brokerageId: "b" }, stub as any) === "assistant-voice-9")
  const stubNull = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { default_isa_voice_id: null } }) }) }) }) }
  check("assistant voice unset → honest fallback to the presenter voice", await resolveVideoVoiceId({ voiceKind: "assistant", presenterVoiceId: "agent-voice-1", brokerageId: "b" }, stubNull as any) === "agent-voice-1")
}

function sourceLayer() {
  console.log("\n[wiring — watcher autopilot + render worker voice]")
  const watcher = src("lib/kernel/regulatory-watcher.ts")
  check("the watcher authors training on a NEW escalated change", /authorRegulatoryTraining\(supabase, \{/.test(watcher) && /severityTier: severity\.tier/.test(watcher))
  const reg = src("lib/education/regulatory-curriculum.ts")
  check("persists a gated learning_modules draft, agent+broker, regulation-tagged", /from\("learning_modules"\)\.insert\(/.test(reg) && /audience_roles: \["agent", "broker"\]/.test(reg) && /gap_tags: \[tag\]/.test(reg) && /status: "pending_review"/.test(reg))
  check("required training only when the change is binding", /required: change\.severityTier === "binding"/.test(reg))
  check("idempotent per signature (no duplicate module)", /contains\("gap_tags", \[tag\]\)/.test(reg))
  const worker = src("app/api/cron/director-reel-render/route.ts")
  check("the render worker resolves the voice by audience (video_metadata.voice)", /resolveVideoVoiceId\(/.test(worker) && /voiceId: renderVoiceId/.test(worker))
  const reg2 = src("lib/kernel/manager-registry.ts")
  check("burn domain notes the autopilot under the regulatory watcher", /regulatory→curriculum autopilot|regulation:\{signature\}/.test(reg2))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] persist a regulatory training module → agent+broker + required → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const change = { signature: "zz_test_tcpa_2026", title: "New TCPA consent rule", source: "FCC", url: null, severityTier: "binding", effectiveDate: "2026-08-01", surfaceLabels: ["Consent gate"] }
    const curriculum = {
      title: "New TCPA consent rule — what changes",
      summary: "A new consent standard takes effect; here's what you must do.",
      objectives: ["Know the new consent standard", "Update your outreach before the effective date"],
      lessons: [{ title: "What changed", keyPoints: ["Prior express written consent now required", "Re-confirm existing contacts"] }],
      quiz: [{ question: "What's now required?", options: ["Nothing", "Written consent"], correctIndex: 1 }],
    }
    const { persistRegulatoryModule } = await import("../lib/education/regulatory-curriculum")
    const ok = await persistRegulatoryModule(svc as any, brokerageId, change, curriculum)
    check("live: persisted the regulatory training module", ok === true)

    const { data: mod } = await svc.from("learning_modules").select("id, status, audience_roles, required, gap_tags").eq("brokerage_id", brokerageId).contains("gap_tags", [regulationTag(change.signature)]).maybeSingle()
    if (mod) cleanup.push({ table: "learning_modules", id: (mod as any).id })
    check("live: agent+broker audience, required (binding), pending_review", !!mod && (mod as any).audience_roles.includes("agent") && (mod as any).audience_roles.includes("broker") && (mod as any).required === true && (mod as any).status === "pending_review")

    const { authorRegulatoryTraining } = await import("../lib/education/regulatory-curriculum")
    const second = await authorRegulatoryTraining(svc as any, { brokerageId, change })
    const { count } = await svc.from("learning_modules").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).contains("gap_tags", [regulationTag(change.signature)])
    check("live: idempotent — one module per regulation signature", count === 1 && second === false)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  await pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ REGULATORY_CURRICULUM_FAIL"); process.exit(1) }
  console.log(" ✅ REGULATORY_CURRICULUM_PASS — a new rule auto-trains the team; agent-facing videos speak in the assistant voice")
}
main()
