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
 *   persona 'investor'    → refused by the CHECK at the time of that live run;
 *                           ADMITTED since m589 (owner: "investor is a persona
 *                           and not a contact type")
 *   an active enrolment blocks a second; a COMPLETED one does not
 */
import { readFileSync } from "node:fs"
import {
  CONTACT_SOURCE_HOME_VALUE,
  CONTACT_SOURCE_LEAD_MAGNET,
  CAMPAIGN_PERSONAS,
  CAMPAIGN_CONTACT_TYPES,
  normalizeContactSource,
  normalizeContactPersona,
  contactTypeForContact,
  contactTypeForSource,
  isCampaignPersona,
  isCampaignContactType,
} from "../lib/campaigns/contact-sources"
import type { Persona } from "../lib/kernel/types"
import {
  autoEnrollContact,
  pickSequence,
  ACTIVE_ENROLLMENT_STATUSES,
} from "../lib/campaign-sequences/auto-enroll"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  stripComments(readFileSync(p, "utf8"))

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

console.log("\n── TWO axes, not one (m294 corrects m293) ──")
{
  // m293 shipped `persona` with a CHECK of buyer|seller|both|lifetime. That is
  // CONTACT_TYPE. Persona is the SITUATION that brought them to the market.
  const liveType = CHECK_VOCABULARIES.campaign_sequences?.contact_type ?? []
  // The persona vocabulary anchor is contacts.contact_persona — the column the
  // enrolment input actually carries (AutoEnrollInput.contactPersona) — which
  // m589 (APPLIED) widened to fourteen values including 'investor' (owner
  // ruling: "investor is a persona and not a contact type"). The
  // campaign_sequences.persona CHECK must stay the SAME vocabulary; m591
  // (written, not applied) widens it, and the check below stays honestly red
  // until the integrator lands it. This block previously pinned `13` — a
  // waypoint count (§2); the rule is roster ≡ live CHECK, whatever the number.
  const livePersona = CHECK_VOCABULARIES.contacts?.contact_persona ?? []
  const liveSeqPersona = CHECK_VOCABULARIES.campaign_sequences?.persona ?? []

  check(`contact_type has 4 values (${liveType.join(", ")})`, liveType.length === 4)
  check("the module declares exactly them",
    CAMPAIGN_CONTACT_TYPES.length === 4 && CAMPAIGN_CONTACT_TYPES.every((t) => liveType.includes(t)))
  check("'first_time' is NOT a contact_type", !isCampaignContactType("first_time"))

  check(`the live contacts.contact_persona CHECK is non-empty (${livePersona.length} values)`, livePersona.length > 0)
  check("the module declares exactly the live contacts.contact_persona vocabulary",
    CAMPAIGN_PERSONAS.length === livePersona.length && CAMPAIGN_PERSONAS.every((p) => livePersona.includes(p)))
  check(`campaign_sequences.persona is the SAME vocabulary — m591 widens it with 'investor'; red until applied (contacts=${livePersona.length}, sequences=${liveSeqPersona.length})`,
    livePersona.length === liveSeqPersona.length && livePersona.every((p) => liveSeqPersona.includes(p)))
  check("'seller' is NOT a persona — that was the m293 error",
    !isCampaignPersona("seller") && !isCampaignPersona("buyer"))
  for (const p of ["first_time", "divorce", "probate", "expired", "fsbo", "downsize", "senior"]) {
    check(`persona '${p}' is storable`, livePersona.includes(p))
  }

  // The persona vocabulary must stay identical to lib/kernel/types.ts `Persona`,
  // which lib/agents/campaign-orchestrator.ts already composes campaigns by.
  const kernelPersonas: Persona[] = ["first_time", "relocated", "luxury", "fsbo", "probate", "upsize",
    "downsize", "military", "divorce", "senior", "expired", "foreclosure", "investor", "other"]
  check("the persona set is IDENTICAL to the kernel Persona union",
    kernelPersonas.length === CAMPAIGN_PERSONAS.length &&
    kernelPersonas.every((p) => (CAMPAIGN_PERSONAS as readonly string[]).includes(p)))

  check("seller resolves from contact_type", contactTypeForContact("seller") === "seller")
  check("a past client is lifetime_customer", contactTypeForContact("past_client") === "lifetime_customer")
  check("an unknown type defaults to buyer, never dropped",
    contactTypeForContact("wat") === "buyer" && contactTypeForContact(null) === "buyer")
  check("a home-value capture is a SELLER whatever the type said",
    contactTypeForSource(CONTACT_SOURCE_HOME_VALUE, "buyer") === "seller")
  check("…but a known lifetime customer stays lifetime",
    contactTypeForSource(CONTACT_SOURCE_HOME_VALUE, "past_client") === "lifetime_customer")

  // contacts.contact_persona is free text and has ALREADY drifted from Persona.
  check("'first_time_buyer' (a live value) maps to first_time",
    normalizeContactPersona("first_time_buyer") === "first_time")
  check("'luxury_buyer' (a live value) maps to luxury",
    normalizeContactPersona("luxury_buyer") === "luxury")
  check("'downsizer' maps to downsize", normalizeContactPersona("downsizer") === "downsize")
  check("'listing_seller' names a CONTACT TYPE, not a situation → null",
    normalizeContactPersona("listing_seller") === null)
  check("'past_client' likewise → null", normalizeContactPersona("past_client") === null)
  check("an unknown persona is null, never guessed", normalizeContactPersona("wat") === null)
}

console.log("\n── selection ranks MOST SPECIFIC across both axes ──")
{
  const all = [
    { id: "divorcing-seller", contact_type: "seller", persona: "divorce" },
    { id: "any-seller",       contact_type: "seller", persona: null },
    { id: "anyone-divorcing", contact_type: null,     persona: "divorce" },
    { id: "anyone",           contact_type: null,     persona: null },
  ]
  check("a divorcing seller gets the divorcing-seller campaign",
    pickSequence(all, "seller", "divorce")?.id === "divorcing-seller")
  check("a downsizing seller falls back to the general seller campaign",
    pickSequence(all, "seller", "downsize")?.id === "any-seller")
  check("a divorcing BUYER gets the persona campaign, not the seller one",
    pickSequence(all, "buyer", "divorce")?.id === "anyone-divorcing")
  check("a first-time buyer with no matching rung falls all the way back",
    pickSequence(all, "buyer", "first_time")?.id === "anyone")
  check("a contact with NO persona still gets the contact_type campaign",
    pickSequence(all, "seller", null)?.id === "any-seller")

  // The important negative: never enrol into a campaign written for someone else.
  check("a probate campaign never takes a first-time buyer",
    pickSequence([{ id: "probate", contact_type: null, persona: "probate" }], "buyer", "first_time") === null)
  check("a seller campaign never takes a buyer",
    pickSequence([{ id: "sellers", contact_type: "seller", persona: null }], "buyer", "first_time") === null)
  check("no candidates → null, not a guess", pickSequence([], "seller", "divorce") === null)
}

console.log("\n── the enroller ──")
{
  const seq = [{ id: "seq-1", contact_type: "seller", persona: null }]
  const a = fakeDb({ campaign_sequences: [seq], sequence_enrollments: [[]] })
  const r = await autoEnrollContact(a.db, {
    brokerageId: "b1", contactId: "c1", source: "home_value_tool", contactType: "seller",
    contactPersona: "downsizer", enrolledBy: "agent-1", now: new Date("2026-07-29T00:00:00.000Z"),
  })
  check("enrols on the canonicalised source", r.enrolled && r.sequenceId === "seq-1")
  const sel = a.calls.find((c) => c.table === "campaign_sequences")
  check("selects by brokerage + source_key + active",
    sel?.filters.brokerage_id === "b1" && sel?.filters.source_key === "home_value" && sel?.filters.is_active === true)
  const ins = a.calls.find((c) => c.table === "sequence_enrollments" && c.payload)
  // current_step is the last COMPLETED step (engine convention — the executor
  // sends current_step + 1). This check used to pin current_step === 1, which
  // was the off-by-one itself: every auto-enrolled contact skipped the first
  // touch (fixed 2026-08-28). Assert the RULE: fresh enrolment at 0, and a
  // next_step_at the step cron can actually poll.
  check("writes an active enrolment awaiting its FIRST touch (current_step 0, next_step_at set)",
    ins?.payload.status === "active" && ins?.payload.current_step === 0 && typeof ins?.payload.next_step_at === "string")
  check("first step defaults to 24h out",
    ins?.payload.next_step_at === "2026-07-30T00:00:00.000Z")
  check("carries the tenant and the enrolling agent",
    ins?.payload.brokerage_id === "b1" && ins?.payload.enrolled_by === "agent-1")

  const b = fakeDb({ campaign_sequences: [seq], sequence_enrollments: [[{ id: "e1", status: "active" }]] })
  const r2 = await autoEnrollContact(b.db, { brokerageId: "b1", contactId: "c1", source: "home_value", contactType: "seller" })
  check("a double form post does not enrol twice", !r2.enrolled && r2.reason === "already enrolled")
  check("…and it does not insert", !b.calls.some((c) => c.table === "sequence_enrollments" && c.payload))

  const c = fakeDb({ campaign_sequences: [[]], sequence_enrollments: [[]] })
  const r3 = await autoEnrollContact(c.db, { brokerageId: "b1", contactId: "c1", source: "home_value", contactType: "seller" })
  check("no keyed sequence → no enrolment, and it says so",
    !r3.enrolled && (r3.reason ?? "").includes("no active sequence"))

  const d = fakeDb({ campaign_sequences: [[]], sequence_enrollments: [[]] })
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
