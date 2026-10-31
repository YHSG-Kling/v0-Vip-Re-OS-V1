/**
 * scripts/canaries/wave145-compliance-ux.ts — COMPLIANCE / UX canary (wave 145, lane 145J; owner rulings 18, 21, CLAUDE.md §6; C3):
 *   RULING 18 / C3 — accessibility preferences are EXPLICIT, user-controllable fields (communication format, captions / transcripts,
 *     language, text size / display, preferred portal modality) with a real reader (lib/contacts/accessibility-preferences.ts
 *     readAccessibilityPreferences, tenant-pinned) AND a real writer the person controls; never inferred from age / demographics —
 *     the age-band paths (ageGroupChannelAffinity, DELIVERY_MATRIX 65+/18-30, CHANNEL_ORDER_BY_BAND) give way to stated
 *     preferences + one default.
 *   RULING 21 — "Teams required document checklist should follow the team": checklists resolve by state, brokerage, team,
 *     transaction type, representation, stage and policy version; mandatory brokerage / state rules win a conflict (the FLOOR); on a
 *     team move / join the team's requirements are CARRIED to the adopting brokerage, the source's rows are kept as evidence, nothing
 *     crosses tenants.
 *   §6 — ONE contract-type vocabulary: the second list (lib/state-forms/field-defs.ts contractType, lib/workflow/intake/voice-to-offer.ts)
 *     merges onto the canonical contract_subtype vocabulary, or retires.
 *   Uncited required-doc presets are SURFACED as uncited (brokerage policy) — the citations themselves stay an owner item.
 *
 * Through the survivors at b364eb4b: lib/compliance/required-documents.ts resolveRequiredDocuments (in memory),
 * lib/compliance/adaptive-vocabulary.ts resolveVocabularyValue (pure), stripped source of the education / follow-up planners.
 * Lane 145H's names bind at the `WAVE145 BIND` lines; its fixtures, the rulings' assertions.
 *
 * MEASURED AT b364eb4b: no accessibility-preferences module or column; ageGroupChannelAffinity (lib/ai-isa/next-best-touch.ts),
 * CHANNEL_ORDER_BY_BAND (lib/agents/education-delivery-producer.ts) and DELIVERY_MATRIX (lib/kernel/education.ts) still pick
 * channels / formats by age band; field-defs / voice-to-offer write residential / as_is / land / commercial, which the canonical
 * vocabulary does not know; a team's required-document rows are stamped with the brokerage they were written under, so a moved
 * team's rows stop resolving; a team rule can override a brokerage's mandatory block.
 */
import { LIVE } from "./_harness"
import { findLanded, listFiles, strippedRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"
import { CONTRACTS, bindContract, canary145, quiet, sqlCode, wave145Migrations } from "./wave145-harness"

// ── WAVE145 BIND (lane 145H notes, "## Canary requirements", published 16:24Z) ──────────────────────────────────────────────────
// lib/contacts/accessibility-preferences.ts readAccessibilityPreferences · writeAccessibilityPreferences; app/actions/contacts/
// accessibility-preferences.ts saveContactAccessibilityPreferences; lib/agents/education-delivery-producer.ts pickEducationChannel;
// lib/kernel/education.ts getEducationDelivery; lib/compliance/team-checklist-carry.ts carryTeamChecklistRules · listJoinedTeams;
// lib/compliance/required-doc-presets.ts uncitedLegalClaims; lib/state-forms/field-defs.ts OFFER_FIELD_DEFS.

export async function run() {
  const c = canary145("Compliance/UX: stated accessibility preferences with a real reader and writer, never inferred from age · team checklists follow the team under the brokerage/state floor, never across tenants · one contract-type vocabulary · uncited presets surfaced")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory / static only")
  const B = "00000000-0000-4000-8000-00000000b001", B2 = "00000000-0000-4000-8000-00000000b002", CT = "00000000-0000-4000-8000-00000000c001", CT0 = "00000000-0000-4000-8000-00000000c000", U = "00000000-0000-4000-8000-00000000a001"

  // ── 1 · C3: one tenant-pinned reader of what the person STATED ──
  const C3 = await bindContract(CONTRACTS.C3_ACCESSIBILITY)
  await c.check("145H", "C3 · ACCESSIBILITY PREFERENCES ARE STATED FIELDS READ THROUGH ONE TENANT-PINNED READER (ruling 18: 'explicit, user-controllable fields … never inferred'): readAccessibilityPreferences(svc, brokerageId, contactId) returns what the contact STATED (captions) for its own brokerage, refuses the same contact read under ANOTHER brokerage, refuses (never 'nothing stated') when the read itself is refused, says NOTHING is stated for a 65-74 contact who stated nothing — and the reader names no age / birth / demographic column", async () => {
    if (!C3.mod) return { ok: false, evidence: C3.evidence }
    const rows = [
      { id: CT, contact_id: CT, brokerage_id: B, accessibility_preferences: { captions: true }, preferred_language: "en", enrichment_profile: {} },
      { id: CT0, contact_id: CT0, brokerage_id: B, age_range: "65-74", accessibility_preferences: null, preferred_language: null, enrichment_profile: {} },
    ]
    const svc = memSupabase({ contacts: rows }, { uuidIds: true })
    const refused = memSupabase({ contacts: rows }, { refuse: { contacts: "permission denied for table contacts" } })
    const read = async (s: unknown, b: string, id: string) => (await quiet(async () => C3.mod!.readAccessibilityPreferences(s, b, id))) as Record<string, any>
    const own = await read(svc, B, CT), other = await read(svc, B2, CT), denied = await read(refused, B, CT), aged = await read(svc, B, CT0)
    const src = strippedRepo(CONTRACTS.C3_ACCESSIBILITY.file) ?? ""
    const readsAge = /["'`](age_range|birthday|birth_date|birth_year|gender|household_income)["'`]|\b(ageSegment|age_band|generationalCohort)\b/.test(src)
    return { ok: own.ok && own.stated === true && own.preferences?.captions === true && !other.ok && !denied.ok && aged.ok && aged.stated === false && !readsAge, evidence: `own → stated ${own.stated}, captions ${own.preferences?.captions}; other tenant → ${other.ok ? "READ" : "refused"}; refused read → ${denied.ok ? `ok (stated ${denied.stated})` : "refused"}; 65-74 with nothing stated → stated ${aged.stated}; reader names an age column ${readsAge}` }
  })

  // ── 2 · …with a real WRITER the person controls ──
  await c.check("145H", "ACCESSIBILITY PREFERENCES HAVE A REAL WRITER THE PERSON CONTROLS (ruling 18: 'never invented without a reader/writer path'): writeAccessibilityPreferences records a contact's own statement with provenance (source contact), refuses an AGE BAND offered as a preference (nothing written), and the staff door writes only when the contact asked (contactRequested)", async () => {
    if (!C3.mod || typeof C3.mod.writeAccessibilityPreferences !== "function") return { ok: false, evidence: `${C3.evidence}${C3.mod ? "; no writeAccessibilityPreferences" : ""}` }
    const svc = memSupabase({ contacts: [{ id: CT, contact_id: CT, brokerage_id: B, accessibility_preferences: null, preferred_language: null, enrichment_profile: {} }] }, { uuidIds: true })
    const write = async (input: unknown) => (await quiet(async () => C3.mod!.writeAccessibilityPreferences(svc, { brokerageId: B, contactId: CT, input, writer: { userId: U, kind: "contact" } }))) as Record<string, any>
    const ageBand = await write({ age_band: "65+" })
    const afterAge = JSON.stringify((svc.tables.contacts ?? [])[0]?.accessibility_preferences ?? null)
    const valid = await write({ captions: true })
    const row = (svc.tables.contacts ?? [])[0] ?? {}
    const source = row.enrichment_profile?.field_provenance?.accessibility_preferences?.source
    const door = strippedRepo("app/actions/contacts/accessibility-preferences.ts") ?? ""
    const doorGated = /contactRequested\s*!==\s*true[\s\S]{0,40}return\s*\{\s*ok:\s*false/.test(door)
    return { ok: !ageBand.ok && !/65/.test(afterAge) && valid.ok && row.accessibility_preferences?.captions === true && source === "contact" && doorGated, evidence: `age band → ${ageBand.ok ? "WRITTEN" : "refused"} (stored ${afterAge}); captions → ${valid.ok ? "written" : valid.error}, provenance ${source ?? "∅"}; staff door requires the contact's request ${doorGated}` }
  })

  // ── 3 · never inferred from age: the education rail and format come from what is stated, else ONE default ──
  const { blankStrings } = await import("../strip-comments")
  const runtime = [...listFiles("lib", (f) => /\.tsx?$/.test(f)), ...listFiles("app", (f) => /\.tsx?$/.test(f))]
  const census = (names: readonly string[]) => runtime.flatMap((f) => { const raw = strippedRepo(f) ?? ""; if (!names.some((n) => raw.includes(n))) return []; const s = blankStrings(raw); return names.filter((n) => new RegExp(`\\b${n}\\b`).test(s)).map((n) => `${n}@${f}`) })
  // POSITIVE CONTROL: the finder reads code, not a tombstone comment and not a registry string.
  const { stripComments } = await import("../strip-comments")
  const finderControl = /\bCHANNEL_ORDER_BY_BAND\b/.test(blankStrings(stripComments("const order = CHANNEL_ORDER_BY_BAND[band]"))) && !/\bCHANNEL_ORDER_BY_BAND\b/.test(blankStrings(stripComments("// TOMBSTONE: CHANNEL_ORDER_BY_BAND retired\nconst what = \"CHANNEL_ORDER_BY_BAND is gone\"")))
  const eduHits = census(["CHANNEL_ORDER_BY_BAND", "DELIVERY_MATRIX"])
  await c.check("145H", "THE EDUCATION RAIL AND FORMAT ARE NEVER INFERRED FROM AGE (ruling 18: 'never inferred from age/demographics'; lane 145H item 2): with nothing stated, a 65+ and an 18-30 contact get the SAME default rail and no preferred format; the default delivery is a guide that does not auto-play and says it was not stated by the person; a STATED video preference IS honoured (positive control); CHANNEL_ORDER_BY_BAND and the age-keyed DELIVERY_MATRIX are gone from code (stripped, strings blanked; finder control)", async () => {
    const prod = await quiet(async () => import("../../lib/agents/education-delivery-producer")) as unknown as Record<string, any>
    const edu = await quiet(async () => import("../../lib/kernel/education")) as unknown as Record<string, any>
    if (typeof prod.pickEducationChannel !== "function" || typeof edu.getEducationDelivery !== "function") return { ok: false, evidence: "pickEducationChannel / getEducationDelivery not exported" }
    const pick = (ageSegment: string, accessibility?: Record<string, unknown>) => prod.pickEducationChannel({ ageSegment, moduleChannels: ["article"], consent: { tcpa_consent: true }, preferredChannel: null, ...(accessibility ? { accessibility } : {}) }) as Record<string, any>
    const old = pick("65+"), young = pick("18-30"), video = pick("65+", { communication_format: "video" })
    // HEAD keys the delivery on DELIVERY_MATRIX[ageSegment]: with no age band it returns undefined — reported, never thrown.
    const d = (edu.getEducationDelivery({}) ?? {}) as Record<string, any>
    const same = old.channel === young.channel && old.preferredFormat == null && young.preferredFormat == null
    return { ok: finderControl && eduHits.length === 0 && same && d.autoPlay === false && d.statedByPerson === false && video.preferredFormat === "video", evidence: `65+ → ${old.channel}/${old.preferredFormat ?? "∅"} (${old.railSource ?? "?"}); 18-30 → ${young.channel}/${young.preferredFormat ?? "∅"}; default delivery ${d.primaryFormat}, autoPlay ${d.autoPlay}, stated ${d.statedByPerson}; stated video → ${video.preferredFormat ?? "∅"}; age paths in code ${eduHits.join(", ") || "none"}` }
  })
  const touchHits = census(["ageGroupChannelAffinity"])
  c.rule("145E", "THE FOLLOW-UP TOUCH PLANNER PICKS NO CHANNEL BY AGE (ruling 18; lane 145H Outside-lane 2 routes lib/ai-isa/next-best-touch.ts to lane 145E, whose file it is): ageGroupChannelAffinity is gone from code — the stated preferred channel first, then one neutral default (stripped, strings blanked; finder control above)", finderControl && touchHits.length === 0, `age-band touch paths in code: ${touchHits.join(", ") || "none"}`)

  // ── 4 · §6: ONE contract-type vocabulary ──
  const av = await quiet(async () => import("../../lib/compliance/adaptive-vocabulary"))
  // field-defs is READ AT RUNTIME (OFFER_FIELD_DEFS.contractType.enum_values), never parsed: a lazy source regex runs past a field
  // whose enum is a reference (CONTRACT_SUBTYPES) into the NEXT field's literal list (measured 16:28Z — it read the listing-agreement
  // type list as the contract type). voice-to-offer's intake type is parsed for a literal union; a named type adds no values.
  const fdMod = await quiet(async () => import("../../lib/state-forms/field-defs")) as unknown as Record<string, any>
  const fdVals = ((fdMod.OFFER_FIELD_DEFS?.contractType?.enum_values ?? []) as unknown[]).map(String)
  const v2o = strippedRepo("lib/workflow/intake/voice-to-offer.ts") ?? ""
  const literalUnion = (src: string) => [...(/contractType\s*:\s*IntakeField<([^>]*)>/.exec(src)?.[1] ?? "").matchAll(/["']([\w-]+)["']/g)].map((m) => m[1])
  const v2oVals = literalUnion(v2o)
  const unionControl = literalUnion(`contractType: IntakeField<"residential" | "land">`).join(",") === "residential,land" && literalUnion("contractType: IntakeField<ContractSubtype>").length === 0
  const second = [...new Set([...fdVals, ...v2oVals])]
  const unresolved = second.filter((v) => !av.resolveVocabularyValue("contract_subtype", v))
  const residential = av.resolveVocabularyValue("contract_subtype", "residential")?.key ?? null
  const vocabControl = !!av.resolveVocabularyValue("contract_subtype", "short_sale") && !av.resolveVocabularyValue("contract_subtype", "banana_split")
  c.rule("145H", "ONE CONTRACT-TYPE VOCABULARY (CLAUDE.md §6; lane 145H item 3): every value the second lists can still write (lib/state-forms/field-defs.ts OFFER_FIELD_DEFS.contractType, read at runtime; lib/workflow/intake/voice-to-offer.ts) resolves on the canonical contract_subtype vocabulary (key, alias or label) — old stored spellings resolve forever (residential → standard) and as_is / land / commercial either get a home or are no longer writable (positive controls: short_sale resolves, a nonsense value does not; the literal-union parser reads a specimen union and adds nothing for a named type)", vocabControl && unionControl && fdVals.length > 0 && unresolved.length === 0 && residential === "standard", `field-defs ${fdVals.join(",") || "∅"}; voice-to-offer literals ${v2oVals.join(",") || "none (named type)"}; unresolved ${unresolved.join(",") || "none"}; residential → ${residential ?? "∅"}`)

  // ── 5 · RULING 21 floor: the brokerage's mandatory rule wins a conflict with a team rule ──
  const rq = await quiet(async () => import("../../lib/compliance/required-documents"))
  const T = "00000000-0000-4000-8000-00000000d001", T2 = "00000000-0000-4000-8000-00000000d002"
  const row = (id: string, brokerage: string, scope: string, scopeId: string, classification: string, extra: Record<string, unknown> = {}) => ({ id, brokerage_id: brokerage, scope_type: scope, scope_id: scopeId, classification, deal_type: "seller", is_required: true, block_on_missing: true, state_code: null, policy_version: 1, ...extra })
  const floorDb = memSupabase({ brokerage_required_documents: [row("rb", B, "brokerage", B, "disclosure", { block_on_missing: true }), row("rt", B, "team", T, "disclosure", { block_on_missing: false }), row("r2", B, "team", T2, "hoa_documents"), row("rx", B2, "brokerage", B2, "wire_instructions")] }, { uuidIds: true })
  const floor = await quiet(() => rq.resolveRequiredDocuments(floorDb as never, { brokerageId: B, teamId: T, dealType: "seller", stage: "closing" } as never)) as Record<string, any>
  const disclosure = (floor.docs ?? []).find((d: Record<string, unknown>) => d.classification === "disclosure") as Record<string, any> | undefined
  const classes = (floor.docs ?? []).map((d: Record<string, unknown>) => d.classification).sort()
  c.rule("145H", "MANDATORY BROKERAGE / STATE RULES WIN A CONFLICT WITH A TEAM RULE (ruling 21: 'resolve conflicts with mandatory brokerage/state ones'): a team-1 seller deal whose team marks the disclosure non-blocking still BLOCKS on it because the brokerage's rule is mandatory (the floor rule is named on the result); team 2's rows and another brokerage's rows never apply", floor.ok && disclosure?.block_on_missing === true && (disclosure?.floor_rule_ids ?? []).includes("rb") && !classes.includes("hoa_documents") && !classes.includes("wire_instructions"), floor.ok ? `disclosure block ${disclosure?.block_on_missing}, floor ${JSON.stringify(disclosure?.floor_rule_ids ?? null)}; docs ${classes.join(",")}` : String(floor.error))

  // ── 6 · RULING 21 carry: a moved team's checklist follows it; the source's rows stay; nothing crosses tenants ──
  const carry = await bindContract({ id: "145H team checklist carry", lane: "145H", file: "lib/compliance/team-checklist-carry.ts", exports: ["carryTeamChecklistRules", "listJoinedTeams"] })
  await c.check("145H", "A TEAM'S REQUIRED-DOCUMENT CHECKLIST FOLLOWS THE TEAM (ruling 21: 'Teams required document checklist should follow the team'): when team T joins brokerage B its team rules are CARRIED into B (each naming the rule it came from), the source brokerage's rows are left exactly as they were (historical policy evidence kept), a second carry adds nothing, and a team that is not in the adopting brokerage is refused (never a write into another tenant)", async () => {
    if (!carry.mod) return { ok: false, evidence: `${carry.evidence}; HEAD: team rows are stamped with the brokerage they were written under and the resolver filters on the deal's brokerage — a moved team's rows stop resolving; findLanded: ${findLanded(["lib/compliance", "lib/kernel/brokerage-transfer.ts"], /\b(carryTeam\w*|teamChecklist\w*|carried_from_rule_id)\b/) ?? "nothing"}` }
    const SRC = "00000000-0000-4000-8000-00000000e001"
    const srcRows = [row("s1", SRC, "team", T, "disclosure"), row("s2", SRC, "brokerage", SRC, "listing_agreement")]
    const db = memSupabase({ teams: [{ id: T, brokerage_id: B, team_lead_id: U }, { id: T2, brokerage_id: B2, team_lead_id: null }], brokerage_required_documents: srcRows.map((r) => ({ ...r })), required_document_policy_versions: [], tenant_policy_versions: [], adaptive_vocabulary_terms: [], brokerage_vocabulary: [] }, { uuidIds: true, stampCreatedAt: true })
    const before = JSON.stringify(srcRows)
    const run1 = await quiet(async () => carry.mod!.carryTeamChecklistRules(db, { sourceBrokerageId: SRC, targetBrokerageId: B, teamIds: [T], includeWorkspaceRules: true, actorUserId: U, reason: "wave145 canary" })) as Record<string, any>
    const after = JSON.stringify((db.tables.brokerage_required_documents ?? []).filter((r) => r.brokerage_id === SRC).map((r) => { const o: Record<string, unknown> = {}; for (const k of Object.keys(srcRows[0])) o[k] = r[k]; return o }))
    const carried = (db.tables.brokerage_required_documents ?? []).filter((r) => r.brokerage_id === B && r.scope_type === "team" && r.scope_id === T && !!r.carried_from_rule_id)
    const run2 = await quiet(async () => carry.mod!.carryTeamChecklistRules(db, { sourceBrokerageId: SRC, targetBrokerageId: B, teamIds: [T], includeWorkspaceRules: true, actorUserId: U, reason: "wave145 canary" })) as Record<string, any>
    const stray = await quiet(async () => carry.mod!.carryTeamChecklistRules(db, { sourceBrokerageId: SRC, targetBrokerageId: B, teamIds: [T2], includeWorkspaceRules: false, actorUserId: U, reason: "wave145 canary" })) as Record<string, any>
    return { ok: run1.ok && carried.length >= 1 && after === before && run2.ok && run2.carried === 0 && run2.alreadyCarried >= 1 && !stray.ok, evidence: `carried ${run1.carried ?? "?"} (rows naming their source ${carried.length}); source rows unchanged ${after === before}; second carry ${run2.carried}/${run2.alreadyCarried}; a team outside B → ${stray.ok ? "CARRIED" : "refused"}` }
  })
  const m869 = wave145Migrations().find((m) => m.num === 869) ?? null
  if (m869) {
    const { claimOf } = await import("../migration-status")
    c.pendingOwner("145H", "THE TEAM-CHECKLIST CARRY IS LIVE (ruling 21): the migration that adds the carry's provenance column is applied", claimOf(m869.sql) === "applied" && /carried_from_rule_id/.test(sqlCode(m869.sql)), "Integrator: apply supabase/migrations/m869 (brokerage_required_documents.carried_from_rule_id) through the MCP and regenerate the schema caches — until then the carry refuses live (lane 145H requirement 5)", `${m869.file.split("/").pop()}: ${claimOf(m869.sql)}`)
  }

  // ── 7 · uncited presets: brokerage policy (green — preserve) + surfaced as uncited (lane H) + the citation (owner) ──
  const seeder = strippedRepo("app/actions/compliance/seed-required-docs.ts") ?? ""
  const claimsState = /legal_basis\s*:\s*["']state_requirement["']/.test(seeder)
  const writer = strippedRepo("app/actions/compliance/manage-required-docs.ts") ?? ""
  const gatedState = /isPrimarySourceUrl\s*\(/.test(writer) && /VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES/.test(writer)
  c.rule("145H", "AN UNCITED PRESET IS BROKERAGE POLICY, NEVER A STATE REQUIREMENT (green, preserve): the preset seeder writes no 'state_requirement' legal basis; only the compliance-approver path with an official (.gov / .us) source may record one", !claimsState && gatedState, `seeder claims state_requirement ${claimsState}; state requirement gated on an official source + compliance approver ${gatedState}`)
  const presets = await quiet(async () => import("../../lib/compliance/required-doc-presets")) as unknown as Record<string, any>
  const tx = presets.getRequiredDocPresetsForState("TX", "buyer") as Array<Record<string, unknown>>
  const uncited = typeof presets.uncitedLegalClaims === "function" ? (presets.uncitedLegalClaims(tx) as unknown[]).length : -1
  const cited = typeof presets.uncitedLegalClaims === "function" ? (presets.uncitedLegalClaims(tx.map((p) => ({ ...p, legal_basis: "state_requirement", source_url: "https://www.trec.texas.gov/forms" }))) as unknown[]).length : -1
  c.rule("145H", "UNCITED PRESET CLAIMS ARE SURFACED, NEVER PASSED OFF AS LAW (lane 145H item 3: 'surface the human compliance task'): the presets' legal claims with no official source are named as uncited (TX buyer presets carry some), and the same claims with a state-requirement basis and an official .gov source are not (positive control)", uncited > 0 && cited === 0, uncited < 0 ? "no uncitedLegalClaims exported (lane 145H)" : `TX buyer presets: uncited ${uncited}; with an official source ${cited}`)
  c.pendingOwner("145H", "EACH STATE PRESET IS CITED OR KEPT AS BROKERAGE POLICY BY A HUMAN COMPLIANCE APPROVER (owner item carried from wave 144): every preset's legal claim carries an official source or is confirmed as brokerage policy", uncited === 0 && typeof presets.uncitedLegalClaims === "function", "A compliance approver confirms each state's preset rows (TX, CA, FL, NY, IL, GA, AZ, CO, WA, NC + the US baseline) against the official state source, or keeps them as brokerage policy — AI never invents a binding legal requirement", uncited < 0 ? "uncited claims not yet surfaced" : `${uncited} TX buyer claim(s) uncited`)

  c.blind("The resolver and the carry ran on the in-memory client (no RLS); the tenant vocabulary tables are absent, so platform vocabulary decides. The age-band census reads stripped lib/ + app/ with strings blanked for the three named identifiers — a renamed age path is out of its sight (the education behaviour step covers the education rail). The contract-type census parses the two named second lists; test:check-vocabulary is the wider census.")
  return c.report([], 0)
}
