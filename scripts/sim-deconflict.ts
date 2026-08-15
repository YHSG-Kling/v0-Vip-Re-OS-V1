/**
 * scripts/sim-deconflict.ts
 *
 * End-to-end live test of the De-Conflict Engine against the real Supabase DB.
 *
 *   npx tsx scripts/sim-deconflict.ts
 *
 * Sequence:
 *   1. Pick the oldest brokerage (real tenant — no test brokerage created).
 *   2. Seed a temporary test contact under that brokerage.
 *   3. Seed N synthetic message_provider_logs rows on email for the contact.
 *   4. Run evaluateDeconflict() for the same channel.
 *   5. Assert:
 *        - 0 prior touches → allowed
 *        - 3 prior touches → suppressed_over_touch (email default max=3)
 *        - 0 prior sms touches → allowed (separate channel counter)
 *   6. Confirm deconflict_suppression_log captured both decisions.
 *   7. Delete every row this script created (test contact, message logs,
 *      deconflict log rows).
 *
 * No external network: this is pure DB + engine logic. The actual D-ID/Lob/
 * Twilio APIs are not called.
 */
import "dotenv/config"
import { createServiceClient } from "../lib/supabase/service"
import { evaluateDeconflict } from "../lib/kernel/deconflict"

interface Cleanup {
  brokerageId:    string
  contactId:      string
  insertedLogIds: string[]
  insertedDecIds: string[]
}

async function pickBrokerage(svc: ReturnType<typeof createServiceClient>): Promise<string> {
  const { data, error } = await svc
    .from("brokerages")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error || !data) throw new Error(`Cannot find any brokerage to use: ${error?.message ?? "no rows"}`)
  return data.id as string
}

async function seedContact(svc: ReturnType<typeof createServiceClient>, brokerageId: string): Promise<string> {
  const email = `sim-deconflict-${Date.now()}@test.local`
  const { data, error } = await svc
    .from("contacts")
    .insert({
      brokerage_id: brokerageId,
      first_name:   "Sim",
      last_name:    "Deconflict",
      email,
      status: "active",
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`Failed to seed contact: ${error?.message ?? "no rows"}`)
  return data.id as string
}

/**
 * Seed N email touches via email_sends (the canonical email touch source the
 * engine reads). For sms/phone we'd use isa_outreach_log; not needed for the
 * current test cases.
 */
async function seedEmailTouches(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  contactId:   string,
  count:       number,
): Promise<string[]> {
  const ids: string[] = []
  const sentAt = new Date().toISOString()
  for (let i = 0; i < count; i++) {
    const { data, error } = await svc
      .from("email_sends")
      .insert({
        brokerage_id: brokerageId,
        contact_id:   contactId,
        status:       "sent",
        sent_at:      sentAt,
      })
      .select("id")
      .single()
    if (error || !data) throw new Error(`Failed to seed email touch ${i}: ${error?.message ?? "no rows"}`)
    ids.push(data.id as string)
  }
  return ids
}

async function cleanup(cu: Cleanup) {
  const svc = createServiceClient()
  await svc.from("deconflict_suppression_log").delete().eq("contact_id", cu.contactId)
  if (cu.insertedLogIds.length > 0) {
    await svc.from("email_sends").delete().in("id", cu.insertedLogIds)
  }
  await svc.from("contacts").delete().eq("id", cu.contactId)
}

async function recentDeconflictIds(
  svc: ReturnType<typeof createServiceClient>,
  contactId: string,
): Promise<string[]> {
  const { data } = await svc
    .from("deconflict_suppression_log")
    .select("id")
    .eq("contact_id", contactId)
  return (data ?? []).map(r => r.id as string)
}

async function main() {
  const svc = createServiceClient()
  const brokerageId = await pickBrokerage(svc)
  const contactId   = await seedContact(svc, brokerageId)
  const cu: Cleanup = { brokerageId, contactId, insertedLogIds: [], insertedDecIds: [] }
  let exitCode = 0

  try {
    // Test 1 — 0 prior email touches → ALLOWED
    const d1 = await evaluateDeconflict({
      brokerageId,
      channel:      "email",
      contactId,
      systemSource: "sim",
    })
    console.log("[T1] 0 prior email touches:", d1)
    if (!d1.allowed) { console.error("FAIL T1 — expected allowed"); exitCode = 1 }

    // Seed 3 email touches (== policy max)
    cu.insertedLogIds.push(...await seedEmailTouches(svc, brokerageId, contactId, 3))

    // Test 2 — 3 prior email touches (== max) → SUPPRESSED
    const d2 = await evaluateDeconflict({
      brokerageId,
      channel:      "email",
      contactId,
      systemSource: "sim",
    })
    console.log("[T2] 3 prior email touches:", d2)
    if (d2.allowed) { console.error("FAIL T2 — expected suppressed (touches=3 >= max=3)"); exitCode = 1 }

    // Test 3 — 0 prior SMS touches (channel counter is per-channel) → ALLOWED
    const d3 = await evaluateDeconflict({
      brokerageId,
      channel:      "sms",
      contactId,
      systemSource: "sim",
    })
    console.log("[T3] 0 prior sms touches (email saturated):", d3)
    if (!d3.allowed) { console.error("FAIL T3 — expected allowed (SMS counter is separate)"); exitCode = 1 }

    // Confirm audit log was written
    cu.insertedDecIds = await recentDeconflictIds(svc, contactId)
    console.log(`[Audit] deconflict_suppression_log captured ${cu.insertedDecIds.length} rows`)
    if (cu.insertedDecIds.length < 3) { console.error("FAIL audit — expected ≥ 3 rows"); exitCode = 1 }
  } finally {
    await cleanup(cu)
    console.log(`[Cleanup] removed contact ${contactId} + ${cu.insertedLogIds.length} touches + ${cu.insertedDecIds.length} audit rows`)
  }

  console.log(exitCode === 0 ? "✓ De-Conflict simulator PASS" : "✗ De-Conflict simulator FAIL")
  process.exit(exitCode)
}

main().catch(err => {
  console.error("Simulator crashed:", err)
  process.exit(2)
})
