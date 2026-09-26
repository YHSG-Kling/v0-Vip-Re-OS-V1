/**
 * scripts/lead-identity-gate-guard.ts  (npm run test:lead-identity-gate) — pure, no DB, no network.
 *
 * THE RAW → LEAD IDENTITY GATE (lane 84C, wave 84). Owner, 2026-09-26, verbatim:
 *   "in order remember if the record/row from scrapping comes in and doesnt have phone and/or email
 *    with first and last name, it can't come in as a lead - it goes in as a raw lead to
 *    dedup/enrich/dedup, etc."
 *
 *   G1  THE predicate (canonical-lead-eligibility.ts::isLeadEligibleIdentity) on a truth table:
 *       first + last + (phone OR email) passes; every shape short of it — name-only, phone-only with no
 *       last name, email-only, a VERIFIED mailing address alone (the retired wave-14 arm), placeholder
 *       names, entity names, initials, handles — is REFUSED. Real names that look odd (Na, Church,
 *       O'Neil, José, 王) PASS — the refusal list is not allowed to eat real people.
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
 *   G5  THE DIRECT DOORS — crm.ts::createLeadOnlyRecordForAcquisitionSource gates by default and only the
 *       unknown-sender door declares person_initiated_inbound; lead-promoter.ts refuses at its own insert.
 *   G6  ENRICH CAN RESCUE A NAME-ONLY ROW — both PeopleData legs send a location qualifier with the name.
 *   G7  registration + ownership.
 *
 * Every code-token scan reads stripComments/blankComments output from scripts/strip-comments.ts
 * (CLAUDE.md §2: a tombstone is not a call site).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
import {
  isLeadEligibleIdentity, evaluateCanonicalLeadEligibility, personNameProblem,
  PLACEHOLDER_NAME_TOKENS, ENTITY_NAME_TOKENS,
} from "../lib/lead-pipeline/canonical-lead-eligibility"
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
console.log("\n[G1 · THE predicate: first + last + (phone OR email), nothing less]")
const PASS: Array<[string, Parameters<typeof isLeadEligibleIdentity>[0]]> = [
  ["first + last + phone", { first_name: "Maria", last_name: "Gonzalez", phone: "3055550142" }],
  ["first + last + email", { first_name: "Maria", last_name: "Gonzalez", email: "m@x.com" }],
  ["first + last + both", { first_name: "Maria", last_name: "Gonzalez", email: "m@x.com", phone: "3055550142" }],
  ["real surname 'Na' is not the N/A placeholder", { first_name: "Min", last_name: "Na", phone: "3055550142" }],
  ["real surname 'Church' is not an entity", { first_name: "Charlotte", last_name: "Church", email: "c@x.com" }],
  ["apostrophe/hyphen names", { first_name: "Anne-Marie", last_name: "O'Neil", phone: "3055550142" }],
  ["accented names", { first_name: "José", last_name: "García", email: "j@x.com" }],
  ["single-character CJK name parts", { first_name: "伟", last_name: "王", phone: "3055550142" }],
]
for (const [label, c] of PASS) check(`PASSES: ${label}`, isLeadEligibleIdentity(c), JSON.stringify(evaluateCanonicalLeadEligibility(c)))

const REFUSE: Array<[string, Parameters<typeof isLeadEligibleIdentity>[0], "name" | "contact_anchor"]> = [
  ["POSITIVE CONTROL: name only (no phone, no email)", { first_name: "Maria", last_name: "Gonzalez" }, "contact_anchor"],
  ["POSITIVE CONTROL: phone only, no last name", { first_name: "Maria", phone: "3055550142" }, "name"],
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
check("a pass reports its channels (phone, email)", JSON.stringify((evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", email: "m@x.com", phone: "1" }) as any).via) === '["email","phone"]')
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
check("createLeadOnlyRecordForAcquisitionSource gates BEFORE its insert, default origin scraped",
  crmFn.indexOf("evaluateCanonicalLeadEligibility(") > 0 && crmFn.indexOf("evaluateCanonicalLeadEligibility(") < crmFn.indexOf('.from("leads")') && /const scraped = \(params\.origin \?\? "scraped"\) === "scraped"/.test(crmFn) && /if \(scraped \? !gate\.eligible : !reachable\)/.test(crmFn))
const inboundDeclarers = files.filter((f) => /origin:\s*"person_initiated_inbound"/.test(stripComments(read(f))))
check("ONLY the unknown-sender (person-initiated inbound email) door declares person_initiated_inbound",
  inboundDeclarers.length === 1 && inboundDeclarers[0].endsWith("lib/lead-pipeline/unknown-sender-identification.ts"), inboundDeclarers.join(", "))
const promoter = stripped("lib/lead-promotion/lead-promoter.ts")
check("promoteRawRecordToLead refuses at its own insert (no caller can skip the gate)",
  promoter.indexOf("evaluateCanonicalLeadEligibility(") > 0 && promoter.indexOf("evaluateCanonicalLeadEligibility(") < promoter.indexOf(".from('leads')") && /if \(!gate\.eligible\) \{\s*\n\s*return \{ success: false/.test(promoter))
check("the evaluator door (eligibility-core) delegates to the predicate", /evaluateCanonicalLeadEligibility\(\{/.test(stripped("lib/lead-promotion/eligibility-core.ts")))

// ── G6 · enrichment can rescue a name-only row ──────────────────────────────
console.log("\n[G6 · PeopleData is asked WITH a location, so dedup → enrich → dedup can turn a name into a phone/email]")
check("raw path (enrichWithPeopleData) sends the territory city/state as PDL's location", /address: pdlLocation,/.test(pp) && /const pdlLocation = \[fields\.city, fields\.state\]/.test(pp))
check("drain (enrichment-orchestrator) sends city/state with the name", /address: \[entity\.city \?\? entity\.mailing_city, entity\.state \?\? entity\.mailing_state\]/.test(stripped("lib/lead-pipeline/enrichment-orchestrator.ts")))
check("skipTraceWithPeopleData forwards `address` as PDL's `location`", /location: params\.address,/.test(stripped("lib/external/peopledata-client.ts")))

// ── G7 · registration ───────────────────────────────────────────────────────
console.log("\n[G7 · registration + ownership]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
const guard = pkg.scripts.guard ?? ""
check("package.json registers test:lead-identity-gate", pkg.scripts["test:lead-identity-gate"] === "tsx scripts/lead-identity-gate-guard.ts")
check("guard runs it AFTER test:scrapers (ordering only)", guard.indexOf("npm run test:scrapers") >= 0 && guard.indexOf("npm run test:lead-identity-gate") > guard.indexOf("npm run test:scrapers"))
const owner = Object.values(MAINTENANCE_DOMAINS).find((d) => d.proof === "test:lead-identity-gate")
check("MAINTENANCE_DOMAINS owns it", !!owner && owner.manager === "data_steward")

console.log(`\n  denominators: ${PASS.length} passing + ${REFUSE.length + 1} refused fixtures · ${sites.length} leads insert sites · ${files.length} app/lib files scanned`)
console.log("  blind spots: the census sees `.from(\"leads\").insert(` literally — an insert through a variable table name (lib/platform/demo-tenant.ts seeds demo leads via svc.from(table)) or an RPC/trigger is outside it (live check 2026-09-26: no public function inserts into leads except assert_tenant_isolation, a test helper); the name vocabulary is English-centric and errs toward refusal (a refused record stays raw and retryable)")
console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(failed === 0 ? " ✅ LEAD_IDENTITY_GATE_PASS" : " ❌ LEAD_IDENTITY_GATE_FAIL")
process.exit(failed === 0 ? 0 : 1)
