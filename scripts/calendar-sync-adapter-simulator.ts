#!/usr/bin/env tsx
/**
 * scripts/calendar-sync-adapter-simulator.ts   (npm run test:calendar-sync-adapter)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CALENDAR SYNC ADAPTER SEAM — proves that a calendar_sync_mappings row can only ever be
 * written from a PROVIDER'S OWN event id, and that the adapter registry is complete against the
 * live CHECK vocabulary.
 *
 * Owner: MAINTENANCE_DOMAINS.calendar_sync_adapters → data_steward (this file is its proof).
 *
 * WHY THIS EXISTS. `calendar_sync_mappings.provider_event_id` is `text NOT NULL` and holds the
 * id GOOGLE or MICROSOFT gave the event. For four waves the table had no writer at all, and that
 * was the correct state: writing a placeholder would have asserted that a local event is synced
 * to a provider event that does not exist, after which `is_synced` means nothing and the next
 * push creates a duplicate. w26 built the Google adapter; w27 built the Outlook one. The thing
 * that must not rot is the REFUSAL: an adapter that quietly falls back to a fabricated id would
 * make every assertion downstream of it false, and nothing else on the chain would notice.
 *
 * LAYERS
 *   1 · PURE — the Graph event body and its UTC normalization, imported and executed. This is
 *       why lib/providers/calendar/graph-event-shape.ts is a separate module: the adapters carry
 *       `import "server-only"`, whose index.js THROWS on import under tsx, so nothing inside them
 *       can be exercised directly (same split as free-slots.ts / personal-calendar.ts).
 *   2 · REGISTRY COVERAGE — DERIVED, never hardcoded (CLAUDE.md §2: assert the rule, derive the
 *       number). The provider list comes from scripts/check-vocabularies.ts (the live CHECK), the
 *       registered list from the CALENDAR_SYNC_ADAPTERS literal, and each registered adapter's
 *       own `name:` is read from its module and matched to the key it is filed under — a mapping
 *       row stamped with the wrong provider_type could never join.
 *   3 · SOURCE INVARIANTS — read through stripComments (CLAUDE.md §2: a tombstone is not a call
 *       site, and every one of these files is dense with comments containing the very tokens
 *       being searched for; reading raw source here would pass on the prose alone).
 *   4 · POSITIVE CONTROLS — every absence assertion above re-run against a DELIBERATELY BROKEN
 *       copy of the same source, which must go red. A clean tree and a broken finder both report
 *       zero.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { toGraphEvent, graphDateTimeUtc } from "../lib/providers/calendar/graph-event-shape"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const ROOT = process.cwd()
const readSrc = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** Every source read for CODE TOKENS goes through here. Never the raw file. */
const code = (p: string) => stripComments(readSrc(p))

const KERNEL = "lib/kernel/calendar-sync.ts"
const OUTLOOK_ADAPTER = "lib/providers/calendar/outlook-calendar-sync-adapter.ts"
const GOOGLE_ADAPTER = "lib/providers/calendar/google-calendar-sync-adapter.ts"
const EMAIL_ADAPTER = "lib/providers/email/personal-email-adapter.ts"

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1 · PURE — the Graph event body (imported and run, not string-matched)]")
// ─────────────────────────────────────────────────────────────────────────────

const body = toGraphEvent({
  title: "Showing — 12 Oak St",
  description: "Location: 12 Oak St",
  startAtUtcISO: "2026-09-04T14:00:00.000Z",
  endAtUtcISO: "2026-09-04T15:00:00.000Z",
}) as unknown as {
  subject: string
  body: { contentType: string; content: string }
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
}

check("subject carries the event title (Graph's spelling, not Google's `summary`)",
  body.subject === "Showing — 12 Oak St")
check("body is an itemBody with contentType — a bare string is refused by Graph",
  body.body.contentType === "HTML" && body.body.content === "Location: 12 Oak St")
check("a missing description becomes an empty body, never `undefined`",
  (toGraphEvent({ title: "t", startAtUtcISO: "2026-09-04T14:00:00Z" }) as any).body.content === "")

// The whole reason graph-event-shape.ts exists: Graph reads `dateTime` as a NAKED wall-clock
// reading in the zone named beside it. A trailing Z left on the string is the failure mode.
check("start/end are naked wall-clock readings — no trailing Z, no offset",
  !/Z$/.test(body.start.dateTime) && !/[+-]\d\d:\d\d$/.test(body.start.dateTime) &&
  !/Z$/.test(body.end.dateTime),
  `${body.start.dateTime} → ${body.end.dateTime}`)
check("the zone is declared UTC, matching the reading that was sent",
  body.start.timeZone === "UTC" && body.end.timeZone === "UTC")
check("the INSTANT survives the mapping exactly (re-parsing as UTC returns the input)",
  Date.parse(body.start.dateTime + "Z") === Date.parse("2026-09-04T14:00:00.000Z") &&
  Date.parse(body.end.dateTime + "Z") === Date.parse("2026-09-04T15:00:00.000Z"))

// An offset-bearing input must be CONVERTED, not truncated. Truncating "10:00+02:00" to
// "10:00" and calling it UTC would move a showing two hours — silently, and only for agents
// outside UTC, which is the shape that survives a manual smoke test.
check("a non-UTC offset is converted to the UTC instant, not truncated",
  graphDateTimeUtc("2026-09-04T10:00:00+02:00") === "2026-09-04T08:00:00.000",
  graphDateTimeUtc("2026-09-04T10:00:00+02:00"))

check("a missing end falls back to the start (Graph refuses a body with no end)",
  (() => {
    const e = toGraphEvent({ title: "t", startAtUtcISO: "2026-09-04T14:00:00Z" }) as any
    return e.end.dateTime === e.start.dateTime
  })())

// POSITIVE CONTROL for the refusal itself: an unparseable instant must THROW rather than
// coerce. "Invalid Date" reaching Graph would create a real event at a nonsense time and the
// mapping would record it as synced.
check("an unparseable timestamp THROWS instead of coercing (positive control)",
  (() => {
    try { graphDateTimeUtc("not-a-date"); return false } catch { return true }
  })())
check("…and the throw propagates out of toGraphEvent (positive control)",
  (() => {
    try { toGraphEvent({ title: "t", startAtUtcISO: "", endAtUtcISO: "nope" }); return false } catch { return true }
  })())

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2 · REGISTRY COVERAGE — derived from the live CHECK, not hardcoded]")
// ─────────────────────────────────────────────────────────────────────────────

const kernelCode = code(KERNEL)

/** The provider_type values the LIVE database admits. Deriving from here (rather than writing
 *  ["google_calendar","outlook"] into this file) is what makes a THIRD provider added to the
 *  CHECK fail this proof instead of passing it silently — CLAUDE.md §2's rule about waypoints. */
const liveProviders = CHECK_VOCABULARIES.calendar_provider_accounts?.provider_type ?? []
const mappingProviders = CHECK_VOCABULARIES.calendar_sync_mappings?.provider_type ?? []

check("the live CHECK vocabulary was found at all (guards against a blind read)",
  liveProviders.length > 0, `${liveProviders.length} value(s)`)
check("account and mapping tables admit the SAME provider vocabulary (a row keyed one way could never join the other)",
  liveProviders.slice().sort().join(",") === mappingProviders.slice().sort().join(","),
  `${liveProviders.join("|")} vs ${mappingProviders.join("|")}`)

/** Registered keys, read out of the CALENDAR_SYNC_ADAPTERS object literal in stripped source. */
function registeredAdapters(src: string): Array<{ key: string; identifier: string }> {
  const m = src.match(/const CALENDAR_SYNC_ADAPTERS[^=]*=\s*\{([\s\S]*?)\n\}/)
  if (!m) return []
  const out: Array<{ key: string; identifier: string }> = []
  for (const line of m[1].split("\n")) {
    const entry = line.match(/^\s*([A-Za-z_][\w]*)\s*:\s*([A-Za-z_][\w]*)\s*,?\s*$/)
    if (entry) out.push({ key: entry[1], identifier: entry[2] })
  }
  return out
}

/** identifier → module path, from the kernel's own imports. */
function importedFrom(src: string, identifier: string): string | null {
  const re = new RegExp(`import\\s*\\{\\s*${identifier}\\s*\\}\\s*from\\s*"@/([^"]+)"`)
  const m = src.match(re)
  return m ? `${m[1]}.ts` : null
}

const registered = registeredAdapters(kernelCode)
check("the CALENDAR_SYNC_ADAPTERS literal was parsed (guards against a blind read)",
  registered.length > 0, `${registered.length} entr(ies)`)

for (const p of liveProviders) {
  const entry = registered.find((r) => r.key === p)
  check(`'${p}' has a registered adapter`, entry != null,
    entry ? undefined : "no entry in CALENDAR_SYNC_ADAPTERS — pushes for this provider fall through to a 'partial' log")
}
check("no adapter is registered under a provider the database does not admit",
  registered.every((r) => liveProviders.includes(r.key)),
  registered.map((r) => r.key).join("|"))

// Each adapter's OWN `name:` must equal the key it is filed under. A mismatch would stamp
// calendar_sync_mappings.provider_type with a value that cannot join the account row.
for (const r of registered) {
  const path = importedFrom(kernelCode, r.identifier)
  if (!path) { check(`'${r.key}' adapter module resolves from the kernel's imports`, false, r.identifier); continue }
  const adapterCode = code(path)
  const nameMatch = adapterCode.match(/name:\s*"([^"]+)"/)
  check(`'${r.key}' adapter declares name: "${r.key}" (${path})`, nameMatch?.[1] === r.key,
    nameMatch ? `declares "${nameMatch[1]}"` : "no name: field found")
}

check("MAINTENANCE_DOMAINS.calendar_sync_adapters names THIS proof",
  MAINTENANCE_DOMAINS.calendar_sync_adapters?.proof === "test:calendar-sync-adapter",
  MAINTENANCE_DOMAINS.calendar_sync_adapters?.proof ?? "domain missing")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3 · SOURCE INVARIANTS — no adapter may fabricate an event id]")
// ─────────────────────────────────────────────────────────────────────────────

/** Every callConnector call in an adapter must have its result checked. callConnector NEVER
 *  throws (it resolves { ok:false }), so an unchecked call hands `undefined` back as the
 *  provider's event id — into a NOT NULL column. Same trap class as CLAUDE.md §3. */
function connectorCallsAreChecked(src: string): { calls: number; checks: number } {
  return {
    calls: (src.match(/await\s+callConnector\s*[<(]/g) ?? []).length,
    checks: (src.match(/!res\.ok/g) ?? []).length,
  }
}

/** A fabricated id, in any of the spellings this repo has actually used. personal-calendar.ts's
 *  sibling path legitimately degrades to a mock; an ADAPTER never may. */
const FABRICATION = /\bmock\b|\bplaceholder\b|\bfake[-_]?id\b|"evt[-_]/i

for (const path of [GOOGLE_ADAPTER, OUTLOOK_ADAPTER]) {
  const src = code(path)
  const { calls, checks } = connectorCallsAreChecked(src)
  check(`${path}: every callConnector result is checked`, calls > 0 && checks >= calls,
    `${calls} call(s), ${checks} check(s)`)
  check(`${path}: refuses when the provider returns no id`, /if\s*\(\s*!externalId\s*\)/.test(src))
  check(`${path}: contains no fabricated-id fallback`, !FABRICATION.test(src))
  check(`${path}: resolves the credential through getFreshPersonalToken (the owner's own connection)`,
    /getFreshPersonalToken\s*\(\s*userId\s*\)/.test(src))
  check(`${path}: refuses a credential from the WRONG provider`, /tok\.provider\s*!==/.test(src))
  check(`${path}: is server-only`, /import\s+"server-only"/.test(src))
  // PATCH-vs-POST: without this branch every re-push creates a duplicate event on the agent's
  // calendar and orphans the id the mapping already holds.
  check(`${path}: updates when an externalId is already held, creates otherwise`,
    /existingId\s*\?\s*"PATCH"\s*:\s*"POST"/.test(src) || /method:\s*existingId\s*\?\s*"PATCH"\s*:\s*"POST"/.test(src))
}

// The kernel side of the contract — the mapping row is written FROM the adapter's answer.
check(`${KERNEL}: provider_event_id is bound to the adapter's returned id`,
  /provider_event_id:\s*externalId/.test(kernelCode))
check(`${KERNEL}: externalId comes only from adapter.upsertEvent`,
  /\{\s*externalId\s*\}\s*=\s*await\s+adapter\.upsertEvent/.test(kernelCode))
check(`${KERNEL}: the mapping write happens AFTER the provider answers`,
  kernelCode.indexOf("adapter.upsertEvent") > 0 &&
  kernelCode.indexOf("provider_event_id: externalId") > kernelCode.indexOf("adapter.upsertEvent"))
// CLAUDE.md §4 — identity comes from the ACCOUNT ROW, never from the caller or a parameter.
check(`${KERNEL}: the credential is the ACCOUNT OWNER'S, not the caller's`,
  /userId:\s*ownerUserId/.test(kernelCode) && !/upsertEvent\(\{[\s\S]{0,200}userId:\s*params\.userId/.test(kernelCode))
check(`${KERNEL}: provider_type on the mapping comes from the account row`,
  /provider_type:\s*accountRow\.provider_type/.test(kernelCode))
// CLAUDE.md §3 — an UPDATE that matched nothing resolves exactly like one that worked.
check(`${KERNEL}: the mapping write is COUNTED, not assumed`,
  /written\.length\s*===\s*0/.test(kernelCode) && /\.select\("id"\)/.test(kernelCode))
check(`${KERNEL}: an inactive or inbound-only account is refused before any push`,
  /is_active\s*===\s*false/.test(kernelCode) && /sync_direction\s*===\s*"inbound"/.test(kernelCode))

// The credential the Outlook adapter depends on. Microsoft NARROWS a refreshed access token to
// the scopes requested, so a mail-only refresh silently drops Calendars.ReadWrite ~1h after the
// account is connected — see the note in personal-email-adapter.ts.
const emailCode = code(EMAIL_ADAPTER)
check(`${EMAIL_ADAPTER}: the Microsoft refresh asks for Calendars.ReadWrite`,
  /Calendars\.ReadWrite/.test(emailCode))
// The fallback is not decoration: asking for a scope that was never consented makes Microsoft
// refuse the ENTIRE token request (AADSTS65001), which would turn a degraded calendar into a
// dead MAILBOX for any connection made before Calendars.ReadWrite joined the consent list.
const emailOneLine = emailCode.replace(/\s+/g, " ")
check(`${EMAIL_ADAPTER}: …with a mail-only fallback, so a pre-consent connection cannot be broken`,
  emailOneLine.includes("attempt(MS_REFRESH_SCOPES_WITH_CALENDAR)") &&
  emailOneLine.includes("attempt(MS_REFRESH_SCOPES_MAIL_ONLY)") &&
  emailOneLine.includes(") ?? (await attempt(MS_REFRESH_SCOPES_MAIL_ONLY))"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4 · POSITIVE CONTROLS — every finder above must still recognise its defect]")
// ─────────────────────────────────────────────────────────────────────────────

const outlookSrc = code(OUTLOOK_ADAPTER)

// A fabricated-id fallback is the defect this whole domain exists to prevent.
const withMock = outlookSrc.replace(
  /const externalId = res\.data\?\.id \?\? existingId/,
  'const externalId = res.data?.id ?? existingId ?? "mock-event-id"',
)
check("control: a fabricated-id fallback is DETECTED",
  withMock !== outlookSrc && FABRICATION.test(withMock))

// An unchecked connector result.
const unchecked = outlookSrc.replace(/if\s*\(\s*!res\.ok\s*\)/, "if (false)")
const uncheckedCounts = connectorCallsAreChecked(unchecked)
check("control: an unchecked callConnector result is DETECTED",
  unchecked !== outlookSrc && uncheckedCounts.checks < uncheckedCounts.calls,
  `${uncheckedCounts.calls} call(s), ${uncheckedCounts.checks} check(s)`)

// A missing id that is no longer refused.
const noRefusal = outlookSrc.replace(/if\s*\(\s*!externalId\s*\)/, "if (false)")
check("control: a missing no-id refusal is DETECTED",
  noRefusal !== outlookSrc && !/if\s*\(\s*!externalId\s*\)/.test(noRefusal))

// A provider dropped from the registry — the exact regression this proof was written for.
const deregistered = kernelCode.replace(/^\s*outlook:\s*outlookCalendarSyncAdapter,\s*$/m, "")
check("control: a provider removed from CALENDAR_SYNC_ADAPTERS is DETECTED",
  deregistered !== kernelCode &&
  liveProviders.some((p) => !registeredAdapters(deregistered).some((r) => r.key === p)))

// An adapter filed under the wrong provider key.
const misfiled = outlookSrc.replace(/name:\s*"outlook"/, 'name: "google_calendar"')
check("control: an adapter whose name disagrees with its registry key is DETECTED",
  misfiled !== outlookSrc && (misfiled.match(/name:\s*"([^"]+)"/)?.[1] ?? "") !== "outlook")

// The mapping write no longer counted.
const uncounted = kernelCode.replace(/written\.length\s*===\s*0/, "false")
check("control: an uncounted mapping write is DETECTED",
  uncounted !== kernelCode && !/written\.length\s*===\s*0/.test(uncounted))

// The credential silently switched from the account owner to the caller (CLAUDE.md §4).
const callerCred = kernelCode.replace(/userId:\s*ownerUserId/, "userId: params.userId")
check("control: a caller-supplied identity replacing the account owner's is DETECTED",
  callerCred !== kernelCode && !/userId:\s*ownerUserId/.test(callerCred))

// The Microsoft refresh scope narrowed back to mail-only.
const narrowed = emailCode.replace(/Calendars\.ReadWrite/g, "")
check("control: a Microsoft refresh that drops Calendars.ReadWrite is DETECTED",
  narrowed !== emailCode && !/Calendars\.ReadWrite/.test(narrowed))

// The scanner itself: a tombstone/comment must NOT count as a call site (CLAUDE.md §2). Every
// file above is dense with comments containing these very tokens, so this is the control that
// proves the strip is doing the work rather than the prose.
const commentOnly = `// const externalId = res.data?.id ?? "mock-event-id"\n/* name: "outlook" */\nconst x = 1\n`
check("control: comments containing the searched tokens do NOT count as code",
  !FABRICATION.test(stripComments(commentOnly)) && !/name:\s*"outlook"/.test(stripComments(commentOnly)))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (published beside the number, CLAUDE.md §2):")
console.log("  · No HTTP is exercised. There is no live Google/Microsoft connection here and a")
console.log("    lane may not call one, so this proves the CODE PATH — result checked, missing id")
console.log("    refused, mapping counted — not the providers' behaviour.")
console.log("  · Layer 3 reads SOURCE. It cannot see a fabricated id introduced through a helper")
console.log("    in another module; it sees the adapters' own bodies.")
console.log("  · Coverage is over calendar_provider_accounts.provider_type. A provider reachable")
console.log("    some other way would not appear in that denominator.")
console.log("  · Not covered BY THE ADAPTERS AT ALL, and not asserted here: recurrence, attendees")
console.log("    /invitations, non-UTC display zones, delta sync. Pull is a stub for BOTH")
console.log("    providers — sync is outbound only.")
console.log("──────────────────────────────────────────────────")
if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ CALENDAR_SYNC_ADAPTER_FAIL"); process.exit(1) }
console.log(" ✅ CALENDAR_SYNC_ADAPTER_PASS — every live provider has an adapter, and no adapter can fabricate the id the mapping row is written from")
