#!/usr/bin/env tsx
/**
 * scripts/campaign-auto-enroll-simulator.ts   (npm run test:campaign-auto-enroll) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONTACT SIGNS UP, THE CAMPAIGN STARTS.
 *
 * OWNER RULING: "the home value and lead magnet contacts should have a source and
 * the campaign sequence should be keyed on source. persona column should be
 * present. the campaigns should be automatically keyed off when the contact signs
 * up for those campaigns automatically (autonomous)."
 *
 * WHAT WAS THERE. Two capture flows each hand-rolled a lookup for their follow-up
 * sequence, and both asked for a literal the column's CHECK does not admit:
 *
 *   home-value    .or("trigger_event.eq.home_value_submitted,
 *                      sequence_type.eq.seller_nurture")
 *   lead-magnet   .eq("sequence_type", "lead_magnet")
 *
 * trigger_event admits 14 values, none of them home_value_submitted;
 * sequence_type admits drip|nurture|post_close|re_engagement|transaction, neither
 * seller_nurture nor lead_magnet among them. Both matched nothing on every run —
 * NO capture from either flow was ever enrolled in anything. The home-value flow
 * even notified the agent "Review and start a drip campaign", the manual fallback
 * for an automation that never fired.
 *
 * WHY I DID NOT JUST FIX THE LITERAL. I flagged this earlier and deliberately left
 * it: rewriting `seller_nurture` → `nurture` would make the lookup match an
 * ARBITRARY nurture sequence, so a buyer drip could enrol a home-value seller.
 * That is worse than not firing. The table had no discriminator. m293 adds it —
 * source_key + persona — and the enroller keys on that.
 *
 * SOURCE HAD TO BE CANONICALISED FIRST. contacts.source is free text, and the
 * home-value capture wrote it TWO ways from one feature: source: "home_value" in
 * one insert branch and "home_value_tool" in another. Keying on a value the
 * writers disagree about would silently skip half the captures.
 *
 * VERIFIED LIVE against seeded sequences, then deleted:
 *   home_value + seller   → the seller-specific drip
 *   home_value + buyer    → still the seller drip (a home-value lead IS a seller)
 *   home_value + lifetime → falls back to the persona-agnostic drip
 *   persona 'investor'    → refused by the CHECK
 *   an active enrolment blocks a second; a COMPLETED one does not
 */
import { readFileSync } from "node:fs"
import {
  CONTACT_SOURCE_HOME_VALUE,
  CONTACT_SOURCE_LEAD_MAGNET,
  CAMPAIGN_PERSONAS,
  normalizeContactSource,
  personaForContactType,
  personaForSource,
  isCampaignPersona,
} from "../lib/campaigns/contact-sources"
import {
  autoEnrollContact,
  pickSequence,
  ACTIVE_ENROLLMENT_STATUSES,
} from "../lib/campaign-sequences/auto-enroll"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

/** Recording fake: per-table queued results, and every filter captured. */
function fakeDb(results: Record<string, any[]>) {
  const calls: Array<{ table: string; filters: Record<string, unknown>; payload?: any }> = []
  const queues: Record<string, any[][]> = {}
  for (const [t, rows] of Object.entries(results)) queues[t] = rows.slice()
  const db = {
    from(table: string) {
      const rec = { table, filters: {} as Record<string, unknown>, payload: undefined as any }
      calls.push(rec)
      const next = () => (queues[table] ?? []).shift() ?? []
      const b: any = {
        select() { return b },
        eq(c: string, v: unknown) { rec.filters[c] = v; return b },
        is(c: string, v: unknown) { rec.filters[`${c}:is`] = v; return b },
        in(c: string, v: unknown) { rec.filters[`${c}:in`] = v; return b },
        limit() { return b },
        insert(p: any) { rec.payload = p; return Promise.resolve({ error: null }) },
        maybeSingle() { return Promise.resolve({ data: next()[0] ?? null, error: null }) },
        then(res: any) { return Promise.resolve({ data: next(), error: null }).then(res) },
      }
      return b
    },
  }
  return { db, calls }
}

console.log("\n── the source vocabulary is canonical, and repairs what was written ──")
{
  check("home_value is the key", CONTACT_SOURCE_HOME_VALUE === "home_value")
  check("lead_magnet is the key", CONTACT_SOURCE_LEAD_MAGNET === "lead_magnet")
  check("'home_value_tool' — the second spelling one feature wrote — maps forward",
    normalizeContactSource("home_value_tool") === CONTACT_SOURCE_HOME_VALUE)
  check("'home_value_page' maps forward too",
    normalizeContactSource("home_value_page") === CONTACT_SOURCE_HOME_VALUE)
  check("a prefixed magnet source keys on its prefix",
    normalizeContactSource("lead_magnet:home_valuation") === CONTACT_SOURCE_LEAD_MAGNET)
  check("case and padding do not matter", normalizeContactSource("  Home_Value  ") === CONTACT_SOURCE_HOME_VALUE)
  check("a NON-keyed source returns null — never an arbitrary campaign",
    normalizeContactSource("website") === null && normalizeContactSource("referral") === null)
  check("empty/null are null", normalizeContactSource("") === null && normalizeContactSource(null) === null)
}

console.log("\n── persona matches the live CHECK (m293) ──")
{
  const live = CHECK_VOCABULARIES.campaign_sequences?.persona ?? []
  check(`campaign_sequences.persona has 4 values (${live.length})`, live.length === 4)
  check("the module declares exactly them",
    CAMPAIGN_PERSONAS.length === 4 && CAMPAIGN_PERSONAS.every((p) => live.includes(p)))
  check("'investor' is not a campaign persona", !isCampaignPersona("investor"))
  check("seller resolves from contact_type", personaForContactType("seller") === "seller")
  check("both resolves", personaForContactType("both") === "both")
  check("a past client is lifetime", personaForContactType("past_client") === "lifetime")
  check("sphere is lifetime too", personaForContactType("sphere") === "lifetime")
  check("an unknown type defaults to buyer, never dropped",
    personaForContactType("wat") === "buyer" && personaForContactType(null) === "buyer")
  check("a home-value capture is a SELLER whatever the type says",
    personaForSource(CONTACT_SOURCE_HOME_VALUE, "buyer") === "seller")
  check("…but a known lifetime customer stays lifetime",
    personaForSource(CONTACT_SOURCE_HOME_VALUE, "past_client") === "lifetime")
  check("a lead magnet keeps the contact's own persona",
    personaForSource(CONTACT_SOURCE_LEAD_MAGNET, "buyer") === "buyer")
}

console.log("\n── selection: exact persona beats persona-agnostic ──")
{
  const both = [{ id: "seller-drip", persona: "seller" }, { id: "any-drip", persona: null }]
  check("a seller gets the seller drip", pickSequence(both, "seller")?.id === "seller-drip")
  check("a lifetime contact falls back to the agnostic drip", pickSequence(both, "lifetime")?.id === "any-drip")
  check("agnostic-only still enrols", pickSequence([{ id: "any-drip", persona: null }], "buyer")?.id === "any-drip")
  check("no candidates → null, not a guess", pickSequence([], "seller") === null)
  check("a mismatched-persona-only set does NOT enrol the wrong audience",
    pickSequence([{ id: "buyer-drip", persona: "buyer" }], "seller") === null)
}

console.log("\n── the enroller ──")
{
  const seq = [{ id: "seq-1", persona: "seller" }]
  const a = fakeDb({ campaign_sequences: [seq, []], sequence_enrollments: [[]] })
  const r = await autoEnrollContact(a.db, {
    brokerageId: "b1", contactId: "c1", source: "home_value_tool", contactType: "seller",
    enrolledBy: "agent-1", now: new Date("2026-07-29T00:00:00.000Z"),
  })
  check("enrols on the canonicalised source", r.enrolled && r.sequenceId === "seq-1")
  const sel = a.calls.find((c) => c.table === "campaign_sequences")
  check("selects by brokerage + source_key + active",
    sel?.filters.brokerage_id === "b1" && sel?.filters.source_key === "home_value" && sel?.filters.is_active === true)
  const ins = a.calls.find((c) => c.table === "sequence_enrollments" && c.payload)
  check("writes an active enrolment at step 1", ins?.payload.status === "active" && ins?.payload.current_step === 1)
  check("first step defaults to 24h out",
    ins?.payload.next_step_at === "2026-07-30T00:00:00.000Z")
  check("carries the tenant and the enrolling agent",
    ins?.payload.brokerage_id === "b1" && ins?.payload.enrolled_by === "agent-1")

  const b = fakeDb({ campaign_sequences: [seq, []], sequence_enrollments: [[{ id: "e1", status: "active" }]] })
  const r2 = await autoEnrollContact(b.db, { brokerageId: "b1", contactId: "c1", source: "home_value", contactType: "seller" })
  check("a double form post does not enrol twice", !r2.enrolled && r2.reason === "already enrolled")
  check("…and it does not insert", !b.calls.some((c) => c.table === "sequence_enrollments" && c.payload))

  const c = fakeDb({ campaign_sequences: [[], []], sequence_enrollments: [[]] })
  const r3 = await autoEnrollContact(c.db, { brokerageId: "b1", contactId: "c1", source: "home_value", contactType: "seller" })
  check("no keyed sequence → no enrolment, and it says so",
    !r3.enrolled && (r3.reason ?? "").includes("no active sequence"))

  const d = fakeDb({ campaign_sequences: [[], []], sequence_enrollments: [[]] })
  const r4 = await autoEnrollContact(d.db, { brokerageId: "b1", contactId: "c1", source: "website" })
  check("a non-keyed source never touches the database",
    !r4.enrolled && d.calls.length === 0 && (r4.reason ?? "").includes("not campaign-keyed"))

  const e = { from() { throw new Error("boom") } }
  const r5 = await autoEnrollContact(e as any, { brokerageId: "b1", contactId: "c1", source: "home_value" })
  check("it never throws into the capture — the contact is what matters",
    !r5.enrolled && r5.reason === "boom")

  check("a completed enrolment is NOT a blocker (a past client can re-enter)",
    !(ACTIVE_ENROLLMENT_STATUSES as readonly string[]).includes("completed") &&
    !(ACTIVE_ENROLLMENT_STATUSES as readonly string[]).includes("converted"))
  const liveEnr = CHECK_VOCABULARIES.sequence_enrollments?.status ?? []
  check("every blocking status is a real enrolment status",
    ACTIVE_ENROLLMENT_STATUSES.every((s) => liveEnr.includes(s)))
}

console.log("\n── both captures go through the one enroller ──")
{
  const hv = src("app/actions/home-value.ts")
  check("home-value calls autoEnrollContact", /autoEnrollContact\(supabase, \{/.test(hv))
  check("its dead lookup is gone",
    !/seller_nurture/.test(hv) && !/home_value_submitted/.test(hv))
  // Both contact inserts plus the enroller call reference the constant. Scoped to
  // the CONTACTS spellings: calendar_events.source keeps "home_value_page", which
  // records where an appointment came from — a different table, different meaning.
  check("no contacts insert still writes a raw source literal",
    (hv.match(/\bsource: CONTACT_SOURCE_HOME_VALUE/g) ?? []).length >= 2 &&
    !/\bsource: "home_value"/.test(hv) && !/\bsource: "home_value_tool"/.test(hv))
  // tcpa_consent_source KEEPS the literal on purpose: that column records which
  // tool captured consent — TCPA provenance, not the campaign key. Only
  // contacts.source is canonicalised.
  check("the 'home_value_tool' spelling survives ONLY as consent provenance",
    !/\bsource: "home_value_tool"/.test(hv) &&
    /tcpa_consent_source: tcpaConsent \? "home_value_tool"/.test(hv))

  const lm = src("lib/kernel/lead-magnets.ts")
  check("lead-magnet calls autoEnrollContact", /autoEnrollContact\(supabase, \{/.test(lm))
  check("its dead lookup is gone", !/"sequence_type", "lead_magnet"/.test(lm))
  check("it writes the canonical source", /CONTACT_SOURCE_LEAD_MAGNET/.test(lm))
  check("it resolves the persona whether the contact was new or existing",
    /let capturedContactType: string \| null = null/.test(lm) &&
    /contactType: capturedContactType/.test(lm))
  check("a magnet download follows up immediately, not in 24h",
    /firstStepDelayMs: 0/.test(lm))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ CAMPAIGN_AUTO_ENROLL_FAIL"); process.exit(1) }
console.log(" ✅ CAMPAIGN_AUTO_ENROLL_PASS — the capture enrols itself, keyed on source and persona")
