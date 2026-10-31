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
  // wave 147 (lane 147Z): captureConsentedContact( is the C8 survivor — it IS the contact, consent and identity stages at once
  // (captureContact's person evidence + the consent record + the contact upsert), so a door on C8 is credited for all three.
  ["identity", /linkOpenHouseCheckInIdentity\(|sendInstantOpenHouseGreeting\(|linkPersonEvidence\(|captureContact\(|captureConsentedContact\(/],
  ["consent", /tcpa_?[cC]onsent|persistContactConsent\(|contact_consent_events|captureConsentedContact\(/],
  ["contact", /resolveOrCreateOpenHouseContact\(|captureContact\(|captureConsentedContact\(|contact_id:\s*(params\.contactId|contactId|checkedInContactId)/],
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

/** WAVE 147 (lane 147Z): the event types ONE producer statement writes. A literal `event_type: "x"` produces x. A variable
 *  `event_type: kind` produces every value of the array literal the producer's own body REFUSES on — `if (!(LIST as readonly
 *  string[]).includes(kind)) return …` — and nothing provable otherwise (null → the column default, published). */
function producedTypes(stmt: string, body: string): string[] | null {
  const lit = /event_type:\s*["']([a-z_]+)["']/.exec(stmt.slice(0, 900))?.[1]
  if (lit) return [lit]
  const ident = /event_type:\s*([A-Za-z_$][\w$]*)\s*[,}\n]/.exec(stmt.slice(0, 900))?.[1]
  if (!ident) return null
  const masked = blankComments(body)
  const gate = new RegExp(`!\\s*\\(?\\s*([A-Z_][A-Z0-9_]*)(?:\\s+as\\s+readonly\\s+string\\[\\])?\\s*\\)?\\.includes\\(\\s*${ident}\\s*\\)\\s*\\)\\s*return\\b`).exec(masked)
  if (!gate) return null
  const list = new RegExp(`const\\s+${gate[1]}\\s*=\\s*\\[([^\\]]*)\\]`).exec(masked)
  return list ? [...list[1].matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]) : null
}

/** The `{ … }` block that follows index `at` (brace-matched on comment- AND string-blanked text, so a brace inside a string
 *  or a template's text cannot unbalance it; `${…}` is code and balances). Returns the comment-blanked slice. */
function blockAfter(src: string, at: number): string {
  const c = blankComments(src), m = blankStrings(c)
  const open = m.indexOf("{", at)
  if (open < 0) return ""
  let depth = 0
  for (let i = open; i < m.length; i++) {
    if (m[i] === "{") depth++
    else if (m[i] === "}" && --depth === 0) return c.slice(open, i + 1)
  }
  return ""
}

/** The broker-open half of the kiosk door: it can fire (the event read selects event_type), it fires BEFORE the C8 consumer
 *  capture, it records the agent's visit (an attendee row, no consumer consent claimed) with its capture evidence, it RETURNS
 *  (no fall-through into the consumer path) and it creates no consumer contact, consent, enrichment or greeting. */
function brokerOpenBranch(src: string): { ok: boolean; why: string } {
  const c = blankComments(src)
  const at = c.search(/\.event_type\s*===\s*["']broker_open["']/)
  const c8 = c.search(/captureConsentedContact\(\{/)
  if (at < 0) return { ok: false, why: "no broker_open branch" }
  const block = blockAfter(src, at)
  const inner = block.slice(1, -1).trim()
  const why = [
    !/\.from\(\s*["']open_house_events["']\s*\)\s*\.select\(\s*["'][^"']*\bevent_type\b/.test(c) && "the event read does not select event_type (the branch can never fire)",
    !(c8 > at) && "the branch is not ahead of the C8 consumer capture",
    !(() => { const g = c.search(/if\s*\(\s*!tcpaConsent\s*\)\s*\{?\s*return\b/); return g > at + block.length && g < c8 })() && "the consumer path does not refuse a missing consent between the branch and C8",
    !/\.from\(\s*["']open_house_attendees["']\s*\)\s*\.insert\(/.test(block) && "no attendee row",
    !/tcpa_consent:\s*false/.test(block) && "claims consumer consent",
    !/attendee_captured[\s\S]{0,400}broker_open:\s*true/.test(block) && "no capture evidence marked broker_open",
    !/return\s+NextResponse\.json\([^;]*\)\s*$/.test(inner) && "falls through into the consumer path",
    /captureConsentedContact\(|captureContact\(|persistContactConsent\(|\.from\(\s*["']contacts["']\s*\)|contact_consent_events|queueContactEnrichment\(|sendInstantOpenHouseGreeting\(/.test(block) && "creates a consumer contact / consent / enrichment / greeting",
  ].filter(Boolean) as string[]
  return { ok: why.length === 0, why: why.join("; ") || "ok" }
}

/** The virtual join door: the event must be a virtual open house, the forward target comes ONLY from that event's own
 *  check_in_url (never from the link — not an open redirect), the invitation is re-read for this event AND this event's
 *  brokerage, and the attendance row is tenant-stamped from the event. */
function virtualJoinDoor(src: string): { ok: boolean; why: string } {
  const c = blankComments(src)
  const redirectTarget = /NextResponse\.redirect\(\s*([A-Za-z_$][\w$]*)/.exec(c)?.[1] ?? ""
  const assigns = redirectTarget ? [...c.matchAll(new RegExp(`\\b${redirectTarget}\\s*=(?!=)\\s*([^\\n;}]+)`, "g"))].map((m) => m[1]) : []
  const why = [
    !/export\s+async\s+function\s+GET\s*\(/.test(c) && "no GET door",
    !/event_type\s*!==\s*["']virtual_open_house["']/.test(c) && "does not require a virtual open house",
    !(redirectTarget && assigns.length > 0 && assigns.every((a) => /^(null|u\.toString\(\))$/.test(a.trim()))) && `the forward target is not derived only from the event's check_in_url (${redirectTarget || "none"} ← ${assigns.join(" | ")})`,
    !/new URL\(\s*String\(\s*ev\?\.check_in_url/.test(c) && "the URL is not read off the event row",
    /searchParams\.get\([^)]*\)[\s\S]{0,40}redirect|redirect\([^)]*searchParams/.test(c) && "a link parameter reaches the redirect",
    !/\.from\(\s*["']open_house_invitations["']\s*\)[\s\S]{0,300}\.eq\(\s*["']event_id["']\s*,\s*ev\.id\s*\)[\s\S]{0,80}\.eq\(\s*["']brokerage_id["']\s*,\s*ev\.brokerage_id\s*\)/.test(c) && "the invitation is not re-read for this event and its brokerage",
    !/\.from\(\s*["']open_house_rsvp_tracking["']\s*\)[\s\S]{0,300}brokerage_id:\s*ev\.brokerage_id[\s\S]{0,60}rsvp_status:\s*["']attended["']/.test(c) && "no tenant-stamped attended row",
  ].filter(Boolean) as string[]
  return { ok: why.length === 0, why: why.join("; ") || "ok" }
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
    for (const t of producedTypes(p.stmt, bodyOf(files.get(p.file) ?? "", p.fn)) ?? [LIVE_DEFAULT]) produced.set(t, [...(produced.get(t) ?? []), `${p.file}::${p.fn}`])
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
  // wave 147 (lane 147Z — lane 147F "Still open": broker_open / virtual_open_house were CHECK-admitted and never produced;
  // orphan doctrine §1.2, BUILD the missing half). ONE scheduling door produces all three kinds through one validated list.
  check("the scheduling door (createOpenHouse) PRODUCES every live event type through ONE validated vocabulary — no twin producer",
    types.every((t) => (produced.get(t) ?? []).includes("app/actions/open-house.ts::createOpenHouse")), JSON.stringify([...produced]))
  check("POSITIVE CONTROL: a variable event_type validated by a refusing includes() produces the list; an unvalidated variable produces nothing provable",
    JSON.stringify(producedTypes(`.from("open_house_events").insert({ event_type: kind, x: 1 })`, `function f(){ const KINDS = ["open_house", "broker_open"] as const\n if (!(KINDS as readonly string[]).includes(kind)) return { error: 1 } }`)) === JSON.stringify(["open_house", "broker_open"])
    && producedTypes(`.from("open_house_events").insert({ event_type: kind, x: 1 })`, `function f(){ const KINDS = ["broker_open"]; if (KINDS.includes(kind)) log() }`) === null)
  {
    const kioskSrc = raw("app/api/open-house/attend/route.ts")
    const bo = brokerOpenBranch(kioskSrc)
    check(`broker_open: the kiosk records the cooperating AGENT's visit (attendee row + capture evidence) ahead of C8 and returns — no consumer contact, consent, enrichment or greeting (${bo.why})`, bo.ok)
    const fallThrough = kioskSrc.replace(/return NextResponse\.json\(\{ success: true, attendeeId: \(agentVisit as \{ id: string \}\)\.id, brokerOpen: true \}\)/, "void 0")
    const consumerInBranch = kioskSrc.replace(/check_in_time: new Date\(\)\.toISOString\(\), working_with_agent: true, tcpa_consent: false,/, "check_in_time: new Date().toISOString(), working_with_agent: true, tcpa_consent: false, x: await persistContactConsent(svc, {}),")
    const noSelect = kioskSrc.replace(/qr_code_id, event_type, listings\(address\)/, "qr_code_id, listings(address)")
    const noConsentGate = kioskSrc.replace(/\n\s*if \(!tcpaConsent\) \{\n\s*return NextResponse\.json\(\{ error: "TCPA consent is required" \}, \{ status: 400 \}\)\n\s*\}/, "\n")
    check("POSITIVE CONTROL: a broker-open branch that falls through, one that writes consumer consent, a read that never selects event_type, and a consumer path with no consent refusal are each red",
      fallThrough !== kioskSrc && !brokerOpenBranch(fallThrough).ok && consumerInBranch !== kioskSrc && !brokerOpenBranch(consumerInBranch).ok && noSelect !== kioskSrc && !brokerOpenBranch(noSelect).ok && noConsentGate !== kioskSrc && !brokerOpenBranch(noConsentGate).ok,
      [brokerOpenBranch(fallThrough).why, brokerOpenBranch(consumerInBranch).why, brokerOpenBranch(noSelect).why, brokerOpenBranch(noConsentGate).why].join(" | "))
    const joinSrc = raw("app/open-house/[eventId]/join/route.ts")
    const vj = virtualJoinDoor(joinSrc)
    check(`virtual_open_house: the join door records an invited contact's attendance (tenant from the event) and forwards ONLY to the event's own https URL (${vj.why})`, !!joinSrc && vj.ok)
    // The join door's in-tree producer: the ONE invitation sender (the only code that knows the staged invitation id) mints
    // the join link for a virtual event, from the same (eventId, invitationId) credential the door re-reads.
    const sender = blankComments(raw("lib/communications/send-invitation.ts"))
    const mintsJoin = (s: string) => /event_type\s*===\s*["']virtual_open_house["'][\s\S]{0,200}`\$\{appUrl\}\/open-house\/\$\{params\.eventId\}\/join\?i=\$\{params\.invitationId\}`/.test(s) && /Join online: \$\{joinLink\}/.test(s) && /joinLink,/.test(s)
    check("virtual_open_house: the invitation sender mints the join link (eventId + invitationId) for a virtual event, in the email AND the text — the join door has its in-tree producer", mintsJoin(sender))
    check("POSITIVE CONTROL: a sender that never mints the join link is red", !mintsJoin(sender.replace(/\/join\?i=/g, "/rsvp/")))
    const openRedirect = joinSrc.replace(/return NextResponse\.redirect\(meetingUrl, 302\)/, `return NextResponse.redirect(req.nextUrl.searchParams.get("to") ?? meetingUrl, 302)`)
    const anyEventInvite = joinSrc.replace(/\.eq\("event_id", ev\.id\)\n\s*\.eq\("brokerage_id", ev\.brokerage_id\)/, "")
    check("POSITIVE CONTROL: a join door that forwards to a link parameter, and one that reads the invitation without the event + brokerage pair, are each red",
      openRedirect !== joinSrc && !virtualJoinDoor(openRedirect).ok && anyEventInvite !== joinSrc && !virtualJoinDoor(anyEventInvite).ok,
      [virtualJoinDoor(openRedirect).why, virtualJoinDoor(anyEventInvite).why].join(" | "))
  }

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
  // wave 147 (lane 147Z — lane 147A Outside-lane 3 / this lane's Outside-lane 3): the PUBLIC kiosk is on C8 — the event owns
  // the form (its tenant is re-read, a forged event refuses), the wording is the door's, and the door writes no contact,
  // consent or enrichment row of its own any more.
  const kiosk = stripComments(raw("app/api/open-house/attend/route.ts"))
  const ownContactWrite = /\.from\(\s*["']contacts["']\s*\)\s*\.insert\(|persistContactConsent\(|queueContactEnrichment\(/
  check("the kiosk door captures through C8 (captureConsentedContact, formOwner open_house_events, the door's own wording) and writes no contact / consent / enrichment row itself",
    /captureConsentedContact\(\{/.test(kiosk) && /formOwner:\s*\{\s*table:\s*"open_house_events",\s*id:\s*eventId\s*\}/.test(kiosk) && /text:\s*doorText/.test(kiosk) && !ownContactWrite.test(kiosk))
  check("POSITIVE CONTROL: the own-write finder sees a direct contacts insert", ownContactWrite.test(`await supabase.from("contacts").insert({ email })`))

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

    // wave 147 (lane 147Z): the two producer halves, run. A broker open's sign-in is a cooperating agent's visit; a virtual
    // open house's join records the invited contact's attendance and forwards to the event's own meeting URL.
    const EVB = "e1470000-0000-4000-8000-0000000000e3", EVV = "e1470000-0000-4000-8000-0000000000e4"
    const INV = "f1470000-0000-4000-8000-0000000000e1", INV_FOREIGN = "f1470000-0000-4000-8000-0000000000e2"
    const T = (svc as any).tables as Record<string, any[]>
    T.open_house_events.push({ id: EVB, brokerage_id: B, listing_id: LST, agent_id: AG, status: "scheduled", event_type: "broker_open" },
      { id: EVV, brokerage_id: B, listing_id: LST, agent_id: AG, status: "scheduled", event_type: "virtual_open_house", check_in_url: "https://meet.example.test/oh147" })
    const contactsBefore = tbl("contacts").length, consentBefore = tbl("contact_consent_events").length
    const kioskRoute = await import("../app/api/open-house/attend/route")
    const boRes = await kioskRoute.POST(new Request("http://localhost/api/open-house/attend", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.14.7.1" }, body: JSON.stringify({ eventId: EVB, firstName: "Coop", lastName: "Agent", email: "coop.agent@example.test", phone: "8135550199", hearAboutUs: "MLS broker tour" }) }) as any)
    const boBody = await boRes.json() as any
    const boAtt = tbl("open_house_attendees").find((a) => a.event_id === EVB)
    check("broker_open (run): the agent's sign-in is an attendee row (working with an agent, no consumer consent claimed) and the door says so",
      boBody?.success === true && boBody?.brokerOpen === true && boAtt?.tcpa_consent === false && boAtt?.working_with_agent === true && boAtt?.brokerage_id === B, JSON.stringify({ boBody, boAtt }).slice(0, 300))
    check("…and NO consumer contact or consent row was created (the same counters saw the event-day contact and consent above — positive control)",
      contactsBefore >= 1 && consentBefore >= 1 && tbl("contacts").length === contactsBefore && tbl("contact_consent_events").length === consentBefore)
    check("…its capture evidence is recorded, marked broker_open", JSON.stringify(tbl("lifecycle_events")).includes("broker_open"), JSON.stringify(tbl("lifecycle_events").slice(-2)).slice(0, 300))
    const attendeesBefore = tbl("open_house_attendees").length
    const consumerNoConsent = await kioskRoute.POST(new Request("http://localhost/api/open-house/attend", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.14.7.1" }, body: JSON.stringify({ eventId: EV, firstName: "No", lastName: "Box", email: "nobox@example.test" }) }) as any)
    check("POSITIVE CONTROL: the same kiosk on a CONSUMER open house still refuses a sign-in with no consent, and files nothing",
      consumerNoConsent.status === 400 && tbl("open_house_attendees").length === attendeesBefore && tbl("contacts").length === contactsBefore, `status ${consumerNoConsent.status}`)

    const knownContact = tbl("contacts")[0]?.id as string
    T.open_house_invitations = [{ id: INV, event_id: EVV, brokerage_id: B, contact_id: knownContact, channel: "email" },
      { id: INV_FOREIGN, event_id: EVV, brokerage_id: B2, contact_id: "c1470000-0000-4000-8000-0000000000e2", channel: "email" }]
    const { NextRequest } = await import("next/server")
    const joinRoute = await import("../app/open-house/[eventId]/join/route")
    const joinVisit = (ev: string, q: string) => joinRoute.GET(new NextRequest(`http://localhost/open-house/${ev}/join${q}`, { headers: { "x-forwarded-for": "10.14.7.2" } }), { params: Promise.resolve({ eventId: ev }) })
    const j1 = await joinVisit(EVV, `?i=${INV}`)
    const tracked = (tbl("open_house_rsvp_tracking") ?? []).filter((r) => r.event_id === EVV)
    check("virtual_open_house (run): an invited contact's join is recorded as attended (tenant from the event) and forwarded to the event's meeting URL",
      j1.status === 302 && j1.headers.get("location") === "https://meet.example.test/oh147" && tracked.length === 1 && tracked[0].contact_id === knownContact && tracked[0].rsvp_status === "attended" && tracked[0].brokerage_id === B,
      JSON.stringify({ status: j1.status, loc: j1.headers.get("location"), tracked }).slice(0, 300))
    const j2 = await joinVisit(EVV, `?i=${INV_FOREIGN}`)
    const j3 = await joinVisit(EVB, `?i=${INV}`)
    const j4 = await joinVisit(EVV, `?to=https://evil.example.test`)
    check("POSITIVE CONTROL: an invitation from another brokerage records nothing; a non-virtual event is 404; a link parameter never moves the forward target",
      j2.status === 302 && (tbl("open_house_rsvp_tracking") ?? []).filter((r) => r.event_id === EVV).length === 1 && j3.status === 404 && j4.headers.get("location") === "https://meet.example.test/oh147",
      JSON.stringify({ j2: j2.status, j3: j3.status, j4: j4.headers.get("location") }))
  }

  console.log("\n[blind spots]")
  console.log("  · stage detection reads tokens in each door and the functions it calls two levels deep inside the open-house files; a stage delegated further (e.g. a reactor three hops away) is credited only through the event it emits")
  console.log("  · 'broker_open' / 'virtual_open_house' are produced by createOpenHouse (wave 147, lane 147Z): a broker open's sign-ins are AGENTS (an attendee row + capture evidence, no consumer contact or consent); a virtual open house records attendance only for an INVITED contact who joins through /open-house/<id>/join — an anonymous joiner is forwarded and recorded nowhere, and staying in the meeting is unproven (no meeting-provider participant webhook exists — WAITING_EXTERNAL)")
  console.log("  · the runtime step runs on memSupabase (no RLS, CHECK, FK or trigger); the live column default is a fixture measured 2026-10-31")
  console.log("  · C8: the public kiosk is on captureConsentedContact (wave 147, lane 147Z); the agent-side event-day / walk-in doors still resolve through the open-house kernel resolver (lane 147Z notes, Still open)")
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  for (const f of failures) console.log(`   ✗ ${f}`)
  process.exit(failed > 0 ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
