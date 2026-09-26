/**
 * scripts/lead-identity-gate-guard.ts  (npm run test:lead-identity-gate) — pure, no DB, no network.
 *
 * THE RAW → LEAD IDENTITY GATE (lane 84C, wave 84; rule tightened by lane 85B, wave 85). Owner verbatim:
 *   wave 84: "in order remember if the record/row from scrapping comes in and doesnt have phone and/or email
 *    with first and last name, it can't come in as a lead - it goes in as a raw lead to
 *    dedup/enrich/dedup, etc."
 *   wave 85: "change in what is needed to become a lead it should be email required so email and/or phone."
 *            "an unknown sender needs to go through enrichment before lead gate."
 *
 *   G1  THE predicate (canonical-lead-eligibility.ts::isLeadEligibleIdentity) on a truth table:
 *       first + last + EMAIL passes (phone optional); every shape short of it — PHONE-ONLY (wave 85),
 *       name-only, email-only with no name, a VERIFIED mailing address alone (the retired wave-14 arm),
 *       placeholder names, entity names, initials, handles — is REFUSED. Real names that look odd (Na,
 *       Church, O'Neil, José, 王) PASS — the refusal list is not allowed to eat real people.
 *   G8  WHAT COUNTS AS AN EMAIL — invalid syntax / disposable / automated (noreply@) refused; a ROLE
 *       address (info@, sales@) COUNTS (a real person's shared inbox is still a person).
 *   G9  THE EMAIL-SEEK HOOK — a phone-only raw row's enrich leg asks the reverse skip trace by phone
 *       (cheapest phone-keyed provider already wired), fills only empties, never re-bills a phone.
 *   G10 THE UNKNOWN INBOUND-EMAIL SENDER GOES RAW — lands in raw_scraped_leads, runs the one raw path,
 *       becomes a lead only through THE gate; name from signature / display name / first.last@ / PDL.
 *   G2  CENSUS — every `.from("leads").insert/upsert(` in app/ + lib/ (comment-blanked source) sits in a
 *       file that calls the predicate BEFORE the insert. Derived denominator; POSITIVE CONTROL: an
 *       ungated fixture insert is flagged.
 *   G3  ORDER + RE-GATE — in processRawRecord the gate runs after the post-enrichment dedup and before
 *       the insert; a refusal writes insufficient_identity_for_promotion; that status is STRANDED and the
 *       lead-scraping cron's sweep resets stranded rows to pending and re-runs processRawRecord
 *       (dedup → enrich → dedup → gate).
 *   G4  THE ADDRESS ARM IS GONE — the gate reads no mailing field; promotion-address-verification.ts and
 *       verifyAddressBatchData do not exist and nothing imports/calls them. POSITIVE CONTROL: the same
 *       finders flag a fixture that does.
 *   G5  THE DIRECT DOORS — crm.ts::createLeadOnlyRecordForAcquisitionSource gates EVERY insert (the
 *       person-initiated-inbound exemption is retired, wave 85); lead-promoter.ts refuses at its own insert.
 *   G6  ENRICH CAN RESCUE A NAME-ONLY ROW — both PeopleData legs send a location qualifier with the name.
 *   G7  registration + ownership.
 *
 * Every code-token scan reads stripComments/blankComments output from scripts/strip-comments.ts
 * (CLAUDE.md §2: a tombstone is not a call site).
 */
// ── test-only shim (lane 85B) — unknown-sender-identification.ts imports `server-only`, which throws
// outside a Server Component. Neutralised in the require cache BEFORE the runtime import in G10 (the
// same idiom scripts/lead-email-conversion-simulator.ts uses).
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }

import { readFileSync, existsSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
import {
  isLeadEligibleIdentity, evaluateCanonicalLeadEligibility, personNameProblem, leadEmailProblem,
  PLACEHOLDER_NAME_TOKENS, ENTITY_NAME_TOKENS,
} from "../lib/lead-pipeline/canonical-lead-eligibility"
import { emailSeekDecision, seekEmailForRawRecord } from "../lib/lead-pipeline/email-seek"
import { STRANDED_STATUSES } from "../lib/lead-pipeline/promotion-gate-health"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const stripped = (p: string) => stripComments(read(p))

// ── G1 · the predicate ──────────────────────────────────────────────────────
console.log("\n[G1 · THE predicate: first + last + EMAIL (phone optional), nothing less]")
const PASS: Array<[string, Parameters<typeof isLeadEligibleIdentity>[0]]> = [
  ["POSITIVE CONTROL: first + last + email ONLY (no phone) — email alone qualifies", { first_name: "Maria", last_name: "Gonzalez", email: "m@x.com" }],
  ["first + last + email + phone", { first_name: "Maria", last_name: "Gonzalez", email: "m@x.com", phone: "3055550142" }],
  ["a ROLE address is still a person's email (info@)", { first_name: "Dana", last_name: "Whitfield", email: "info@whitfieldhomes.com" }],
  ["real surname 'Na' is not the N/A placeholder", { first_name: "Min", last_name: "Na", email: "min.na@x.com" }],
  ["real surname 'Church' is not an entity", { first_name: "Charlotte", last_name: "Church", email: "c@x.com" }],
  ["apostrophe/hyphen names", { first_name: "Anne-Marie", last_name: "O'Neil", email: "am@x.com", phone: "3055550142" }],
  ["accented names", { first_name: "José", last_name: "García", email: "j@x.com" }],
  ["single-character CJK name parts", { first_name: "伟", last_name: "王", email: "wang@x.com" }],
]
for (const [label, c] of PASS) check(`PASSES: ${label}`, isLeadEligibleIdentity(c), JSON.stringify(evaluateCanonicalLeadEligibility(c)))

const REFUSE: Array<[string, Parameters<typeof isLeadEligibleIdentity>[0], "name" | "contact_anchor"]> = [
  ["POSITIVE CONTROL: first + last + PHONE ONLY (no email) — stays raw (wave 85)", { first_name: "Maria", last_name: "Gonzalez", phone: "3055550142" }, "contact_anchor"],
  ["POSITIVE CONTROL: name only (no phone, no email)", { first_name: "Maria", last_name: "Gonzalez" }, "contact_anchor"],
  ["phone only, no last name", { first_name: "Maria", phone: "3055550142" }, "name"],
  ["email is invalid syntax (phone present)", { first_name: "Maria", last_name: "Gonzalez", email: "maria@gmail", phone: "3055550142" }, "contact_anchor"],
  ["email is a disposable mailbox", { first_name: "Maria", last_name: "Gonzalez", email: "maria@mailinator.com" }, "contact_anchor"],
  ["email is an automated mailbox (noreply@)", { first_name: "Maria", last_name: "Gonzalez", email: "noreply@gonzalez.com" }, "contact_anchor"],
  ["email only, no name", { email: "m@x.com" }, "name"],
  ["last name + email, no first", { last_name: "Gonzalez", email: "m@x.com" }, "name"],
  ["single-token full name crammed into first_name", { first_name: "Maria Gonzalez", phone: "3055550142" }, "name"],
  ["whitespace-only contact points", { first_name: "Maria", last_name: "Gonzalez", email: "  ", phone: " " }, "contact_anchor"],
  ["placeholder 'Unknown' / 'Owner'", { first_name: "Unknown", last_name: "Owner", phone: "3055550142" }, "name"],
  ["placeholder 'Current Resident'", { first_name: "Current", last_name: "Resident", phone: "3055550142" }, "name"],
  ["placeholder N/A", { first_name: "N/A", last_name: "Smith", email: "a@b.com" }, "name"],
  ["entity: LLC split across the columns", { first_name: "ABC Holdings", last_name: "LLC", phone: "3055550142" }, "name"],
  ["entity: family trust", { first_name: "Smith Family", last_name: "Trust", email: "t@x.com" }, "name"],
  ["entity: estate of", { first_name: "Estate of John", last_name: "Doe", phone: "3055550142" }, "name"],
  ["entity: bank", { first_name: "First National", last_name: "Bank", phone: "3055550142" }, "name"],
  ["initial only", { first_name: "J.", last_name: "Smith", phone: "3055550142" }, "name"],
  ["a handle, not a name", { first_name: "jane123", last_name: "Roe", email: "j@x.com" }, "name"],
]
for (const [label, c, dim] of REFUSE) {
  const r = evaluateCanonicalLeadEligibility(c)
  check(`REFUSED (${dim}): ${label}`, !isLeadEligibleIdentity(c) && !r.eligible && r.failing === dim, JSON.stringify(r))
}
// The retired wave-14 arm: a VERIFIED mailing address alone no longer makes a lead. The candidate type
// has no mailing field any more, so the fixture is passed through `as any` — exactly how a caller that
// still believed in the address arm would have to smuggle it in.
check("POSITIVE CONTROL: name + VERIFIED mailing address, no phone/email → REFUSED (wave-14 arm retired)",
  !isLeadEligibleIdentity({ first_name: "Walter", last_name: "Sobchak", mailing_address: "742 Evergreen Ter, Miami FL", mailing_address_verified: true } as any))
check("a pass reports its channels (email always, phone when present)",
  JSON.stringify((evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", email: "m@x.com", phone: "1" }) as any).via) === '["email","phone"]' &&
  JSON.stringify((evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", email: "m@x.com" }) as any).via) === '["email"]')
check("the phone-only refusal names the rule (email required, phone alone does not make a lead)",
  /email/i.test((evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", phone: "3055550142" }) as any).reason ?? "") &&
  /phone alone/i.test((evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", phone: "3055550142" }) as any).reason ?? ""))
check("isLeadEligibleIdentity ≡ evaluateCanonicalLeadEligibility().eligible on every fixture",
  [...PASS.map(([, c]) => c), ...REFUSE.map(([, c]) => c)].every((c) => isLeadEligibleIdentity(c) === evaluateCanonicalLeadEligibility(c).eligible))
check("vocabularies are non-trivial and lowercase", PLACEHOLDER_NAME_TOKENS.length >= 10 && ENTITY_NAME_TOKENS.length >= 10 && [...PLACEHOLDER_NAME_TOKENS, ...ENTITY_NAME_TOKENS].every((t) => t === t.toLowerCase()))
check("personNameProblem names the reason", /entity/.test(personNameProblem("ABC Holdings", "LLC") ?? "") && /placeholder/.test(personNameProblem("Unknown", "Smith") ?? ""))

// ── G2 · census of every leads insert ───────────────────────────────────────
console.log("\n[G2 · every leads INSERT/UPSERT in app/ + lib/ is gated by THE predicate]")
function walk(d: string, out: string[]) {
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n.startsWith(".")) continue
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(p)
  }
}
const files: string[] = []
for (const d of ["app", "lib"]) if (existsSync(d)) walk(d, files)
const INSERT_RE = /\.from\(\s*(['"`])leads\1\s*\)\s*\.(insert|upsert)\s*\(/g
const GATE_RE = /\b(evaluateCanonicalLeadEligibility|isLeadEligibleIdentity)\s*\(/g
/** Insert sites in `src` (comment-BLANKED so positions are real) with no predicate call before them. */
function ungatedInserts(src: string): number[] {
  const code = blankComments(src)
  const gates = [...code.matchAll(GATE_RE)].map((m) => m.index ?? 0)
  return [...code.matchAll(INSERT_RE)].map((m) => m.index ?? 0).filter((at) => !gates.some((g) => g < at))
}
const sites: string[] = []
const ungated: string[] = []
for (const f of files) {
  const src = read(f)
  const code = blankComments(src)
  for (const m of code.matchAll(INSERT_RE)) sites.push(`${f}:${code.slice(0, m.index).split("\n").length}`)
  for (const at of ungatedInserts(src)) ungated.push(`${f}:${code.slice(0, at).split("\n").length}`)
}
check(`every leads insert site is preceded by the predicate — ${sites.length - ungated.length}/${sites.length}`, ungated.length === 0 && sites.length > 0, ungated.join(", "))
console.log(`    sites: ${sites.join(" · ")}`)
check("POSITIVE CONTROL: an ungated fixture insert is flagged",
  ungatedInserts(`async function f() { await svc.from("leads").insert({ first_name: "x" }) }`).length === 1)
check("POSITIVE CONTROL: a gate named only in a COMMENT does not count (tombstones are not call sites)",
  ungatedInserts(`// evaluateCanonicalLeadEligibility(c)\nawait svc.from('leads').insert(row)`).length === 1)
check("POSITIVE CONTROL: a gate AFTER the insert does not count",
  ungatedInserts(`await svc.from('leads').insert(row)\nisLeadEligibleIdentity(c)`).length === 1)

// ── G3 · order + re-gate loop ───────────────────────────────────────────────
console.log("\n[G3 · processRawRecord: dedup → enrich → dedup → GATE → insert; refusals stay raw and are re-gated]")
const pp = stripped("lib/lead-pipeline/pipeline-processor.ts")
const order = ["'pre_enrichment'", "enrichWithPeopleData(", "'post_enrichment'", "evaluateCanonicalLeadEligibility(", ".from('leads')"].map((t) => pp.indexOf(t))
check("pre-dedup → enrich → post-dedup → gate → leads insert, in that order", order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), order.join(" < "))
check("a refusal writes insufficient_identity_for_promotion (the record stays RAW)", /if \(!promoEligibility\.eligible\) \{\s*\n\s*await setStatus\(supabase, rawRecordId, 'insufficient_identity_for_promotion'/.test(pp))
check("insufficient_identity_for_promotion is a STRANDED status (the sweep's input)", (STRANDED_STATUSES as readonly string[]).includes("insufficient_identity_for_promotion"))
const cron = stripped("app/api/cron/lead-scraping/route.ts")
check("the lead-scraping cron resets stranded rows to pending and re-runs processRawRecord",
  /\.in\('processing_status', STRANDED_STATUSES[\s\S]{0,600}?processing_status:\s*'pending'[\s\S]{0,900}?processRawRecord\(r\.id\)/.test(cron))

// ── G4 · the address arm is gone ────────────────────────────────────────────
console.log("\n[G4 · the wave-14 verified-mailing-address arm is retired, not bypassed]")
const gateCode = stripped("lib/lead-pipeline/canonical-lead-eligibility.ts")
check("the predicate reads no mailing field", !/mailing_address/.test(gateCode))
check("POSITIVE CONTROL: the same finder sees a mailing read when one exists", /mailing_address/.test(stripComments(`const hasMailing = !!c.mailing_address`)))
check("promotion-address-verification.ts is deleted", !existsSync("lib/lead-pipeline/promotion-address-verification.ts"))
// An IMPORT names the module inside a string literal, so imports are read from comment-stripped
// source; CALLS are read with strings blanked too, so registry prose that names the retired function
// (manager-registry.ts carries the history) is not a call site.
const ADDR_IMPORT_RE = /(?:from\s*|import\(\s*)["'][^"']*promotion-address-verification["']/
const ADDR_CALL_RE = /\b(?:verifyMailingAddressForPromotion|verifyAddressBatchData|needsPromotionAddressVerification|interpretLobForPromotion)\s*\(/
const retiredAddrUse = (src: string) => ADDR_IMPORT_RE.test(stripComments(src)) || ADDR_CALL_RE.test(blankStrings(src))
const addrUsers = files.filter((f) => retiredAddrUse(read(f)))
check("nothing in app/ + lib/ imports or calls the retired address verifiers", addrUsers.length === 0, addrUsers.join(", "))
check("POSITIVE CONTROL: the finder sees a live import of the retired module", retiredAddrUse(`import { x } from "@/lib/lead-pipeline/promotion-address-verification"`))
check("POSITIVE CONTROL: the finder sees a live call", retiredAddrUse(`const v = await verifyAddressBatchData({ street })`))
check("POSITIVE CONTROL: prose naming the function inside a string is NOT a call", !retiredAddrUse(`const what = "verifyAddressBatchData( was deleted"`))
check("the gate's Lob call is gone from processRawRecord (direct-mail CASS stays at the send)",
  !/verifyAddressViaLob|verifyMailingAddressForPromotion/.test(pp) && /needsCassCheck\(/.test(stripped("lib/providers/dispatch.ts")))

// ── G5 · the direct doors ───────────────────────────────────────────────────
console.log("\n[G5 · direct lead doors refuse through the same predicate]")
const crm = stripped("lib/kernel/crm.ts")
const crmFn = crm.slice(crm.indexOf("export async function createLeadOnlyRecordForAcquisitionSource("))
check("createLeadOnlyRecordForAcquisitionSource gates EVERY insert BEFORE it (no origin exemption)",
  crmFn.indexOf("evaluateCanonicalLeadEligibility(") > 0 && crmFn.indexOf("evaluateCanonicalLeadEligibility(") < crmFn.indexOf('.from("leads")') && /if \(!gate\.eligible\) \{/.test(crmFn) && !/origin\??:/.test(crmFn.slice(0, crmFn.indexOf("evaluateCanonicalLeadEligibility("))))
const EXEMPT_RE = /person_initiated_inbound/
const exemptDeclarers = files.filter((f) => EXEMPT_RE.test(blankStrings(stripComments(read(f)))) || /origin:\s*"person_initiated_inbound"/.test(stripComments(read(f))))
check("NO door declares the retired person_initiated_inbound exemption (the unknown sender lands raw, wave 85)", exemptDeclarers.length === 0, exemptDeclarers.join(", "))
check("POSITIVE CONTROL: the finder sees a live declaration", /origin:\s*"person_initiated_inbound"/.test(stripComments(`createLeadOnlyRecordForAcquisitionSource({ origin: "person_initiated_inbound" })`)))
check("POSITIVE CONTROL: a tombstone naming it in a comment is not a declaration", !/origin:\s*"person_initiated_inbound"/.test(stripComments(`// origin: "person_initiated_inbound" was retired`)))
const promoter = stripped("lib/lead-promotion/lead-promoter.ts")
check("promoteRawRecordToLead reads the email/phone FIRST-CLASS columns before raw_data (the gate now requires the email)",
  /\.select\('[^']*\bemail, phone'\)/.test(promoter) && /const email = \(rawRecord as any\)\?\.email \|\| rawData\.email/.test(promoter))
check("promoteRawRecordToLead refuses at its own insert (no caller can skip the gate)",
  promoter.indexOf("evaluateCanonicalLeadEligibility(") > 0 && promoter.indexOf("evaluateCanonicalLeadEligibility(") < promoter.indexOf(".from('leads')") && /if \(!gate\.eligible\) \{\s*\n\s*return \{ success: false/.test(promoter))
check("the evaluator door (eligibility-core) delegates to the predicate", /evaluateCanonicalLeadEligibility\(\{/.test(stripped("lib/lead-promotion/eligibility-core.ts")))

// ── G6 · enrichment can rescue a name-only row ──────────────────────────────
console.log("\n[G6 · PeopleData is asked WITH a location, so dedup → enrich → dedup can turn a name into a phone/email]")
check("raw path (enrichWithPeopleData) sends the territory city/state as PDL's location", /address: pdlLocation,/.test(pp) && /const pdlLocation = \[fields\.city, fields\.state\]/.test(pp))
check("drain (enrichment-orchestrator) sends city/state with the name", /address: \[entity\.city \?\? entity\.mailing_city, entity\.state \?\? entity\.mailing_state\]/.test(stripped("lib/lead-pipeline/enrichment-orchestrator.ts")))
check("skipTraceWithPeopleData forwards `address` as PDL's `location`", /location: params\.address,/.test(stripped("lib/external/peopledata-client.ts")))

// ── G8 · what counts as an email ────────────────────────────────────────────
console.log("\n[G8 · the email anchor: invalid / disposable / automated refused; role addresses COUNT]")
check("leadEmailProblem: missing / invalid / disposable / automated are named",
  leadEmailProblem(null) === "missing" && leadEmailProblem("  ") === "missing" && leadEmailProblem("jane@gmail") === "invalid_syntax" &&
  leadEmailProblem("jane@mailinator.com") === "disposable_domain" && leadEmailProblem("no-reply@acme.com") === "automated_mailbox" &&
  leadEmailProblem("mailer-daemon@acme.com") === "automated_mailbox")
check("ROLE addresses are NOT refused (info@, sales@, office@, hello@) — refusing them would refuse real people",
  ["info@smithhomes.com", "sales@x.com", "office@x.com", "hello@x.com"].every((e) => leadEmailProblem(e) === null))
check("POSITIVE CONTROL: an ordinary personal address passes (the finder is not refusing everything)", leadEmailProblem("jane.doe@gmail.com") === null)
check("the gate's email vocabulary is email-verifier.ts's (no second copy of the disposable / automated lists)",
  /from "@\/lib\/external\/email-verifier"/.test(gateCode) && !/mailinator/.test(gateCode) && !/mailer-daemon/.test(gateCode))
const unknownMod = stripped("lib/lead-pipeline/unknown-sender-identification.ts")
check("the unknown-sender prefilter reads the SAME automated vocabulary (moved to email-verifier.ts, not redefined)",
  /import \{ AUTOMATED_LOCAL_PARTS, ROLE_LOCAL_PARTS \} from "@\/lib\/external\/email-verifier"/.test(unknownMod) && !/const AUTOMATED_LOCAL_PARTS/.test(unknownMod))

// ── G9 · the email-seek hook ────────────────────────────────────────────────
console.log("\n[G9 · a phone-only raw row's enrich leg SEEKS AN EMAIL, then the gate re-runs]")
check("decision: phone + no email → seek; usable email → no seek; no phone → no seek",
  emailSeekDecision({ email: null, phone: "3055550142" }).seek === true &&
  emailSeekDecision({ email: "m@x.com", phone: "3055550142" }).seek === false &&
  emailSeekDecision({ email: null, phone: null }).seek === false)
check("decision: an UNUSABLE email (noreply@) still seeks a real one", emailSeekDecision({ email: "noreply@x.com", phone: "3055550142" }).seek === true)
check("decision: a phone already reverse-traced (billed) is never re-billed on the sweep's retry",
  emailSeekDecision({ email: null, phone: "(305) 555-0142", prior: { at: "t", phone: "3055550142", status: "no_match", provider: "batchdata", cost_usd: 0.07, reason: "" } }).seek === false)
{
  let asked: any = null
  const fakeReverse: any = async (input: any, deps: any) => {
    asked = { input, deps }
    return { status: "matched", provider: "batchdata", route: {}, person: { firstName: "Maria", lastName: "Gonzalez", fullName: "Maria Gonzalez" },
      phones: ["3055550142"], emails: ["noreply@spam.com", "maria.g@gmail.com"], propertyAddress: null, costUsd: 0.07, gate: { allowed: true }, peopleData: null, reason: "BatchData reverse skip trace matched" }
  }
  const found = await seekEmailForRawRecord({ brokerageId: "b1", ref: "raw-1", firstName: "Maria", lastName: "Gonzalez", phone: "3055550142", email: null },
    { reverse: fakeReverse, batchDataConfigured: true, now: () => new Date("2026-09-26T00:00:00Z") })
  check("found: the first USABLE email is taken (the automated one skipped), stamped for no-rebill",
    found.status === "found" && found.email === "maria.g@gmail.com" && found.stamp?.status === "matched" && found.stamp?.cost_usd === 0.07, JSON.stringify(found))
  check("the reverse trace is asked by PHONE only, and PeopleData is NOT asked twice (peopleData: null)",
    asked?.input.phone === "3055550142" && asked?.input.email === null && asked?.deps.peopleData === null)
  check("the found email PASSES the gate on re-evaluation (name + email) — the phone-only row can now become a lead",
    isLeadEligibleIdentity({ first_name: "Maria", last_name: "Gonzalez", phone: "3055550142", email: found.email }))
  const freeMiss = await seekEmailForRawRecord({ brokerageId: "b1", ref: "raw-2", firstName: null, lastName: null, phone: "3055550199", email: null },
    { reverse: (async () => ({ status: "no_match", provider: null, route: {}, person: null, phones: [], emails: [], propertyAddress: null, costUsd: 0, gate: { allowed: true }, peopleData: null, reason: "no person returned" })) as any, batchDataConfigured: true })
  check("a FREE miss (no one matched, not billed) is not stamped — the sweep may retry it", freeMiss.status === "not_found" && freeMiss.stamp === null)
  const noKey = await seekEmailForRawRecord({ brokerageId: "b1", ref: "raw-3", firstName: null, lastName: null, phone: "3055550199", email: null },
    { reverse: fakeReverse, batchDataConfigured: false })
  check("fail closed: no BatchData key → no call, skipped", noKey.status === "skipped" && noKey.costUsd === 0)
  const noTenant = await seekEmailForRawRecord({ brokerageId: null, ref: "raw-4", firstName: null, lastName: null, phone: "3055550199", email: null },
    { reverse: fakeReverse, batchDataConfigured: true })
  check("fail closed: no tenant → no billed call (§4)", noTenant.status === "skipped")
}
check("processRawRecord's enrich leg calls the hook BEFORE the Perplexity gap-fill, and the gate still runs after the post-enrich dedup",
  pp.indexOf("seekEmailForRawRecord(") > pp.indexOf("skipTraceWithPeopleData(") && pp.indexOf("seekEmailForRawRecord(") < pp.indexOf("shouldGapFill(base)"))
check("a billed attempt's stamp is persisted on the raw row (normalized_preview.email_seek)", /email_seek: enriched\.emailSeek\.stamp/.test(pp))

// ── G10 · the unknown inbound-email sender goes raw ─────────────────────────
console.log("\n[G10 · an UNKNOWN inbound-email sender lands RAW → dedup → enrich → dedup → THE gate]")
{
  const us = await import("../lib/lead-pipeline/unknown-sender-identification")
  check("parseFromHeader splits a display name off the address",
    JSON.stringify(us.parseFromHeader('"Pat Buyer" <Pat.Buyer@Example.com>')) === JSON.stringify({ address: "pat.buyer@example.com", displayName: "Pat Buyer" }) &&
    us.parseFromHeader("pat@example.com").displayName === null)
  const n1 = us.deriveSenderName({ extractedName: "Pat Buyer", displayName: "P B", fromEmail: "x@y.com" })
  const n2 = us.deriveSenderName({ extractedName: null, displayName: "Pat Buyer", fromEmail: "x@y.com" })
  const n3 = us.deriveSenderName({ extractedName: null, displayName: null, fromEmail: "pat.buyer@gmail.com" })
  const n4 = us.deriveSenderName({ extractedName: null, displayName: null, fromEmail: "pbuyer77@gmail.com" })
  const n5 = us.deriveSenderName({ extractedName: "Pat", displayName: null, fromEmail: "info.sales@x.com" })
  check("name source order: signature → display name → first.last@ local part",
    n1.nameSource === "signature" && n1.lastName === "Buyer" && n2.nameSource === "display_name" && n3.nameSource === "email_local_part" && n3.firstName === "Pat" && n3.lastName === "Buyer", JSON.stringify([n1, n2, n3]))
  check("no last name is fabricated: a handle-shaped local part yields nothing; a one-word signature stays first-name-only",
    n4.firstName === null && n4.lastName === null && n5.firstName === "Pat" && n5.lastName === null, JSON.stringify([n4, n5]))
  const fakeSvc: any = {
    from: () => {
      const q: any = {
        select: () => q, eq: () => q, is: () => q, not: () => q, order: () => q, limit: () => q, ilike: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: () => q, update: () => q,
        then: (res: any) => res({ data: [], error: null }),
      }
      return q
    },
  }
  const cls = (f: Record<string, unknown>) => async () => ({ available: true, costUsd: 0.0004, classification: {
    isSpamOrVendor: false, hasRealEstateIntent: true, intentType: "buyer", isTransactional: false, transactionalType: "none",
    extractedName: null, extractedPhone: null, extractedAddress: null, confidence: 0.9, ...f } as any })
  const owner: any = { brokerageId: "b1", ownerKind: "brokerage", agentId: null, userId: null }
  let landed: any = null
  const held = await us.identifyAndRouteUnknownSender(
    { mailboxOwner: owner, fromEmail: "kx92@gmail.com", subject: "Buying", body: "Want to buy in spring", messageId: "m1" },
    { classifier: cls({}), svc: fakeSvc, landRaw: (async (...a: any[]) => { landed = a; return { leadId: null, rawId: "raw-9", pipelineReason: "promotion_identity_gate: name" } }) as any },
  )
  check("POSITIVE CONTROL: an unknown sender with no findable name goes RAW (raw_held) — not a lead",
    held.outcome === "raw_held" && held.rawId === "raw-9" && !held.leadId, JSON.stringify(held))
  check("the raw landing is handed the classifier's own cost (the per-record acquisition cost) and the conversation",
    Array.isArray(landed) && landed[4] === 0.0004 && landed[1]?.subject === "Buying" && landed[1]?.messageId === "m1")
  const promoted = await us.identifyAndRouteUnknownSender(
    { mailboxOwner: owner, fromEmail: "Pat Buyer <pat.buyer@gmail.com>", subject: "Buying", body: "Want to buy", messageId: "m2" },
    { classifier: cls({ extractedName: "Pat Buyer" }), svc: fakeSvc, landRaw: (async () => ({ leadId: "lead-9", rawId: "raw-10", pipelineReason: "lead_creation" })) as any },
  )
  check("a sender whose name is found passes THE gate INSIDE the raw path → lead_created (the only way to a lead)",
    promoted.outcome === "lead_created" && promoted.leadId === "lead-9", JSON.stringify(promoted))
  check("the sender's OWN address satisfies the email requirement; the name must still be found",
    isLeadEligibleIdentity({ first_name: "Pat", last_name: "Buyer", email: "pat.buyer@gmail.com" }) && !isLeadEligibleIdentity({ email: "kx92@gmail.com" }))
  const landSrc = unknownMod.slice(unknownMod.indexOf("async function landUnknownSenderRaw("))
  check("landUnknownSenderRaw → ingestRawSourceBatch → processRawRecord (the one raw path), never a direct leads insert",
    landSrc.indexOf("ingestRawSourceBatch(") > 0 && landSrc.indexOf("processRawRecord(") > landSrc.indexOf("ingestRawSourceBatch(") &&
    !/createLeadOnlyRecordForAcquisitionSource\(/.test(blankStrings(unknownMod)) && !/\.from\(\s*["']leads["']\s*\)\s*\.insert/.test(unknownMod))
  check("processRawRecord resolves a market-less BROKERAGE-origin row's owner from its own brokerage_id (so the stranded sweep can re-gate it)",
    /const rowBrokerageId = \(rec\.source_origin \?\? 'brokerage'\) === 'brokerage' \? \(rec\.brokerage_id \?\? null\) : null/.test(pp) &&
    /const effectiveBrokerageId = brokerageId \?\? marketBrokerageId \?\? rowBrokerageId/.test(pp))
}

// ── G7 · registration ───────────────────────────────────────────────────────
console.log("\n[G7 · registration + ownership]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
const guard = pkg.scripts.guard ?? ""
check("package.json registers test:lead-identity-gate", pkg.scripts["test:lead-identity-gate"] === "tsx scripts/lead-identity-gate-guard.ts")
check("guard runs it AFTER test:scrapers (ordering only)", guard.indexOf("npm run test:scrapers") >= 0 && guard.indexOf("npm run test:lead-identity-gate") > guard.indexOf("npm run test:scrapers"))
const owner = Object.values(MAINTENANCE_DOMAINS).find((d) => d.proof === "test:lead-identity-gate")
check("MAINTENANCE_DOMAINS owns it", !!owner && owner.manager === "data_steward")

// ── G11 · the promotion core runs without a session and is not a public endpoint ──
// Wave 85 integrator: processRawRecord read raw_scraped_leads on the cookie
// client (RLS admits only a logged-in platform admin / AI-ISA seat), so the
// sessionless cron and inbound-mail webhooks got "Raw record not found"; and the
// file was 'use server', so the core was a public HTTP endpoint taking a
// caller-chosen brokerage (CLAUDE.md §4). The RULE: no directive, server-only,
// service client, never the cookie client.
console.log("\n[G11 · promotion core: sessionless + not a public endpoint]")
const ppRaw = read("lib/lead-pipeline/pipeline-processor.ts")
const ppCode = blankStrings(blankComments(ppRaw))
const isUseServer = (src: string) => /^\s*(['"])use server\1/.test(blankComments(src))
const readsCookieClient = (src: string) => /from\s+['"]@\/lib\/supabase\/server['"]/.test(stripComments(src))
check("pipeline-processor.ts carries no 'use server' directive", !isUseServer(ppRaw))
check("POSITIVE CONTROL: the directive finder sees 'use server' when present", isUseServer(`'use server'\nexport async function f() {}`))
check("pipeline-processor.ts imports server-only", /import\s+['"]server-only['"]/.test(stripComments(ppRaw)))
check("pipeline-processor.ts never imports the cookie client", !readsCookieClient(ppRaw))
check("POSITIVE CONTROL: the cookie-client finder sees the import", readsCookieClient(`import { createClient } from '@/lib/supabase/server'`))
check("processRawRecord builds the service client", /createServiceClient\s*\(\s*\)/.test(ppCode))

console.log(`\n  denominators: ${PASS.length} passing + ${REFUSE.length + 1} refused fixtures · ${sites.length} leads insert sites · ${files.length} app/lib files scanned`)
console.log("  blind spots: the census sees `.from(\"leads\").insert(` literally — an insert through a variable table name (lib/platform/demo-tenant.ts seeds demo leads via svc.from(table)) or an RPC/trigger is outside it (live check 2026-09-26: no public function inserts into leads except assert_tenant_isolation, a test helper); the name vocabulary is English-centric and errs toward refusal (a refused record stays raw and retryable); the disposable-domain list is email-verifier.ts's short starter list (a new throwaway domain passes as an email — a false ADMISSION, retried by nothing); G10 runs the unknown-sender orchestrator with an injected raw landing — the real ingestRawSourceBatch/processRawRecord are proven by G3 and the lead-intake proofs, not re-run here")
console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(failed === 0 ? " ✅ LEAD_IDENTITY_GATE_PASS" : " ❌ LEAD_IDENTITY_GATE_FAIL")
process.exit(failed === 0 ? 0 : 1)
