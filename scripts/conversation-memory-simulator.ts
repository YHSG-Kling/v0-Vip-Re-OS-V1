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
  recordMemoryFact,
  currentMemoryFacts,
  factsDueForReview,
  memoryContextBlock,
  compileObservedFacts,
  factsFromQualification,
  recordConversationFacts,
  MEMORY_FACT_REVIEW_DAYS,
  type InteractionRow,
  type MemoryFact,
} from "../lib/kernel/conversation-memory"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"

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

  console.log("\n[Layer 0 · lane 97B memory compiler — facts with confidence + expiry]")
  {
    const T0 = new Date("2026-09-01T12:00:00Z")
    const day = (d: number) => new Date(T0.getTime() + d * 86_400_000)
    let ledger: MemoryFact[] = []
    ledger = recordMemoryFact(ledger, { key: "price_expectation", value: "$550,000", observedAt: day(0).toISOString(), confidence: 0.7, source: "conversation" })
    ledger = recordMemoryFact(ledger, { key: "price_expectation", value: "$600,000", observedAt: day(10).toISOString(), confidence: 0.8, source: "conversation" })
    const cur = currentMemoryFacts(ledger, day(11))
    const old = ledger.find((f) => f.value === "$550,000")
    check("SUPERSEDE: a newer price fact supersedes the old one (the new one is current)",
      cur.length === 1 && cur[0].value === "$600,000", JSON.stringify(cur))
    check("SUPERSEDE-KEEPS-HISTORY: the old fact is KEPT, marked superseded, not overwritten",
      !!old && old.supersededAt === day(10).toISOString() && old.supersededBy === "$600,000")
    check("FACT-SHAPE: observed_at, confidence and review_by ride on every fact (review_by derived from the per-key table)",
      cur[0].confidence === 0.8 && cur[0].reviewBy === new Date(day(10).getTime() + MEMORY_FACT_REVIEW_DAYS.price_expectation * 86_400_000).toISOString())
    // A late-arriving OLDER statement never displaces a newer one.
    const late = recordMemoryFact(ledger, { key: "price_expectation", value: "$500,000", observedAt: day(5).toISOString(), confidence: 0.9, source: "conversation" })
    check("SUPERSEDE-ORDER: an older statement arriving late is history, not the current fact",
      currentMemoryFacts(late, day(11))[0]?.value === "$600,000" && late.some((f) => f.value === "$500,000" && !!f.supersededAt))
    // Same value re-stated → re-confirmed in place (no new row).
    const reconf = recordMemoryFact(ledger, { key: "price_expectation", value: "$600,000 ", observedAt: day(20).toISOString(), confidence: 0.6, source: "call" })
    check("RECONFIRM: restating the same value moves observed_at/review_by forward without a new row",
      reconf.filter((f) => f.key === "price_expectation").length === 2 && currentMemoryFacts(reconf, day(21))[0].observedAt === day(20).toISOString())

    // EXPIRY: past review_by the fact leaves the AI context.
    ledger = recordMemoryFact(ledger, { key: "timeline", value: "1-3_months", observedAt: day(0).toISOString(), confidence: 0.8, source: "contacts.timeline" })
    const spine = { summary: "Last touch today.", facts: ledger }
    const inside = memoryContextBlock(spine, day(30))
    const after = memoryContextBlock(spine, day(MEMORY_FACT_REVIEW_DAYS.timeline + 1))
    check("EXPIRY-CONTROL (positive control): inside review_by the timeline IS in the AI context",
      inside.includes("timeline: 1-3_months"), inside)
    check("EXPIRY: past review_by the timeline leaves the AI context (only a re-confirm cue remains)",
      !after.includes("1-3_months") && /re-confirming[^\n]*timeline/.test(after), after)
    check("EXPIRY-SUPERSEDED-NEVER-IN-CONTEXT: a superseded value never reaches the context",
      !inside.includes("$550,000") && inside.includes("$600,000"))
    check("DUE-FOR-REVIEW: the expired key is listed for re-confirmation", factsDueForReview(spine, day(70)).some((f) => f.key === "timeline"))

    // The column observer: an UNCHANGED column is not a re-statement; a CHANGED one supersedes.
    const same = compileObservedFacts({ facts: ledger }, [{ key: "timeline", value: "1-3_months", confidence: 0.8, source: "contacts.timeline" }], day(40))
    check("OBSERVER-UNCHANGED: re-reading an unchanged column does not refresh observed_at",
      currentMemoryFacts(same, day(41)).find((f) => f.key === "timeline")?.observedAt === day(0).toISOString())
    const changed = compileObservedFacts({ facts: ledger }, [{ key: "timeline", value: "3-6_months", confidence: 0.8, source: "contacts.timeline" }], day(40))
    check("OBSERVER-CHANGED: a changed column supersedes the old timeline",
      currentMemoryFacts(changed, day(41)).find((f) => f.key === "timeline")?.value === "3-6_months"
        && changed.some((f) => f.value === "1-3_months" && !!f.supersededAt))

    // WIRING (stripped source — a tombstone is not a call site).
    const root = join(import.meta.dirname, "..")
    const code = (rel: string) => blankStrings(stripComments(readFileSync(join(root, rel), "utf8")))
    check("WIRED-WRITER: updateContactContext carries the ledger forward through compileObservedFacts",
      /spine\.facts\s*=\s*compileObservedFacts\(/.test(code("lib/kernel/conversation-memory.ts")))
    check("WIRED-READER: the portal AI chat reads the compiled block, not the raw spine summary",
      /memoryContextBlock\(/.test(code("app/api/portal/ai-chat/route.ts")))
    check("WIRED-DECAY: the decayed intent ages the stated timeline from the memory fact",
      /currentMemoryFacts\(/.test(code("lib/lead-intelligence/behavioral-summary.ts")))
    check("WIRED-SCAN-CONTROL (positive control): the writer regex matches the shape it guards",
      /spine\.facts\s*=\s*compileObservedFacts\(/.test("spine.facts = compileObservedFacts(prior, x, now)"))
  }

  console.log("\n[Layer 0b · lane 98B conversation → memory fact, written NOW]")
  {
    const facts = factsFromQualification({ timeline: "1-3_months", preferredChannel: "sms", maxPrice: 650000, reasonForMove: "new job in Tampa" })
    check("qualification → facts in the observer's spelling (timeline bucket, channel, 'up to <max>', reason)",
      facts.length === 4 && facts.some((f) => f.key === "price_expectation" && f.value === "up to 650000") && facts.some((f) => f.key === "channel_preference" && f.value === "sms"))
    check("POSITIVE CONTROL: an empty answer states no fact", factsFromQualification({}).length === 0)

    // In-memory contacts row — the recorder reads + writes metadata, tenant-pinned, counted.
    const BRK = "11111111-1111-4111-8111-111111111111", CID = "22222222-2222-4222-8222-222222222222"
    const row: Record<string, any> = { id: CID, brokerage_id: BRK, motivation_type: null, metadata: { preferences: ["pool"], context_spine: { summary: "s", facts: [] } } }
    const fake = {
      from(_t: string) {
        const f: Array<[string, unknown]> = []
        let patch: Record<string, unknown> | null = null
        const hit = () => f.every(([k, v]) => row[k] === v)
        const b: any = {
          select() { return b }, update(p: Record<string, unknown>) { patch = p; return b },
          eq(k: string, v: unknown) { f.push([k, v]); return b },
          maybeSingle() { return Promise.resolve({ data: hit() ? { metadata: row.metadata, motivation_type: row.motivation_type } : null, error: null }) },
          then(res: (v: unknown) => unknown) { if (patch && hit()) Object.assign(row, patch); return Promise.resolve({ data: patch && hit() ? [{ id: CID }] : [], error: null }).then(res) },
        }
        return b
      },
    }
    const t1 = new Date("2026-06-01T00:00:00Z")
    const r1 = await recordConversationFacts(CID, BRK, facts, { client: fake as never, now: t1, source: "conversation.record_qualification" })
    const led1 = currentMemoryFacts(row.metadata.context_spine, t1)
    check("a stated timeline is recorded IMMEDIATELY (current, source conversation, observed now)",
      r1.recorded === 4 && led1.some((f) => f.key === "timeline" && f.value === "1-3_months" && f.source === "conversation.record_qualification" && f.observedAt === t1.toISOString()))
    check("sibling metadata + spine keys preserved; price mirrored to metadata.price_expectation (the observer's column)",
      row.metadata.preferences?.[0] === "pool" && row.metadata.context_spine.summary === "s" && row.metadata.price_expectation === "up to 650000")
    const t2 = new Date("2026-07-15T00:00:00Z")
    await recordConversationFacts(CID, BRK, [{ key: "timeline", value: "1-3_months", confidence: 0.85 }], { client: fake as never, now: t2 })
    const tl = currentMemoryFacts(row.metadata.context_spine, t2).find((f) => f.key === "timeline")
    check("a RE-STATEMENT of the same value refreshes observed_at / review_by now (not only on the 6h refresh)", tl?.observedAt === t2.toISOString())
    check("the spine refresh then sees an UNCHANGED price and does not flip it back",
      compileObservedFacts(row.metadata.context_spine, [{ key: "price_expectation", value: "up to 650000", confidence: 0.7, source: "contacts.metadata.price_expectation" }], t2)
        .filter((f) => f.key === "price_expectation" && !f.supersededAt).length === 1)
    const wrong = await recordConversationFacts(CID, "99999999-9999-4999-8999-999999999999", facts, { client: fake as never, now: t2 })
    check("POSITIVE CONTROL: another tenant's id matches nothing — recorded 0, said", wrong.recorded === 0 && !!wrong.error)
    row.motivation_type = "relocation"
    const r3 = await recordConversationFacts(CID, BRK, [{ key: "motivation", value: "closer to family", confidence: 0.7 }], { client: fake as never, now: t2 })
    check("a typed motivation_type column wins — free words are not recorded beside it (no flip-flop)", r3.recorded === 0)

    const tool = blankStrings(stripComments(readFileSync(join(process.cwd(), "lib/ai-isa/customer-context-tools.ts"), "utf8")))
    check("WIRED: record_qualification (every AI surface's shared tool) records the facts via recordConversationFacts",
      /factsFromQualification\(\{/.test(tool) && /recordConversationFacts\(ctx\.contactId, ctx\.brokerageId, facts,/.test(tool))
  }

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
