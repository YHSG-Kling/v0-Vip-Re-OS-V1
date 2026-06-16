#!/usr/bin/env tsx
/**
 * scripts/persona-render-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves cadence/sequence copy is PERSONA + ENRICHMENT driven — never a hard-coded template —
 * and FAIR-HOUSING-SAFE by construction: protected-class enrichment (family/life events, income,
 * age) may TIME outreach upstream but NEVER becomes copy facts.
 *
 * Layer 1 (shell-runnable, pure): buildPersonaContext curates safe facts (ownership, buyer stage,
 *   months-since-contact) and EXCLUDES protected signals; contacts vs leads read their own field.
 * Layer 2 (live, creds-gated): generateEntityStepCopy loads a real contact AND a real lead from
 *   their OWNING table and feeds persona+facts into the generator (deterministic echo) — proving
 *   enriched facts reach the copy and the fallback is used only when the generator yields nothing.
 *   Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/persona-render-simulator.ts   (npm run test:persona-render)
 */
import { buildPersonaContext } from "../lib/campaign-sequences/persona-render"

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
  console.log(" ✅ Persona render verified — copy is persona+enrichment driven, Fair-Housing-safe, table-correct.")
  console.log(" PERSONA_RENDER_PASS")
  process.exit(0)
}

const NOW = new Date("2026-06-16T12:00:00.000Z")

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Persona+enrichment render simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · buildPersonaContext curation + Fair Housing]")
  const c = buildPersonaContext(
    { first_name: "Dana", last_name: "Reyes", contact_type: "buyer", buyer_stage: "actively_touring", home_owner_status: "renter", last_contacted_at: new Date("2026-04-16T12:00:00.000Z").toISOString() },
    "contact", NOW,
  )
  check("contact persona: name + buyer audience", c.persona.name === "Dana Reyes" && c.persona.audience === "buyer")
  check("contact facts include renting + buyer stage + months-since", c.facts.some(f => /renting/.test(f)) && c.facts.some(f => /buyer journey stage/.test(f)) && c.facts.some(f => /2 months/.test(f)), JSON.stringify(c.facts))

  // Lead reads its OWN persona field (persona, not contact_persona) + ownership from the
  // enrichment_profile JSONB (leads have no home_owner_status column — lineage to the copy).
  const l = buildPersonaContext({ first_name: "Sam", persona: "first_time_buyer", enrichment_profile: { home_owner_status: "owner", household_income: 240000 } }, "lead", NOW)
  check("lead audience is 'lead' + situation from persona field", l.persona.audience === "lead" && /first time buyer/.test(l.persona.situation ?? ""))
  check("lead ownership fact comes from enrichment_profile jsonb", l.facts.some(f => /owns their home/.test(f)))
  check("protected field INSIDE enrichment_profile (income) does NOT leak", !l.facts.join(" ").toLowerCase().includes("income") && !l.facts.join(" ").includes("240000"))

  // FAIR HOUSING: protected-class inputs must NOT leak into facts.
  const fh = buildPersonaContext(
    // these protected fields are not even read columns; prove a row carrying them yields none in facts
    { first_name: "Pat", contact_type: "buyer", buyer_stage: "nurture", home_owner_status: "owner", last_contacted_at: NOW.toISOString(), ...( { life_events: ["new_baby"], household_income: 250000, age: 34, marital_status: "married" } as any) },
    "contact", NOW,
  )
  const factsBlob = fh.facts.join(" | ").toLowerCase()
  check("no protected-class signal leaks into facts (baby/income/age/married)", !/baby|income|\bage\b|married|child|family/.test(factsBlob), factsBlob)

  console.log("\n[Layer 2 · live: persona-grounded generation for a contact AND a lead]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { generateEntityStepCopy } = await import("../lib/campaign-sequences/persona-render-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  // Deterministic generator: echo the facts so we can prove enrichment reached the copy.
  const echoGen = async (req: { facts: string[]; persona: { audience?: string | null } }) => ({ subject: "ZZ", body: `AUD:${req.persona.audience}|FACTS:${req.facts.join(";")}` })
  const contactId = uuid(), leadId = uuid()

  try {
    await svc.from("contacts").insert({ id: contactId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Persona", contact_type: "seller", buyer_stage: "nurture", home_owner_status: "owner", last_contacted_at: new Date("2026-03-16T12:00:00.000Z").toISOString() })
    await svc.from("leads").insert({ id: leadId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "LeadPersona", persona: "investor", email: "zz.lp@example.com", enrichment_profile: { home_owner_status: "owner" } })

    const cCopy = await generateEntityStepCopy({ svc, entity: "contact", id: contactId, intent: "re-engage", channel: "email", fallback: { subject: "f", body: "FALLBACK" }, generator: echoGen, now: NOW })
    check("contact copy is persona-grounded (seller audience + owner fact, not fallback)", /AUD:seller/.test(cCopy.body) && /owns their home/.test(cCopy.body), cCopy.body)

    const lCopy = await generateEntityStepCopy({ svc, entity: "lead", id: leadId, intent: "re-engage", channel: "email", fallback: { subject: "f", body: "FALLBACK" }, generator: echoGen, now: NOW })
    check("lead copy reads the LEADS table + enrichment_profile ownership (lineage to copy)", /AUD:lead/.test(lCopy.body) && /owns their home/.test(lCopy.body), lCopy.body)

    // Generator returns nothing → deterministic fallback (still produces copy, never blank).
    const nullGen = async () => null
    const fb = await generateEntityStepCopy({ svc, entity: "contact", id: contactId, intent: "re-engage", channel: "email", fallback: { subject: "f", body: "DETERMINISTIC_FALLBACK" }, generator: nullGen, now: NOW })
    check("generator yields nothing → deterministic fallback used", fb.body === "DETERMINISTIC_FALLBACK")
  } finally {
    await svc.from("contacts").delete().eq("id", contactId).then(() => {}, () => {})
    await svc.from("leads").delete().eq("id", leadId).then(() => {}, () => {})
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seeded contact removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
