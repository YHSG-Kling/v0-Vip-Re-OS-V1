/**
 * scripts/identity-dedup-guard.ts — C36 IDENTITY & DEDUP (wave 150, lane 150EFG; directive 150G).
 *
 *   A  subject keys: APN (county-scoped, punctuation/leading-zero blind), address, LLC / trust / estate / business entity,
 *      household (never merges two persons), person — and owner-name kinds;
 *   B  verified ownership — "a source-produced property does not magically prove an owner's identity";
 *   C  canary 5 — two sources disagree: the held (tenant/customer-confirmed) phone is never quietly overwritten, the
 *      offered value is kept as a conflict with both sources; a gap is filled; an identical value corroborates;
 *      the real merge path (pipeline-processor post-enrichment duplicate) rides the rule, tenant-pinned and counted;
 *   D  no cross-tenant identity spill + no double charge for a known result (the survivors, proved wired).
 *
 * Positive controls: the old merge expression (`enriched.phone || existing.phone`) is shown overwriting a confirmed phone;
 * the forbidden-shape finder sees that line in a specimen; the ownership verifier is shown verifying with two sources.
 *
 * BLIND SPOTS (published): conflicts on the merge path are recorded on lead_deduplication_log.match_details (no UI reads
 * them yet beyond the dedup log); the APN key needs the county FIPS for cross-county safety ("?" scope otherwise); the
 * household key is surname + address — two unrelated same-surname households at one address read as one household
 * (never as one person); provider-side contact columns other than email stay governed by provider-dedup.ts.
 */
import { readFileSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"

const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not installed */ }

const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const stripped = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

async function main() {
  const id = await import("../lib/identity/subject-identity")
  const rt = await import("../lib/lead-pipeline/raw-record-types")

  console.log("\n[A] subject keys + owner kinds")
  check("an LLC is an entity", id.ownerNameKind("Oak Holdings LLC") === "entity_trust_estate")
  check("a family trust is an entity", id.ownerNameKind("Smith Family Revocable Trust") === "entity_trust_estate")
  check("an estate is an entity", id.ownerNameKind("Estate of Mary Jones") === "entity_trust_estate")
  check("a realty group is a business", id.ownerNameKind("Acme Realty Group") === "business")
  check("two owners on one deed are a household", id.ownerNameKind("John & Jane Smith") === "household")
  check("a person is a person", id.ownerNameKind("Maria Lopez") === "person")
  const k1 = id.subjectIdentityKeys({ apn: "012-345-678", countyFips: "12033" })
  const k2 = id.subjectIdentityKeys({ apn: "12345678", countyFips: "12033" })
  const k3 = id.subjectIdentityKeys({ apn: "12345678", countyFips: "12113" })
  check("one parcel printed two ways → one APN key", k1[0] === k2[0] && /^apn:12033:/.test(k1[0] ?? ""), `${k1[0]} vs ${k2[0]}`)
  check("the same APN string in another county → a different parcel", k3[0] !== k1[0])
  const e1 = id.subjectIdentityKeys({ ownerName: "Oak Holdings LLC", state: "FL" }).find((k) => k.startsWith("entity:"))
  const e2 = id.subjectIdentityKeys({ ownerName: "OAK HOLDINGS, L.L.C.", state: "fl" }).find((k) => k.startsWith("entity:"))
  check("an LLC spelled two ways → one entity key", !!e1 && e1 === e2, `${e1} vs ${e2}`)
  const a1 = id.subjectIdentityKeys({ propertyAddress: "12 Palafox Street", zip: "32501" })[0]
  const a2 = id.subjectIdentityKeys({ propertyAddress: "12 palafox st.", zip: "32501-1234" })[0]
  check("an address spelled two ways → one address key", a1 === a2, `${a1} vs ${a2}`)
  const hh = id.subjectIdentityKeys({ lastName: "Smith", mailingAddress: "9 Bay Dr", zip: "32501", email: "j@x.org" })
  check("a household key and the person key are DIFFERENT keys (a household never merges two persons)", hh.some((k) => k.startsWith("hh:")) && hh.some((k) => k.startsWith("email:")))

  console.log("\n[B] verified ownership")
  const person = { firstName: "Maria", lastName: "Lopez", mailingAddress: "9 Bay Dr", zip: "32501" }
  check("a scraped page alone proves nothing", id.verifyOwnership(person, [{ source: "zillow", rights: "public_web", ownerName: "Maria Lopez" }]).verdict === "unverified")
  check("one licensed source naming her, no corroboration → unverified", id.verifyOwnership({ ...person, mailingAddress: null }, [{ source: "batchdata", rights: "licensed_vendor", ownerName: "LOPEZ MARIA" }]).verdict === "unverified")
  check("POSITIVE CONTROL: two independent authoritative sources → verified", id.verifyOwnership(person, [{ source: "batchdata", rights: "licensed_vendor", ownerName: "LOPEZ MARIA" }, { source: "county_recorder", rights: "public_record", ownerName: "Maria G Lopez" }]).verdict === "verified")
  check("one authoritative source + her own matching mailing address → verified", id.verifyOwnership(person, [{ source: "rentcast", rights: "licensed_vendor", ownerName: "Maria Lopez", mailingAddress: "9 Bay Drive" }]).verdict === "verified")
  check("two providers disagree about the owner → CONFLICT (kept, never resolved by picking one)", id.verifyOwnership(person, [{ source: "batchdata", rights: "licensed_vendor", ownerName: "Maria Lopez" }, { source: "rentcast", rights: "licensed_vendor", ownerName: "Robert Chen" }]).verdict === "conflict")
  check("an LLC owner of record → entity_owner (the person behind it unproven)", id.verifyOwnership(person, [{ source: "county_recorder", rights: "public_record", ownerName: "Bay Holdings LLC" }]).verdict === "entity_owner")

  console.log("\n[C] canary 5 — source merge preserves conflicts")
  const held = { phone: "(850) 555-1111", email: "maria@lopez.org", first_name: "Maria", last_name: null }
  const offered = { phone: "850-555-9999", email: "MARIA@LOPEZ.ORG", first_name: "Maria", last_name: "Lopez" }
  const naive = { phone: offered.phone || held.phone }
  check("POSITIVE CONTROL: the pre-150 merge expression overwrote the confirmed phone", naive.phone === "850-555-9999")
  const m = id.mergeSourceFacts(held, offered, { heldSource: "contact_record", incomingSource: "batchdata+enrichment" })
  check("the tenant-confirmed phone is NOT overwritten", !("phone" in m.patch))
  check("the offered phone is kept as a conflict naming both sources", m.conflicts.some((c) => c.field === "phone" && c.kept === "(850) 555-1111" && c.offered === "850-555-9999" && c.keptSource === "contact_record" && c.offeredBy === "batchdata+enrichment"))
  check("an identical value (case-blind email, same first name) corroborates", m.corroborated.includes("email") && m.corroborated.includes("first_name"))
  check("a gap (last name) is filled", m.patch.last_name === "Lopez")
  check("the same line written two ways is not a conflict", id.mergeSourceFacts({ phone: "(850) 555-1111" }, { phone: "+1 850 555 1111" }, { heldSource: "a", incomingSource: "b" }).conflicts.length === 0)
  check("a protected field cannot be made overwritable", !("phone" in id.mergeSourceFacts(held, offered, { heldSource: "a", incomingSource: "b", overwritable: ["phone"] }).patch))
  const pp = stripped("lib/lead-pipeline/pipeline-processor.ts")
  const forbidden = /phone:\s*enriched\.phone\s*\|\|\s*postEnrichDuplicate\.phone/
  check("POSITIVE CONTROL: the forbidden-shape finder sees the old merge line", forbidden.test("        phone:                 enriched.phone || postEnrichDuplicate.phone,"))
  check("the post-enrichment merge no longer lets the enriched phone win", !forbidden.test(pp) && !/email:\s*enriched\.email\s*\|\|\s*postEnrichDuplicate\.email/.test(pp))
  check("the merge path rides mergeSourceFacts", /mergeSourceFacts\(\s*\{ email: postEnrichDuplicate\.email, phone: postEnrichDuplicate\.phone/.test(pp))
  check("the merge write is tenant-pinned, error-read and COUNTED", /\.update\(mergeUpdate\)\s*\.eq\('id', postEnrichDuplicate\.id\)\s*\.eq\('brokerage_id', effectiveBrokerageId\)\s*\.select\('id'\)/.test(pp) && /if \(mergeErr \|\| \(mergedRows \?\? \[\]\)\.length === 0\)/.test(pp))
  check("conflicts land on the dedup log beside the kept value", /identity_conflicts: merged\.conflicts/.test(pp))

  console.log("\n[D] no cross-tenant spill · no double charge")
  const rec = { source: "batchdata", sourceRecordId: "bd-1", behaviorType: "motivated_seller", intentType: "seller", intentSignals: [], rawPayload: {} } as any
  const keyFor = (b: string) => rt.buildRawDataEnvelope(rec, { brokerageId: b, rights: { rights: "licensed_vendor", licence: "x" }, entityKindOf: id.ownerNameKind, actorType: "cron", costUsd: null }).idempotency_key
  check("one observation in two tenants → two scoped keys", keyFor("t-a") !== keyFor("t-b") && keyFor("t-a").startsWith("t:t-a|"))
  const pi = stripped("lib/kernel/person-identity.ts")
  check("the person store is tenant-keyed (resolvePerson refuses without a brokerage)", /export async function resolvePerson\(/.test(pi) && /brokerage/i.test(pi.slice(pi.indexOf("export async function resolvePerson("), pi.indexOf("export async function resolvePerson(") + 1800)))
  const fbm = pp.slice(pp.indexOf("async function findBestMatch("))
  check("the three-table dedup never reaches across tenants (findBestMatch pins brokerage_id)", /\.eq\(['"]brokerage_id['"], brokerageId\)/.test(fbm))
  const preAt = pp.indexOf("if (preEnrichDuplicate) {")
  const spendAt = pp.indexOf("await enrichWithPeopleData(")
  check("a person the tenant already holds is parked BEFORE the paid enrichment (no double charge)", preAt > 0 && spendAt > preAt && /duplicate_pre_enrich/.test(pp.slice(preAt, spendAt)))
  const pd = stripped("lib/enrichment/provider-dedup.ts")
  check("a fresh provider answer is reused, not re-bought (provider-dedup isFresh / PROVIDER_FRESHNESS_DAYS)", /export function isFresh\(/.test(pd) && /PROVIDER_FRESHNESS_DAYS/.test(pd))

  console.log(`\nIDENTITY DEDUP — ${passed} passed, ${failed} failed ${failed === 0 ? "✅ IDENTITY_DEDUP_PASS" : "❌ IDENTITY_DEDUP_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
