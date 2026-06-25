#!/usr/bin/env tsx
/**
 * scripts/outreach-identity-simulator.ts   (npm run test:outreach-identity)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OUTREACH IDENTITY AUTHORITY — whose avatar/voice fronts a touch at each stage.
 * LEAD → brokerage/solo identity; CONTACT/LIFETIME → the ASSIGNED AGENT. One authority so
 * the video, the voice call, and the voice drop never disagree (fixes the leadId=contactId
 * mix-up that pulled the wrong — or no — agent identity).
 *
 * Live (gated by SUPABASE_SERVICE_ROLE_KEY): a contact assigned to a known agent resolves to
 * THAT agent's user_id; a lead presenter resolves to a real human on the roster (never null
 * when a roster exists). Reverse-delete; cleanup == 0.
 */
export {} // module scope

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
function report() {
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ OUTREACH_IDENTITY_FAIL"); process.exit(1) }
  console.log(" ✅ OUTREACH_IDENTITY_PASS — contact fronts its assigned agent; lead fronts the brokerage/solo identity")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Outreach identity authority simulator")
  console.log("══════════════════════════════════════════════════")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set (live-only)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { resolveContactPresenterUserId, resolveLeadPresenterUserId } = await import("../lib/ai-isa/outreach-identity")
  const svc = createServiceClient()
  const TAG = `Ident${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).maybeSingle()
    if (!agent) { console.log("  ⏭  Skipped — need an agent with a user_id + brokerage."); return report() }
    const brokerageId = (agent as any).brokerage_id as string
    const agentId = (agent as any).id as string
    const agentUserId = (agent as any).user_id as string

    // CONTACT → the ASSIGNED AGENT.
    const { data: contact } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Contact", contact_type: "buyer", agent_id: agentId,
    }).select("id").single()
    const contactId = (contact as any).id as string
    cleanup.push({ table: "contacts", id: contactId })
    const cPres = await resolveContactPresenterUserId(svc, contactId, brokerageId)
    check("contact presenter is the ASSIGNED AGENT's user_id", cPres === agentUserId, `got ${cPres} expected ${agentUserId}`)

    // An UNASSIGNED contact → null (no agent to front it; caller falls to brokerage default).
    const { data: unassigned } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Unassigned", contact_type: "buyer", agent_id: null,
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (unassigned as any).id })
    const uPres = await resolveContactPresenterUserId(svc, (unassigned as any).id, brokerageId)
    check("unassigned contact → null (caller uses brokerage default)", uPres === null)

    // LEAD → a real human on the brokerage roster (never null when a roster exists).
    const lPres = await resolveLeadPresenterUserId(svc, brokerageId, null)
    check("lead presenter is a real human on the roster (non-null)", !!lPres)
    if (lPres) {
      const { data: u } = await svc.from("users").select("id").eq("id", lPres).maybeSingle()
      check("lead presenter resolves to a real users.id (brokerage/solo face)", !!(u as any)?.id)
    }
  } finally {
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ } }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("first_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0, `got ${count}`)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
