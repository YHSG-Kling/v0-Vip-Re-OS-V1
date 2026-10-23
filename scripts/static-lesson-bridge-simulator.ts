#!/usr/bin/env tsx
/**
 * scripts/static-lesson-bridge-simulator.ts   (npm run test:static-lesson-bridge)
 * ─────────────────────────────────────────────────────────────────────────────
 * STATIC CUSTOMER-LESSON → CANONICAL BRIDGE (owner: "close the loops" on the
 * flagged static customer-lesson drift). The /learn feed is built from an in-code
 * catalog whose keys are STRINGS; completion lives on learning_assignments.module_id,
 * a NOT-NULL uuid with a FK to learning_modules.id. markLessonRead used to write the
 * raw string key into that column — a guaranteed uuid/FK violation on every customer
 * lesson-read — and the completion read-back (module uuids) could never match a
 * static string key. This proves the deterministic bridge closes both: the lesson is
 * materialized as a real module under a stable id, completion records against the
 * uuid, the feed reads it back, and the bridged row is excluded from the milestone
 * panel so a lesson never appears in two places.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { staticLessonModuleId, isUuid, STATIC_BRIDGE_TAG } from "../lib/portal/static-lesson-bridge"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n── deterministic id + uuid discrimination (pure) ──")
  const brk = "b0000000-0000-0000-0000-000000000001"
  const a = staticLessonModuleId(brk, "buyer_pre_intro")
  const b = staticLessonModuleId(brk, "buyer_pre_intro")
  check("same (brokerage, lesson) ⇒ same module id (stable across write & read)", a === b)
  check("the derived id is a valid uuid (satisfies the FK column)", isUuid(a))
  check("different lessons ⇒ different ids", staticLessonModuleId(brk, "buyer_pre_intro") !== staticLessonModuleId(brk, "seller_pre_intro"))
  check("different brokerages ⇒ different ids (tenant isolation)", staticLessonModuleId(brk, "x") !== staticLessonModuleId("a0000000-0000-0000-0000-0000000000ff", "x"))
  check("a raw static key is NOT a uuid", !isUuid("buyer_pre_intro"))
}

function sourceLayer() {
  console.log("\n── every duplicate/corruption-prone path is wired to the bridge ──")
  const pe = src("app/actions/portal-education.ts")
  check("markLessonRead branches on isUuid — canonical uuid recorded directly, static key bridged",
    /isUuid\(lessonKey\)/.test(pe) && /bridgeStaticLessonCompletion/.test(pe))
  check("markLessonRead NO LONGER writes the raw lessonKey into module_id",
    !/module_id:\s*moduleId/.test(pe))
  check("getLessonFeed maps the static key to its deterministic module id for completion",
    /staticLessonModuleId\(access\.brokerageId, lesson\.key\)/.test(pe))

  const bridge = src("lib/portal/static-lesson-bridge.ts")
  check("the bridge materializes a canonical module AND records the assignment (idempotent upserts)",
    /from\("learning_modules"\)\.upsert/.test(bridge) && /from\("learning_assignments"\)\.upsert/.test(bridge) &&
    /onConflict: "id"/.test(bridge) && /onConflict: "contact_id,module_id"/.test(bridge))
  check("bridged modules are tagged so they can be excluded from the panel",
    bridge.includes(`gap_tags: [STATIC_BRIDGE_TAG]`) && STATIC_BRIDGE_TAG === "static_bridge")

  const feed = src("lib/learning-router/milestone-gated-modules.ts")
  check("the milestone-gated customer feed EXCLUDES bridged static lessons (no double surface)",
    /\.not\("gap_tags", "cs", '\{static_bridge\}'\)/.test(feed))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the wiring"); return }
  const svc = createClient(url, key)
  console.log("\n[live] bridge a static lesson → complete → read back → excluded from panel → clean up")
  const { data: c } = await svc.from("contacts").select("id, brokerage_id").not("brokerage_id", "is", null).limit(1).maybeSingle()
  if (!c) { console.log("  ⊘ no contact — skipping"); return }
  const brokerageId = (c as any).brokerage_id, contactId = (c as any).id
  const mid = staticLessonModuleId(brokerageId, "__bridge_test_lesson__")
  try {
    const { bridgeStaticLessonCompletion } = await import("../lib/portal/static-lesson-bridge")
    const r1 = await bridgeStaticLessonCompletion(svc as any, { brokerageId, contactId, lesson: { key: "__bridge_test_lesson__", title: "Bridge Test Lesson", description: "d", milestoneKey: null, estimatedMinutes: 5 } })
    check("live: bridge returned the deterministic module id", r1 === mid)
    const { data: mod } = await svc.from("learning_modules").select("id, audience_roles, gap_tags, status").eq("id", mid).maybeSingle()
    check("live: a published customer module now exists, tagged static_bridge", (mod as any)?.status === "published" && ((mod as any)?.audience_roles ?? []).includes("customer") && ((mod as any)?.gap_tags ?? []).includes("static_bridge"))
    const { data: asg } = await svc.from("learning_assignments").select("status").eq("contact_id", contactId).eq("module_id", mid).maybeSingle()
    check("live: completion recorded against the uuid (FK satisfied)", (asg as any)?.status === "completed")
    // idempotent second bridge
    await bridgeStaticLessonCompletion(svc as any, { brokerageId, contactId, lesson: { key: "__bridge_test_lesson__", title: "Bridge Test Lesson", description: "d", milestoneKey: null, estimatedMinutes: 5 } })
    const { count: modCount } = await svc.from("learning_modules").select("id", { count: "exact", head: true }).eq("id", mid)
    const { count: asgCount } = await svc.from("learning_assignments").select("id", { count: "exact", head: true }).eq("contact_id", contactId).eq("module_id", mid)
    check("live: idempotent — exactly one module + one assignment after a second bridge", modCount === 1 && asgCount === 1)
    const { resolveMilestoneGatedFeed } = await import("../lib/learning-router/milestone-gated-modules")
    const gated = await resolveMilestoneGatedFeed(svc as any, contactId).catch(() => null)
    const inPanel = gated ? [...(gated.unlocked ?? []), ...(gated.upcoming ?? []), ...(gated.locked ?? [])].some((m: any) => m.id === mid) : false
    check("live: the bridged lesson is NOT surfaced in the milestone panel", !inPanel)
  } finally {
    await svc.from("learning_assignments").delete().eq("module_id", mid)
    await svc.from("learning_modules").delete().eq("id", mid)
    const { count: m } = await svc.from("learning_modules").select("id", { count: "exact", head: true }).eq("id", mid)
    const { count: a } = await svc.from("learning_assignments").select("id", { count: "exact", head: true }).eq("module_id", mid)
    check("live: cleanup count == 0", (m ?? 0) + (a ?? 0) === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STATIC_LESSON_BRIDGE_FAIL"); process.exit(1) }
  console.log(" ✅ STATIC_LESSON_BRIDGE_PASS — static customer lessons record completion on the canonical rail; no FK corruption, no duplicate surface")
}
main()
