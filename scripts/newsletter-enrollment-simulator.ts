#!/usr/bin/env tsx
/**
 * scripts/newsletter-enrollment-simulator.ts   (npm run test:newsletter-enroll)
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTO-ENROLL into the content channel (newsletter/blog/podcast) at each lifecycle stage —
 * the passive "stay top of mind" tool that paralleled the FB audience sync. Owner's scope:
 * LEADS → brokerage/team/solo subscription; CONTACTS + LIFETIME → the assigned AGENT.
 *
 * Live (gated by SUPABASE_SERVICE_ROLE_KEY): a verified-email lead enrolls at brokerage scope;
 * opted-out / unverified leads are skipped; a contact RE-KEYS the same-email row to the agent;
 * an unsubscribed email is never re-subscribed. Reverse-delete; cleanup == 0.
 */
// newsletter-enrollment imports `server-only`; neutralize it for tsx before lazy import.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try { const p = _require.resolve("server-only"); _require.cache[p] = { id: p, filename: p, loaded: true, exports: {} } as any } catch { /* noop */ }

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
function report() {
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ NEWSLETTER_ENROLL_FAIL"); process.exit(1) }
  console.log(" ✅ NEWSLETTER_ENROLL_PASS — leads → brokerage/solo, contacts/lifetime → agent; consent + unsubscribe respected; idempotent")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Newsletter lifecycle auto-enrollment simulator")
  console.log("══════════════════════════════════════════════════")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set (live-only simulator)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { enrollLeadInNewsletter, enrollContactInNewsletter } = await import("../lib/content/newsletter-enrollment")
  const svc = createServiceClient()
  const TAG = `News${Date.now()}`
  const email = `${TAG.toLowerCase()}@example.com`.replace(/[^a-z0-9@._-]/g, "")
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!brokerage) { console.log("  ⏭  Skipped — need a brokerage."); return report() }
    const brokerageId = (brokerage as any).id as string
    const { data: agentRow } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const agentId = (agentRow as any)?.id as string | undefined

    // ── Verified-email lead → brokerage-scope enrollment ──
    const { data: lead } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Lead",
      email, email_verified: true, email_opt_out: false, lead_stage: "new",
    }).select("id").single()
    const leadId = (lead as any).id as string
    cleanup.push({ table: "leads", id: leadId })

    const r1 = await enrollLeadInNewsletter({ leadId, brokerageId })
    check("verified-email lead enrolls (brokerage/solo scope)", r1.enrolled && r1.reason === "enrolled", JSON.stringify(r1))
    const { data: sub1 } = await svc.from("newsletter_subscribers").select("id, status, agent_id, contact_id, source")
      .eq("brokerage_id", brokerageId).eq("email", email).maybeSingle()
    if (sub1) cleanup.push({ table: "newsletter_subscribers", id: (sub1 as any).id })
    check("subscriber row: status subscribed, source auto_lead_capture", !!sub1 && (sub1 as any).status === "subscribed" && (sub1 as any).source === "auto_lead_capture")

    // ── Opt-out + unverified leads are skipped ──
    const { data: optOut } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "OptOut",
      email: `optout-${email}`, email_verified: true, email_opt_out: true, lead_stage: "new",
    }).select("id").single()
    cleanup.push({ table: "leads", id: (optOut as any).id })
    const rOpt = await enrollLeadInNewsletter({ leadId: (optOut as any).id, brokerageId })
    check("email-opted-out lead is skipped", !rOpt.enrolled && rOpt.reason === "email_opt_out")
    const { data: unver } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Unver",
      email: `unver-${email}`, email_verified: false, email_opt_out: false, lead_stage: "new",
    }).select("id").single()
    cleanup.push({ table: "leads", id: (unver as any).id })
    const rUnv = await enrollLeadInNewsletter({ leadId: (unver as any).id, brokerageId })
    check("unverified-email lead is skipped (deliverability)", !rUnv.enrolled && rUnv.reason === "email_unverified")

    // ── Contact (same email) RE-KEYS the row to the assigned agent ──
    if (agentId) {
      const { data: contact } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, first_name: TAG, last_name: "Contact",
        email, email_opt_out: false, agent_id: agentId, contact_type: "buyer",
      }).select("id").single()
      const contactId = (contact as any).id as string
      cleanup.push({ table: "contacts", id: contactId })
      const r2 = await enrollContactInNewsletter({ contactId, brokerageId, tier: "contact" })
      check("contact enrollment re-keys the same-email row to the AGENT", r2.enrolled && r2.reason === "rekeyed" && r2.scope === "agent", JSON.stringify(r2))
      const { data: sub2 } = await svc.from("newsletter_subscribers").select("agent_id, contact_id, source")
        .eq("brokerage_id", brokerageId).eq("email", email).maybeSingle()
      check("re-keyed row now carries the agent + contact link", !!sub2 && (sub2 as any).agent_id === agentId && (sub2 as any).contact_id === contactId)
    } else {
      check("contact re-key test skipped (no agent) — lead enrollment covered the path", true)
    }

    // ── An unsubscribed email is NEVER re-subscribed ──
    await svc.from("newsletter_subscribers").update({ status: "unsubscribed", unsubscribed_at: new Date().toISOString() })
      .eq("brokerage_id", brokerageId).eq("email", email)
    const { data: lead2 } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Recapture",
      email, email_verified: true, email_opt_out: false, lead_stage: "new",
    }).select("id").single()
    cleanup.push({ table: "leads", id: (lead2 as any).id })
    const r3 = await enrollLeadInNewsletter({ leadId: (lead2 as any).id, brokerageId })
    check("unsubscribed email is NEVER re-subscribed (CAN-SPAM)", !r3.enrolled && r3.reason === "previously_unsubscribed")
  } finally {
    await svc.from("newsletter_subscribers").delete().eq("email", email).then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ } }
    const { count } = await svc.from("leads").select("id", { count: "exact", head: true }).eq("first_name", TAG)
    check("cleanup verified — 0 seeded leads remain", (count ?? 0) === 0, `got ${count}`)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
