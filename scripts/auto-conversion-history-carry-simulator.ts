#!/usr/bin/env tsx
/**
 * scripts/auto-conversion-history-carry-simulator.ts  (npm run test:auto-conversion-carry)
 *
 * THE AUTOMATIC LEAD→CONTACT CONVERSION CARRIES THE LEAD'S HISTORY TOO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 *
 * There are TWO lanes that turn a lead into a contact:
 *
 *   MANUAL     app/actions → lib/contact-promotion/promote-lead-to-contact.ts
 *              promoteLeadToContactService — a human clicks "promote".
 *   AUTOMATIC  lib/kernel/lead-acquisition-handlers.ts handleLeadAssigned —
 *              a qualified lead clears evaluateAndAssignLead and becomes a
 *              contact with NO human click. This is the lane the owner's routing
 *              ruling makes the NORMAL one.
 *
 * `lib/contact-promotion/history-carry.ts:carryLeadHistoryToContact` does two
 * things: it stamps the lineage LINK (leads.contact_id + converted_at) and it
 * RE-POINTS the sixteen dual-keyed history tables — the ISA activity feed, the
 * call log, the qualification record, voice_calls, the outreach ledger, the
 * consent events, the chat transcripts — so the new contact opens onto the
 * conversation that produced it.
 *
 * It was wired into the MANUAL lane only. The automatic lane had a hand-rolled
 * inline UPDATE that stamped the link and nothing else, so every
 * automatically-converted contact — the majority — opened onto an EMPTY history
 * while the lead's own calls and consent trail sat unreachable behind a `leads`
 * row migration 034 locks agents out of. Its own file even documented the
 * re-point list as something that "runs on the automatic conversion path".
 *
 * The fix is the SAME FUNCTION on both lanes, never a second copy — a second
 * copy is exactly how the two drifted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROLS: reverting the carry call, or replacing it with a hand-rolled
 * update, or dropping a table from the shared list, each turns assertions red.
 *
 * No database. Mock clients + source assertions.
 */
import { readFileSync } from "node:fs"
import { carryLeadHistoryToContact, REPOINTED_HISTORY_TABLES } from "../lib/contact-promotion/history-carry"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; failures.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const code = (p: string) => stripComments(readFileSync(p, "utf8"))

/** Records every update()/insert() issued, per table, with its filters. */
function recorder(opts: { failTable?: string } = {}) {
  const calls: Array<{ table: string; op: string; payload: any; filters: Array<[string, string, any]> }> = []
  const from = (table: string) => {
    const rec = { table, op: "", payload: undefined as any, filters: [] as Array<[string, string, any]> }
    const b: any = {
      update: (payload: any) => { rec.op = "update"; rec.payload = payload; calls.push(rec); return b },
      insert: (payload: any) => { rec.op = "insert"; rec.payload = payload; calls.push(rec); return b },
      select: () => b,
      eq: (c: string, v: any) => { rec.filters.push(["eq", c, v]); return b },
      is: (c: string, v: any) => { rec.filters.push(["is", c, v]); return b },
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve: any) =>
        resolve(
          opts.failTable === table
            ? { data: null, error: { message: "refused by RLS" }, count: null }
            : { data: null, error: null, count: 3 },
        ),
    }
    return b
  }
  return { client: { from }, calls }
}

async function main(): Promise<void> {
  const handlers = code("lib/kernel/lead-acquisition-handlers.ts")
  const manual = code("lib/contact-promotion/promote-lead-to-contact.ts")

  // ═══ 1. BOTH LANES RUN THE SAME FUNCTION ══════════════════════════════════
  console.log("\n[1 · one carry, two lanes]")
  {
    check("the MANUAL lane calls carryLeadHistoryToContact", manual.includes("carryLeadHistoryToContact("))
    check("the AUTOMATIC lane (handleLeadAssigned) calls it too — this is the whole finding",
      handlers.includes("carryLeadHistoryToContact("))
    check("...importing it from the shared module, not re-declaring it",
      /(from|import\()\s*['"]@\/lib\/contact-promotion\/history-carry['"]/.test(handlers)
        && !/function carryLeadHistoryToContact/.test(handlers))

    // The hand-rolled inline stamp must be GONE, or the two would both run and
    // the automatic lane would write converted_at twice with different clocks.
    check("...and the hand-rolled inline `contact_id + converted_at` UPDATE it replaces\n    is gone — two writers of one pair can disagree about when a lead converted",
      !/\.from\('leads'\)\s*\.update\(\{\s*contact_id: contact\.id,\s*converted_at:/.test(handlers))
    // UPDATED with the conversion-finality pass. This used to assert an inline
    // `is_active: false` update in THIS file. That inline update was the third
    // hand-rolled deactivation in the tree and it wrote only ONE of the four
    // closure markers — `ai_isa_owner` stayed true and sequence_enrollments
    // stayed open, so a converted lead was still ISA-owned and still enrolled.
    // All converters now delegate to the ONE implementation
    // (lib/contact-promotion/lead-deactivator.ts), which is what the assertion
    // tracks now. Guarded end-to-end by npm run test:conversion-finality.
    check("...while the lead is still CLOSED on this lane — now through the ONE\n    deactivator, not a per-lane inline update that wrote a single marker",
      /deactivateLead\(supabase, leadId\)/.test(handlers))
    check("...and its refusal is READ — supabase-js resolves a refusal, so an\n    unchecked deactivation is a lead that stays active forever, silently",
      /deactivated\.success/.test(handlers))
  }

  // ═══ 2. THE CARRY DOES BOTH HALVES ════════════════════════════════════════
  console.log("\n[2 · the link AND the re-point]")
  {
    const { client, calls } = recorder()
    const res = await carryLeadHistoryToContact(client, {
      leadId: "lead-1", contactId: "contact-1", brokerageId: "brok-1",
    })

    const link = calls.find((c) => c.table === "leads")
    check("the LINK is stamped on leads", !!link && link.op === "update")
    check("...as contacts.id (the PRIMARY key migration 039 joins on), never\n    contacts.contact_id — the tables' two uuids are never equal on a live row",
      link?.payload?.contact_id === "contact-1")
    check("...together with converted_at, in ONE statement so the pair cannot disagree",
      typeof link?.payload?.converted_at === "string")
    check("...and the result reports it landed", res.linked)

    const repointed = calls.filter((c) => c.table !== "leads")
    check(`ALL ${REPOINTED_HISTORY_TABLES.length} dual-keyed history tables are re-pointed`,
      repointed.length === REPOINTED_HISTORY_TABLES.length,
      `${repointed.length} of ${REPOINTED_HISTORY_TABLES.length}`)

    const missed = REPOINTED_HISTORY_TABLES.filter((t) => !repointed.some((c) => c.table === t))
    check("...and none is skipped", missed.length === 0, missed.join(", "))

    const one = repointed[0]
    check("a re-point fills contact_id and rewrites NOTHING else — the row keeps its\n    lead_id, its author and its created_at",
      !!one && Object.keys(one.payload).length === 1 && one.payload.contact_id === "contact-1",
      JSON.stringify(one?.payload))
    check("...only where contact_id IS NULL, so a row that already names a contact\n    is never re-aimed",
      repointed.every((c) => c.filters.some(([k, col]) => k === "is" && col === "contact_id")))
    check("...tenant-pinned, so a re-point can never cross a brokerage boundary",
      repointed.every((c) => c.filters.some(([k, col, v]) => k === "eq" && col === "brokerage_id" && v === "brok-1")))
    check("...and the counts are reported per table", Object.keys(res.repointed).length === REPOINTED_HISTORY_TABLES.length)
  }

  // ═══ 3. NOTHING IS DUPLICATED ═════════════════════════════════════════════
  console.log("\n[3 · re-point, never duplicate]")
  {
    const { client, calls } = recorder()
    await carryLeadHistoryToContact(client, { leadId: "l", contactId: "c", brokerageId: "b" })
    check("not one INSERT is issued — duplicating history would double every count\n    and give one conversation two created_at truths",
      calls.every((c) => c.op === "update"))
  }

  // ═══ 4. EVERY NAMED TABLE AND COLUMN IS REAL ══════════════════════════════
  console.log("\n[4 · a PGRST204 here kills the whole carry, on the lane that runs by default]")
  {
    const bad: string[] = []
    for (const t of REPOINTED_HISTORY_TABLES) {
      const cols = (SCHEMA_SNAPSHOT as Record<string, string[] | undefined>)[t]
      if (!cols) { bad.push(`${t} (no such table)`); continue }
      for (const c of ["lead_id", "contact_id", "brokerage_id"]) {
        if (!cols.includes(c)) bad.push(`${t}.${c}`)
      }
    }
    check("every re-pointed table exists and carries lead_id + contact_id + brokerage_id",
      bad.length === 0, bad.join(", "))

    const leadCols = new Set(SCHEMA_SNAPSHOT.leads)
    check("leads carries contact_id, converted_at and is_active",
      ["contact_id", "converted_at", "is_active"].every((c) => leadCols.has(c)))
  }

  // ═══ 5. A REFUSAL IS SEEN, AND NEVER ABORTS THE CONVERSION ════════════════
  console.log("\n[5 · best-effort, but never silent]")
  {
    const { client } = recorder({ failTable: "voice_calls" })
    const res = await carryLeadHistoryToContact(client, { leadId: "l", contactId: "c", brokerageId: "b" })
    check("a refused re-point is reported as a warning, not swallowed —\n    supabase-js RESOLVES a refusal, it does not throw",
      res.warnings.some((w) => w.includes("voice_calls")))
    check("...and it names the contact whose history is now short", res.warnings.some((w) => w.includes("contact c")))
    check("...while the other fifteen tables still carried",
      Object.keys(res.repointed).length === REPOINTED_HISTORY_TABLES.length - 1)

    const linkFail = recorder({ failTable: "leads" })
    const r2 = await carryLeadHistoryToContact(linkFail.client, { leadId: "l", contactId: "c", brokerageId: "b" })
    check("a refused LINK reports linked:false and says the lineage view will be empty",
      !r2.linked && r2.warnings.some((w) => w.includes("contact_lead_history")))
  }

  // ═══ 6. THE AUTOMATIC LANE SURFACES WHAT THE CARRY REPORTS ════════════════
  console.log("\n[6 · the automatic lane does not discard the warnings]")
  {
    check("handleLeadAssigned logs every carry warning", /carry\.warnings/.test(handlers))
    check("...and never throws on one — a history-carry failure must not turn a\n    successful assignment into a failed request",
      !/throw[\s\S]{0,120}carry\.warnings/.test(handlers))
    check("...and it runs the carry BEFORE it deactivates the lead, so the lineage\n    link exists before the lead's life ends",
      handlers.indexOf("carryLeadHistoryToContact(") < handlers.indexOf("deactivateLead(supabase, leadId)"))
  }

  console.log(`\n${"═".repeat(70)}`)
  console.log(`AUTO CONVERSION HISTORY CARRY — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("Both conversion lanes carry the lead's history through the same function.")
}

main().catch((e) => { console.error(e); process.exit(1) })
