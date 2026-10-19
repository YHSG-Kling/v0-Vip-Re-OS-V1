#!/usr/bin/env tsx
/**
 * scripts/entity-types-guard.ts   (npm run test:entity-types) — wave 142, lane 142D. Pure: no network, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * ENTITY TYPES — THE PRE-SCAN CHOICE AND THE ENTITY A SCAN BECAME. Owner, verbatim (2026-10-18): "why is
 * the business card being saved as a contactid? it depends on what type of person it is — user type they
 * are vendor, contact or agent. before scanning, the user chooses which type and then scans. these types
 * of mislabeling keeps happening … we have user types and contact types."
 *
 *  A. the vocabulary (executed): resolvePreScanChoice — "auto" is a pick, a class is a pick, the legacy
 *     3-way target is a pick, nothing / "" / a stranger is NOT; CARD_SUBJECT_TYPES === the live CHECK
 *  B. the ACTION on STRIPPED source (CLAUDE.md §2 — a tombstone naming `target` is not a call site):
 *     subjectType REQUIRED (the refusal sentence, no `subjectType?:`), "auto" HOLDS (needs_type_confirmation
 *     written, review_status pending), the pre-scan pick stored as classified_by 'picker' on the insert,
 *     the typed m789 writes per branch (vendor_id / recruit_id / routed_entity_type contact|vendor|recruit|none),
 *     the vendor + agent branches run the identity crosswalk (business_identity capability, consumer_email
 *     only, under withActionLedger) and never captureContact, every routed return names `entity: { kind`,
 *     NO return projects a `target:` (positive control), confirm refuses a held scan without a human's type
 *     unless the pick was stored, the reader selects + returns the typed columns
 *  C. the SURFACE on stripped source: the placeholder is disabled and unsubmittable, "auto" is an option,
 *     the upload zone is gated on the pick, the pick is sent as `subjectType`, the confirm form carries the
 *     type picker, the history column says "Record" (positive controls on fixtures)
 *  D. the migration file: m789 adds the three columns, both FKs and the CHECK (header = the lane stamp or APPLIED)
 *  E. THE VOCABULARY CENSUS (stripped, strings kept): every literal that reaches a users.user_type /
 *     contacts.contact_type WRITE or DB FILTER under lib/ app/ is a value the live CHECK admits — the DB
 *     refuses a retired spelling on write and matches nothing on read, in silence (CLAUDE.md §3);
 *     `===` comparisons are PUBLISHED (readers may tolerate a legacy spelling — contact-vocabulary-guard's
 *     asymmetry), never failed. Positive control: a forged `.eq("user_type","lender")` + `contact_type: "client"`
 *     insert are both caught.
 *  F. ROLE-VOCABULARY DRIFT, REPORTED (lane 142A owns the roster predicates): lib/security/types.ts
 *     CanonicalRole vs users_user_type_check vs lib/auth/resolve-user-role.ts UserRole — the three sets and
 *     their differences, with counts. Printed, never failed here.
 *  G. registration: package.json, chain membership (never position), MAINTENANCE_DOMAINS.entity_types
 * BLIND SPOTS (published): the action needs a session + the Vision provider, so B is source, not execution
 * (the pure rules it applies run in A; the canary runs captureContact end-to-end); the census is a regex over
 * literal comparisons — a value carried in a variable is not seen (role-vocabulary-guard covers the alias
 * table's calls); `category` is not censused (the column name is shared by many tables).
 */
import { readFileSync, existsSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "./strip-comments"
import { walkTs } from "./runtime-roots"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { resolvePreScanChoice, CARD_SUBJECT_TYPES } from "../lib/contacts/card-classifier"
import { isCanonicalRole } from "../lib/security/types"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const failures: string[] = []
const ok = (c: unknown, m: string, extra?: string) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; failures.push(m); console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`) } }
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const stripped = (p: string) => stripComments(read(p))
const ACTION = "app/actions/business-card/business-card-actions.ts"
const PAGE = "app/dashboard/agent/business-cards/page.tsx"
const CLASSIFIER = "lib/contacts/card-classifier.ts"
const MIGRATION = "supabase/migrations/m789-business-card-scans-typed-entity-linkage.sql"

/** The body of the first `if (<marker>) {` block, braces balanced (the classification simulator's idiom). */
function branchBody(src: string, marker: string): string {
  const start = src.indexOf(marker)
  if (start === -1) return ""
  const braceStart = src.indexOf("{", start)
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(braceStart, i + 1) }
  }
  return src.slice(braceStart)
}

console.log("\n━━━ A · the vocabulary (executed) ━━━")
{
  ok(resolvePreScanChoice("auto")?.kind === "auto", "\"auto\" is a pick — the reader suggests, the human confirms")
  const v = resolvePreScanChoice("vendor")
  ok(v?.kind === "explicit" && v.type === "vendor", "a concrete class is an explicit pick")
  const legacy = resolvePreScanChoice(undefined, "recruit")
  ok(legacy?.kind === "explicit" && legacy.type === "agent", "the legacy 3-way target still counts (recruit → agent)")
  ok(resolvePreScanChoice(undefined) === null && resolvePreScanChoice("") === null && resolvePreScanChoice("customer") === null && resolvePreScanChoice(null, null) === null, "POSITIVE CONTROL: nothing, \"\", a stranger (\"customer\") and null are NOT a pick — never a silent default")
  const live = CHECK_VOCABULARIES.business_card_scans?.card_subject_type ?? []
  ok(live.length > 0 && [...CARD_SUBJECT_TYPES].sort().join(",") === [...live].sort().join(","), `CARD_SUBJECT_TYPES === business_card_scans.card_subject_type CHECK (${live.length} values)`, `${[...CARD_SUBJECT_TYPES].sort().join(",")} vs ${[...live].sort().join(",")}`)
}

console.log("\n━━━ B · the action, stripped source ━━━")
{
  const src = stripped(ACTION)
  ok(src.includes("export async function uploadBusinessCard"), "positive control: the action's door is visible after stripping")
  ok(/subjectType: PreScanChoice\b/.test(src) && !/subjectType\?: PreScanChoice/.test(src), "uploadBusinessCard REQUIRES subjectType (PreScanChoice) — not optional")
  ok(/const pick = resolvePreScanChoice\(params\.subjectType, params\.target\)\s*\n\s*if \(!pick\) throw new Error\(PRE_SCAN_CHOICE_REQUIRED\)/.test(src) && /Choose who this card is for/.test(read(ACTION)), "no choice → the scan is REFUSED with the one spelled sentence (fail closed), before the service client")
  const pickAt = src.indexOf("resolvePreScanChoice(params.subjectType"), svcAt = src.indexOf("createServiceClient()")
  ok(pickAt > -1 && svcAt > pickAt, "the refusal runs BEFORE the service client is created")
  ok(/const needsTypeConfirmation = pick\.kind === "auto"/.test(src) && /const needsConfirmation = viable && \(assessment\.needsConfirmation \|\| needsTypeConfirmation\)/.test(src), "\"auto\" HOLDS the scan: needsConfirmation folds the type hold in")
  const insert = src.slice(src.indexOf('.from("business_card_scans")\n    .insert({'), src.indexOf('.select("id")\n    .single()\n  if (scanRowErr)'))
  ok(insert.length > 100 && /needs_type_confirmation: needsTypeConfirmation/.test(insert) && /\.\.\.preScanClassification/.test(insert) && /needsConfirmation \? "pending" : "approved"/.test(insert), "the scan row records needs_type_confirmation + the pre-scan classification; a held scan is review_status 'pending'")
  ok(/card_subject_type: pick\.type, classified_by: "picker" as const/.test(src) && /card_subject_type: suggestion!\.subjectType, classified_by: suggestion!\.source/.test(src), "an explicit pick is stored as classified_by 'picker'; \"auto\" stores the reader/notes SUGGESTION with its own tier — never 'picker'")
  ok(/subjectTypePick: pick\.kind === "explicit" \? pick\.type : undefined, human: false/.test(src), "only an EXPLICIT pick routes at upload; \"auto\" never reaches routeClassifiedCard un-confirmed")
  // the branches
  const vendor = branchBody(src, 'if (cardSubjectType === "vendor")')
  const agent = branchBody(src, 'if (cardSubjectType === "agent")')
  const sphere = branchBody(src, 'if (cardSubjectType === "sphere" || cardSubjectType === "unknown")')
  ok(vendor.length > 40 && agent.length > 40 && sphere.length > 40, "positive control: the three branches were found")
  ok(/vendor_id: vendor\.id,\s*routed_entity_type: "vendor"/.test(vendor) && /entity: \{ kind: "vendor", id: vendor\.id \}/.test(vendor), "VENDOR card → vendors row; the scan carries vendor_id + routed_entity_type 'vendor'; the result says entity vendor")
  ok(/recruit_id: recruit\.id,\s*routed_entity_type: "recruit"/.test(agent) && /entity: \{ kind: "recruit", id: recruit\.id \}/.test(agent) && /\.from\("recruits"\)\.insert/.test(agent), "AGENT card → recruits row (never a tenant login, never a contact); the scan carries recruit_id + 'recruit'; the result says entity recruit")
  ok(/routed_entity_type: "none"/.test(sphere) && /entity: \{ kind: "none", id: null \}/.test(sphere), "SPHERE / UNKNOWN card → no record, said in a typed column ('none') and in the result")
  ok(!vendor.includes("captureContact(") && !agent.includes("captureContact(") && !sphere.includes("captureContact("), "none of the three branches calls captureContact")
  ok(/routed_entity_type: "contact",?\s*\}\)\s*\.eq\("id", scanRef\.id\)/.test(src) && /contact_id: contactId,/.test(src) && /entity: \{ kind: "contact", id: contactId \}/.test(src), "CONTACT / POTENTIAL_CONTACT → captureContact, the ONE case the scan is rightly a contact id (typed 'contact')")
  ok((src.match(/\bcaptureContact\s*\(/g) ?? []).length === 1, "exactly ONE captureContact call site (the identity/dedup layer)")
  // identity / dedup
  ok(/await crosswalkBusinessIdentity\(\{[^\n]*entityKind: "vendor"/.test(vendor) && /await crosswalkBusinessIdentity\(\{[^\n]*entityKind: "recruit"/.test(agent), "the vendor + agent branches run the B2B2C identity crosswalk (a business identity matched against the tenant's contacts)")
  // The marker lands on the BODY brace — the helper's first `{` is its `args: {` parameter type, which
  // branchBody would otherwise return (the 2026-10-19 run: two false accusations from a 200-char slice).
  const helper = branchBody(src, "}): Promise<IdentityCrosswalkEvidence | null> {")
  ok(helper.length > 200 && /runVersiumBusinessIdentityLeg\(\{/.test(helper) && /outputs: \["consumer_email"\]/.test(helper) && /withActionLedger</.test(helper) && /action: "business_card\.identity_crosswalk"/.test(helper), "the crosswalk goes through the business_identity capability leg (budget-gated, booked), asks consumer_email ONLY, under withActionLedger")
  ok(!/\.from\("(vendors|recruits|contacts)"\)\.(update|insert)/.test(helper) && /\.from\("contacts"\)\.select\("id"\)\.eq\("brokerage_id", brokerageId\)\.eq\("email"/.test(helper), "the crosswalk WRITES NOTHING onto the vendor / recruit / contact — it matches by email under the tenant and leaves evidence on the scan")
  // the return shape
  const targetProjection = /\btarget:\s*"(contact|vendor|recruit)"/
  ok(!targetProjection.test(src), "NO return projects the pre-142 `target` (a sphere card reported as \"contact\")")
  ok(targetProjection.test('return { ...resultBase, contactId: null, target: "contact" }'), "POSITIVE CONTROL: the finder catches the old projection")
  ok((src.match(/entity: \{ kind: "(contact|vendor|recruit|none)"/g) ?? []).length >= 6, "every return names `entity: { kind … }` (≥ 6 sites)")
  // confirm
  const confirm = src.slice(src.indexOf("export async function confirmBusinessCardScan"))
  ok(/const storedPick: CardSubjectType \| null = row\.classified_by === "picker" \? row\.card_subject_type : null/.test(confirm) && /const subjectType: CardSubjectType \| null = params\.subjectType \?\? storedPick/.test(confirm), "confirm resolves the type from the human: the pick named now, else the pick stored BEFORE the scan (classified_by 'picker')")
  ok(/if \(!row\.contact_id && !subjectType\) \{\s*return \{ ok: false, needsSubjectType: true, suggestedSubjectType: row\.card_subject_type \?\? null/.test(confirm), "a held scan with no human type is REFUSED with needsSubjectType (the suggestion shown back, never promoted)")
  ok(/subjectTypePick: subjectType \?\? undefined, human: true/.test(confirm), "the human's type is what routes")
  // reader
  const reader = src.slice(src.indexOf("export async function getRecentScans"))
  ok(/vendor_id, recruit_id, routed_entity_type/.test(reader) && /const entity: ScanEntity \| null = routed === "contact"/.test(reader) && /routed === "none" \? \{ kind: "none", id: null \}/.test(reader) && /needsTypeConfirmation: pending && ed\.needs_type_confirmation === true/.test(reader), "getRecentScans reads the typed m789 columns and returns `entity` + the type hold (pre-m789 rows: a contact link is a contact, anything else is unknown — never \"contact\")")
  // the pure module holds the vocabulary; the server file exports only endpoints
  const cls = stripped(CLASSIFIER)
  ok(/export type PreScanChoice = CardSubjectType \| "auto"/.test(cls) && /export type ScanEntity = \{ kind: "contact" \| "vendor" \| "recruit" \| "none"; id: string \| null \}/.test(cls) && /export function resolvePreScanChoice\(/.test(cls), "PreScanChoice / ScanEntity / resolvePreScanChoice live in the PURE classifier module, shared by action and surface")
  ok(!/^export (type|interface|const|function) /m.test(src.replace(/^export async function /gm, "")), "the \"use server\" file exports endpoints only (every export async)")
}

console.log("\n━━━ C · the surface, stripped source ━━━")
{
  const page = stripped(PAGE)
  ok(/\{ value: "", label: "Choose who this is…", disabled: true \}/.test(page), "the placeholder choice is DISABLED — it cannot be submitted")
  ok(!/\{ value: "", label: "Auto-detect" \}/.test(page) && /\{ value: "auto", label: "Not sure[^"]*" \}/.test(page), "the silent \"Auto-detect\" default is gone; \"Not sure\" is an explicit option")
  ok(/if \(!cardSubjectPick\) \{\s*toast\(\{\s*title: "Choose who this card is for first"/.test(page), "processFile refuses to scan without a choice (the client half of fail-closed)")
  ok(/subjectType: cardSubjectPick,/.test(page) && !/subjectType: cardSubjectPick \|\| undefined/.test(page), "the choice is sent as `subjectType` — never undefined-ed into a server default")
  ok(/aria-disabled=\{!cardSubjectPick\}/.test(page) && /onClick=\{\(\) => \{ if \(cardSubjectPick\) fileInputRef\.current\?\.click\(\) \}\}/.test(page), "the upload zone is closed until a choice is made")
  ok(/id="confirm-subject-type"/.test(page) && /subjectType: typePick/.test(page) && /if \(needsType && !typePick\)/.test(page), "the confirm form carries the TYPE picker for a held \"auto\" scan and will not file without one")
  ok(/>Record<\/th>/.test(page) && !/>Contact<\/th>/.test(page) && /ENTITY_LABEL\[s\.entity\.kind\]/.test(page), "the history column is \"Record\" and renders the entity the scan BECAME (vendor / recruit / contact / none)")
  // positive controls on fixtures
  const old = 'const SUBJECT_TYPE_OPTIONS = [\n  { value: "", label: "Auto-detect" },\n]\nconst res = await uploadBusinessCard({ subjectType: cardSubjectPick || undefined })\n<th>Contact</th>'
  ok(/\{ value: "", label: "Auto-detect" \}/.test(old) && /subjectType: cardSubjectPick \|\| undefined/.test(old) && />Contact<\/th>/.test(old), "POSITIVE CONTROL: the pre-142 surface shapes (Auto-detect default, `|| undefined`, a Contact column) are each recognised")
}

console.log("\n━━━ D · the migration ━━━")
{
  ok(existsSync(join(ROOT, MIGRATION)), `${MIGRATION} exists`)
  const sql = existsSync(join(ROOT, MIGRATION)) ? read(MIGRATION) : ""
  ok(/^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(sql), "the header carries the lane stamp or the integrator's APPLIED stamp (never pinned to one)")
  ok(/ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES public\.vendors\(id\)/.test(sql) && /ADD COLUMN IF NOT EXISTS recruit_id uuid REFERENCES public\.recruits\(id\)/.test(sql) && /ADD COLUMN IF NOT EXISTS routed_entity_type text/.test(sql), "vendor_id (FK vendors), recruit_id (FK recruits), routed_entity_type")
  ok(/CHECK \(routed_entity_type IS NULL OR routed_entity_type IN \('contact', 'vendor', 'recruit', 'none'\)\)/.test(sql), "the CHECK spells the same four kinds the action writes (one vocabulary)")
  ok(/DROP CONSTRAINT IF EXISTS business_card_scans_routed_entity_type_check,\s*ADD CONSTRAINT/.test(sql) && !/^\s*DROP (INDEX|POLICY|TABLE|COLUMN)/m.test(sql), "idempotent, non-destructive (no standalone DROP — the MCP applies it)")
}

console.log("\n━━━ E · the vocabulary census (stripped, strings kept) ━━━")
{
  const USER_TYPES = new Set(CHECK_VOCABULARIES.users?.user_type ?? [])
  const CONTACT_TYPES = new Set(CHECK_VOCABULARIES.contacts?.contact_type ?? [])
  ok(USER_TYPES.size > 0 && CONTACT_TYPES.size > 0, `positive control: the live CHECKs are loaded (user_type ${USER_TYPES.size}, contact_type ${CONTACT_TYPES.size})`)
  type Hit = { file: string; line: number; column: "user_type" | "contact_type"; value: string; kind: "filter" | "write" | "compare" }
  const lineOf = (s: string, idx: number) => s.slice(0, idx).split("\n").length
  function census(src: string, file: string): Hit[] {
    const hits: Hit[] = []
    for (const column of ["user_type", "contact_type"] as const) {
      const vocab = column === "user_type" ? USER_TYPES : CONTACT_TYPES
      const push = (idx: number, value: string, kind: Hit["kind"]) => { if (!vocab.has(value)) hits.push({ file, line: lineOf(src, idx), column, value, kind }) }
      for (const m of src.matchAll(new RegExp(`\\.(?:eq|neq)\\(\\s*["']${column}["']\\s*,\\s*["']([a-z_]+)["']`, "g"))) push(m.index ?? 0, m[1], "filter")
      for (const m of src.matchAll(new RegExp(`\\.in\\(\\s*["']${column}["']\\s*,\\s*\\[([^\\]]*)\\]`, "g"))) for (const v of m[1].matchAll(/["']([a-z_]+)["']/g)) push(m.index ?? 0, v[1], "filter")
      // A literal that spells the COLUMN'S OWN NAME is a header→column alias entry (`contact_type: 'contact_type'`
      // in the import mapper), never a value written to the column — the rule, not a file exemption.
      for (const m of src.matchAll(new RegExp(`\\b${column}:\\s*["']([a-z_]+)["']`, "g"))) if (m[1] !== column) push(m.index ?? 0, m[1], "write")
      // `typeof row.contact_type === "string"` compares a TYPE NAME, not a vocabulary value — excluded by rule.
      for (const m of src.matchAll(new RegExp(`\\b${column}\\s*(?:===|!==|==|!=)\\s*["']([a-z_]+)["']`, "g"))) if (!/typeof\s+[\w.?]*$/.test(src.slice(Math.max(0, (m.index ?? 0) - 48), m.index))) push(m.index ?? 0, m[1], "compare")
    }
    return hits
  }
  const forged = census('await svc.from("users").select("id").eq("user_type", "lender")\nawait svc.from("contacts").insert({ contact_type: "client" })\nif (u.user_type === "title_agent") {}\nconst MAP = { Category: "contact_type", contact_type: "contact_type" }', "fixture.ts")
  ok(forged.some((h) => h.column === "user_type" && h.value === "lender" && h.kind === "filter") && forged.some((h) => h.column === "contact_type" && h.value === "client" && h.kind === "write") && forged.some((h) => h.value === "title_agent" && h.kind === "compare"), "POSITIVE CONTROL: a forged .eq(\"user_type\",\"lender\") filter, a contact_type \"client\" write and a title_agent compare are each caught")
  ok(!forged.some((h) => h.value === "contact_type"), "NEGATIVE CONTROL: a header→column alias entry (`contact_type: \"contact_type\"`) is not a write of a value")
  const files = [...walkTs(join(ROOT, "lib")), ...walkTs(join(ROOT, "app"))]
  const all: Hit[] = []
  for (const f of files) all.push(...census(stripComments(readFileSync(f, "utf8")), relative(ROOT, f)))
  const hard = all.filter((h) => h.kind !== "compare")
  const soft = all.filter((h) => h.kind === "compare")
  console.log(`  census: ${files.length} files scanned; ${hard.length} write/filter literal(s) outside the CHECK; ${soft.length} compare literal(s) outside the CHECK (published, reader-tolerant)`)
  for (const h of hard) console.log(`    ✗ ${h.file}:${h.line} ${h.column} ${h.kind} "${h.value}"`)
  for (const h of soft) console.log(`    · ${h.file}:${h.line} ${h.column} compare "${h.value}" (a tolerant READ — report, not a failure)`)
  ok(hard.length === 0, "no WRITE or DB FILTER under lib/ app/ names a users.user_type / contacts.contact_type value the live CHECK refuses", hard.map((h) => `${h.file}:${h.line} ${h.value}`).join(", "))
}

console.log("\n━━━ F · role-vocabulary drift (reported — lane 142A owns the roster) ━━━")
{
  const storable = new Set(CHECK_VOCABULARIES.users?.user_type ?? [])
  const candidates = new Set([...storable, "lender", "title_agent", "member", "customer", "prospect", "tenant"])
  const canonical = new Set([...candidates].filter((v) => isCanonicalRole(v)))
  const rur = stripped("lib/auth/resolve-user-role.ts")
  const unionSrc = rur.slice(rur.indexOf("export type UserRole ="), rur.indexOf("export function isPlatformStaffIdentity"))
  const userRole = new Set([...unionSrc.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]))
  const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort()
  console.log(`  users_user_type_check (${storable.size}): ${[...storable].sort().join(", ")}`)
  console.log(`  CanonicalRole (lib/security/types.ts) ∩ candidates (${canonical.size}): ${[...canonical].sort().join(", ")}`)
  console.log(`  UserRole (lib/auth/resolve-user-role.ts) (${userRole.size}): ${[...userRole].sort().join(", ")}`)
  console.log(`  canonical but NOT storable (a permission vocabulary, never a seat): ${diff(canonical, storable).join(", ") || "none"}`)
  console.log(`  storable but NOT canonical: ${diff(storable, canonical).join(", ") || "none"}`)
  console.log(`  UserRole lacks (vs CHECK): ${diff(storable, userRole).join(", ") || "none"} · UserRole adds (vs CHECK): ${diff(userRole, storable).join(", ") || "none"}`)
  ok(userRole.size > 0, "positive control: the UserRole union was parsed")
  ok(!userRole.has("lender") && !userRole.has("title_agent"), "the column vocabulary (UserRole) does not claim lender / title_agent (owner 2026-09-04: a lender is a VENDOR CATEGORY)")
}

console.log("\n━━━ G · registration ━━━")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  ok(/entity-types-guard\.ts/.test(pkg.scripts["test:entity-types"] ?? ""), "package.json registers test:entity-types")
  ok(new RegExp("npm run test:entity-types(\\s|&|$)").test(pkg.scripts.guard ?? ""), "the guard chain runs it (membership, not position)")
  const d = MAINTENANCE_DOMAINS.entity_types
  ok(!!d && d.proof === "test:entity-types" && d.manager === "data_steward" && (d.coOwners ?? []).includes("sphere_of_influence") && (d.coOwners ?? []).includes("compliance_officer"), "MAINTENANCE_DOMAINS.entity_types: data_steward accountable, sphere_of_influence + compliance_officer co-own")
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
console.log("  blind spots: the action is asserted on stripped source (a session + the Vision provider are needed to execute it; the pure rules ran in A); the census is a literal scan — a value carried in a variable is not seen (role-vocabulary-guard covers the alias calls); vendors.category is not censused (a shared column name).")
if (fail > 0) { for (const f of failures) console.log(`   - ${f}`); console.log(" ❌ ENTITY_TYPES_FAIL"); process.exit(1) }
console.log(" ✅ ENTITY_TYPES_PASS — the type is chosen before the scan, and a scan says which entity it became")
