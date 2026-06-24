#!/usr/bin/env tsx
/**
 * scripts/home-value-capture-simulator.ts  (npm run test:home-value-capture)
 *
 * Proves the home-value lead capture is MANAGER-OWNED, not a flat insert: a consented "what's my
 * home worth" request runs through the canonical captureContact pipeline (dedup → enrichment queue →
 * score → CONTACT_CAPTURED → portal invite) and then hands seller intent to the Listing Concierge.
 *
 *  - PURE (always): the consent + contact-method gates reject before any DB work.
 *  - LIVE (creds-gated): seed brokerage + agent, capture a home-value lead, assert a contact with
 *    source='home_value_form' + contact_type='seller' + a queued enrichment row + a
 *    home_value_seller_intent manager_signal; a SECOND capture with the same email MERGES (dedup, no
 *    duplicate). Self-cleaning (reverse-delete, count == 0).
 */
import { randomUUID } from "node:crypto"
import { captureHomeValueLead } from "../app/actions/home-value-lead"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

const baseInput = (over: Partial<Parameters<typeof captureHomeValueLead>[0]> = {}) => ({
  agentId: randomUUID(), brokerageId: randomUUID(), agentUserId: randomUUID(),
  fullName: "Dana Seller", email: "dana@demo.local", phone: "+15125550133",
  consentToContact: true,
  property: { address: "100 Main St", city: "Austin", state: "TX", zip: "78701", estimatedValue: 640000 },
  ...over,
})

async function pureLayer(): Promise<void> {
  console.log("\n[home-value capture · pure — consent + contact-method gates]")
  const noConsent = await captureHomeValueLead(baseInput({ consentToContact: false }))
  check("no consent ⇒ rejected", noConsent.success === false)
  const noContact = await captureHomeValueLead(baseInput({ email: "", phone: undefined }))
  check("no email/phone ⇒ rejected", noContact.success === false)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[home-value capture · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the gates")
    return
  }
  console.log("\n[home-value capture · live — managed capture + dedup + seller-intent → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const tag = `HVCAP-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const userId = randomUUID()
  let agentId: string | null = null
  const email = `seller+${tag}@demo.local`
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} Brokerage`, city: "Austin", state: "TX" })
    await svc.from("users").insert({ id: userId, brokerage_id: brokerageId, email: `agent+${tag}@demo.local`, first_name: "Hv", last_name: "Agent", user_type: "agent" })
    const { data: ar } = await svc.from("agents").insert({ user_id: userId, brokerage_id: brokerageId, is_active: true }).select("id").single()
    agentId = ar!.id as string

    const first = await captureHomeValueLead({
      agentId, brokerageId, agentUserId: userId,
      fullName: "Dana Seller", email, phone: "+15125550199", consentToContact: true,
      property: { address: `${tag} 100 Main St`, city: "Austin", state: "TX", zip: "78701", estimatedValue: 640000 },
    })
    check("capture succeeds", first.success === true && !!first.contactId)

    const { data: c } = await svc.from("contacts").select("source, contact_type, tcpa_consent").eq("id", first.contactId!).maybeSingle()
    const row = c as { source?: string; contact_type?: string; tcpa_consent?: boolean } | null
    check("contact has source=home_value_form (managed pipeline)", row?.source === "home_value_form")
    check("contact classified contact_type=seller", row?.contact_type === "seller")
    check("TCPA consent recorded", row?.tcpa_consent === true)

    const { count: enrich } = await svc.from("lead_enrichment_queue").select("id", { count: "exact", head: true }).eq("contact_id", first.contactId!)
    check("enrichment was queued (manager pipeline)", (enrich ?? 0) >= 1)

    const { count: signals } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("contact_id", first.contactId!).eq("signal_type", "home_value_seller_intent")
    check("seller intent handed to Listing Concierge", (signals ?? 0) >= 1)

    // Second capture, same email → DEDUP (merge), no duplicate contact.
    const second = await captureHomeValueLead({
      agentId, brokerageId, agentUserId: userId,
      fullName: "Dana Seller", email, phone: "+15125550199", consentToContact: true,
      property: { address: `${tag} 100 Main St`, city: "Austin", state: "TX", zip: "78701", estimatedValue: 650000 },
    })
    check("re-capture dedups to the SAME contact", second.success === true && second.contactId === first.contactId)
    const { count: dupes } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("email", email)
    check("exactly ONE contact for the email (no duplicate)", (dupes ?? 0) === 1)
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId)
    await svc.from("lead_enrichment_queue").delete().eq("brokerage_id", brokerageId)
    await svc.from("lead_score_history").delete().eq("brokerage_id", brokerageId)
    await svc.from("activities").delete().eq("brokerage_id", brokerageId)
    await svc.from("notifications").delete().eq("brokerage_id", brokerageId)
    await svc.from("contacts").delete().eq("brokerage_id", brokerageId)
    if (agentId) await svc.from("agents").delete().eq("id", agentId)
    await svc.from("users").delete().eq("id", userId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("cleanup complete", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  await pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ HOME_VALUE_CAPTURE_FAIL"); process.exit(1) }
  console.log(" ✅ HOME_VALUE_CAPTURE_PASS — home-value leads run through the managed capture pipeline")
}

main().catch((e) => { console.error(e); process.exit(1) })
