#!/usr/bin/env tsx
/**
 * scripts/lead-cert-earnable-simulator.ts   (npm run test:lead-cert-earnable)
 * ─────────────────────────────────────────────────────────────────────────────
 * LEAD-MANAGEMENT CERT IS EARNABLE (owner: "close the loops" — the flagged legacy
 * training_courses/agent_courses drift). agent_courses has NO runtime writer (the
 * course-taking runtime was never built; superseded by learning_modules /
 * learning_assignments), so agent_courses.status could never become 'passed'.
 * That made "Pass the Lead Management Essentials course" a permanently-unsatisfiable
 * gate on a REQUIRED onboarding cert — and because completeOnboarding() needs all
 * three required certs, EVERY agent's onboarding was un-completable. This proves the
 * dead gate is gone and the live, writeable training_videos gate is what remains.
 *
 * SOURCE: checkLeadManagementEligibility no longer reads agent_courses/training_courses,
 *         and still gates on the required lead_management training_videos.
 * LIVE (creds-gated): a seed agent who has watched the required lead_management videos
 *         >= 90% has ZERO missing requirements ⇒ eligible; cleanup == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function sourceLayer() {
  console.log("\n[wiring — the dead course gate is gone; the live video gate remains]")
  const eng = src("lib/onboarding/certification-engine.ts")
  // Isolate the Lead Management eligibility function body.
  const m = eng.match(/async function checkLeadManagementEligibility\([\s\S]*?\n}\n/)
  const body = m ? m[0] : ""
  check("checkLeadManagementEligibility exists", body.length > 0)
  check("it NO LONGER reads the write-dead agent_courses table", !/from\(['"]agent_courses['"]\)/.test(body))
  check("it NO LONGER reads the seed-only training_courses table", !/from\(['"]training_courses['"]\)/.test(body))
  check("it STILL gates on required lead_management training_videos (a live, writeable signal)",
    /from\(['"]training_videos['"]\)/.test(body) && /lead_management/.test(body) && /is_required/.test(body))
  check("the removal is documented (why the course gate was unearnable)",
    /never (?:built|written)|seed-only|unearnable|un-completable|permanently-unsatisf/i.test(body) || /NOTE —/.test(body))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source layer proved the wiring"); return }
  const svc = createClient(url, key)
  console.log("\n[live] a seed agent who watched the required lead_management videos is eligible")
  const { data: ag } = await svc.from("agents").select("id, brokerage_id").limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const agentId = (ag as any).id, brokerageId = (ag as any).brokerage_id
  const { data: vids } = await svc.from("training_videos").select("id").eq("category", "lead_management").eq("is_required", true)
  const videoIds = ((vids ?? []) as Array<{ id: string }>).map((v) => v.id)
  if (videoIds.length === 0) { console.log("  ⊘ no required lead_management videos seeded — skipping"); return }
  const seeded: string[] = []
  try {
    for (const vid of videoIds) {
      const { data: row } = await svc.from("video_completion_tracking")
        .insert({ agent_id: agentId, brokerage_id: brokerageId, training_video_id: vid, percent_watched: 95, completed: true })
        .select("id").maybeSingle()
      if (row) seeded.push((row as any).id)
    }
    const { checkCertificationEligibility } = await import("../lib/onboarding/certification-engine")
    const res = await checkCertificationEligibility("Lead Management Essentials", agentId, brokerageId)
    check("live: with the required videos watched, the cert is ELIGIBLE (no unearnable course gate)",
      res.eligible === true && res.missingRequirements.length === 0)
  } finally {
    for (const id of seeded) await svc.from("video_completion_tracking").delete().eq("id", id)
    let left = 0
    for (const id of seeded) { const { count } = await svc.from("video_completion_tracking").select("id", { count: "exact", head: true }).eq("id", id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LEAD_CERT_EARNABLE_FAIL"); process.exit(1) }
  console.log(" ✅ LEAD_CERT_EARNABLE_PASS — the required Lead Management cert is earnable; onboarding can complete")
}
main()
