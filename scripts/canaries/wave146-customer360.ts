/**
 * scripts/canaries/wave146-customer360.ts — CUSTOMER 360 canary (wave 146, lane 146J; owner rulings 11, 12, 13; contract C6 — lane 146D):
 *   RULING 11 / C6 — "Enrichment should be customer360 which drives the outreach": customer360For(svc, brokerageId, party) is a READ —
 *     a VIEW over the existing canonical graph (never a duplicate database) — whose every field carries source, time, confidence,
 *     consent and purpose; honest freshness (a monthly dataset is never 'real-time'); append ≠ confirmed intent; tenant-pinned.
 *   RULING 12 — the provider comparison (PeopleData + Versium vs Celebrus, FullContact, DealMachine, …) is a sourced document with a
 *     recommendation; never an invented price ("not published" is an answer); an adapter only for a verified material gap.
 *   RULING 13 — research (protected) attributes stay segregated and out of targeting; the absence of a sensitive field never blocks.
 *
 * Through the survivors at bf67aa63: contacts.enrichment_profile.field_provenance (lib/lead-pipeline/enrichment-column-map.ts
 * FieldProvenance — source / capability / retrievedAt / matchConfidence / purpose), public.protected_research_attributes (m864, lane
 * 145F's segregated store), form_submissions, agent_client_messages. C6 binds by the spec's FILE + NAME and is driven on an in-memory
 * client; its output is read by MEANING (which seeded values and labels appear), never by its shape.
 *
 * MEASURED AT bf67aa63: lib/enrichment/customer-360.ts and docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md do not exist.
 */
import { landedModule, setSvc } from "./_harness"
import { readRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"
import { quiet, sqlCode } from "./wave145-harness"
import { CONTRACTS_146, bind146, canary146, errText, jsonOf, rowCounts, tableDiff, totalAdded, wave146Migrations } from "./wave146-harness"

// ── WAVE146 BIND (lane 146D notes, "## Canary requirements") ── not published at the time of writing; C6 is bound by the spec's name.

/** PURE — every ATTRIBUTE in a value tree: an object carrying both a `value` and a `source` key (the field-level entry), with its path. */
export function provenanceEntries(v: unknown, path = "$", out: Array<{ path: string; entry: Record<string, unknown> }> = []): Array<{ path: string; entry: Record<string, unknown> }> {
  if (Array.isArray(v)) v.forEach((x, i) => provenanceEntries(x, `${path}[${i}]`, out))
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    if ("value" in o && "source" in o) out.push({ path, entry: o })
    for (const [k, x] of Object.entries(o)) if (x && typeof x === "object") provenanceEntries(x, `${path}.${k}`, out)
  }
  return out
}
const hasKey = (o: Record<string, unknown>, re: RegExp) => Object.keys(o).some((k) => re.test(k))
/** PURE — an attribute carries the ruled provenance: time, confidence, consent, purpose, ownership (a null value is an honest
 *  "unstated"; a MISSING key is the defect). */
export function entryComplete(o: Record<string, unknown>): boolean {
  return hasKey(o, /retrieved|observed|as_?of|updated|timestamp|At$|_at$/i) && hasKey(o, /confidence/i) && hasKey(o, /consent/i) && hasKey(o, /purpose/i) && hasKey(o, /owner/i)
}
/** PURE — an attribute from a periodic (monthly) dataset labelled real-time in a freshness CLASS field (never prose). */
export function claimsRealtime(o: unknown): boolean {
  return /"(mode|class|freshness|cadenceClass|cadence_class|kind)"\s*:\s*"(realtime|real_time|real-time|live|streaming)/i.test(jsonOf(o))
}
/** PURE — every object that says an intent is CONFIRMED on appended / vendor data alone (append ≠ intent). */
export function appendedConfirmations(v: unknown, out: string[] = [], path = "$"): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => appendedConfirmations(x, out, `${path}[${i}]`))
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    if (o.confirmed === true && /append|vendor|versium|peopledata|provider/i.test(`${String(o.basis ?? "")} ${String(o.source ?? "")}`)) out.push(path)
    for (const [k, x] of Object.entries(o)) if (x && typeof x === "object") appendedConfirmations(x, out, `${path}.${k}`)
  }
  return out
}

export async function run() {
  const c = canary146("Customer 360: a READ over the canonical graph with field-level source / time / confidence / consent / purpose · honest freshness · append ≠ intent · tenant-pinned · research attributes never surface · the provider comparison is sourced with a recommendation")

  // ── 1 · C6 driven ──
  const C6 = await bind146(CONTRACTS_146.C6_C360)
  const B = "aaaaaaaa-0146-4000-8000-0000000000d1", B2 = "aaaaaaaa-0146-4000-8000-0000000000d2"
  const PROTECTED = "ZZ-PROTECTED-146J"
  const prov = (source: string, purpose = "relationship_outreach") => ({ source, capability: "person.enrich_contact", retrievedAt: "2026-09-30T00:00:00Z", matchConfidence: "individual", purpose, actor: null })
  const svc = memSupabase({
    contacts: [
      { id: "c-1", contact_id: "cc-1", brokerage_id: B, first_name: "Pat", last_name: "Rowe", email: "pat146j@example.test", phone: "+15555550111", contact_type: "buyer", household_income: "100k-150k", homeowner_status: "renter",
        // Protected-class columns PRESENT on the record (ruling 13: stored, never surfaced for outreach) and a STAFF-stated timeline
        // (the positive control for "append ≠ intent": a stated intent IS confirmed).
        gender: "female", marital_status: "married", timeline: "1-3_months",
        // Vendor-appended facts under the stored shapes the intent-signal reader knows (lib/enrichment/intent-signal-sources.ts:
        // PeopleData job_start_date / location_history) plus provenance stamps on projected columns.
        email_opt_out: false, sms_consent: true, enrichment_profile: { household_income: "100k-150k", homeowner_status: "renter", job_start_date: "2026-08-01", location_history: ["Orlando, FL", "Tampa, FL"], captured_at: "2026-09-30T00:00:00Z", field_provenance: { household_income: prov("versium"), homeowner_status: prov("peopledata"), email: prov("contact", "account"), timeline: { source: "staff", capability: "staff_edit", retrievedAt: "2026-10-20T00:00:00Z", matchConfidence: null, purpose: "staff_edit", actor: "u-staff" } } } },
      { id: "c-2", contact_id: "cc-2", brokerage_id: B, first_name: "Lee", email: "lee146j@example.test", enrichment_profile: {} },
    ],
    protected_research_attributes: [{ id: "pr-1", brokerage_id: B, contact_id: "c-1", provider: "versium", source_field: "religion", attribute_value: PROTECTED, purpose: "authorized_research" }],
    form_submissions: [{ id: "fs-1", brokerage_id: B, contact_id: "c-1", form_id: "lm-1", created_at: "2026-10-28T12:00:00Z", data: { interest: "first home guide" } }],
    agent_client_messages: [{ id: "m-1", brokerage_id: B, recipient_contact_id: "c-1", status: "sent", created_at: "2026-10-27T12:00:00Z", channel: "email" }],
    portal_activity: [], listing_views: [], showings: [], transactions: [], leads: [],
  }, { uuidIds: true })
  setSvc(svc)
  await c.check("146D", "C6 · customer360For IS A TENANT-PINNED READ WHOSE EVERY FIELD SAYS WHERE IT CAME FROM (ruling 11: 'field-level source, timestamp, confidence, consent, purpose and ownership — as a VIEW over the existing canonical graph, never a duplicate database … Append ≠ confirmed intent … never call a monthly dataset real-time'; ruling 13): for an own contact it returns the seeded facts, including the vendor-appended ones, and every attribute (an object carrying a value and its source) also carries a time, a confidence, a consent, a purpose and an ownership (null = honestly unstated; a missing key is the defect); it WRITES NOTHING; a monthly-dataset field (Versium / PeopleData) is never classed real-time; appended data alone is never a CONFIRMED intent (finder controls on both); the protected research value never appears; the same contact asked under ANOTHER brokerage yields none of its facts; a contact with no enrichment at all still reads (the absence of a sensitive field never blocks)", async () => {
    if (!C6.mod) return { ok: false, evidence: C6.evidence }
    const before = rowCounts(svc.tables)
    const read = async (b: string, id: string) => { try { return { r: await quiet(async () => C6.mod!.customer360For(svc, b, { kind: "contact", type: "contact", id })), e: null as string | null } } catch (e) { return { r: null, e: errText(e) } } }
    const own = await read(B, "c-1"), foreign = await read(B2, "c-1"), bare = await read(B, "c-2")
    const wrote = totalAdded(tableDiff(before, svc.tables))
    const ownJson = jsonOf(own.r)
    const entries = provenanceEntries(own.r)
    const incomplete = entries.filter((e) => !entryComplete(e.entry)).map((e) => e.path)
    // Vendor-appended facts may surface as attributes (source = the vendor) or as stored provider facts (provider = the vendor):
    // either way they must be there, and none may be classed real-time.
    const vendorObjs: Array<{ path: string; entry: Record<string, unknown> }> = []
    const walk = (v: unknown, path: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`)); else if (v && typeof v === "object") { const o = v as Record<string, unknown>; if (/^(versium|peopledata)/i.test(String(o.source ?? o.provider ?? ""))) vendorObjs.push({ path, entry: o }); for (const [k, x] of Object.entries(o)) if (x && typeof x === "object") walk(x, `${path}.${k}`) } }
    walk(own.r, "$")
    const monthlyRealtime = vendorObjs.filter((e) => claimsRealtime(e.entry)).map((e) => e.path)
    const confirmedOnAppend = appendedConfirmations(own.r)
    const versiumSeen = vendorObjs.length > 0
    // CONTROLS for the two finders: a periodic field labelled realtime IS caught, prose mentioning real-time is not; a confirmed
    // intent on a provider append IS caught, a person-stated one is not.
    const finderControl = claimsRealtime({ source: "versium", freshness: { mode: "realtime_write" } }) && !claimsRealtime({ source: "versium", freshness: { mode: "periodic_provider", cadence: "monthly — never real-time" } })
      && appendedConfirmations({ intent: [{ confirmed: true, basis: "provider_append" }] }).length === 1 && appendedConfirmations({ intent: [{ confirmed: true, basis: "person_stated" }] }).length === 0
    const ownRead = !own.e && !(own.r && typeof own.r === "object" && (own.r as Record<string, unknown>).ok === false)
    // Ruling 13: the protected-class columns are NAMED as withheld, their values never appear; control: a STATED intent is confirmed.
    const protectedValues = /"female"|"married"/.test(ownJson)
    const withheldNamed = /gender/.test(ownJson) && /marital_status/.test(ownJson)
    const statedConfirmed: string[] = []
    const findStated = (v: unknown) => { if (Array.isArray(v)) v.forEach(findStated); else if (v && typeof v === "object") { const o = v as Record<string, unknown>; if (o.confirmed === true && /staff|person|stated/i.test(String(o.basis ?? ""))) statedConfirmed.push(String(o.signal ?? o.source ?? "")); Object.values(o).forEach(findStated) } }
    findStated(own.r)
    // FAIL CLOSED: a refused contacts read is never a view.
    const refusedSvc = memSupabase({ contacts: [] }, { refuse: { contacts: "permission denied for table contacts" } })
    let refusedRead: unknown = null
    try { refusedRead = await quiet(async () => C6.mod!.customer360For(refusedSvc, B, { kind: "contact", type: "contact", id: "c-1" })) } catch (e) { refusedRead = { ok: false, threw: errText(e) } }
    const refusedClosed = (refusedRead as Record<string, unknown> | null)?.ok === false || refusedRead === null
    const ok = ownRead && /pat146j@example\.test|100k-150k/.test(ownJson) && entries.length > 0 && incomplete.length === 0 && versiumSeen && wrote === 0 && monthlyRealtime.length === 0 && confirmedOnAppend.length === 0 && statedConfirmed.length > 0 && finderControl && !ownJson.includes(PROTECTED) && !protectedValues && withheldNamed && !/pat146j@example\.test|100k-150k/.test(jsonOf(foreign.r)) && !bare.e && refusedClosed
    return { ok, evidence: `own → ${own.e ?? (ownRead ? `${entries.length} attribute(s), incomplete ${incomplete.slice(0, 4).join(",") || "none"}, vendor-sourced seen ${versiumSeen}` : `refused ${ownJson.slice(0, 100)}`)}; wrote ${wrote} row(s); monthly labelled real-time ${monthlyRealtime.join(",") || "none"}; intent confirmed on an append ${confirmedOnAppend.join(",") || "none"}; stated intent confirmed ${statedConfirmed.length ? statedConfirmed.slice(0, 2).join(",") : "NONE (control failed)"}; protected research value surfaced ${ownJson.includes(PROTECTED)}; gender / marital values surfaced ${protectedValues}, columns named as withheld ${withheldNamed}; another brokerage → ${foreign.e ?? (/pat146j/.test(jsonOf(foreign.r)) ? "LEAKED" : "nothing")}; no-enrichment contact → ${bare.e ?? "read"}; refused read → ${refusedClosed ? "not a view" : "A VIEW (fails open)"}; finder controls ${finderControl}` }
  })

  // ── 1b · RULING 11's WATCHER: a first-party action → the canonical person → the arbiter, once (lane 146D: watchFirstPartyIntent) ──
  await c.check("146D", "A FIRST-PARTY ACTION REACHES THE ARBITER ONCE, ON THE CANONICAL PERSON, AND ONLY WHEN IT IS NEWS (ruling 11: 'A changed eligible attribute / first-party action → change detected → canonical record matched → gap/freshness/provenance check → record updated → intent context reassessed → arbiter/manager → action or no action → evidence … Append ≠ confirmed intent'): a contact's first saved home an hour ago is routed ONCE to the arbiter as a life-change signal the arbiter knows, about that contact; another tenant's save is not routed; running the watcher again routes nothing more (replay); a refused history read routes nothing for its candidates (fail closed)", async () => {
    const W = await quiet(async () => landedModule<Record<string, any>>("../../lib/enrichment/first-party-intent-watcher.ts")) as Record<string, any> | null
    if (!W || typeof W.watchFirstPartyIntent !== "function") return { ok: false, evidence: "lib/enrichment/first-party-intent-watcher.ts watchFirstPartyIntent not landed — awaiting lane 146D" }
    const NOW = new Date("2026-10-29T15:00:00Z"), hAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
    const ws = memSupabase({
      contacts: [{ id: "c-w", contact_id: "cc-w", brokerage_id: B, agent_id: "ag-w", contact_type: "buyer", is_active: true, deleted_at: null }, { id: "c-x", contact_id: "cc-x", brokerage_id: B2, agent_id: "ag-x", contact_type: "buyer", is_active: true, deleted_at: null }],
      // the live column the save is stamped on (saved_properties.saved_at), the dismissal flag the watcher honours
      saved_properties: [{ id: "sp-1", brokerage_id: B, contact_id: "c-w", saved_at: hAgo(1), dismissed: false, created_at: hAgo(1) }, { id: "sp-x", brokerage_id: B2, contact_id: "c-x", saved_at: hAgo(1), dismissed: false, created_at: hAgo(1) }],
      saved_searches: [], client_portal_activity: [], portal_access_logs: [], website_visitors: [], form_submissions: [], showings: [], showing_requests: [], property_views: [], leads: [], agent_action_ledger: [], signal_reactivations: [],
    }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    setSvc(ws)
    const routed: Array<Record<string, unknown>> = []
    // The responder seam is the arbiter's respondToLifeChangeSignal(svc, signal) — the signal is the SECOND argument.
    const respond = async (_svc: unknown, p: Record<string, unknown>) => { routed.push(p); return { action: "noted" } }
    const run1 = await quiet(async () => W.watchFirstPartyIntent(ws, B, { now: NOW }, { respond, dormancy: { staleDays: 14, lifetimeStaleDays: 60 } })) as Record<string, unknown>
    const first = routed.length
    const run2 = await quiet(async () => W.watchFirstPartyIntent(ws, B, { now: NOW }, { respond, dormancy: { staleDays: 14, lifetimeStaleDays: 60 } })) as Record<string, unknown>
    const arb = await quiet(async () => import("../../lib/ai-isa/followup-arbiter")) as unknown as { LIFE_CHANGE_SIGNAL_KINDS?: Record<string, string> }
    const known = routed.every((p) => !arb.LIFE_CHANGE_SIGNAL_KINDS || String(p.signalType) in arb.LIFE_CHANGE_SIGNAL_KINDS)
    const aboutContact = routed.length > 0 && routed.every((p) => jsonOf(p).includes("c-w") && !jsonOf(p).includes("c-x"))
    const refusedSvc = memSupabase({ contacts: ws.tables.contacts, saved_properties: ws.tables.saved_properties }, { refuse: { agent_action_ledger: "permission denied", signal_reactivations: "permission denied", client_portal_activity: "permission denied", portal_access_logs: "permission denied" } })
    const before = routed.length
    const run3 = await quiet(async () => W.watchFirstPartyIntent(refusedSvc, B, { now: NOW }, { respond, dormancy: { staleDays: 14, lifetimeStaleDays: 60 } })) as Record<string, unknown>
    const routedOnRefusal = routed.length - before
    const ok = first === 1 && routed.length - routedOnRefusal === 1 && known && aboutContact && routedOnRefusal === 0
    return { ok, evidence: `first run routed ${first} (${routed.slice(0, 1).map((p) => `${p.signalType} → ${jsonOf(p.subject ?? p.party ?? p.contactId).slice(0, 40)}`).join("") || "nothing"}); replay routed ${routed.length - first - routedOnRefusal} more (${jsonOf({ replayed: run2?.replayed, routed: run2?.routed }).slice(0, 60)}); signal known to the arbiter ${known}; only the contact's own ${aboutContact}; refused history → routed ${routedOnRefusal} (${jsonOf({ refused: run3?.refused }).slice(0, 40)}); run1 ${jsonOf(run1).slice(0, 80)}` }
  })

  // ── 2 · NEVER A DUPLICATE DATABASE: lane 146D's migrations create no copy of the profile ──
  const dMigs = wave146Migrations().filter((m) => m.lane === "146D")
  const COPY = /customer_?360|c360|unified_?profile|profile_?snapshot|person_?360/i
  const copies = dMigs.flatMap((m) => [...sqlCode(m.sql).matchAll(/CREATE\s+(?:TABLE|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_0-9]+)/gi)].map((x) => x[1]).filter((t) => COPY.test(t)))
  const copyControl = COPY.test("customer_360_profiles") && !COPY.test("contact_signal_events")
  c.rule("146D", "CUSTOMER 360 IS A VIEW, NEVER A SECOND STORE (ruling 11: 'as a VIEW over the existing canonical graph, never a duplicate database'): no lane-146D migration creates a table or materialized view that copies the profile (customer_360 / c360 / unified profile / profile snapshot — positive control on the name finder)",
    copies.length === 0 && copyControl, `lane-146D migrations: ${dMigs.map((m) => m.file.split("/").pop()).join(", ") || "none"}; profile copies: ${copies.join(", ") || "none"}; control ${copyControl}`)

  // ── 3 · RULING 12: the provider comparison is sourced, recommends, and invents no price ──
  const doc = readRepo("docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md")
  const PROVIDERS: Array<[string, RegExp]> = [["Celebrus", /celebrus/i], ["FullContact", /full\s*contact/i], ["DealMachine", /deal\s*machine/i], ["PeopleData", /people\s*data/i], ["Versium", /versium/i]]
  const named = doc ? PROVIDERS.filter(([, re]) => re.test(doc)).map(([p]) => p) : []
  const urls = doc ? new Set([...doc.matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m) => m[0])).size : 0
  const dated = doc ? /20\d\d-\d\d-\d\d/.test(doc) : false
  const recommends = doc ? /^#+\s*.*recommend/im.test(doc) : false
  // RE-ASSERTED at bind (lane 146D's document): a per-line "$ figure without a URL on the same line" finder accused SOURCED rows (a
  // table row citing an earlier source, "(read 2026-10-23)", "$0 vendor (compute only)") — a measurement that accuses a sourced
  // document is worse than none (CLAUDE.md §2). The RULE is per PROVIDER: every compared provider is tied to a source — a URL, a
  // dated read, or the honest "not published" / UNKNOWN — somewhere it is discussed. (Blind spot: each individual figure is not traced.)
  const paras = doc ? doc.split(/\n\s*\n|\n(?=\|)/) : []
  const SOURCED = /https?:\/\/|\(read \d{4}-\d\d-\d\d\)|read \d{4}-\d\d-\d\d|not published|UNKNOWN|§\d/i
  const unsourcedProviders = PROVIDERS.filter(([, re]) => !paras.some((p) => re.test(p) && SOURCED.test(p))).map(([p]) => p)
  const sourcedControl = SOURCED.test("FullContact pricing: not published (read 2026-10-29)") && !SOURCED.test("FullContact costs $1 per record")
  c.rule("146D", "THE PROVIDER COMPARISON IS SOURCED AND RECOMMENDS THE LOWEST-COST COMBINATION (ruling 12: 'Compare the current PeopleData + Versium stack against Celebrus, FullContact, DealMachine … never invent prices — \"not published\" is an answer'): docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md exists, names all five, cites dated sources, carries a recommendation section, and every compared provider is tied to a source or an honest 'not published' / UNKNOWN (positive control on the source finder)",
    !!doc && named.length === PROVIDERS.length && urls >= 5 && dated && recommends && unsourcedProviders.length === 0 && sourcedControl,
    doc ? `named ${named.join(",")}; ${urls} distinct URL(s); dated ${dated}; recommendation section ${recommends}; providers without a source ${unsourcedProviders.join(",") || "none"}; control ${sourcedControl}` : "docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md not written — awaiting lane 146D")

  c.blind("C6 is driven on an in-memory client seeded under the live column names (contacts.enrichment_profile.field_provenance, protected_research_attributes, form_submissions, agent_client_messages); a source lane 146D reads that this seed does not carry simply contributes nothing. Field completeness is judged on every object in the output that names a `source` — an output that carries provenance under another key name reads as 'no provenance entries' and the evidence says so. The watcher chain (a changed attribute / first-party action → match → freshness check → update → intent reassessed → arbiter) is lane 146D's test:lifetime-signals / test:signal-integrity / test:enrichment-*; the comparison document's FACTS are not verified here (only that they are sourced and dated).")
  return c.report([], 0)
}
