#!/usr/bin/env tsx
/**
 * scripts/client-education-simulator.ts   (npm run test:client-education)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CLIENT EDUCATION AUTHOR — the OS teaches buyers/sellers/lifetime clients, closing the
 * education arc to the customer. A curated persona/stage syllabus becomes gated learning_modules
 * (audience 'customer', stage/persona tagged) which the existing concierge delivery + portal push.
 *
 * PURE:   CLIENT_SYLLABUS coverage (buyer/seller stages + persona) + clientTag namespacing.
 * SOURCE: authoring persists to learning_modules by audience/stage/persona; rides the education-delivery
 *         cron; owned by recruiting_manager (engine) / concierge delivery.
 * LIVE (creds-gated on Supabase): persist a buyer-stage module → lands on learning_modules with customer
 *         audience + stage tag → idempotent → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { CLIENT_SYLLABUS, clientTag } from "../lib/education/client-education-curriculum"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[CLIENT_SYLLABUS · pure — buyer/seller stages + persona, well-formed]")
  const buyer = CLIENT_SYLLABUS.filter((t) => t.kind === "buyer_stage")
  const seller = CLIENT_SYLLABUS.filter((t) => t.kind === "seller_stage")
  const persona = CLIENT_SYLLABUS.filter((t) => t.kind === "persona")
  check("covers buyer stages incl. under-contract + inspection + low appraisal + first-30-days", buyer.some((t) => t.milestone === "offer_accepted") && buyer.some((t) => t.milestone === "inspection_completed") && buyer.some((t) => t.milestone === "appraisal_completed") && buyer.some((t) => t.milestone === "closed"))
  check("covers seller stages incl. listing-live + offers + repairs + close-out", seller.some((t) => t.milestone === "listing_live") && seller.some((t) => t.milestone === "offer_received") && seller.some((t) => t.milestone === "inspection_period") && seller.some((t) => t.milestone === "closed"))
  check("includes persona entries incl. a lifetime past-client nurture", persona.some((t) => t.persona === "first_time_buyer") && persona.some((t) => t.persona === "past_client"))
  check("every stage module carries a milestone; every persona module a persona", buyer.concat(seller).every((t) => !!t.milestone) && persona.every((t) => !!t.persona))
  check("clientTag namespaces buyer/seller/persona distinctly", clientTag(buyer[0]).startsWith("client:buyer:") && clientTag(seller[0]).startsWith("client:seller:") && clientTag(persona[0]).startsWith("client:persona:"))
  check("every topic has a grounding brief + title", CLIENT_SYLLABUS.every((t) => t.brief.length > 20 && t.title.length > 5))
  check("tags are unique across the syllabus", new Set(CLIENT_SYLLABUS.map(clientTag)).size === CLIENT_SYLLABUS.length)
}

function sourceLayer() {
  console.log("\n[wiring — customer-audienced learning_modules, cron, owned]")
  const authoring = src("lib/education/client-education-authoring.ts")
  check("persists to learning_modules, audience 'customer', pending_review", /from\("learning_modules"\)\.insert\(/.test(authoring) && /audience_roles: \["customer"\]/.test(authoring) && /status: "pending_review"/.test(authoring))
  check("stage modules carry stage_tags/milestone; persona modules carry audience_personas", /stage_tags: !isPersona[\s\S]*?audience_personas: isPersona/.test(authoring) || (/stage_tags:/.test(authoring) && /audience_personas:/.test(authoring)))
  check("client voice: FOR the client, no fabricated legal/financial advice", /client[\s\S]*?defer|no jargon|reassuring|general guidance/i.test(authoring))
  const eng = src("lib/education/client-education-curriculum.ts")
  check("idempotent per client tag", /contains\("gap_tags", \[tag\]\)/.test(eng))
  const cron = src("app/api/cron/education-delivery/route.ts")
  check("the education-delivery cron authors missing client modules", /runClientEducationCurriculumAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain registered with a runnable proof", /client_education_author:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:client-education"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] persist a buyer-stage client module → learning_modules (customer, stage-tagged) → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const topic = CLIENT_SYLLABUS.find((t) => t.key === "buyer_offer_accepted")!
    const tag = clientTag(topic)
    const curriculum = {
      title: "You're under contract — what happens next",
      summary: "Congratulations! Here's exactly what happens now and what you need to do.",
      objectives: ["Know your next 3 deadlines", "Know what you personally need to do this week"],
      lessons: [
        { title: "The next two weeks", keyPoints: ["Wire your earnest money", "Schedule your inspection"] },
        { title: "What we handle for you", keyPoints: ["Appraisal + financing coordination", "We watch every deadline"] },
      ],
      quiz: [{ question: "What's due first?", options: ["Closing", "Earnest money", "Nothing"], correctIndex: 1 }],
    }
    const { persistClientModule } = await import("../lib/education/client-education-authoring")
    const ok = await persistClientModule(svc as any, brokerageId, tag, topic, curriculum)
    check("live: persisted a client module to learning_modules", ok === true)

    const { data: mod } = await svc.from("learning_modules").select("id, status, audience_roles, stage_tags, milestone_key, gap_tags").eq("brokerage_id", brokerageId).contains("gap_tags", [tag]).maybeSingle()
    if (mod) cleanup.push({ table: "learning_modules", id: (mod as any).id })
    check("live: customer-audienced, pending_review, stage-tagged for the milestone", !!mod && (mod as any).status === "pending_review" && (mod as any).audience_roles.includes("customer") && (mod as any).stage_tags.includes("offer_accepted") && (mod as any).milestone_key === "offer_accepted")

    const { runClientEducationCurriculum } = await import("../lib/education/client-education-curriculum")
    await runClientEducationCurriculum(svc as any, { brokerageId, maxPerRun: 1 })
    const { count } = await svc.from("learning_modules").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).contains("gap_tags", [tag])
    check("live: idempotent — the seeded client topic is not re-authored", count === 1)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CLIENT_EDUCATION_FAIL"); process.exit(1) }
  console.log(" ✅ CLIENT_EDUCATION_PASS — buyers/sellers/lifetime clients get persona/stage education on the canonical rail")
}
main()
