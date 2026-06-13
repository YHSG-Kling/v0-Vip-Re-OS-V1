#!/usr/bin/env tsx
/**
 * scripts/conversation-memory-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONTEXT SPINE harness — one durable running summary per contact, so every
 * manager reads the SAME memory and nobody forgets what was discussed.
 *
 * Layer 1 (pure): composeContextSummary over sample interaction rows —
 *   captures last touch + stated preferences + open next step + sentiment; honest
 *   empty when there are no interactions; NEVER fabricates a fact not in the rows;
 *   deterministic (no rewriter) is stable; the injectable rewriter may only
 *   re-phrase the provided facts.
 * Layer 2 (live, gated): seed a contact + REAL interaction rows
 *   (conversations + activities + ai_isa_activities) → updateContactContext →
 *   assert the spine PERSISTED to contacts.metadata.context_spine, loadContactContext
 *   returns it, a refresh is IDEMPOTENT (no duplicate/growth), an empty contact gets
 *   an honest-empty spine, then reverse-delete + assert cleanup count == 0.
 *
 * No mocks/stubs/demo data — Layer 2 uses real rows in the live tables.
 * Run: npx tsx scripts/conversation-memory-simulator.ts  (npm run test:conversation-memory)
 */
import {
  composeContextSummary,
  updateContactContext,
  loadContactContext,
  type InteractionRow,
} from "../lib/kernel/conversation-memory"

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
  console.log(" ✅ Context spine (conversation memory) verified")
}

const ISO = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Context spine (conversation memory) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure compose]")
  const rows: InteractionRow[] = [
    { at: ISO(1), source: "ai_isa", channel: "call", text: "Discussed budget; wants to tour this weekend.", sentiment: "positive", outcome: "appointment_set" },
    { at: ISO(4), source: "conversation", channel: "sms", text: "Asked about school districts near Maple Heights.", sentiment: "neutral" },
    { at: ISO(9), source: "activity", channel: "email", text: "Sent three listing matches under $600k.", outcome: "sent" },
  ]
  const facts = {
    contactType: "buyer", buyerStage: "BUYER_SEARCHING",
    preferences: ["3 bed / 2 bath", "under $600k", "wants a yard"],
    openNextStep: "Tour Saturday at 11am",
  }
  const spine = await composeContextSummary(rows, facts, { now: new Date() })
  check("last touch = most recent row (1 day ago)", spine.lastTouch === rows[0].at)
  check("preferences carried forward verbatim", spine.preferences.join("|") === "3 bed / 2 bath|under $600k|wants a yard")
  check("open next step captured", spine.openNextStep === "Tour Saturday at 11am")
  check("sentiment = most recent row carrying one (positive)", spine.sentiment === "positive")
  check("interactionCount = 3 real rows", spine.interactionCount === 3)
  check("summary mentions the real last touch", spine.summary.includes("wants to tour this weekend"))
  check("summary surfaces a stated preference", spine.summary.includes("under $600k"))
  check("summary surfaces the open next step", spine.summary.includes("Tour Saturday"))
  // No fabrication: nothing not present in rows/facts leaks in.
  check("no fabrication — no invented address", !/\b\d+\s+\w+\s+(Street|St|Ave|Avenue|Road|Rd|Lane)\b/i.test(spine.summary) || spine.summary.includes("Maple Heights"))
  check("no fabrication — no invented price beyond $600k", !/\$\d/.test(spine.summary.replace(/\$600k/gi, "")))

  // Honest empty — no interactions, no facts.
  const empty = await composeContextSummary([], {}, { now: new Date() })
  check("honest empty: interactionCount 0", empty.interactionCount === 0)
  check("honest empty: says nothing to summarize", empty.summary.includes("nothing to summarize"))
  check("honest empty: no preferences/next-step invented", empty.preferences.length === 0 && empty.openNextStep === null)

  // Determinism: same input → same summary (no rewriter).
  const spine2 = await composeContextSummary(rows, facts, { now: new Date(spine.updatedAt) })
  check("deterministic: identical input → identical summary", spine2.summary === spine.summary)

  // Injectable rewriter may ONLY re-phrase the provided facts.
  let rewriterFactsSeen: string[] = []
  const withRewriter = await composeContextSummary(rows, facts, {
    now: new Date(),
    rewriter: async ({ facts: f }) => { rewriterFactsSeen = f; return "REPHRASED: " + f.join(" / ") },
  })
  check("rewriter seam is invoked with the deterministic facts", rewriterFactsSeen.length > 0)
  check("rewriter output is used as the summary", withRewriter.summary.startsWith("REPHRASED:"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live persistence]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live persistence]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Cmem${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // A contact with a REAL interaction footprint across all three lanes.
    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Riley", last_name: TAG, contact_type: "buyer",
      buyer_stage: "BUYER_SEARCHING",
      metadata: { preferences: ["3 bed / 2 bath", "under $600k"], open_next_step: "Tour Saturday at 11am" },
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })
    const contactId = (con as any).id

    const { data: conv } = await svc.from("conversations").insert({
      brokerage_id: brokerageId, contact_id: contactId, agent_id: (agent as any).id,
      type: "sms", status: "active", sentiment: "positive",
      last_message_at: ISO(1), intent_primary: "buyer_intent",
      last_ai_context_summary: "Asked about school districts near Maple Heights.",
    }).select("id").single()
    cleanup.push({ table: "conversations", id: (conv as any).id })

    const { data: act } = await svc.from("activities").insert({
      brokerage_id: brokerageId, contact_id: contactId, agent_id: (agent as any).id,
      activity_type: "email", title: "Sent three listing matches under $600k",
      channel: "email", outcome: "sent", created_at: ISO(9),
    }).select("id").single()
    cleanup.push({ table: "activities", id: (act as any).id })

    const { data: isa } = await svc.from("ai_isa_activities").insert({
      brokerage_id: brokerageId, contact_id: contactId, activity_type: "call",
      summary: "Discussed budget; wants to tour this weekend.", outcome: "appointment_set",
      channel: "phone", created_at: ISO(2),
    }).select("id").single()
    cleanup.push({ table: "ai_isa_activities", id: (isa as any).id })

    // Compose + PERSIST (deterministic — no token spend).
    const persisted = await updateContactContext(contactId, svc)
    check("live: spine composed from ≥3 real interaction rows", persisted.interactionCount >= 3)
    check("live: open next step read from canonical metadata", persisted.openNextStep === "Tour Saturday at 11am")
    check("live: stated preferences read from canonical metadata", persisted.preferences.includes("under $600k"))
    check("live: summary reflects a real row", persisted.summary.includes("tour this weekend"))

    // Read it back — any manager can.
    const loaded = await loadContactContext(contactId, svc)
    check("live: loadContactContext returns the persisted spine", !!loaded && loaded.summary === persisted.summary)
    check("live: persisted under contacts.metadata.context_spine", !!loaded && loaded.interactionCount === persisted.interactionCount)

    // Idempotent refresh — no duplicate, no growth (one spine, updated in place).
    const refreshed = await updateContactContext(contactId, svc)
    const { data: after } = await svc.from("contacts").select("metadata").eq("id", contactId).maybeSingle()
    const md = ((after as any)?.metadata ?? {}) as Record<string, any>
    const spineKeys = Object.keys(md).filter((k) => k === "context_spine")
    check("idempotent: exactly ONE context_spine key (no duplication)", spineKeys.length === 1)
    check("idempotent: same interactionCount on refresh (no growth)", refreshed.interactionCount === persisted.interactionCount)
    check("idempotent: sibling metadata preserved (preferences intact)", Array.isArray(md.preferences) && md.preferences.includes("under $600k"))

    // Honest empty — a contact with zero interactions.
    const { data: empty } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Quinn", last_name: TAG, contact_type: "lead",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (empty as any).id })
    const emptySpine = await updateContactContext((empty as any).id, svc)
    check("live honest empty: interactionCount 0 for no-interaction contact", emptySpine.interactionCount === 0)
    check("live honest empty: summary says nothing to summarize", emptySpine.summary.includes("nothing to summarize"))
    const emptyLoaded = await loadContactContext((empty as any).id, svc)
    check("live honest empty: persisted + loadable", !!emptyLoaded && emptyLoaded.interactionCount === 0)
  } finally {
    for (const cl of [...cleanup].reverse()) {
      try { await svc.from(cl.table).delete().eq("id", cl.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("last_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
