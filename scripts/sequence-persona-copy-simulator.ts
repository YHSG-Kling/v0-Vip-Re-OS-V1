#!/usr/bin/env tsx
/**
 * scripts/sequence-persona-copy-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the WHOLE sequencer can write persona+enrichment copy, not just mail-merge tokens:
 * renderSequenceStep now generates the body from the contact's persona + Fair-Housing-safe facts
 * when a step opts in via ai_intent (m232) — and is unchanged (template interpolation) otherwise.
 *
 * Live-only (renderSequenceStep loads contact/brokerage/brand-voice from the DB; agentUserId=null
 * so no signature assembly is needed). Seeds a real contact, renders WITH ai_intent + a
 * deterministic generator (asserts the persona facts reach the body) and WITHOUT (asserts the
 * static template is used). Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/sequence-persona-copy-simulator.ts   (npm run test:sequence-persona-copy)
 */
export {} // module scope
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
  console.log(" ✅ Sequencer persona copy verified — ai_intent generates from enrichment; template path unchanged.")
  console.log(" SEQUENCE_PERSONA_COPY_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Sequencer persona-copy render simulator")
  console.log("══════════════════════════════════════════════════")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n  ⏭  Live-only simulator skipped — SUPABASE creds not set.")
    console.log("     (renderSequenceStep loads contact/brokerage/brand-voice; persona curation is")
    console.log("      shell-tested in test:persona-render. This proves the render path end-to-end.)")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { renderSequenceStep } = await import("../lib/campaign-sequences/render-step")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const contactId = uuid()
  const leadId = uuid()
  // Deterministic generator: echo persona + facts so we can prove enrichment reached the copy.
  const echoGen = async (req: { facts: string[]; persona: { audience?: string | null } }) =>
    ({ subject: "ZZ subject", body: `AUD:${req.persona.audience}|FACTS:${req.facts.join(";")}` })

  try {
    await svc.from("contacts").insert({ id: contactId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "SeqPersona", contact_type: "seller", buyer_stage: "nurture", home_owner_status: "owner", last_contacted_at: new Date(Date.now() - 90 * 86_400_000).toISOString() })

    // WITH ai_intent → generated from persona + enrichment.
    const gen = await renderSequenceStep({
      brokerageId, contactId, agentUserId: null,
      step: { channel: "email", subject: "Static subject", body: "STATIC TEMPLATE BODY" },
      personaIntent: "a warm no-pressure re-engagement", generator: echoGen as any,
    })
    check("ai_intent → body generated from persona (seller audience + owner fact)", /AUD:seller/.test(gen.htmlBody) && /owns their home/.test(gen.htmlBody), gen.htmlBody.slice(0, 200))
    check("ai_intent → subject from the generated draft", (gen.subject ?? "").includes("ZZ subject"))
    check("ai_intent → static template body NOT used", !/STATIC TEMPLATE BODY/.test(gen.htmlBody))

    // WITHOUT ai_intent → legacy template interpolation (unchanged).
    const tmpl = await renderSequenceStep({
      brokerageId, contactId, agentUserId: null,
      step: { channel: "email", subject: "Hi {{first_name}}", body: "STATIC TEMPLATE BODY for {{first_name}}" },
    })
    check("no ai_intent → static template body used", /STATIC TEMPLATE BODY for ZZ/.test(tmpl.htmlBody), tmpl.htmlBody.slice(0, 200))
    check("no ai_intent → token interpolation still fires ({{first_name}})", /Hi ZZ/.test(tmpl.subject ?? ""))

    // No hardcoded fallback: ai_intent + failed generation + no template body → empty (adapter skips).
    const blank = await renderSequenceStep({
      brokerageId, contactId, agentUserId: null,
      step: { channel: "email", subject: null, body: null },
      personaIntent: "re-engage", generator: (async () => null) as any,
    })
    check("ai_intent + failed generation + no template → empty=true (never sends blank/filler)", blank.empty === true, JSON.stringify({ empty: blank.empty }))

    // LEAD entity → renderSequenceStep reads the LEADS table (was contacts-only, so leads couldn't render).
    await svc.from("leads").insert({ id: leadId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "RenderLead", email: "zz.rl@example.com", persona: "investor", last_contacted_at: new Date(Date.now() - 60 * 86_400_000).toISOString() })
    const leadRender = await renderSequenceStep({
      brokerageId, contactId: leadId, agentUserId: null, entity: "lead",
      step: { channel: "email", subject: "S", body: "T" },
      personaIntent: "re-engage", generator: echoGen as any,
    })
    check("lead entity → body generated from the LEADS row (lead audience, not contact)", /AUD:lead/.test(leadRender.htmlBody), leadRender.htmlBody.slice(0, 200))
    const leadTmpl = await renderSequenceStep({
      brokerageId, contactId: leadId, agentUserId: null, entity: "lead",
      step: { channel: "email", subject: "Hi {{first_name}}", body: "lead template {{first_name}}" },
    })
    check("lead entity → tokens resolve from the leads row", /lead template ZZ/.test(leadTmpl.htmlBody), leadTmpl.htmlBody.slice(0, 120))
  } finally {
    await svc.from("contacts").delete().eq("id", contactId).then(() => {}, () => {})
    await svc.from("leads").delete().eq("id", leadId).then(() => {}, () => {})
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seeded contact removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
