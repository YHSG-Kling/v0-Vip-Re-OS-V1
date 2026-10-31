#!/usr/bin/env tsx
/**
 * scripts/event-checkin-writers-guard.ts   (npm run test:event-checkin-writers) — in-memory, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 147, LANE 147F — owner ruling 7, verbatim: "make sure that we didn't lose check-in writers for any event like open
 * houses" — attendance, identity matching, consent, follow-up and event evidence.
 *
 *   1  EVENT TYPES × PRODUCERS × DOORS — the live open_house_events.event_type CHECK (scripts/check-vocabularies.ts) against
 *      the code that CREATES events (every `.from("open_house_events").insert(`, stripped) and the check-in doors that
 *      ACCEPT them. A type with a producer and no accepting door is red; a type with NO producer owes no writer and is
 *      published (CHECK-admitted, never created — measured live 2026-10-31: column default 'open_house', 0 rows).
 *   2  THE WRITER CENSUS — every `.from("open_house_attendees").insert(` site in app/ + lib/ (stripped) belongs to a declared
 *      check-in door or to the kernel writer a door reaches. An undeclared writer is red (a new door must be judged here).
 *   3  THE STAGE MATRIX — each door, followed two calls deep: participant row · identity (person-identity evidence) · consent ·
 *      Contact · the arbiter follow-up (OPEN_HOUSE_ATTENDEE_CAPTURED fanned out / the follow-up action / the greeting) · event
 *      evidence (lifecycle event). Every stage must exist on every door.
 *   4  READERS — each written half has a reader (attendees, the consent ledger, the capture event's reactor reader).
 *   5  OTHER EVENT KINDS — the buyer TOUR check-in writer (tour_stops.time_arrived_at) is present; its proof is test:tour-checkin.
 *   6  RUNTIME — the event-day door on the in-memory client: a consented sign-in → attendee + Contact + consent anchored to
 *      the contact + person evidence + a fanned-out capture event; the walk-in door refuses a body tenant that is not the
 *      session's (the IDOR this wave closed).
 *
 * POSITIVE CONTROLS on every finder. BLIND SPOTS printed at the end.
 * Run: NODE_OPTIONS=--max-old-space-size=6000 npx tsx --conditions=react-server scripts/event-checkin-writers-guard.ts
 */
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { memSupabase } from "./in-memory-supabase"
import { stubModule, setSvc } from "./canaries/_harness"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const raw = (rel: string): string => { try { return readFileSync(join(ROOT, rel), "utf8") } catch { return "" } }
const walk = (d: string, out: string[] = []): string[] => { for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) { const r = join(d, e.name); if (e.isDirectory()) { if (!/^(node_modules|\.next)$/.test(e.name)) walk(r, out) } else if (/\.(ts|tsx)$/.test(e.name)) out.push(r) } return out }

/** Real `.from("t").<op>(` sites (the `.from(` token survives blankStrings — a specimen string is not a site). */
function writeSites(files: Map<string, string>, table: string, op: RegExp): Array<{ file: string; at: number; fn: string; stmt: string }> {
  const out: Array<{ file: string; at: number; fn: string; stmt: string }> = []
  for (const [file, src] of files) {
    const c = blankComments(src), m = blankStrings(c)
    for (const hit of c.matchAll(new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g"))) {
      const at = hit.index ?? 0
      if (!/\.from\(/.test(m.slice(at, at + 7))) continue
      const stmt = c.slice(at, at + 900)
      if (!op.test(m.slice(at, at + 120))) continue
      out.push({ file, at, fn: enclosingFn(m, at), stmt })
    }
  }
  return out
}
function enclosingFn(masked: string, at: number): string {
  const before = masked.slice(0, at)
  const all = [...before.matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/g)]
  return all.length ? all[all.length - 1][1] : "(module)"
}
/** The body of `name` in `src` (top-level function → next top-level function). */
function bodyOf(src: string, name: string): string {
  const c = blankComments(src)
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`).exec(c)
  if (!m) return ""
  const rest = c.slice(m.index + m[0].length)
  const next = /\n(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*[(<]/.exec(rest)
  return c.slice(m.index, m.index + m[0].length + (next ? next.index : rest.length))
}

// ── the declared check-in doors (the entry each SURFACE calls) ─────────────────────────────────────
const DOORS = [
  { key: "kiosk", surface: "public QR / kiosk sign-in (/open-house/[eventId]/signin)", file: "app/api/open-house/attend/route.ts", fn: "POST" },
  { key: "event_day", surface: "the listing's event-day tab", file: "app/actions/seller-open-house.ts", fn: "checkInAttendee" },
  { key: "walk_in", surface: "agent walk-in (mobile walk-in, convert-attendee)", file: "app/actions/open-house-kernel.ts", fn: "completeOpenHouseCheckInAction" },
  { key: "dashboard_steps", surface: "/dashboard/open-houses (the client composes the five kernel steps)", file: "app/actions/open-house-kernel.ts", fn: "createOpenHouseAttendeeFromContactAction", composedWith: ["resolveOrCreateOpenHouseContactAction", "attachOpenHouseSourceAttributionAction", "notifyAssignedAgentForOpenHouseLeadAction", "generateOpenHouseFollowupNextActionAction"] },
  { key: "mobile_known", surface: "mobile panel, a known contact", file: "app/actions/open-house-automation.ts", fn: "recordVisitor" },
] as const
/** Kernel writers the doors reach (a writer here is legitimate only because a declared door calls it). */
const KERNEL_WRITERS = [{ file: "lib/kernel/open-house.ts", fn: "createOpenHouseAttendeeFromContact" }]
/** Files whose top-level functions a door's calls resolve into (two levels). */
const RESOLVE_FILES = ["lib/kernel/open-house.ts", "lib/open-house/instant-greeting.ts", "app/actions/open-house-kernel.ts", "app/actions/seller-open-house.ts", "app/actions/open-house-automation.ts", "app/api/open-house/attend/route.ts"]

const STAGES: Array<[string, RegExp]> = [
  ["participant", /\.from\(\s*["']open_house_attendees["']\s*\)\s*\.\s*insert\(|createOpenHouseAttendeeFromContact\(/],
  ["identity", /linkOpenHouseCheckInIdentity\(|sendInstantOpenHouseGreeting\(|linkPersonEvidence\(|captureContact\(/],
  ["consent", /tcpa_?[cC]onsent|persistContactConsent\(|contact_consent_events/],
  ["contact", /resolveOrCreateOpenHouseContact\(|captureContact\(|contact_id:\s*(params\.contactId|contactId|checkedInContactId)/],
  ["follow_up", /OPEN_HOUSE_ATTENDEE_CAPTURED|generateOpenHouseFollowupNextAction\(|sendInstantOpenHouseGreeting\(/],
  ["evidence", /emitKernelEvent\(|processKernelEvent\(|recordLifecycleEvent\(/],
]

/** The door's reach: its body + the bodies of the functions it calls in RESOLVE_FILES, two levels deep. */
function reach(door: { file: string; fn: string; composedWith?: readonly string[] }): string {
  const defs = new Map<string, string>()
  for (const f of RESOLVE_FILES) { const src = raw(f); for (const m of blankComments(src).matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/g)) if (!defs.has(m[1])) defs.set(m[1], bodyOf(src, m[1])) }
  let text = [door.fn, ...(door.composedWith ?? [])].map((n) => bodyOf(raw(door.file), n)).join("\n")
  for (let level = 0; level < 2; level++) {
    const add: string[] = []
    for (const [name, body] of defs) if (!text.includes(body) && new RegExp(`\\b${name}\\s*\\(`).test(blankStrings(text))) add.push(body)
    text += "\n" + add.join("\n")
  }
  return text
}
function stagesOf(text: string): Record<string, boolean> {
  return Object.fromEntries(STAGES.map(([k, re]) => [k, re.test(text)]))
}

async function main(): Promise<void> {
  const files = new Map<string, string>()
  for (const f of [...walk("app"), ...walk("lib")]) files.set(f, raw(f))

  // ── 1 ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── 1  event types × producers × accepting doors ──")
  const types = CHECK_VOCABULARIES.open_house_events?.event_type ?? []
  const LIVE_DEFAULT = "open_house" // measured live 2026-10-31 (information_schema.columns.column_default): 'open_house'::text — a FIXTURE, published
  const producers = writeSites(files, "open_house_events", /\.\s*(insert|upsert)\s*\(/)
  const produced = new Map<string, string[]>()
  for (const p of producers) {
    const t = /event_type:\s*["']([a-z_]+)["']/.exec(p.stmt.slice(0, 700))?.[1] ?? LIVE_DEFAULT
    produced.set(t, [...(produced.get(t) ?? []), `${p.file}::${p.fn}`])
  }
  const accepted = (doorFilters: string[][]) => (t: string) => doorFilters.some((fl) => fl.length === 0 || fl.includes(t))
  const doorFilters = DOORS.map((d) => [...reach(d).matchAll(/\.eq\(\s*["']event_type["']\s*,\s*["']([a-z_]+)["']\s*\)/g)].map((m) => m[1]))
  console.log(`  · live event types: ${types.join(", ")} · ${producers.length} producer site(s): ${[...produced].map(([t, s]) => `${t} ← ${s.length}`).join("; ")}`)
  for (const t of types) {
    if (produced.has(t)) check(`event type '${t}' has producers AND a check-in door that accepts it`, accepted(doorFilters)(t))
    else console.log(`  ◌ event type '${t}': CHECK-admitted, NO producer in app/ or lib/ (live: 0 rows) — no check-in writer is owed until something creates such an event (published, not red)`)
  }
  check("POSITIVE CONTROL: a producer of 'broker_open' with only an open_house-filtering door would be red", !accepted([["open_house"]])("broker_open") && accepted([[]])("broker_open"))
  check(`every produced type is a live CHECK value (${[...produced.keys()].join(", ")})`, [...produced.keys()].every((t) => types.includes(t)))

  // ── 2 ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── 2  every attendee writer belongs to a declared check-in door ──")
  const writers = writeSites(files, "open_house_attendees", /\.\s*insert\s*\(/)
  const declared = new Set<string>([...DOORS.map((d) => `${d.file}::${d.fn}`), ...KERNEL_WRITERS.map((k) => `${k.file}::${k.fn}`)])
  const undeclared = writers.filter((w) => !declared.has(`${w.file}::${w.fn}`)).map((w) => `${w.file}::${w.fn}`)
  console.log(`  · ${writers.length} open_house_attendees insert site(s): ${writers.map((w) => `${w.file}::${w.fn}`).join(", ")}`)
  check(`every insert site is a declared door or a kernel writer a door reaches (${undeclared.length ? undeclared.join("; ") : "0 undeclared"})`, writers.length > 0 && undeclared.length === 0)
  check("the kernel writer is reached by a declared door (not an orphan writer)", KERNEL_WRITERS.every((k) => DOORS.some((d) => new RegExp(`\\b${k.fn}\\s*\\(`).test(blankStrings(reach(d))))))
  check("POSITIVE CONTROL: a specimen insert outside any door is found as undeclared; a commented one and a string specimen are not",
    (() => {
      const spec = new Map([["app/actions/zz.ts", `export async function sneakyCheckIn(){ await s.from("open_house_attendees").insert({}) }\n// s.from("open_house_attendees").insert({})\nconst X = \`s.from("open_house_attendees").insert({})\``]])
      const w = writeSites(spec, "open_house_attendees", /\.\s*insert\s*\(/)
      return w.length === 1 && w[0].fn === "sneakyCheckIn"
    })())

  // ── 3 ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── 3  the stage matrix: participant · identity · consent · Contact · follow-up · evidence — on every door ──")
  for (const d of DOORS) {
    const s = stagesOf(reach(d))
    const missing = Object.entries(s).filter(([, v]) => !v).map(([k]) => k)
    console.log(`  · ${d.key.padEnd(15)} ${STAGES.map(([k]) => `${k}=${s[k] ? "✓" : "✗"}`).join(" ")}   (${d.surface})`)
    check(`${d.key}: every stage is wired (${missing.length ? `missing ${missing.join(", ")}` : "all six"})`, missing.length === 0)
  }
  check("POSITIVE CONTROL: a door that files the attendee and stops is missing identity, contact, follow-up and evidence",
    (() => { const s = stagesOf(`await svc.from("open_house_attendees").insert({ tcpa_consent: true })`); return s.participant && s.consent && !s.identity && !s.contact && !s.follow_up && !s.evidence })())
  {
    const ev = bodyOf(raw("app/actions/seller-open-house.ts"), "checkInAttendee")
    const emitAt = ev.search(/OPEN_HOUSE_ATTENDEE_CAPTURED/), resolveAt = ev.search(/resolveOrCreateOpenHouseContact\(/)
    check("event_day: the capture event is emitted AFTER the contact resolves, FANNED OUT (not auditOnly) and carries contactId — so the arbiter's reader sees it",
      emitAt > resolveAt && resolveAt > 0 && !/auditOnly:\s*true/.test(ev.slice(emitAt - 400, emitAt + 900)) && /contactId:\s*checkedInContactId/.test(ev.slice(emitAt - 400, emitAt + 900)))
    check("event_day: the consent row is anchored to the contact (contact_id on contact_consent_events)", /contact_consent_events"\)\.insert\(\{[\s\S]{0,200}contact_id:\s*checkedInContactId/.test(ev))
    const walkIn = bodyOf(raw("app/actions/open-house-kernel.ts"), "completeOpenHouseCheckInAction")
    check("walk_in: the session gate runs BEFORE any write (resolveOpenHouseScope; a body brokerage that disagrees is refused)",
      /const scoped = await resolveOpenHouseScope\(input\.open_house_id\)/.test(walkIn) && /decideClaimedTenant\(\{\s*actingBrokerageId:\s*scoped\.scope\.brokerageId,\s*claimedBrokerageId:\s*input\.brokerage_id\s*\}\)/.test(walkIn) && walkIn.search(/resolveOpenHouseScope\(/) < walkIn.search(/resolveOrCreateOpenHouseContact\(/))
    const known = bodyOf(raw("app/actions/open-house-automation.ts"), "recordVisitor")
    check("mobile_known: the body contactId is proved in the event's brokerage before it is filed", /\.from\("contacts"\)\.select\("id"\)\.eq\("id", params\.contactId\)\.eq\("brokerage_id", event\.brokerage_id\)/.test(known) && known.search(/params\.contactId\)\.eq\("brokerage_id"/) < known.search(/from\("open_house_attendees"\)/))
  }

  // ── 4 ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── 4  every written half has a reader ──")
  const readSites = (table: string) => writeSites(files, table, /\.\s*select\s*\(/)
  const attendeeReaders = readSites("open_house_attendees"), consentReaders = readSites("contact_consent_events"), evidenceReaders = readSites("person_identity_evidence")
  check(`open_house_attendees is read (${attendeeReaders.length} reader sites)`, attendeeReaders.length > 0)
  check(`contact_consent_events is read (${consentReaders.length} reader sites)`, consentReaders.length > 0)
  check(`person_identity_evidence is read (${evidenceReaders.length} reader sites)`, evidenceReaders.length > 0)
  check("OPEN_HOUSE_ATTENDEE_CAPTURED has its reactor reader (the AI ISA signal + the conversion welcome)", /params\.event === KernelEvent\.OPEN_HOUSE_ATTENDEE_CAPTURED[\s\S]{0,600}toManager:\s*"ai_isa"/.test(stripComments(raw("lib/kernel/event-reactor.ts"))))
  check("POSITIVE CONTROL: the reader finder sees a specimen select and not a comment", writeSites(new Map([["x.ts", `a.from("t1").select("id")\n// a.from("t1").select("x")`]]), "t1", /\.\s*select\s*\(/).length === 1)

  // ── 5 ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── 5  other event kinds ──")
  const tourWriters = writeSites(files, "tour_stops", /\.\s*update\s*\(/).filter((w) => /time_arrived_at/.test(w.stmt.slice(0, 400)))
  check(`the buyer TOUR check-in writer exists (tour_stops.time_arrived_at — ${tourWriters.map((w) => `${w.file}::${w.fn}`).join(", ") || "none"}); its behaviour is proven by test:tour-checkin`, tourWriters.length > 0 && !!raw("scripts/tour-checkin-simulator.ts"))
  check("an RSVP becomes attendance: the kiosk door writes open_house_rsvp_tracking 'attended'", /open_house_rsvp_tracking[\s\S]{0,600}rsvp_status:\s*"attended"/.test(stripComments(raw("app/api/open-house/attend/route.ts"))))

  // ── 6 ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── 6  runtime: the event-day door files a Contact at check-in; the walk-in door refuses a foreign body tenant ──")
  {
    const B = "b1470000-0000-4000-8000-0000000000e1", B2 = "b1470000-0000-4000-8000-0000000000e2"
    const EV = "e1470000-0000-4000-8000-0000000000e1", LST = "11470000-0000-4000-8000-0000000000e1", AG = "a1470000-0000-4000-8000-0000000000e1", U = "u1470000-0000-4000-8000-0000000000e1"
    const STUB = mkdtempSync(join(tmpdir(), "event-checkin-"))
    const fileStub = (spec: string, real: string, body: string) => { const f = join(STUB, `${spec.replace(/[^a-z0-9]+/gi, "_")}.mjs`); writeFileSync(f, `export * from ${JSON.stringify(pathToFileURL(join(ROOT, real)).href)}\n${body}\n`); stubModule(spec, pathToFileURL(f).href) }
    stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}")
    fileStub("@/lib/identity", "lib/identity/index.ts", `export const getAgentContext = async () => ({ isAuthenticated: true, brokerageId: ${JSON.stringify(B)}, agentId: ${JSON.stringify(AG)}, userId: ${JSON.stringify(U)} })`)
    const svc = memSupabase({
      open_house_events: [{ id: EV, brokerage_id: B, listing_id: LST, agent_id: AG, status: "scheduled" }],
      listings: [{ id: LST, brokerage_id: B, address: "5 Sign-In St" }],
      // AG2 is ANOTHER tenant's agent: with its id in the body, the pre-147 door accepted brokerage B2 outright.
      agents: [{ id: AG, user_id: U, brokerage_id: B }, { id: "a1470000-0000-4000-8000-0000000000e2", user_id: "u1470000-0000-4000-8000-0000000000e2", brokerage_id: B2 }],
      contacts: [], open_house_attendees: [], contact_consent_events: [], lifecycle_events: [], person_identities: [], person_identity_evidence: [],
    }, { uuidIds: true })
    setSvc(svc)
    const soh = await import("../app/actions/seller-open-house")
    const r = await soh.checkInAttendee({ eventId: EV, name: "Pat Visitor", email: "pat@example.test", phone: "8135550147", workingWithAgent: false, tcpaConsent: true }) as any
    const tbl = (t: string) => ((svc as any).tables?.[t] ?? []) as any[]
    const att = tbl("open_house_attendees")[0], contact = tbl("contacts")[0], consent = tbl("contact_consent_events")[0]
    check("a consented sign-in → an attendee AND a Contact, the attendee stamped with it", r?.success === true && !!contact?.id && att?.contact_id === contact.id && r.contactId === contact.id, JSON.stringify({ r, att, contact }).slice(0, 300))
    check("…the consent row is anchored to that contact", consent?.contact_id === contact?.id && consent?.consented === true)
    check("…the contact and the attendee are person-identity evidence", tbl("person_identity_evidence").some((e) => e.entity_type === "contact" && e.entity_id === contact?.id) && tbl("person_identity_evidence").some((e) => e.entity_type === "open_house_attendee" && e.entity_id === att?.id), JSON.stringify(tbl("person_identity_evidence")).slice(0, 300))
    check("…and the capture event is recorded WITH the contact (fanned-out evidence the arbiter's reader keys on)", tbl("lifecycle_events").some((e) => String(e.event_type ?? e.event ?? "").includes("attendee") && JSON.stringify(e).includes(String(contact?.id))), JSON.stringify(tbl("lifecycle_events")).slice(0, 300))
    const again = await soh.checkInAttendee({ eventId: EV, name: "Pat Visitor", email: "pat@example.test", workingWithAgent: false, tcpaConsent: true }) as any
    check("a second sign-in of the same email at the same event is the same attendee (no duplicate row, no second contact)", again?.duplicate === true && tbl("open_house_attendees").length === 1 && tbl("contacts").length === 1)
    const noConsent = await soh.checkInAttendee({ eventId: EV, name: "No Consent", email: "nc@example.test", workingWithAgent: false, tcpaConsent: false }) as any
    check("POSITIVE CONTROL: no consent → refused, nothing filed", noConsent?.success === false && tbl("contacts").length === 1)
    const ohk = await import("../app/actions/open-house-kernel")
    const foreign = await ohk.completeOpenHouseCheckInAction({ brokerage_id: B2, agent_id: "a1470000-0000-4000-8000-0000000000e2", open_house_id: EV, first_name: "Eve", last_name: "Other", email: "eve@example.test", check_in_method: "manual" } as any)
    check("the walk-in door REFUSES a body brokerage that is not the session's (was: filed the contact + attendee into it)", foreign.success === false && !tbl("contacts").some((c) => c.brokerage_id === B2), JSON.stringify(foreign))
  }

  console.log("\n[blind spots]")
  console.log("  · stage detection reads tokens in each door and the functions it calls two levels deep inside the open-house files; a stage delegated further (e.g. a reactor three hops away) is credited only through the event it emits")
  console.log("  · 'broker_open' / 'virtual_open_house' have no producer: a broker open's attendees are AGENTS (no consumer consent / contact semantics) and a virtual open house has no join writer — both are owed only when a producer is built (owner decision, published)")
  console.log("  · the runtime step runs on memSupabase (no RLS, CHECK, FK or trigger); the live column default is a fixture measured 2026-10-31")
  console.log("  · C8: the doors resolve contacts through the open-house kernel resolver and the kiosk's own dedupe; lane 147A names the ONE consented-intake survivor — re-pointing is the handoff (notes, Outside-lane)")
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  for (const f of failures) console.log(`   ✗ ${f}`)
  process.exit(failed > 0 ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
