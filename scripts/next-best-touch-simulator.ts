#!/usr/bin/env tsx
/**
 * scripts/next-best-touch-simulator.ts   (npm run test:next-best-touch)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NEXT-BEST-TOUCH DECISION — the manager autonomously picks a contact's next channel by
 * (1) what they REPLY to, (2) AGE-GROUP psychology, (3) ROTATION off the last channel — all
 * within consent. Pure: every branch, no I/O.
 *
 * Wave 100 (100B): plus the CONTACT next-best-action (whether to touch at all) — the SAME NBA as
 * the lead sweep, with dead ends, postponed-until, intent priority, memory, the ledger record and
 * fail-closed reads, executed on an in-memory client; and the property_sold writer.
 */
import { permittedContactChannels, permittedLeadChannels, ageGroupChannelAffinity, decideNextChannel } from "../lib/ai-isa/next-best-touch"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const consented = { email: "c@x.com", phone: "+15125551234", tcpa_consent: true, mailing_address: "9 Oak" }

async function main() {
  console.log("\n[Consent-permitted channels]")
  check("fully consented → email/newsletter/sms/phone/voicedrop/direct_mail (6)", permittedContactChannels(consented).length === 6)
  check("no TCPA → no voice/sms (email + newsletter + mail only)", !permittedContactChannels({ ...consented, tcpa_consent: false }).some((c) => ["sms", "phone", "voicedrop"].includes(c)))
  check("email opted out → email AND newsletter excluded (CAN-SPAM)", (() => { const p = permittedContactChannels({ ...consented, email_opt_out: true }); return !p.includes("email") && !p.includes("newsletter") })())
  check("newsletter permitted whenever email usable", permittedContactChannels(consented).includes("newsletter"))
  check("call_stop_flag → no phone/voicedrop, sms still ok", (() => { const p = permittedContactChannels({ ...consented, call_stop_flag: true }); return !p.includes("phone") && !p.includes("voicedrop") && p.includes("sms") })())
  check("no permitted channel when nothing consented/present", permittedContactChannels({}).length === 0)

  console.log("\n[LEAD channels — same engine, NO TCPA (email/direct_mail/newsletter only)]")
  const leadFull = permittedLeadChannels({ emailUsable: true, mailingVerified: true })
  check("lead with email + mailing → email/newsletter/direct_mail (3)", leadFull.length === 3)
  check("a LEAD never gets sms/phone/voicedrop (TCPA floor)", !leadFull.some((c) => ["sms", "phone", "voicedrop"].includes(c)))
  check("lead with no usable email → no email/newsletter", (() => { const p = permittedLeadChannels({ emailUsable: false, mailingVerified: true }); return !p.includes("email") && !p.includes("newsletter") && p.includes("direct_mail") })())
  check("lead with nothing verified → empty (no_outreach upstream)", permittedLeadChannels({ emailUsable: false, mailingVerified: false }).length === 0)
  // Leads run through the SAME decideNextChannel — cohort-aware rotation across the lead set.
  check("gen-z LEAD → email first (no sms permitted), within the lead set", decideNextChannel({ permitted: leadFull, cohort: "gen_z" }).channel === "email")
  check("LEAD rotates email→ another lead channel when email was last", decideNextChannel({ permitted: leadFull, cohort: "gen_z", lastChannel: "email" }).channel !== "email")

  console.log("\n[Newsletter — the late nurture/rotation pick (managers hand off to Campaign Orch.)]")
  check("newsletter sits LATE in every cohort's affinity (never first)", (["gen_z","millennial","gen_x","boomer","silent","unknown"] as const).every((co) => ageGroupChannelAffinity(co)[0] !== "newsletter" && ageGroupChannelAffinity(co).includes("newsletter")))
  // After the 1:1 channels were recently used, rotation reaches the newsletter as the downshift.
  check("contact rotates TO newsletter when its only alternative was last used",
    decideNextChannel({ permitted: ["email", "newsletter"], cohort: "gen_x", lastChannel: "email" }).channel === "newsletter")

  console.log("\n[Age-group psychology — how each generation wants to be reached]")
  check("gen-z leads with SMS (text-first, screens calls)", ageGroupChannelAffinity("gen_z")[0] === "sms")
  check("boomer leads with PHONE", ageGroupChannelAffinity("boomer")[0] === "phone")
  check("silent gen leads with phone, mail high", ageGroupChannelAffinity("silent")[0] === "phone" && ageGroupChannelAffinity("silent").includes("direct_mail"))
  check("gen-x leads with email", ageGroupChannelAffinity("gen_x")[0] === "email")

  console.log("\n[The decision — engagement → age → rotation, within consent]")
  const allFive = permittedContactChannels(consented)
  check("gen-z + no history → SMS (age affinity)", decideNextChannel({ permitted: allFive, cohort: "gen_z" }).channel === "sms")
  check("boomer + no history → phone", decideNextChannel({ permitted: allFive, cohort: "boomer" }).channel === "phone")
  check("LEARNED engagement beats age affinity", decideNextChannel({ permitted: allFive, cohort: "gen_z", learnedRanked: ["email"] }).channel === "email")
  check("ROTATION — won't repeat the last channel when an alternative exists",
    decideNextChannel({ permitted: allFive, cohort: "boomer", lastChannel: "phone" }).channel !== "phone")
  check("rotation reason is explained", /rotated off/.test(decideNextChannel({ permitted: allFive, cohort: "boomer", lastChannel: "phone" }).reason))
  check("consent floor — gen-z with NO voice consent never gets sms/phone", (() => { const p = permittedContactChannels({ ...consented, tcpa_consent: false }); const d = decideNextChannel({ permitted: p, cohort: "gen_z" }); return !["sms", "phone", "voicedrop"].includes(d.channel) })())
  check("only one permitted → that channel (no spurious rotation)", decideNextChannel({ permitted: ["email"], cohort: "gen_z", lastChannel: "email" }).channel === "email")
  check("nothing permitted → no_channel", decideNextChannel({ permitted: [], cohort: "unknown" }).channel === "no_channel")


  // ───────────────────────────────────────────────────────────────────────────
  // WAVE 100 (lane 100B) — the CONTACT next-best-action. engageContact's channel pick above
  // decided HOW; nothing decided WHETHER. The contact now runs the SAME NBA as the lead sweep
  // (lib/ai-isa/lead-action-plan.ts planNextContactTouch), fed by loadContactNbaContext with the
  // same inputs through the same helpers. Executed against an in-memory client (no network).
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[Contact NBA — dead ends, postponed, intent priority, ledger, fail-closed (wave 100)]")
  const { planNextContactTouch, loadContactNbaContext, nonActionRecordFor } = await import("../lib/ai-isa/lead-action-plan")
  const { scoreDecayedIntent } = await import("../lib/lead-intelligence/behavioral-summary")
  const { recordObservedDeadEnd } = await import("../lib/kernel/ai-isa")
  const B = "11111111-1111-4111-8111-111111111111"
  const C = "22222222-2222-4222-8222-222222222222"
  const OTHER = "33333333-3333-4333-8333-333333333333"
  const L = "55555555-5555-4555-8555-555555555555"
  const NOW = new Date("2026-10-03T12:00:00Z")
  const day = 86_400_000

  type Row = Record<string, unknown>
  /** In-memory PostgREST stand-in: eq / in / is / not-null / or(contact_id.eq.X,lead_id.in.(…)) / limit; insert().select(). */
  const fakeDb = (tables: Record<string, Row[]>, refuse: string[] = []) => {
    const from = (table: string) => {
      const filters: Array<(r: Row) => boolean> = []
      let lim = Infinity
      let inserted: Row[] | null = null
      let one = false
      const b: any = {
        select: () => b, order: () => b, gte: () => b, contains: () => b,
        maybeSingle: () => { one = true; return b }, single: () => { one = true; return b },
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b },
        in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b },
        is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b },
        not: (c: string) => { filters.push((r) => r[c] !== null && r[c] !== undefined); return b },
        or: (expr: string) => {
          const parts = expr.match(/[a-z_]+\.(?:eq\.[^,]+|in\.\([^)]*\))/g) ?? []
          filters.push((r) => parts.some((p) => {
            const [col, op, ...rest] = p.split("."); const val = rest.join(".")
            return op === "eq" ? r[col] === val : val.replace(/[()]/g, "").split(",").includes(String(r[col]))
          }))
          return b
        },
        limit: (n: number) => { lim = n; return b },
        insert: (row: Row) => { inserted = [{ id: `row-${(tables[table] ?? []).length + 1}`, ...row }]; return b },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          if (refuse.includes(table)) return Promise.resolve({ data: null, error: { message: `${table} refused (proof)` }, count: null }).then(res, rej)
          if (inserted) { (tables[table] ??= []).push(...inserted); return Promise.resolve({ data: inserted, error: null }).then(res, rej) }
          const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, lim)
          return Promise.resolve({ data: one ? (rows[0] ?? null) : rows, error: null, count: rows.length }).then(res, rej)
        },
      }
      return b
    }
    return { from }
  }
  const contact: { id: string; ai_outreach_paused: boolean; qualification_summary: string | null; last_contacted_at: string | null } =
    { id: C, ai_outreach_paused: false, qualification_summary: null, last_contacted_at: null }
  const load = (db: ReturnType<typeof fakeDb>, extra: Partial<typeof contact> = {}, humanInitiated = false) =>
    loadContactNbaContext(db, { brokerageId: B, contact: { ...contact, ...extra }, humanInitiated, now: NOW })
  const decide = async (db: ReturnType<typeof fakeDb>, extra: Partial<typeof contact> = {}) => {
    const r = await load(db, extra)
    return r.ok ? planNextContactTouch({ now: NOW, context: r.context }) : null
  }

  // NOT INTERESTED — recorded on the contact (call disposition) → not touched.
  const ni = await decide(fakeDb({ voice_calls: [{ brokerage_id: B, contact_id: C, lead_id: null, outcome: "not_interested", created_at: "2026-09-30T10:00:00Z" }] }))
  check("NOT-INTERESTED: a contact whose call disposition is not_interested is NOT touched (do_nothing, dead_end)", ni?.action === "do_nothing" && ni?.reasonCode === "dead_end")
  const viaLineage = await decide(fakeDb({
    leads: [{ id: L, brokerage_id: B, contact_id: C, long_term_nurture_until: null }],
    ai_isa_activities: [{ brokerage_id: B, lead_id: L, contact_id: null, activity_type: "outcome_recorded", outcome: "not_interested", created_at: "2026-09-01T10:00:00Z" }],
  }))
  check("NOT-INTERESTED (lineage): an ISA outcome recorded on the contact's LEAD before conversion still stops the contact", viaLineage?.action === "do_nothing" && viaLineage?.reasonCode === "dead_end")
  const otherPerson = await decide(fakeDb({ voice_calls: [{ brokerage_id: B, contact_id: OTHER, lead_id: null, outcome: "not_interested", created_at: "2026-09-30T10:00:00Z" }] }))
  check("POSITIVE CONTROL: another contact's not_interested does not touch this one (send_touch)", otherPerson?.action === "send_touch")
  const represented = await decide(fakeDb({}), { qualification_summary: "Timeline: 3-6 months\nalready represented by an agent: yes" })
  check("REPRESENTED: contacts.qualification_summary 'already represented: yes' is a terminal dead end",
    represented?.action === "do_nothing" && represented?.reasonsNotToAct.some((r) => r.outcome === "already_represented" && r.blocking && /contacts\.qualification_summary/.test(r.detail)))

  // POSTPONED — waits until the date, then acts.
  const until = new Date(NOW.getTime() + 20 * day).toISOString()
  const postponedDb = () => fakeDb({ leads: [{ id: L, brokerage_id: B, contact_id: C, long_term_nurture_until: until }] })
  const pp = await decide(postponedDb())
  check("POSTPONED: a postponed contact WAITS until the date (wait, dueAt = the date)", pp?.action === "wait" && pp?.reasonCode === "postponed" && pp?.dueAt?.toISOString() === until)
  const after = await loadContactNbaContext(postponedDb(), { brokerageId: B, contact, humanInitiated: false, now: new Date(Date.parse(until) + day) })
  check("POSTPONED CONTROL: after the date the same contact is touched (send_touch)",
    after.ok && planNextContactTouch({ now: new Date(Date.parse(until) + day), context: after.context }).action === "send_touch")

  // INTENT PRIORITY — accelerating outranks declining (the same momentum rank the lead sweep uses).
  const ago = (d: number) => new Date(NOW.getTime() - d * day).toISOString()
  const declining = scoreDecayedIntent([
    { type: "appointment_request", source: "valuation_requests", observedAt: ago(12) },
    { type: "valuation_request", source: "valuation_requests", observedAt: ago(9) },
    { type: "showing_request", source: "lead_idx_property_interactions", observedAt: ago(8) },
  ], NOW)
  const accelerating = scoreDecayedIntent([
    { type: "listing_view", source: "lead_idx_property_interactions", observedAt: ago(2) },
    { type: "saved_listing", source: "lead_idx_property_interactions", observedAt: ago(1) },
    { type: "listing_view", source: "external_behavior", observedAt: ago(0) },
    { type: "inbound_reply", source: "conversations", observedAt: ago(0) },
  ], NOW)
  const pa = planNextContactTouch({ now: NOW, context: { intent: accelerating } })
  const pd = planNextContactTouch({ now: NOW, context: { intent: declining } })
  check(`INTENT: a contact whose intent is ACCELERATING outranks one that is DECLINING (priority), though its score is lower (acc ${accelerating.score}/${pa.priority} vs dec ${declining.score}/${pd.priority})`,
    accelerating.score < declining.score && pa.priority > pd.priority)
  check("INTENT: declining intent is weighed (intent_declining, non-blocking) — it does not silently block",
    pd.action === "send_touch" && pd.reasonsNotToAct.some((r) => r.code === "intent_declining" && !r.blocking))

  // FATIGUE — autonomous runs respect last_contacted_at; a human's own ask does not fatigue itself.
  const recent = new Date(NOW.getTime() - 2 * 3_600_000).toISOString()
  const auto = await load(fakeDb({}), { last_contacted_at: recent }, false)
  const human = await load(fakeDb({}), { last_contacted_at: recent }, true)
  check("FATIGUE: an autonomous run inside the fatigue window waits; the human-initiated control is not fatigued",
    auto.ok && human.ok && planNextContactTouch({ now: NOW, context: auto.context }).action === "wait" &&
    planNextContactTouch({ now: NOW, context: human.context }).action === "send_touch")

  // LEDGER — wait / do_nothing are recorded via recordNonAction's context; acting records nothing.
  const recWait = pp ? nonActionRecordFor(pp, { brokerageId: B, contactId: C, now: NOW }) : null
  const recNi = ni ? nonActionRecordFor(ni, { brokerageId: B, contactId: C, now: NOW }) : null
  check("LEDGER: wait → WAIT_COOLDOWN, do_nothing → NO_ACTION_NEEDED, both on the contact subject",
    recWait?.reasonCode === "WAIT_COOLDOWN" && recNi?.reasonCode === "NO_ACTION_NEEDED" && recWait?.subject.id === C && recNi?.subject.type === "contact")
  check("LEDGER CONTROL: send_touch records no non-action", otherPerson ? nonActionRecordFor(otherPerson, { brokerageId: B, contactId: C, now: NOW }) === null : false)

  // FAIL CLOSED — a refused dead-end read is "could not check", never "never said no".
  const refused = await load(fakeDb({}, ["voice_calls"]))
  check("FAIL-CLOSED: a refused voice_calls read returns ok:false (engageContact then refuses: stop:nba_unreadable)", !refused.ok)

  // MEMORY — current facts reach the decision as evidence.
  const withMem = await decide(fakeDb({ contacts: [{ id: C, brokerage_id: B, metadata: { context_spine: { facts: [
    { key: "timeline", value: "3-6_months", observedAt: ago(2), confidence: 0.9, reviewBy: new Date(NOW.getTime() + 60 * day).toISOString(), source: "proof" },
  ] } } }] }))
  check("MEMORY: a current memory fact from the contact's spine is evidence on the decision", !!withMem?.evidence.some((e) => e.kind === "memory:timeline"))

  // PROPERTY_SOLD — the writer the vocabulary lacked, onto the existing source the NBA reads.
  const soldDb = fakeDb({ ai_isa_activities: [] })
  const w1 = await recordObservedDeadEnd(soldDb, { brokerageId: B, subject: { type: "contact", id: C }, outcome: "property_sold", source: "proof feed" })
  const w2 = await recordObservedDeadEnd(soldDb, { brokerageId: B, subject: { type: "contact", id: C }, outcome: "property_sold", source: "proof feed" })
  check("PROPERTY-SOLD WRITER: records once on ai_isa_activities (outcome_recorded); a second observation is a duplicate, not a second row",
    w1.recorded && !w2.recorded && w2.duplicate)
  const soldCtx = await load(soldDb)
  check("PROPERTY-SOLD READ BACK: the contact NBA now carries property_sold (weighed only under the default suppressions)",
    soldCtx.ok && (soldCtx.context.deadEnds ?? []).some((d) => d.outcome === "property_sold") &&
    planNextContactTouch({ now: NOW, context: soldCtx.context }).action === "send_touch")
  check("PROPERTY-SOLD SUPPRESSED: a brokerage that suppresses on property_sold stops the touch",
    soldCtx.ok && planNextContactTouch({ now: NOW, context: { ...soldCtx.context, suppressOnOutcomes: ["property_sold"] } }).action === "do_nothing")
  const wRefused = await recordObservedDeadEnd(fakeDb({}, ["ai_isa_activities"]), { brokerageId: B, subject: { type: "lead", id: L }, outcome: "property_sold", source: "proof" })
  check("PROPERTY-SOLD FAIL-CLOSED: a refused dedupe read writes nothing and says so", !wRefused.recorded && !!wRefused.error)

  // WIRING — on the real callers, read from stripped source, with a positive control.
  const { readFileSync } = await import("node:fs")
  const { stripComments } = await import("./strip-comments")
  const src = (p: string) => stripComments(readFileSync(p, "utf8"))
  const engage = src("app/actions/ai-isa/engage-contact.ts")
  const wired = (s: string) => /loadContactNbaContext\(/.test(s) && /planNextContactTouch\(/.test(s) && /recordNonAction\(nonAction/.test(s) &&
    s.indexOf("planNextContactTouch(") < s.indexOf("from('client_portal_messages').insert")
  check("WIRED: engageContact runs the contact NBA and records non-actions BEFORE the portal note (a touch too)", wired(engage))
  check("WIRED CONTROL: a specimen that decides after the portal note is refused",
    !wired(`await supabase.from('client_portal_messages').insert({}); loadContactNbaContext(x); planNextContactTouch(y); recordNonAction(nonAction)`))
  check("WIRED: the RentCast sold transition and the closed transaction both write property_sold",
    /recordObservedDeadEnd\(/.test(src("lib/kernel/listings-batchdata-feed.ts")) && /recordPropertySoldForClosedAddress\(/.test(src("lib/kernel/transactions.ts")))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ NEXT_BEST_TOUCH_FAIL"); process.exit(1) }
  console.log(" ✅ NEXT_BEST_TOUCH_PASS — the manager decides WHETHER (the shared NBA: dead ends, postponed, intent) and then HOW (engagement + age + rotation), within consent")
}

main().catch((e) => { console.error(e); process.exit(1) })
