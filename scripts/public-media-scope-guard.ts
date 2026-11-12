#!/usr/bin/env tsx
/**
 * scripts/public-media-scope-guard.ts   (npm run test:public-media-scope — key to add; see the lane notes)
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * FAIR HOUSING SCOPE + THE 55+ / 62+ EXEMPTION (wave 143, lane 143F). Owner rulings, proven without a database or a network:
 *
 *   A. THE EXEMPTION'S RULES (42 U.S.C. § 3607(b)(2)-(3); 24 CFR 100.300-100.308) as a PURE evaluator: every condition is
 *      individually load-bearing (remove each → the record reads conditions_unmet naming it), the 80 percent line over OCCUPIED
 *      units has its boundary tested on both sides, the two-year occupancy-survey clock is tested on both sides, 62+ needs EVERY
 *      occupied unit, a programme needs a determination, and the sworn certification (§ 100.308) and the state review are
 *      required by the platform. The claim detector has a positive set and a negative set.
 *   B. A CLAIM IS VERIFIED, NEVER ASSUMED: "55+" with no record, an unreadable read, a record for a community the copy does not
 *      name, a stale record → HELD (a finding the AI rewrites around, then a human); only a record that names the community AND
 *      meets every condition passes — and "adult community" / "adult living" stay flagged even then (24 CFR 100.306).
 *   C. THE STORE on an in-memory database: status is COMPUTED (a caller cannot assert it), one record per community, a refused
 *      read is "unreadable" (never []), a delete that matches nothing is reported, every read/write is tenant-pinned.
 *   D. THE DOORS: every public-copy producer in this lane's domain carries the claim check (stripped source); the settings
 *      panel is mounted where a compliance officer can reach it; the server action is tenant-from-session and refuses team_lead.
 *   E. THE NEGATIVE SCOPE (owner: "never CDA, commission, agreements, ledgers, closing reconciliation"): no file in the financial-
 *      record population imports a fair-housing scanner or detector. The finder has a POSITIVE CONTROL (a specimen that does import
 *      one is caught) and a TOMBSTONE CONTROL (a comment that only names one is not a call site). The surface partition
 *      (isPublicMarketingSurface) keeps cda / settlement_statement / internal_form / private_note / financial_record OUT.
 *
 * Pure: readFileSync + stripped source (scripts/strip-comments.ts) + scripts/in-memory-supabase.ts. Denominators and blind spots
 * are printed beside the numbers.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  evaluateOlderPersonsRecord, detectOlderPersonsClaims, assessOlderPersonsClaim, validateOlderPersonsInput, communityKey,
  OLDER_PERSONS_BASES, OLDER_PERSONS_MIN_PERCENT, OLDER_PERSONS_AUTHORITY, OLDER_PERSONS_WRITING_DIRECTIVE, type OlderPersonsVerification,
} from "../lib/compliance/fair-housing-older-persons"
import { loadOlderPersonsVerifications, saveOlderPersonsVerification, removeOlderPersonsVerification, OLDER_PERSONS_TABLE } from "../lib/compliance/fair-housing-older-persons-store"
import { scanPublicCopy, rewritePublicCopyUntilCompliant, isPublicMarketingSurface, PUBLIC_COPY_MAX_REWRITES, type CopySurface } from "../lib/kernel/marketing/public-copy-rewrite"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)

const NOW = new Date("2026-10-23T12:00:00Z")
const B1 = "00000000-0000-4000-8000-0000000000b1"
const B2 = "00000000-0000-4000-8000-0000000000b2"
const U1 = "00000000-0000-4000-8000-0000000000a1"

/** A record that meets EVERY 55+ condition at NOW. */
const good55: OlderPersonsVerification = {
  community_name: "Sun Palms Village", basis: "55_plus", governing_rules: "Declaration of Covenants, Conditions and Restrictions, recorded 2004",
  occupied_units: 200, qualifying_units: 172, survey_completed_on: "2026-03-01", policies_published: true, policies_reference: "Resident handbook §2 and the recorded age restriction",
  age_verification_procedures: true, program_name: null, program_determination_ref: null, sworn_certification_on_file: true,
  certifying_representative: "A. Manager, HOA president", certification_date: "2026-03-05", state: "FL", state_law_reviewed: true,
  verified_by: U1, verified_at: "2026-10-01T00:00:00Z",
}

async function main() {
  // ═══════════════════════════ A · THE EXEMPTION'S RULES ═══════════════════════════
  section("A1 · 55+ — every condition is load-bearing")
  const base = evaluateOlderPersonsRecord(good55, NOW)
  check("a record meeting every condition is VERIFIED, expires two years after the survey", base.status === "verified" && base.unmet.length === 0 && base.expiresOn === "2028-03-01", JSON.stringify(base.unmet.map((c) => c.id)))
  const breaks: Array<[string, Partial<OlderPersonsVerification>, string]> = [
    ["no governing rules (a portion of a building is not a community)", { governing_rules: null }, "community_defined"],
    ["79 of 100 occupied units (below the 80 percent line)", { occupied_units: 100, qualifying_units: 79 }, "eighty_percent"],
    ["counts missing", { occupied_units: null, qualifying_units: null }, "eighty_percent"],
    ["qualifying > occupied is not a count", { occupied_units: 10, qualifying_units: 11 }, "eighty_percent"],
    ["policies not published", { policies_published: false }, "intent_policies"],
    ["no policy reference named", { policies_reference: "" }, "intent_policies"],
    ["no age-verification procedures", { age_verification_procedures: false }, "age_verification_current"],
    ["no survey date", { survey_completed_on: null }, "age_verification_current"],
    ["survey older than two years (2024-10-22, one day over)", { survey_completed_on: "2024-10-22" }, "age_verification_current"],
    ["survey dated in the future", { survey_completed_on: "2026-12-01" }, "age_verification_current"],
    ["no sworn certification on file", { sworn_certification_on_file: false }, "sworn_certification"],
    ["no certifying representative named", { certifying_representative: null }, "sworn_certification"],
    ["no certification date", { certification_date: null }, "sworn_certification"],
    ["state law not reviewed", { state_law_reviewed: false }, "state_law_reviewed"],
    ["no state named", { state: null }, "state_law_reviewed"],
  ]
  for (const [label, patch, id] of breaks) {
    const ev = evaluateOlderPersonsRecord({ ...good55, ...patch }, NOW)
    check(`NOT verified: ${label} → ${id} unmet`, ev.status === "conditions_unmet" && ev.unmet.some((c) => c.id === id), JSON.stringify(ev.unmet.map((c) => c.id)))
  }
  const eighty = evaluateOlderPersonsRecord({ ...good55, occupied_units: 5, qualifying_units: 4 }, NOW)
  check(`boundary: exactly ${OLDER_PERSONS_MIN_PERCENT}% (4 of 5) MEETS the line; 79.9% does not`, eighty.status === "verified" && evaluateOlderPersonsRecord({ ...good55, occupied_units: 1000, qualifying_units: 799 }, NOW).unmet.some((c) => c.id === "eighty_percent"))
  check("boundary: a survey exactly two years old is still current; one day past is not", evaluateOlderPersonsRecord({ ...good55, survey_completed_on: "2024-10-23" }, NOW).status === "verified" && evaluateOlderPersonsRecord({ ...good55, survey_completed_on: "2024-10-22" }, NOW).status === "conditions_unmet")
  check("the evaluator publishes its honest limits (attestation, not a legal determination; new construction; state law)", base.caveats.some((c) => /attestation/.test(c)) && base.caveats.some((c) => /25 percent/.test(c)) && base.caveats.some((c) => /State/.test(c)))
  check("every condition names its authority (statute / CFR section / platform policy)", base.conditions.every((c) => c.authority.length > 5 && ["statute", "regulation", "platform"].includes(c.requiredBy)))
  check("the authority constants cite the statute and the regulation range the owner named", /3607\(b\)/.test(OLDER_PERSONS_AUTHORITY.statute) && /100\.300.*100\.308/.test(OLDER_PERSONS_AUTHORITY.regulation))

  section("A2 · 62+ and the programme basis")
  const good62: OlderPersonsVerification = { ...good55, community_name: "Elm Court Seniors", basis: "62_plus", occupied_units: 50, qualifying_units: 50, survey_completed_on: null }
  check("62+: EVERY occupied unit solely occupied by persons 62+ → verified (fresh verification, two-year platform clock)", evaluateOlderPersonsRecord(good62, NOW).status === "verified")
  check("62+: 49 of 50 is NOT enough (the line is 100 percent, not 80)", evaluateOlderPersonsRecord({ ...good62, qualifying_units: 49 }, NOW).unmet.some((c) => c.id === "all_units_62_plus"))
  check("62+: the same record verified three years ago is stale", evaluateOlderPersonsRecord({ ...good62, verified_at: "2023-10-01T00:00:00Z" }, NOW).unmet.some((c) => c.id === "age_verification_current"))
  const goodProg: OlderPersonsVerification = { ...good55, community_name: "Harbor Senior Apartments", basis: "federal_state_program", program_name: "HUD Section 202", program_determination_ref: "HUD determination letter 2019-114", occupied_units: null, qualifying_units: null }
  check("programme: a named programme + determination reference → verified", evaluateOlderPersonsRecord(goodProg, NOW).status === "verified")
  check("programme: no determination reference → program_determination unmet", evaluateOlderPersonsRecord({ ...goodProg, program_determination_ref: null }, NOW).unmet.some((c) => c.id === "program_determination"))
  check("input validation: bad basis, bad counts, qualifying > occupied, bad date, bad state are refused", validateOlderPersonsInput({ community_name: "X Village", basis: "x" as never }).length > 0 && validateOlderPersonsInput({ ...good55, qualifying_units: 999 }).some((m) => /exceed/.test(m)) && validateOlderPersonsInput({ ...good55, survey_completed_on: "03/01/2026" }).some((m) => /YYYY/.test(m)) && validateOlderPersonsInput({ ...good55, state: "Florida" }).some((m) => /2-letter/.test(m)) && validateOlderPersonsInput(good55).length === 0)

  section("A3 · the claim detector — positive set, negative set")
  const claimHits = ["Welcome to our 55+ community", "a 62+ building", "ages 55 and over only", "for residents 62 and older", "55-plus living", "over 55", "senior living at its best", "a senior community", "senior housing options", "an age-restricted neighbourhood", "age-qualified homes", "an active adult lifestyle", "housing for older persons", "a retirement community"]
  const claimMisses = ["Priced at $55+ per square foot", "Unit 1155+ in the tower", "Our senior agent has 20 years", "a senior discount for veterans", "three bedrooms and a fenced yard", "built in 1955 and updated", "55 Maple Street", "62 acres of land", "senior thesis"]
  for (const t of claimHits) check(`CLAIM detected: "${t}"`, detectOlderPersonsClaims(t).some((c) => c.kind === "age_qualified"), JSON.stringify(detectOlderPersonsClaims(t)))
  for (const t of claimMisses) check(`NOT a claim: "${t}"`, !detectOlderPersonsClaims(t).some((c) => c.kind === "age_qualified"), JSON.stringify(detectOlderPersonsClaims(t)))
  check("24 CFR 100.306 wording ('adult living') is reported as inconsistent intent, not as a claim", detectOlderPersonsClaims("Enjoy adult living").every((c) => c.kind === "inconsistent_intent") && detectOlderPersonsClaims("Enjoy adult living").length === 1)

  // ═══════════════════════════ B · A CLAIM IS VERIFIED, NEVER ASSUMED ═══════════════════════════
  section("B · assess + the public-copy scan")
  const ad = "Sun Palms Village is a 55+ community with a clubhouse and a pool."
  check("no record supplied (nobody checked) → unverified, never verified", assessOlderPersonsClaim(ad, undefined, NOW).status === "unverified")
  check("an EMPTY record list → unverified (the tenant recorded none)", assessOlderPersonsClaim(ad, [], NOW).status === "unverified")
  check("an UNREADABLE record read → unreadable (fail closed), the reason says so", assessOlderPersonsClaim(ad, "unreadable", NOW).status === "unreadable" && /could not be read/.test(assessOlderPersonsClaim(ad, "unreadable", NOW).reason))
  check("a verified record the copy names → VERIFIED, with the record and its expiry", (() => { const a = assessOlderPersonsClaim(ad, [good55], NOW); return a.status === "verified" && a.record?.community_name === "Sun Palms Village" && a.record.expiresOn === "2028-03-01" })())
  check("a verified record for a DIFFERENT community does not cover this claim (the exemption is a community's, not a phrase's)", assessOlderPersonsClaim("Palm Grove is a 55+ community.", [good55], NOW).status === "unverified")
  check("a stale record the copy names → conditions_unmet naming age_verification_current", (() => { const a = assessOlderPersonsClaim(ad, [{ ...good55, survey_completed_on: "2022-01-01" }], NOW); return a.status === "conditions_unmet" && a.unmet.some((c) => c.id === "age_verification_current") })())
  check("copy with no age-qualified claim → none (and no record is consulted)", assessOlderPersonsClaim("Three bedrooms, a fenced yard.", "unreadable", NOW).status === "none")
  check("'adult living' stays inconsistent EVEN WITH a verified record (24 CFR 100.306)", assessOlderPersonsClaim("Sun Palms Village — a 55+ community for adult living", [good55], NOW).inconsistentWording.length === 1)
  check("communityKey match needs the whole name (a 2-letter name never matches)", communityKey("Sun Palms, Village!") === "sun palms village" && assessOlderPersonsClaim("55+ at AB", [{ ...good55, community_name: "AB" }], NOW).status === "unverified")

  const scanVerified = await scanPublicCopy(ad, "lead_magnet", { olderPersons: [good55], now: NOW })
  const scanNone = await scanPublicCopy(ad, "lead_magnet", { now: NOW })
  const scanStale = await scanPublicCopy(ad, "listing", { olderPersons: [{ ...good55, survey_completed_on: "2022-01-01" }], now: NOW })
  check("scanPublicCopy: a verified community's 55+ copy PASSES (ok, no older-persons finding)", scanVerified.ok && scanVerified.olderPersons?.status === "verified" && !scanVerified.findings.some((f) => /3607/.test(f.reference)), JSON.stringify(scanVerified.findings.map((f) => f.phrase)))
  check("scanPublicCopy: the same copy with nobody having checked is HELD (not ok), the finding carries the reason AND the fix AND the citation", !scanNone.ok && scanNone.findings.some((f) => /55\+/.test(f.phrase) && /verified/.test(f.fix) && /3607\(b\)/.test(f.reference)))
  check("scanPublicCopy: an unmet / stale record holds the claim and names what to update", !scanStale.ok && scanStale.findings.some((f) => /age_verification_current/.test(f.fix)))
  const adultCommunity = await scanPublicCopy("Sun Palms Village is an adult community.", "listing", { olderPersons: [good55], now: NOW })
  check("'adult community' is STILL a finding with a verified record in hand (the pattern list + 100.306 — not relaxed by the exemption)", !adultCommunity.ok)
  const adultLiving = await scanPublicCopy("Sun Palms Village offers adult living.", "listing", { olderPersons: [good55], now: NOW })
  check("'adult living' (not in the pattern list) is caught by the 100.306 rule", !adultLiving.ok && adultLiving.findings.some((f) => f.reference === "24 CFR 100.306"))
  const cleanCopy = await scanPublicCopy("Three bedrooms, a fenced yard and a short walk to the park.", "listing", { now: NOW })
  check("copy with no claim is untouched by the new rule (ok, status none) — nothing was flagged for the phrase alone", cleanCopy.ok && cleanCopy.olderPersons?.status === "none")

  // The loop: flagged → AI rewrites with the reason → recheck → human.
  let seen: string[] = []
  const fixed = await rewritePublicCopyUntilCompliant({ text: ad, surface: "lead_magnet", olderPersons: [], rewrite: async (_t, findings) => { seen = findings.map((f) => f.fix); return "Sun Palms Village has a clubhouse and a pool." } })
  check("the loop: an unverified claim is rewritten WITH THE REASON (the rewriter is handed the exemption fix), rechecked, and passes", fixed.ok && fixed.rewrites === 1 && !fixed.escalated && seen.some((s) => /exemption/.test(s) || /verified/.test(s)), JSON.stringify(seen))
  const stubborn = await rewritePublicCopyUntilCompliant({ text: ad, surface: "lead_magnet", olderPersons: [], rewrite: async (t) => `${t} Really.` })
  check(`the loop: a rewriter that keeps the claim is capped at ${PUBLIC_COPY_MAX_REWRITES} rewrites and ESCALATED to a human — never auto-approved`, !stubborn.ok && stubborn.escalated && stubborn.rewrites === PUBLIC_COPY_MAX_REWRITES)
  const verifiedLoop = await rewritePublicCopyUntilCompliant({ text: ad, surface: "lead_magnet", olderPersons: [good55], rewrite: async () => { throw new Error("must not be called") } })
  check("the loop: with the exemption verified there is nothing to rewrite (0 rewrites)", verifiedLoop.ok && verifiedLoop.rewrites === 0)
  check("the writing directive tells the model not to state the claim without a verified community", /Never state or imply/.test(OLDER_PERSONS_WRITING_DIRECTIVE) && /verified/.test(OLDER_PERSONS_WRITING_DIRECTIVE))

  // ═══════════════════════════ C · THE STORE ═══════════════════════════
  section("C · store — computed status, one record per community, fail closed, tenant-pinned, counted delete")
  const mem = memSupabase({ [OLDER_PERSONS_TABLE]: [], agent_action_ledger: [] }, { uuidIds: true })
  const input55 = { ...good55 }
  delete (input55 as Partial<OlderPersonsVerification>).verified_by
  const saved = await saveOlderPersonsVerification(mem, { brokerageId: B1, actorUserId: U1, input: { ...input55, survey_completed_on: "2026-03-01" }, now: NOW })
  check("a complete attestation is recorded and evaluates VERIFIED", saved.ok && saved.evaluation.status === "verified" && mem.tables[OLDER_PERSONS_TABLE].length === 1, JSON.stringify(saved))
  const row = mem.tables[OLDER_PERSONS_TABLE][0]
  check("the row carries the COMPUTED status, the expiry, the attesting user and a community_key — and the tenant", row?.status === "verified" && row.expires_on === "2028-03-01" && row.verified_by === U1 && row.community_key === "sun palms village" && row.brokerage_id === B1)
  const forged = await saveOlderPersonsVerification(mem, { brokerageId: B1, actorUserId: U1, input: { ...input55, community_name: "Forged Estates", qualifying_units: 10, status: "verified" } as never, now: NOW })
  check("a caller cannot ASSERT 'verified': a record whose counts fail the line is stored conditions_unmet whatever status was passed", forged.ok && forged.evaluation.status === "conditions_unmet" && mem.tables[OLDER_PERSONS_TABLE].find((r) => r.community_key === "forged estates")?.status === "conditions_unmet")
  const again = await saveOlderPersonsVerification(mem, { brokerageId: B1, actorUserId: U1, input: { ...input55, occupied_units: 210, qualifying_units: 180 }, now: NOW })
  check("saving the same community again REPLACES it (one record per community), created:false", again.ok && !again.created && mem.tables[OLDER_PERSONS_TABLE].filter((r) => r.community_key === "sun palms village").length === 1 && mem.tables[OLDER_PERSONS_TABLE].find((r) => r.community_key === "sun palms village")?.occupied_units === 210)
  const ledgerRows = mem.tables.agent_action_ledger.filter((r) => r.action === "compliance.older_persons.verify")
  check("evidence: a compliance.older_persons.verify ledger row per attestation, HUMAN_REQUESTED, naming the attester", ledgerRows.length >= 3 && ledgerRows.every((r) => r.reason_code === "HUMAN_REQUESTED" && (r.actor_user_id === U1 || JSON.stringify(r).includes(U1))), `rows=${ledgerRows.length}`)
  check("invalid input is refused before any write", !(await saveOlderPersonsVerification(mem, { brokerageId: B1, actorUserId: U1, input: { community_name: "Valid Name", basis: "55_plus", occupied_units: 5, qualifying_units: 9 } })).ok && !(await saveOlderPersonsVerification(mem, { brokerageId: "", actorUserId: U1, input: good55 })).ok && !(await saveOlderPersonsVerification(mem, { brokerageId: B1, actorUserId: "", input: good55 })).ok)
  const loaded = await loadOlderPersonsVerifications(mem, B1)
  check("load returns THIS tenant's records only (the other tenant's is invisible)", loaded !== "unreadable" && loaded.length === 2 && (await loadOlderPersonsVerifications(mem, B2)) instanceof Array && ((await loadOlderPersonsVerifications(mem, B2)) as unknown[]).length === 0)
  check("a REFUSED read is 'unreadable', never [] (an empty list would mean 'recorded none')", (await loadOlderPersonsVerifications(memSupabase({}, { refuse: { [OLDER_PERSONS_TABLE]: "RLS" } }), B1)) === "unreadable" && (await loadOlderPersonsVerifications(memSupabase({}, { missingTables: [OLDER_PERSONS_TABLE] }), B1)) === "unreadable" && (await loadOlderPersonsVerifications(mem, null)) === "unreadable")
  const wrongTenant = await removeOlderPersonsVerification(mem, { brokerageId: B2, id: (loaded as OlderPersonsVerification[])[0].id! })
  check("a delete under the WRONG tenant matches nothing and says so (a zero-row delete is not success)", !wrongTenant.ok && /matched/.test((wrongTenant as { error: string }).error) && mem.tables[OLDER_PERSONS_TABLE].length === 2)
  const removed = await removeOlderPersonsVerification(mem, { brokerageId: B1, id: (loaded as OlderPersonsVerification[])[0].id! })
  check("the right tenant's delete removes exactly one row", removed.ok && mem.tables[OLDER_PERSONS_TABLE].length === 1)

  // ═══════════════════════════ D · THE DOORS ═══════════════════════════
  section("D · every public-copy producer carries the claim check; the writer is admin-gated; the panel is reachable")
  const doors: Array<[string, string, RegExp]> = [
    ["lead magnet PUBLISH (the human's approval)", "lib/kernel/lead-magnets.ts", /loadOlderPersonsVerifications\(supabase as never, input\.brokerageId\)[\s\S]{0,200}scanPublicCopy\(publicText, "lead_magnet", \{ olderPersons \}\)/],
    ["lead magnet AI draft", "lib/lead-magnets/ai-draft.ts", /loadOlderPersonsVerifications\([\s\S]{0,600}olderPersons,/],
    ["book chapters (edit stage)", "lib/lead-magnets/book-creator.ts", /case "edit": \{[\s\S]{0,300}loadOlderPersonsVerifications[\s\S]{0,2500}olderPersons,/],
    ["book chapter revision by the human", "lib/lead-magnets/book-creator.ts", /scanPublicCopy\(text, "book", \{ brokerageName: p\.brand, olderPersons: await loadOlderPersonsVerifications/],
    ["book retail metadata (KDP package)", "lib/lead-magnets/book-publishing-produce.ts", /loadOlderPersonsVerifications[\s\S]{0,400}scanPublicCopy\([\s\S]{0,300}"book", \{ brokerageName, olderPersons \}/],
    ["video script assessment", "lib/video/script-compliance.ts", /detectOlderPersonsClaims\(script\)\.length > 0[\s\S]{0,1200}assessOlderPersonsClaim\(script, records\)/],
    ["video script WRITING prompt", "lib/video/script-compliance.ts", /\$\{OLDER_PERSONS_WRITING_DIRECTIVE\}/],
    ["podcast auto-producer gate", "lib/podcast/auto-producer.ts", /loadOlderPersonsVerifications\(args\.svc as never, args\.brokerageId\)[\s\S]{0,900}assessOlderPersonsClaim\(script, olderRecords\)/],
    ["TV spot master (broadcast copy)", "lib/video/tv-spot-produce.ts", /scanPublicCopy\(script, "video_script", \{ olderPersons \}\)/],
  ]
  for (const [label, file, re] of doors) check(`DOOR carries the claim check: ${label} (${file})`, re.test(code(file)))
  check("CONTROL: the door matcher would NOT match a gate that scans without the records", !doors[0][2].test('const scan = await scanPublicCopy(publicText, "lead_magnet")'))
  const action = code("app/actions/fair-housing-older-persons.ts")
  const actionRaw = raw("app/actions/fair-housing-older-persons.ts")
  const exportsAll = [...action.matchAll(/^export\s+(async\s+)?(function|const|class|let|var)\s+(\w+)/gm)]
  check(`the server action is "use server" with ${exportsAll.length} exports, every one an async function`, /^"use server"/.test(actionRaw.trimStart()) && exportsAll.length === 3 && exportsAll.every((m) => m[1] && m[2] === "function"))
  check("tenant + actor come from the SESSION (getAgentContext); no tenant id is a parameter of any export", /getAgentContext\(\)/.test(action) && !/export async function \w+\([^)]*(brokerageId|brokerage_id)/.test(action))
  check("only the tenant admin roster attests, MINUS team_lead (a 55+ attestation is a legal statement); the grant half is read (resolveTenantAdmin)", /resolveTenantAdmin\(/.test(action) && /ctx\.userType === "team_lead"/.test(action) && /!admin\.ok/.test(action))
  check("the form's fields are whitelisted — id / status / verified_by / verified_at are the server's (not copied from the argument)", !/input\.(status|verified_by|verified_at|id)\b/.test(action))
  check("the panel is MOUNTED on /compliance/settings (where a compliance officer lands)", /<OlderPersonsExemptionPanel \/>/.test(code("app/compliance/settings/page.tsx")) && existsSync(join(ROOT, "app/components/compliance/OlderPersonsExemptionPanel.tsx")))
  const mig = raw("supabase/migrations/m846-older-persons-housing-verifications.sql")
  check("the migration states its status on line 1 (files are not the database: the lane stamp until applied, APPLIED LIVE after)", /^-- (WRITTEN, NOT APPLIED \(wave 143, lane 143F\)|── APPLIED LIVE )/.test(mig))
  const storeSrc = code("lib/compliance/fair-housing-older-persons-store.ts")
  const cols = (/const COLUMNS = "([^"]+)"/.exec(storeSrc)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  const migBody = mig.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")
  check(`every column the store SELECTS exists in the migration's table (${cols.length} derived, none hard-coded)`, cols.length >= 15 && cols.every((c) => new RegExp(`^\\s{2}${c}\\s`, "m").test(migBody)), cols.filter((c) => !new RegExp(`^\\s{2}${c}\\s`, "m").test(migBody)).join(","))
  const migBasis = /basis IN \(([^)]*)\)/.exec(migBody)?.[1]?.split(",").map((s) => s.trim().replace(/'/g, "")) ?? []
  check("the migration's basis CHECK equals OLDER_PERSONS_BASES (one vocabulary; derived, not copied)", migBasis.length === OLDER_PERSONS_BASES.length && OLDER_PERSONS_BASES.every((b) => migBasis.includes(b)))
  check("the migration's RLS: tenant read policy on current_user_brokerage_id(), no write policy for authenticated", /FOR SELECT TO authenticated[\s\S]{0,120}current_user_brokerage_id\(\)/.test(migBody) && /REVOKE INSERT, UPDATE, DELETE/.test(migBody) && !/FOR (INSERT|UPDATE|DELETE|ALL)/.test(migBody))
  check("the table is in the live schema cache (m846 applied at integration; the cache is regenerated from live, never hand-added)", OLDER_PERSONS_TABLE in (CHECK_VOCABULARIES as Record<string, unknown>))

  // ═══════════════════════════ E · THE NEGATIVE SCOPE ═══════════════════════════
  section("E · fair-housing checks NEVER run on CDA / commission / agreements / ledgers / closing reconciliation")
  const partition: Array<[CopySurface, boolean]> = [["listing", true], ["ad", true], ["landing_page", true], ["lead_magnet", true], ["book", true], ["social", true], ["video_script", true], ["newsletter", true], ["blog", true], ["cda", false], ["settlement_statement", false], ["internal_form", false], ["private_note", false], ["financial_record", false]]
  for (const [s, pub] of partition) check(`surface '${s}' is ${pub ? "PUBLIC marketing (scanned)" : "NOT public (never scanned)"}`, isPublicMarketingSurface(s) === pub)
  const cdaScan = await scanPublicCopy("A 55+ community, perfect for families", "cda", { now: NOW })
  check("scanPublicCopy on a CDA surface returns ok with no findings and no older-persons verdict (the scope rule, executed)", cdaScan.ok && cdaScan.findings.length === 0 && cdaScan.olderPersons === undefined)
  check("…on every financial surface", (await Promise.all((["settlement_statement", "financial_record", "internal_form", "private_note"] as CopySurface[]).map((s) => scanPublicCopy("Steering: perfect for families, adults only, 55+", s)))).every((r) => r.ok && r.findings.length === 0))

  const FH_TOKENS = /fair-housing-patterns|public-copy-rewrite|real-estate-compliance-gate|fair-housing-older-persons|detectFairHousingViolations|detectFairHousingRedFlags|scanPublicCopy|rewritePublicCopyUntilCompliant|assessOlderPersonsClaim|assessScriptCompliance|postcheckScript|FairHousingScanner|FAIR_HOUSING_PATTERNS/
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(join(ROOT, dir))) {
      if (n === "node_modules" || n.startsWith(".")) continue
      const p = `${dir}/${n}`
      const st = statSync(join(ROOT, p))
      if (st.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(n)) out.push(p)
    }
    return out
  }
  const all = [...walk("lib"), ...walk("app")]
  // The financial-record population: a path naming a CDA, commission, agreement, settlement, ledger of MONEY, referral fee, revenue share,
  // payout, waterfall, closing reconciliation / compliance, escrow, net sheet. EXCLUDED by name: the message-compliance and action ledgers
  // (a compliance ledger records Fair Housing dispositions of OUTBOUND MESSAGES — it is the audit trail of the gate, not a money record).
  const POP = /(cda|commission|closing-disclosure|settlement|ledger|reconcil|referral-fee|referral|revenue-share|agent-agreement|team-agreement|payout|waterfall|brokerage-fee|closing-compliance|closing-cost|escrow|net-sheet)/i
  const EXCLUDED = /(compliance-ledger|action-ledger|manager-ledger|agent-action-ledger|compliance_ledger)/i
  const population = all.filter((p) => POP.test(p) && !EXCLUDED.test(p))
  const excluded = all.filter((p) => POP.test(p) && EXCLUDED.test(p))
  const offenders = population.filter((p) => FH_TOKENS.test(stripComments(raw(p))))
  check(`NEGATIVE GUARD: 0 of ${population.length} financial-record files import or call a fair-housing scanner / detector (stripped source)`, offenders.length === 0, offenders.join(", "))
  const specimen = 'import { scanPublicCopy } from "@/lib/kernel/marketing/public-copy-rewrite"\nexport const x = scanPublicCopy("a", "cda")'
  const tombstone = '// TOMBSTONE: the fair-housing scan (lib/kernel/marketing/public-copy-rewrite.ts scanPublicCopy) was removed from this CDA path\nexport const y = 1'
  check("POSITIVE CONTROL: the finder DOES see a CDA file that imports the public-copy scanner", FH_TOKENS.test(stripComments(specimen)))
  check("TOMBSTONE CONTROL: a comment that only NAMES the scanner is not a call site (stripped before the scan — CLAUDE.md §2)", !FH_TOKENS.test(stripComments(tombstone)) && FH_TOKENS.test(tombstone))
  check("the population is real (not a clean bill from an empty list): it includes the CDA, commission and closing-compliance modules", population.length >= 100 && population.some((p) => /cda/i.test(p)) && population.some((p) => /commission/i.test(p)) && population.some((p) => /closing/i.test(p)))
  const otherTarget = FH_TOKENS.test(stripComments(raw("lib/kernel/lead-magnets.ts")))
  check("CONTROL: the same finder DOES flag a public-copy producer (lib/kernel/lead-magnets.ts) — it is not blind to the repo's own style", otherTarget)

  // ── Door census (published, not a pass/fail on others' domains)
  section("F · public-copy door census")
  const PUBLIC_DOORS: Array<[string, string, RegExp | null]> = [
    ["lead magnet publish", "lib/kernel/lead-magnets.ts", /olderPersons/],
    ["lead magnet AI draft", "lib/lead-magnets/ai-draft.ts", /olderPersons/],
    ["lead magnet copy action", "app/actions/marketing/lead-magnet-copy.ts", /olderPersons/],
    ["book chapters + revision", "lib/lead-magnets/book-creator.ts", /olderPersons/],
    ["book retail metadata", "lib/lead-magnets/book-publishing-produce.ts", /olderPersons/],
    ["ad creator", "lib/ads/ad-creator.ts", /olderPersons/],
    ["video script assessment", "lib/video/script-compliance.ts", /assessOlderPersonsClaim/],
    ["podcast auto-producer", "lib/podcast/auto-producer.ts", /assessOlderPersonsClaim/],
    ["TV spot master", "lib/video/tv-spot-produce.ts", /olderPersons/],
    ["blog / newsletter / manual podcast writers (via postcheckScript)", "lib/kernel/content-creators.ts", /postcheckScript/],
  ]
  let carried = 0
  for (const [label, file, re] of PUBLIC_DOORS) {
    const has = existsSync(join(ROOT, file)) && !!re && re.test(code(file))
    if (has) carried++
    console.log(`    ${has ? "✓" : "·"} ${label} — ${file}${has ? "" : "  (does not yet pass the tenant's exemption records — outside this lane's files; see the lane notes)"}`)
  }
  check(`the lane's OWN doors all carry the check (${carried} of ${PUBLIC_DOORS.length} listed doors carry it; the rest are other lanes' files and are published, not hidden)`, PUBLIC_DOORS.filter(([, f]) => /^(lib\/(kernel\/lead-magnets|lead-magnets|video|podcast)\b)/.test(f)).every(([, f, re]) => !!re && re.test(code(f))))

  // ── Registration (the integrator adds the package.json key; the lane may not edit package.json)
  section("G · registration")
  const pkg = raw("package.json")
  const registered = /"test:public-media-scope":\s*"tsx scripts\/public-media-scope-guard\.ts"/.test(pkg)
  console.log(`    package.json key "test:public-media-scope": ${registered ? "registered" : "NOT registered — the lane may not edit package.json; the integrator adds it (lane notes)"}`)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` Denominators: ${breaks.length + 1} exemption condition cases; ${claimHits.length} claim phrases / ${claimMisses.length} non-claims; ${population.length} financial-record files scanned (${excluded.length} compliance/action-ledger files excluded by name); ${PUBLIC_DOORS.length} public doors listed`)
  console.log(" Blind spots:")
  for (const b of [
    "the claim detector is a phrase list — a claim worded in a way it does not list ('for those 55 and better') is caught only if a pattern names it; it is a recall-limited net, and the human publish step is the backstop",
    "the exemption record is the tenant's ATTESTATION — nothing here verifies the survey, the affidavits or the certification against a source; it records, dates and expires them (24 CFR 100.307's two-year clock)",
    "state senior-housing statutes are not encoded — `state_law_reviewed` is a human attestation; a state stricter than the federal rule is the reviewer's to apply",
    "newly constructed housing (not yet 25% occupied) and the pre-1988 / employee / reserved-unit allowances are NOT computed — the counts entered must already account for them (the evaluator says so in its caveats)",
    "the negative guard's population is path-named (cda / commission / settlement / ledger / referral / payout / closing-compliance …): a financial module with none of those words in its path is outside it; and the scan is for IMPORTS / CALLS of the named scanners, not for a re-implemented regex over protected-class words",
    "the live database was not read: the table does not exist until the integrator applies m846 — until then every age-qualified claim reads 'unreadable' and is held (fail closed), which is the intended behaviour, not a defect",
  ]) console.log(`   · ${b}`)
  if (failures.length) { console.log(" FAILURES:"); for (const f of failures) console.log(`   - ${f}`) }
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ❌ PUBLIC_MEDIA_SCOPE_FAIL"); process.exit(1) }
  console.log(" ✅ PUBLIC_MEDIA_SCOPE_PASS — a 55+ claim is verified never assumed; fair-housing checks stay on public copy and off CDA / commission / agreements / ledgers / closing reconciliation")
}

main().catch((e) => { console.error(e); process.exit(1) })
